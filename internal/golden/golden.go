// Package golden загружает эталоны поведения testdata/golden, собирает из них входные
// мини-проекты и сравнивает с эталонами результаты.
//
// Эталон состоит из случаев testdata/golden/<домен>/<случай>/: case.json с описанием и именем
// проверяемой операции, входной мини-проект project/ и ожидаемые JSON. Пакет загружает случаи,
// собирает мини-проект во временной папке с наложением overlay/ (BuildProject), разбирает значения
// случаев моделью toolrt и сверяет исходы вызовов (values.go),
// нормализует абсолютные пути в маркер <project> и сравнивает деревья JSON; сами функции домена
// вызывает тест соответствующего пакета. Все эталоны лежат в Git; тесты не зависят от
// файлов вне репозитория.
package golden

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"math/big"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// ProjectMarker заменяет корень проекта в путях ожидаемых JSON, чтобы эталон не зависел от временной папки.
const ProjectMarker = "<project>"

// projectDir — имя каталога входного проекта внутри случая. Результат для не-проекта содержит имя
// каталога (basename пути), поэтому копия для записи создаётся под тем же именем.
const projectDir = "project"

// maxDiff ограничивает число различий в сообщении теста: дальше обычно повторяется одна причина.
const maxDiff = 40

// Case — один случай домена. Поля повторяют case.json, а Dir указывает на каталог случая.
type Case struct {
	// Domain — домен эталонов: status, timing-view, timing-save.
	Domain string `json:"-"`
	// Name — имя каталога случая, уникальное внутри домена.
	Name string `json:"-"`
	// Dir — абсолютный путь каталога случая в testdata/golden.
	Dir string `json:"-"`
	// Description — что проверяет случай, по-русски.
	Description string `json:"description"`
	// Call — проверяемая операция: computeStatus, viewTiming или saveTiming.
	Call string `json:"call"`
	// Project — имя входного каталога проекта или nil, если операция вызывается на несуществующем пути.
	Project *string `json:"project"`
	// Covers — ветки поведения, которые доказывает случай.
	Covers []string `json:"covers"`
	// StubbedMedia — медиафайлы входа, заменённые текстовыми заглушками без изменения результата.
	StubbedMedia []string `json:"stubbedMedia"`
}

// Root находит testdata/golden модуля, поднимаясь от рабочего каталога теста к go.mod.
// Поиск от рабочего каталога, а не от пути исходника, работает и при сборке с -trimpath.
func Root() (string, error) {
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			root := filepath.Join(dir, "testdata", "golden")
			if info, err := os.Stat(root); err != nil || !info.IsDir() {
				return "", fmt.Errorf("в модуле %s нет testdata/golden", dir)
			}
			return root, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", errors.New("не найден go.mod над рабочим каталогом")
		}
		dir = parent
	}
}

// mustRoot возвращает корень эталонов или завершает тест: без эталонов сравнивать не с чем.
func mustRoot(t testing.TB) string {
	t.Helper()
	root, err := Root()
	if err != nil {
		t.Fatal(err)
	}
	return root
}

// Load читает все случаи домена в порядке имён каталогов. Пустой домен считается ошибкой теста,
// чтобы опечатка в имени не превращала проверку в пустой проход.
func Load(t testing.TB, domain string) []Case {
	t.Helper()
	base := filepath.Join(mustRoot(t), domain)
	entries, err := os.ReadDir(base)
	if err != nil {
		t.Fatalf("домен эталонов %s: %v", domain, err)
	}
	var cases []Case
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		dir := filepath.Join(base, entry.Name())
		var item Case
		if err := readJSON(filepath.Join(dir, "case.json"), &item); err != nil {
			t.Fatalf("случай %s/%s: %v", domain, entry.Name(), err)
		}
		item.Domain, item.Name, item.Dir = domain, entry.Name(), dir
		cases = append(cases, item)
	}
	if len(cases) == 0 {
		t.Fatalf("в домене эталонов %s нет случаев", domain)
	}
	return cases
}

// ProjectPath — путь входного проекта для функций только чтения. Для случая без проекта путь
// указывает на несуществующий каталог с тем же basename, что и в эталоне.
func (c Case) ProjectPath() string {
	return filepath.Join(c.Dir, projectDir)
}

// HasProject сообщает, есть ли у случая существующий входной каталог.
func (c Case) HasProject() bool {
	return c.Project != nil
}

// CopyProject копирует вход в t.TempDir()/project для записывающих сценариев (saveTiming): эталон в
// testdata не должен меняться. Для случая без проекта возвращает несуществующий путь в той же папке.
func (c Case) CopyProject(t testing.TB) string {
	t.Helper()
	target := filepath.Join(t.TempDir(), projectDir)
	if !c.HasProject() {
		return target
	}
	// Git не хранит пустые каталоги: пустой входной проект (например, папка без маркера)
	// восстанавливается пустой папкой, а не .gitkeep, который стал бы лишним файлом входа.
	if _, err := os.Stat(c.ProjectPath()); errors.Is(err, fs.ErrNotExist) {
		if err := os.Mkdir(target, 0o755); err != nil {
			t.Fatalf("пустой проект %s/%s: %v", c.Domain, c.Name, err)
		}
		return target
	}
	if err := copyTree(c.ProjectPath(), target); err != nil {
		t.Fatalf("копия проекта %s/%s: %v", c.Domain, c.Name, err)
	}
	return target
}

// Read возвращает файл случая, например expected.json или timing-input.json.
func (c Case) Read(t testing.TB, name string) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(c.Dir, name))
	if err != nil {
		t.Fatalf("случай %s/%s: %v", c.Domain, c.Name, err)
	}
	return data
}

// Expected — основной ожидаемый результат случая (expected.json).
func (c Case) Expected(t testing.TB) []byte {
	t.Helper()
	return c.Read(t, "expected.json")
}

// ReadFile читает файл домена вне каталогов случаев, например timing-validation/cases.json.
func ReadFile(t testing.TB, domain, name string) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(mustRoot(t), domain, name))
	if err != nil {
		t.Fatal(err)
	}
	return data
}

// ValidationCase — синтетический вход validateTiming с ожидаемым списком проблем. Тот же файл
// timing-validation/cases.json читает и тест интерфейса на TypeScript, поэтому timing и lyrics
// оставлены сырыми JSON.
type ValidationCase struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	// Tags помечают особые входы; null-number — граница null, не представимая числом Go.
	Tags  []string `json:"tags"`
	Input struct {
		Timing   json.RawMessage `json:"timing"`
		Lyrics   json.RawMessage `json:"lyrics"`
		Duration *float64        `json:"duration"`
	} `json:"input"`
	// Expected — проблемы в ожидаемом порядке; пустой список означает корректную разметку.
	Expected []string `json:"expected"`
}

// ValidationCases загружает эталоны validateTiming.
func ValidationCases(t testing.TB) []ValidationCase {
	t.Helper()
	var cases []ValidationCase
	if err := json.Unmarshal(ReadFile(t, "timing-validation", "cases.json"), &cases); err != nil {
		t.Fatalf("timing-validation/cases.json: %v", err)
	}
	if len(cases) == 0 {
		t.Fatal("timing-validation/cases.json пуст")
	}
	return cases
}

// projectTail захватывает путь после маркера до пробела, кавычки или «ёлочек» текста сообщения.
var projectTail = regexp.MustCompile(`<project>[^\s"«»]*`)

// NormalizePaths заменяет корень root во всех строках JSON маркером <project> и приводит разделители
// хвоста пути к «/», как в эталонах, записанных на Linux. Ключи и числа не меняются; результат — заново
// сериализованный JSON для семантического сравнения, а не исходные байты.
func NormalizePaths(data []byte, root string) ([]byte, error) {
	value, err := decode(data)
	if err != nil {
		return nil, err
	}
	roots := []string{filepath.Clean(root)}
	if slash := filepath.ToSlash(roots[0]); slash != roots[0] {
		roots = append(roots, slash)
	}
	value = mapStrings(value, func(text string) string {
		changed := false
		for _, item := range roots {
			if strings.Contains(text, item) {
				text = strings.ReplaceAll(text, item, ProjectMarker)
				changed = true
			}
		}
		if !changed {
			return text
		}
		return projectTail.ReplaceAllStringFunc(text, func(match string) string { return strings.ReplaceAll(match, `\`, "/") })
	})
	var out bytes.Buffer
	encoder := json.NewEncoder(&out)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(value); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

// Diff сравнивает два JSON как деревья: порядок ключей и пробелы не важны, числа равны по значению
// (30 и 30.0), а null, отсутствующий ключ и [] различаются. Возвращает до maxDiff различий с путями.
func Diff(want, got []byte) ([]string, error) {
	left, err := decode(want)
	if err != nil {
		return nil, fmt.Errorf("ожидаемый JSON: %w", err)
	}
	right, err := decode(got)
	if err != nil {
		return nil, fmt.Errorf("полученный JSON: %w", err)
	}
	var diffs []string
	compare("$", left, right, &diffs)
	return diffs, nil
}

// AssertJSON завершает тест с перечнем различий, если got не совпадает с эталоном want.
func AssertJSON(t testing.TB, want, got []byte) {
	t.Helper()
	diffs, err := Diff(want, got)
	if err != nil {
		t.Fatal(err)
	}
	if len(diffs) > 0 {
		t.Fatalf("результат отличается от эталона (%d):\n%s", len(diffs), strings.Join(diffs, "\n"))
	}
}

// AssertValue сериализует значение Go, нормализует пути относительно root и сравнивает с эталоном.
// Пустой root отключает нормализацию.
func AssertValue(t testing.TB, want []byte, got any, root string) {
	t.Helper()
	data, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	if root != "" {
		if data, err = NormalizePaths(data, root); err != nil {
			t.Fatal(err)
		}
	}
	AssertJSON(t, want, data)
}

// TreeDigest считает дайджест дерева без каталогов .git: SHA-256 от строк «<sha256>  <путь>\n» по
// всем обычным файлам в байтовом порядке путей с «/». Формат совпадает с
// `find . -path ./.git -prune -o -type f -print | sed 's|^\./||' | LC_ALL=C sort` + sha256sum, поэтому
// проверяет неизменность проекта до и после чтения.
func TreeDigest(root string) (string, error) {
	type entry struct{ path, digest string }
	var files []entry
	err := filepath.WalkDir(root, func(path string, item fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if item.IsDir() && item.Name() == ".git" {
			return filepath.SkipDir
		}
		if !item.Type().IsRegular() {
			return nil
		}
		digest, err := fileDigest(path)
		if err != nil {
			return err
		}
		local, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		files = append(files, entry{filepath.ToSlash(local), digest})
		return nil
	})
	if err != nil {
		return "", err
	}
	sort.Slice(files, func(i, j int) bool { return files[i].path < files[j].path })
	total := sha256.New()
	for _, file := range files {
		fmt.Fprintf(total, "%s  %s\n", file.digest, file.path)
	}
	return hex.EncodeToString(total.Sum(nil)), nil
}

// fileDigest читает файл потоком: в готовом клипе есть MP4 в сотни мегабайт.
func fileDigest(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	digest := sha256.New()
	if _, err := io.Copy(digest, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(digest.Sum(nil)), nil
}

// readJSON строго разбирает служебный JSON эталона.
func readJSON(path string, target any) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, target)
}

// decode разбирает JSON с json.Number, чтобы большие целые не теряли точность до сравнения.
func decode(data []byte) (any, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, err
	}
	if decoder.More() {
		return nil, errors.New("после JSON-значения есть лишние данные")
	}
	return value, nil
}

// mapStrings применяет change ко всем строковым значениям дерева, не трогая ключи.
func mapStrings(value any, change func(string) string) any {
	switch item := value.(type) {
	case string:
		return change(item)
	case []any:
		for index := range item {
			item[index] = mapStrings(item[index], change)
		}
		return item
	case map[string]any:
		for key, entry := range item {
			item[key] = mapStrings(entry, change)
		}
		return item
	default:
		return value
	}
}

// compare рекурсивно накапливает различия; путь записан в стиле JSONPath ($.checks.timing, $.lines[0]).
func compare(path string, want, got any, diffs *[]string) {
	if len(*diffs) >= maxDiff {
		return
	}
	add := func(format string, args ...any) {
		if len(*diffs) < maxDiff {
			*diffs = append(*diffs, path+": "+fmt.Sprintf(format, args...))
		}
	}
	switch left := want.(type) {
	case map[string]any:
		right, ok := got.(map[string]any)
		if !ok {
			add("ожидался объект, получено %s", brief(got))
			return
		}
		keys := make([]string, 0, len(left)+len(right))
		for key := range left {
			keys = append(keys, key)
		}
		for key := range right {
			if _, ok := left[key]; !ok {
				keys = append(keys, key)
			}
		}
		sort.Strings(keys)
		for _, key := range keys {
			child := path + "." + key
			leftValue, inLeft := left[key]
			rightValue, inRight := right[key]
			switch {
			case !inRight:
				*diffs = appendLimited(*diffs, child+": ключ отсутствует, ожидалось "+brief(leftValue))
			case !inLeft:
				*diffs = appendLimited(*diffs, child+": лишний ключ со значением "+brief(rightValue))
			default:
				compare(child, leftValue, rightValue, diffs)
			}
		}
	case []any:
		right, ok := got.([]any)
		if !ok {
			add("ожидался массив, получено %s", brief(got))
			return
		}
		if len(left) != len(right) {
			add("длина массива %d, ожидалось %d", len(right), len(left))
		}
		for index := 0; index < len(left) && index < len(right); index++ {
			compare(fmt.Sprintf("%s[%d]", path, index), left[index], right[index], diffs)
		}
	case json.Number:
		right, ok := got.(json.Number)
		if !ok || !sameNumber(left, right) {
			add("ожидалось %s, получено %s", left, brief(got))
		}
	default:
		if want != got {
			add("ожидалось %s, получено %s", brief(want), brief(got))
		}
	}
}

// appendLimited добавляет различие, пока не достигнут предел сообщения.
func appendLimited(diffs []string, text string) []string {
	if len(diffs) >= maxDiff {
		return diffs
	}
	return append(diffs, text)
}

// sameNumber сравнивает числа JSON точно по значению: «8», «8.0» и «8e0» равны.
func sameNumber(left, right json.Number) bool {
	if left == right {
		return true
	}
	a, okA := new(big.Rat).SetString(string(left))
	b, okB := new(big.Rat).SetString(string(right))
	return okA && okB && a.Cmp(b) == 0
}

// brief печатает значение для сообщения о различии, обрезая длинные фрагменты.
func brief(value any) string {
	if value == nil {
		return "null"
	}
	data, err := json.Marshal(value)
	if err != nil {
		return fmt.Sprint(value)
	}
	text := string(data)
	if len([]rune(text)) > 160 {
		text = string([]rune(text)[:160]) + "…"
	}
	return text
}

// copyTree копирует обычные файлы и каталоги входа; ссылок и особых файлов в эталонах нет.
func copyTree(from, to string) error {
	return filepath.WalkDir(from, func(path string, item fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		local, err := filepath.Rel(from, path)
		if err != nil {
			return err
		}
		target := filepath.Join(to, local)
		if item.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		if !item.Type().IsRegular() {
			return fmt.Errorf("неожиданный тип файла %s", path)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(target, data, 0o644)
	})
}
