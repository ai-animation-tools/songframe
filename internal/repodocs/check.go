// Package repodocs проверяет, что документация репозитория не разошлась с кодом, и генерирует
// карту кода docs/code-map.md.
//
// Проверка ссылок (Check) читает Markdown-файлы репозитория и находит утверждения, которые можно
// сверить механически: относительные ссылки и якоря, пути к файлам в `обратных кавычках`,
// переменные окружения SONGFRAME_*, задачи `wails3 task` и скрипты `yarn`. CheckSources и Check
// также не пускают упоминания прежней версии приложения за пределы раздела «История» README.
// Смысл текста проверка не понимает: устаревшее описание процесса ловит ревизия перед выпуском.
//
// Карта кода (RenderCodeMap) собирается из таблицы областей areas.go и первых предложений
// комментариев `// Package`; тест требует, чтобы каждый Go-пакет и каждая страница интерфейса
// принадлежали ровно одной области, а закоммиченная карта совпадала со сгенерированной.
//
// Пакет работает только со стандартной библиотекой и файловой системой: он не требует CGO, Git
// и сети, поэтому его тесты идут и в общем `go test ./...`, и в отдельном лёгком CI-задании для
// изменений только документации.
package repodocs

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"unicode"
)

// Problem — одно найденное расхождение: файл и строка документа (пути от корня репозитория,
// разделитель `/`) и понятное описание.
type Problem struct {
	File string
	Line int
	Text string
}

func (p Problem) String() string { return fmt.Sprintf("%s:%d: %s", p.File, p.Line, p.Text) }

// skippedDirs не обходятся: зависимости, результаты сборки и каталоги инструментов.
var skippedDirs = map[string]bool{
	".git": true, "node_modules": true, "build": true, "dist": true,
	"storybook-static": true, "test-results": true, "playwright-report": true, "bindings": true,
	// .agents и .claude содержат только символьные ссылки на dev-skills/.
	".agents": true, ".claude": true,
}

// embeddedDoc сообщает, что Markdown-файл — встроенное содержимое продукта, а не документация
// репозитория: промпты агента (resources/skills), документы провайдеров (resources/providers/<вид>)
// и шаблон проекта (resources/templates). Их байты входят в промпты и папку клипа, сверяются
// resources_test.go и эталонами, а пути и ссылки в них отсчитываются от папки клипа. Правка такого
// файла меняет результат программы, поэтому проверка о них молчит.
func embeddedDoc(rel string) bool {
	switch {
	case strings.HasPrefix(rel, "resources/templates/"):
		return true
	case strings.HasPrefix(rel, "resources/skills/"), strings.HasPrefix(rel, "resources/providers/"):
		return path.Base(rel) != "README.md" || strings.Count(rel, "/") > 2
	}
	return false
}

// checkedDoc сообщает, проверяется ли Markdown-файл. Кроме встроенного содержимого пропускаются
// входы эталонов (`testdata/golden/<домен>/<случай>/...`) и fixtures — данные тестов, в которых
// битые ссылки бывают намеренными.
func checkedDoc(rel string) bool {
	if embeddedDoc(rel) || strings.HasPrefix(rel, "testdata/") && strings.Count(rel, "/") > 2 {
		return false
	}
	return !strings.Contains(rel, "/fixtures/") && !strings.Contains(rel, "/testdata/")
}

// markdownFiles возвращает проверяемые Markdown-файлы репозитория в порядке путей.
func markdownFiles(root string) ([]string, error) {
	var files []string
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if p != root && skippedDirs[d.Name()] {
				return filepath.SkipDir
			}
			return nil
		}
		if d.Type()&fs.ModeSymlink != 0 || !strings.HasSuffix(d.Name(), ".md") {
			return nil
		}
		rel, err := filepath.Rel(root, p)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		if checkedDoc(rel) {
			files = append(files, rel)
		}
		return nil
	})
	sort.Strings(files)
	return files, err
}

// docLine — строка документа с номером. fence отмечает содержимое блоков ``` и ~~~: в них
// команды, примеры вывода и схемы, поэтому ссылки и пути там не проверяются, а команды и
// переменные окружения — проверяются.
type docLine struct {
	n     int
	text  string
	fence bool
}

// readDoc читает документ построчно и отмечает строки внутри блоков кода.
func readDoc(file string) ([]docLine, error) {
	f, err := os.Open(file)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var lines []docLine
	fence := ""
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1024*1024), 16*1024*1024)
	for n := 1; sc.Scan(); n++ {
		t := sc.Text()
		trim := strings.TrimLeft(t, " \t>")
		if fence != "" {
			if strings.HasPrefix(trim, fence) {
				fence = ""
			} else {
				lines = append(lines, docLine{n, t, true})
			}
			continue
		}
		if strings.HasPrefix(trim, "```") || strings.HasPrefix(trim, "~~~") {
			fence = trim[:3]
			continue
		}
		lines = append(lines, docLine{n, t, false})
	}
	return lines, sc.Err()
}

var (
	inlineCode   = regexp.MustCompile("`([^`]+)`")
	mdLink       = regexp.MustCompile(`!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)`)
	refLink      = regexp.MustCompile(`^\s{0,3}\[[^\]]+\]:\s+(\S+)`)
	htmlAnchor   = regexp.MustCompile(`<a\s+(?:id|name)="([^"]+)"`)
	headingLine  = regexp.MustCompile(`^#{1,6}\s+(.*?)\s*#*\s*$`)
	envVar       = regexp.MustCompile(`\bSONGFRAME_[A-Z0-9_]*[A-Z0-9]\b`)
	taskCommand  = regexp.MustCompile(`\bwails3 task ([a-z][a-z0-9:_-]*)`)
	yarnCommand  = regexp.MustCompile(`\byarn ([a-z][a-z0-9:_-]*)`)
	repoPathSpan = regexp.MustCompile(`^(?:\.\./)*(?:internal|frontend|scripts|packaging|resources|testdata|docs|dev-skills|www|\.github)/\S*$`)
	taskfileKey  = regexp.MustCompile(`^  ([a-z][a-z0-9:_-]*):\s*$`)
)

// yarnBuiltins — команды самого Yarn, которые не являются скриптами package.json.
var yarnBuiltins = map[string]bool{
	"install": true, "add": true, "remove": true, "up": true, "dlx": true, "exec": true,
	"run": true, "why": true, "info": true, "workspaces": true, "config": true, "set": true,
	"npm": true, "cache": true, "dedupe": true, "node": true, "version": true, "init": true,
}

// historyMarker находит следы прежней версии приложения: её стек и инструменты, прежние имена
// модуля и переменных. История проекта живёт только в разделе «История» корневого README
// (правило AGENTS.md «Документация и код»): в остальных документах, коде, комментариях и
// эталонах текст описывает то, что есть сейчас.
var historyMarker = regexp.MustCompile(`Electron|634fd94|Python|python3|\.py\b|__pycache__|songframe-go|SONGFRAME_GO_|Go-верси|src/main/`)

// historySection — заголовок раздела README, где история разрешена.
const historySection = "## История"

// generatedOutputs — результаты сборки, которых нет в исходниках, но на которые законно
// ссылаются руководства.
var generatedOutputs = []string{"frontend/dist", "frontend/storybook-static", "frontend/bindings"}

// generatedPath сообщает, что путь указывает внутрь результата сборки.
func generatedPath(p string) bool {
	for _, g := range generatedOutputs {
		if p == g || strings.HasPrefix(p, g+"/") {
			return true
		}
	}
	return false
}

// stripCode убирает из строки inline-код, чтобы ссылки внутри примеров не проверялись.
func stripCode(s string) string { return inlineCode.ReplaceAllString(s, "``") }

// slug повторяет правило якорей заголовков GitHub: нижний регистр, удаление знаков препинания
// (кроме дефиса и подчёркивания), пробелы — в дефисы. Кириллица сохраняется.
func slug(heading string) string {
	// Ссылки в заголовке дают якорь по своему тексту.
	heading = regexp.MustCompile(`\[([^\]]*)\]\([^)]*\)`).ReplaceAllString(heading, "$1")
	var b strings.Builder
	for _, r := range strings.ToLower(heading) {
		switch {
		case r == ' ':
			b.WriteRune('-')
		case r == '-' || r == '_' || unicode.IsLetter(r) || unicode.IsDigit(r) || unicode.Is(unicode.Mn, r):
			b.WriteRune(r)
		}
	}
	return b.String()
}

// anchorIndex кэширует якоря Markdown-файлов: заголовки с суффиксами повторов и явные <a id>.
type anchorIndex map[string]map[string]bool

func (idx anchorIndex) anchors(file string) map[string]bool {
	if a, ok := idx[file]; ok {
		return a
	}
	a := map[string]bool{}
	idx[file] = a
	lines, err := readDoc(file)
	if err != nil {
		return a
	}
	seen := map[string]int{}
	for _, l := range lines {
		if l.fence {
			continue
		}
		for _, m := range htmlAnchor.FindAllStringSubmatch(l.text, -1) {
			a[m[1]] = true
		}
		h := headingLine.FindStringSubmatch(l.text)
		if h == nil {
			continue
		}
		s := slug(h[1])
		if k := seen[s]; k > 0 {
			a[fmt.Sprintf("%s-%d", s, k)] = true
		} else {
			a[s] = true
		}
		seen[s]++
	}
	return a
}

// sourceIndex — множество переменных SONGFRAME_*, которые встречаются в исходниках (не в
// Markdown): Go, TypeScript, скрипты, CI и рецепты поставок.
func sourceIndex(root string) (map[string]bool, error) {
	vars := map[string]bool{}
	exts := map[string]bool{
		".go": true, ".ts": true, ".tsx": true, ".js": true, ".mjs": true, ".sh": true,
		".yml": true, ".yaml": true, ".json": true, ".nsi": true, ".nsh": true,
		".cmd": true, ".ps1": true, "": true,
	}
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if p != root && (skippedDirs[d.Name()] && d.Name() != "bindings" || d.Name() == "golden") {
				return filepath.SkipDir
			}
			return nil
		}
		if d.Type()&fs.ModeSymlink != 0 || !exts[filepath.Ext(d.Name())] {
			return nil
		}
		data, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		for _, v := range envVar.FindAll(data, -1) {
			vars[string(v)] = true
		}
		return nil
	})
	return vars, err
}

// taskNames читает имена задач из Taskfile.yml (ключи второго уровня в разделе tasks).
func taskNames(root string) (map[string]bool, error) {
	data, err := os.ReadFile(filepath.Join(root, "Taskfile.yml"))
	if err != nil {
		return nil, err
	}
	names := map[string]bool{}
	for _, l := range strings.Split(string(data), "\n") {
		if m := taskfileKey.FindStringSubmatch(l); m != nil {
			names[m[1]] = true
		}
	}
	return names, nil
}

// yarnScripts читает из frontend/package.json имена скриптов и программ зависимостей, которые
// `yarn <имя>` тоже запускает: `vitest` из пакета vitest, `playwright` из @playwright/test.
// Имя программы берётся из имени пакета и его области: этого достаточно для зависимостей проекта.
func yarnScripts(root string) (map[string]bool, error) {
	data, err := os.ReadFile(filepath.Join(root, "frontend", "package.json"))
	if err != nil {
		return nil, err
	}
	var pkg struct {
		Scripts         map[string]string `json:"scripts"`
		Dependencies    map[string]string `json:"dependencies"`
		DevDependencies map[string]string `json:"devDependencies"`
	}
	if err := json.Unmarshal(data, &pkg); err != nil {
		return nil, fmt.Errorf("frontend/package.json: %w", err)
	}
	names := map[string]bool{}
	for name := range pkg.Scripts {
		names[name] = true
	}
	for _, deps := range []map[string]string{pkg.Dependencies, pkg.DevDependencies} {
		for dep := range deps {
			scope, name, scoped := strings.Cut(strings.TrimPrefix(dep, "@"), "/")
			if scoped {
				names[scope] = true
				names[name] = true
			} else {
				names[dep] = true
			}
		}
	}
	return names, nil
}

// exists проверяет путь относительно корня репозитория, а затем относительно папки документа.
func exists(root, docDir, p string) bool {
	for _, base := range []string{root, filepath.Join(root, docDir)} {
		if _, err := os.Stat(filepath.Join(base, filepath.FromSlash(p))); err == nil {
			return true
		}
	}
	return false
}

// placeholder сообщает, что путь — шаблон (`providers/<id>/`, `*.md`, `{a,b}`), а не файл.
func placeholder(p string) bool { return strings.ContainsAny(p, "<>*{}…|$[]") }

// Check находит механически проверяемые расхождения документации с репозиторием root.
func Check(root string) ([]Problem, error) {
	files, err := markdownFiles(root)
	if err != nil {
		return nil, err
	}
	vars, err := sourceIndex(root)
	if err != nil {
		return nil, err
	}
	tasks, err := taskNames(root)
	if err != nil {
		return nil, err
	}
	scripts, err := yarnScripts(root)
	if err != nil {
		return nil, err
	}
	idx := anchorIndex{}
	var problems []Problem
	for _, rel := range files {
		abs := filepath.Join(root, filepath.FromSlash(rel))
		lines, err := readDoc(abs)
		if err != nil {
			return nil, err
		}
		dir := path.Dir(rel)
		inHistory := false
		for _, l := range lines {
			add := func(format string, args ...any) {
				problems = append(problems, Problem{rel, l.n, fmt.Sprintf(format, args...)})
			}
			if !l.fence && strings.HasPrefix(l.text, "## ") {
				inHistory = rel == "README.md" && strings.TrimSpace(l.text) == historySection
			}
			if !inHistory && historyMarker.MatchString(l.text) {
				add("упоминание прежней версии: история — только в разделе «История» README")
			}
			var targets []string
			plain := stripCode(l.text)
			if l.fence {
				plain = ""
			}
			for _, m := range mdLink.FindAllStringSubmatch(plain, -1) {
				targets = append(targets, m[1])
			}
			if m := refLink.FindStringSubmatch(plain); m != nil {
				targets = append(targets, m[1])
			}
			for _, t := range targets {
				checkLink(root, rel, dir, t, idx, add)
			}
			for _, v := range envVar.FindAllString(l.text, -1) {
				if !vars[v] {
					add("переменная %s не встречается в исходниках", v)
				}
			}
			for _, m := range taskCommand.FindAllStringSubmatch(l.text, -1) {
				if !tasks[m[1]] {
					add("задачи `wails3 task %s` нет в Taskfile.yml", m[1])
				}
			}
			for _, m := range yarnCommand.FindAllStringSubmatch(l.text, -1) {
				if !yarnBuiltins[m[1]] && !scripts[m[1]] {
					add("скрипта `yarn %s` нет в frontend/package.json", m[1])
				}
			}
			if l.fence {
				continue
			}
			for _, m := range inlineCode.FindAllStringSubmatch(l.text, -1) {
				p := strings.TrimSpace(m[1])
				if !repoPathSpan.MatchString(p) || placeholder(p) || generatedPath(p) {
					continue
				}
				p = regexp.MustCompile(`(:\d+(-\d+)?|#.*)$`).ReplaceAllString(p, "")
				if !exists(root, dir, p) {
					add("путь `%s` не существует", p)
				}
			}
		}
	}
	return problems, nil
}

// checkLink проверяет одну ссылку документа rel: внешние адреса пропускаются, относительный путь
// должен существовать, якорь — быть заголовком или <a id> целевого Markdown-файла.
func checkLink(root, rel, dir, target string, idx anchorIndex, add func(string, ...any)) {
	if strings.Contains(target, "://") || strings.HasPrefix(target, "mailto:") {
		return
	}
	file, anchor, _ := strings.Cut(target, "#")
	file, err := url.PathUnescape(file)
	if err != nil {
		add("ссылка %q не разбирается", target)
		return
	}
	targetRel := rel
	if file != "" {
		if strings.HasPrefix(file, "/") {
			add("ссылка %q абсолютная: нужна относительная", target)
			return
		}
		targetRel = path.Clean(path.Join(dir, file))
		if strings.HasPrefix(targetRel, "../") {
			// Ссылки на соседние репозитории рабочей области (например, ../spec) в Git не
			// проверить: их нет в checkout CI.
			return
		}
		if _, err := os.Stat(filepath.Join(root, filepath.FromSlash(targetRel))); err != nil {
			add("ссылка на несуществующий %s", targetRel)
			return
		}
	}
	if anchor == "" || !strings.HasSuffix(targetRel, ".md") {
		return
	}
	anchor, _ = url.PathUnescape(anchor)
	if !idx.anchors(filepath.Join(root, filepath.FromSlash(targetRel)))[strings.ToLower(anchor)] {
		add("в %s нет якоря #%s", targetRel, anchor)
	}
}

// sourceExts — расширения текстовых файлов, которые проверяет CheckSources: исходники, рецепты
// и данные эталонов.
var sourceExts = map[string]bool{
	".go": true, ".ts": true, ".tsx": true, ".js": true, ".mjs": true, ".sh": true,
	".yml": true, ".yaml": true, ".nsi": true, ".nsh": true, ".css": true, ".html": true,
	".json": true, ".txt": true,
}

// CheckSources находит следы прежней версии в исходниках, рецептах и эталонах репозитория, а
// также файлы на языке прежних инструментов (*.py). Сгенерированные bindings и сам пакет
// repodocs, где задано правило, не проверяются.
func CheckSources(root string) ([]Problem, error) {
	var problems []Problem
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(root, p)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		if d.IsDir() {
			if p != root && (skippedDirs[d.Name()] || rel == "internal/repodocs") {
				return filepath.SkipDir
			}
			return nil
		}
		if filepath.Ext(d.Name()) == ".py" {
			problems = append(problems, Problem{rel, 0, "файл прежних инструментов: сборка и проверки пишутся на Go"})
			return nil
		}
		if d.Type()&fs.ModeSymlink != 0 || !sourceExts[filepath.Ext(d.Name())] && d.Name() != "Taskfile.yml" {
			return nil
		}
		data, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		for n, line := range strings.Split(string(data), "\n") {
			if historyMarker.MatchString(line) {
				problems = append(problems, Problem{rel, n + 1, "упоминание прежней версии: история — только в разделе «История» README"})
			}
		}
		return nil
	})
	return problems, err
}
