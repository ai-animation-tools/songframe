// Package scenario проигрывает сценарии эталонов платной попытки (домены media-request и
// cost-check в testdata/golden) на Go-переносе и сравнивает каждый шаг с оригиналом.
//
// Сценарий снят capture-45a.py с CLI оригинала: шаги — вызовы media_request.py или cost_check.py
// над каталогом случая <case> с папками project/ (клип), service/ (конфигурация и файлы тестового
// сервиса internal/mediatest), state/ (каталог состояния) и tmp/ (временная папка ОС). Перед шагом
// применяются правки конфигурации сервиса и файлов, после — сравниваются код, stdout, stderr, новые
// строки журнала вызовов сервиса и всё дерево файлов (*.json — нормализованным текстом, прочие —
// SHA-256). Пути в эталоне заменены маркерами <project>, <service>, <state>, <tmp>; время —
// <time>, UUID — <uuidN> по порядку первого появления (stdout, stderr, журнал, дерево).
//
// Пакет отдельный от internal/mediatest, чтобы тестовый провайдер не тянул пакет testing.
// Сам вызов инструмента и внесение сбоев (замок, обрыв процесса) выполняет Runner теста пакета,
// которому доступны внутренние точки сбоев.
package scenario

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"

	"songframe-go/internal/golden"
	"songframe-go/internal/mediaadapters"
	"songframe-go/internal/mediatest"
	"songframe-go/internal/pycompat"
	"songframe-go/internal/pytool"
)

// markers — папки каталога случая и маркеры их путей в эталоне.
var markers = []string{"project", "service", "state", "tmp"}

var (
	timePattern = regexp.MustCompile(`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z`)
	uuidPattern = regexp.MustCompile(`[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}`)
)

// File — содержимое файла эталона: текст UTF-8 либо hex для двоичных данных.
type File struct {
	Text *string `json:"text"`
	Hex  *string `json:"hex"`
}

// Bytes — байты файла.
func (f File) Bytes() ([]byte, error) {
	if f.Hex != nil {
		return hex.DecodeString(*f.Hex)
	}
	if f.Text == nil {
		return nil, fmt.Errorf("файл эталона без text и hex")
	}
	return []byte(*f.Text), nil
}

// Step — один вызов инструмента и подготовка перед ним.
type Step struct {
	// Tool — media_request или cost_check.
	Tool string `json:"tool"`
	// Args — аргументы командной строки с маркерами путей (без --project).
	Args []string `json:"args"`
	// Project — вызов с проектом <project>; false — действие без проекта (вход к провайдеру).
	Project bool `json:"project"`
	// Configure — поля, дописываемые в конфигурацию тестового сервиса (JSON-текст значений).
	Configure map[string]json.RawMessage `json:"configure"`
	// Write — файлы, записываемые перед шагом (пути относительно каталога случая).
	Write map[string]File `json:"write"`
	// Remove — файлы и пустые каталоги, удаляемые перед шагом, по порядку.
	Remove []string `json:"remove"`
	// Mkdir — пустые каталоги, создаваемые перед шагом.
	Mkdir []string `json:"mkdir"`
	// Fault — сбой шага: lock:<папка>, interrupt_on_downloads, interrupt_before_link:<имя>.
	Fault string `json:"fault"`
}

// Outcome — снятый результат шага.
type Outcome struct {
	Code        int               `json:"code"`
	Stdout      string            `json:"stdout"`
	Stderr      string            `json:"stderr"`
	Traceback   bool              `json:"traceback"`
	Interrupted bool              `json:"interrupted"`
	Calls       []string          `json:"calls"`
	Tree        map[string]string `json:"tree"`
	Dirs        []string          `json:"dirs"`
}

// Scenario — один случай домена.
type Scenario struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Covers      []string        `json:"covers"`
	Files       map[string]File `json:"files"`
	Steps       []Step          `json:"steps"`
	Expected    []Outcome       `json:"expected"`
}

// Load читает cases.json домена.
func Load(t testing.TB, domain string) []Scenario {
	t.Helper()
	root, err := golden.Root()
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(root, domain, "cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var scenarios []Scenario
	if err := json.Unmarshal(data, &scenarios); err != nil {
		t.Fatal(err)
	}
	if len(scenarios) == 0 {
		t.Fatalf("в домене %s нет случаев", domain)
	}
	return scenarios
}

// Env — каталог случая во время проигрывания.
type Env struct {
	// Root — каталог случая (без символических ссылок, как Path.resolve() съёмки).
	Root string
	// Service — тестовый сервис в <case>/service.
	Service *mediatest.Service
}

// Path — каталог маркера: project, service, state или tmp.
func (e *Env) Path(marker string) string { return filepath.Join(e.Root, marker) }

// Real заменяет маркеры путей настоящими путями каталога случая.
func (e *Env) Real(text string) string {
	for _, marker := range markers {
		text = strings.ReplaceAll(text, "<"+marker+">", e.Path(marker))
	}
	return text
}

// Register подключает тестовый сервис под id test так, как его видит процесс съёмки: функции
// входа есть, только если их ответы заданы в конфигурации. Возвращает отмену регистрации.
func (e *Env) Register() func() {
	config := e.Service.Config()
	if config.Has("login") || config.Has("auth_status") {
		return registerAuth(e.Service)
	}
	return e.Service.Register()
}

// registerAuth подключает вариант сервиса с функциями входа.
func registerAuth(service *mediatest.Service) func() {
	return mediaadapters.Register(mediatest.ID, mediatest.WithAuth{Service: service})
}

// Runner выполняет шаг: инструмент step.Tool с аргументами args (маркеры уже заменены).
// interrupted — шаг прерван внесённым сбоем (как KeyboardInterrupt процесса съёмки).
type Runner func(t *testing.T, env *Env, step Step, args []string) (output pytool.Output, interrupted bool)

// Play проигрывает все сценарии домена подтестами.
func Play(t *testing.T, domain string, run Runner) {
	for _, item := range Load(t, domain) {
		t.Run(item.Name, func(t *testing.T) { item.Play(t, run) })
	}
}

// Play проигрывает сценарий в новом каталоге случая. TMPDIR указывает на <case>/tmp: временная
// папка ОС входит в разрешённые рабочие папки попытки.
func (s Scenario) Play(t *testing.T, run Runner) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for _, marker := range markers {
		if err := os.MkdirAll(filepath.Join(root, marker), 0o777); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("TMPDIR", filepath.Join(root, "tmp"))
	names := make([]string, 0, len(s.Files))
	for name := range s.Files {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		writeFile(t, root, name, s.Files[name])
	}
	env := &Env{Root: root, Service: &mediatest.Service{Dir: filepath.Join(root, "service")}}
	if _, err := os.Stat(filepath.Join(root, "service", "service.json")); err != nil {
		t.Fatal(err)
	}
	normalizer := &normalizer{env: env, uuids: map[string]string{}}
	seen := 0
	if len(s.Steps) != len(s.Expected) {
		t.Fatalf("шагов %d, результатов %d", len(s.Steps), len(s.Expected))
	}
	for index, step := range s.Steps {
		prepare(t, env, step)
		args := make([]string, len(step.Args))
		for position, arg := range step.Args {
			args[position] = env.Real(arg)
		}
		output, interrupted := run(t, env, step, args)
		want := s.Expected[index]
		label := fmt.Sprintf("шаг %d %s %v", index, step.Tool, step.Args)
		got := Outcome{Interrupted: interrupted}
		if !interrupted {
			got.Code = output.Code
			got.Stdout = normalizer.text(output.Stdout)
			got.Stderr = output.Stderr
			got.Traceback = strings.HasPrefix(output.Stderr, "Traceback (most recent call last):")
			if got.Traceback {
				// Как в эталоне: сравнивается строка исключения, а не кадры трассировки.
				lines := strings.Split(strings.TrimRight(output.Stderr, "\n"), "\n")
				got.Stderr = lines[len(lines)-1] + "\n"
			}
			got.Stderr = normalizer.text(got.Stderr)
		}
		calls := readCalls(t, env)
		for _, line := range calls[seen:] {
			got.Calls = append(got.Calls, normalizer.text(line))
		}
		seen = len(calls)
		got.Tree, got.Dirs = tree(t, root, normalizer)
		compare(t, label, want, got)
		if t.Failed() {
			return
		}
	}
}

// prepare применяет подготовку шага: конфигурацию сервиса и правки файлов.
func prepare(t *testing.T, env *Env, step Step) {
	t.Helper()
	if len(step.Configure) > 0 {
		keys := make([]string, 0, len(step.Configure))
		for key := range step.Configure {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		values := pycompat.NewDict()
		for _, key := range keys {
			value, err := pycompat.LoadsJSON(string(step.Configure[key]))
			if err != nil {
				t.Fatal(err)
			}
			values.Set(key, value)
		}
		if err := env.Service.Configure(values); err != nil {
			t.Fatal(err)
		}
	}
	for _, name := range step.Remove {
		if err := os.Remove(filepath.Join(env.Root, filepath.FromSlash(name))); err != nil {
			t.Fatal(err)
		}
	}
	for _, name := range step.Mkdir {
		if err := os.MkdirAll(filepath.Join(env.Root, filepath.FromSlash(name)), 0o777); err != nil {
			t.Fatal(err)
		}
	}
	names := make([]string, 0, len(step.Write))
	for name := range step.Write {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		writeFile(t, env.Root, name, step.Write[name])
	}
}

func writeFile(t *testing.T, root, name string, file File) {
	t.Helper()
	data, err := file.Bytes()
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, filepath.FromSlash(name))
	if err := os.MkdirAll(filepath.Dir(path), 0o777); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o666); err != nil {
		t.Fatal(err)
	}
}

// readCalls — строки журнала вызовов тестового сервиса.
func readCalls(t *testing.T, env *Env) []string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(env.Path("service"), "calls.jsonl"))
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		t.Fatal(err)
	}
	text := strings.TrimSuffix(string(data), "\n")
	if text == "" {
		return nil
	}
	return strings.Split(text, "\n")
}

// normalizer — нормализация текста съёмки: маркеры путей, время и UUID одного сценария.
type normalizer struct {
	env   *Env
	uuids map[string]string
}

func (n *normalizer) text(text string) string {
	for _, marker := range markers {
		text = strings.ReplaceAll(text, n.env.Path(marker), "<"+marker+">")
	}
	text = timePattern.ReplaceAllString(text, "<time>")
	return uuidPattern.ReplaceAllStringFunc(text, func(value string) string {
		if _, ok := n.uuids[value]; !ok {
			n.uuids[value] = fmt.Sprintf("<uuid%d>", len(n.uuids)+1)
		}
		return n.uuids[value]
	})
}

// tree — дерево каталога случая без конфигурации и журнала сервиса: файлы (*.json — текстом,
// прочие — SHA-256) и каталоги, в порядке путей как sorted(rglob) съёмки по каждому маркеру.
func tree(t *testing.T, root string, n *normalizer) (map[string]string, []string) {
	t.Helper()
	files := map[string]string{}
	dirs := []string{}
	var paths []string
	for _, marker := range markers {
		base := filepath.Join(root, marker)
		var own []string
		err := filepath.WalkDir(base, func(path string, entry fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if path != base {
				own = append(own, path)
			}
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
		// sorted(rglob) съёмки сравнивает пути строками: «a.json» раньше «a/b».
		sort.Strings(own)
		paths = append(paths, own...)
	}
	for _, path := range paths {
		relative, _ := filepath.Rel(root, path)
		relative = filepath.ToSlash(relative)
		if relative == "service/service.json" || relative == "service/calls.jsonl" {
			continue
		}
		info, err := os.Lstat(path)
		if err != nil {
			t.Fatal(err)
		}
		if info.IsDir() {
			dirs = append(dirs, relative)
			continue
		}
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if strings.HasSuffix(relative, ".json") {
			files[relative] = n.text(string(data))
		} else {
			sum := sha256.Sum256(data)
			files[relative] = "sha256:" + hex.EncodeToString(sum[:])
		}
	}
	sort.Strings(dirs)
	return files, dirs
}

// compare сверяет шаг с эталоном; у прерванного шага — только дерево и журнал.
func compare(t *testing.T, label string, want, got Outcome) {
	t.Helper()
	if want.Interrupted != got.Interrupted {
		t.Fatalf("%s: прерван %v, ожидалось %v (код %d, stderr %q)", label, got.Interrupted, want.Interrupted, got.Code, got.Stderr)
	}
	if !want.Interrupted {
		if want.Code != got.Code {
			t.Errorf("%s: код %d, ожидался %d", label, got.Code, want.Code)
		}
		if want.Stdout != got.Stdout {
			t.Errorf("%s: stdout\n%s\nожидался\n%s", label, got.Stdout, want.Stdout)
		}
		if want.Stderr != got.Stderr || want.Traceback != got.Traceback {
			t.Errorf("%s: stderr (трассировка %v)\n%s\nожидался (трассировка %v)\n%s", label, got.Traceback, got.Stderr, want.Traceback, want.Stderr)
		}
	}
	if strings.Join(want.Calls, "\n") != strings.Join(got.Calls, "\n") {
		t.Errorf("%s: вызовы сервиса\n%s\nожидались\n%s", label, strings.Join(got.Calls, "\n"), strings.Join(want.Calls, "\n"))
	}
	if strings.Join(want.Dirs, "\n") != strings.Join(got.Dirs, "\n") {
		t.Errorf("%s: каталоги %v, ожидались %v", label, got.Dirs, want.Dirs)
	}
	names := map[string]bool{}
	for name := range want.Tree {
		names[name] = true
	}
	for name := range got.Tree {
		names[name] = true
	}
	sorted := make([]string, 0, len(names))
	for name := range names {
		sorted = append(sorted, name)
	}
	sort.Strings(sorted)
	for _, name := range sorted {
		wantFile, inWant := want.Tree[name]
		gotFile, inGot := got.Tree[name]
		switch {
		case !inGot:
			t.Errorf("%s: нет файла %s", label, name)
		case !inWant:
			t.Errorf("%s: лишний файл %s", label, name)
		case wantFile != gotFile:
			t.Errorf("%s: файл %s\n%s\nожидался\n%s", label, name, gotFile, wantFile)
		}
	}
}
