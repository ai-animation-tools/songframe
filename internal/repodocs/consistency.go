package repodocs

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// Сверка значений, которые записаны и в коде, и в документах: размер окна приложения и названия
// проверок страницы «Проверки». Ссылки и пути Check сверяет по файлам, а эти значения — просто
// текст: после переименования в коде документы молча остаются с прежними словами. Источник истины —
// код (main.go и тексты проверок), документы и README шаблона проекта должны совпадать с ним.

var (
	// windowGeometry — геометрия окна в main.go: стартовый и минимальный размер.
	windowGeometry = regexp.MustCompile(`Width:\s*([0-9]+),\s*Height:\s*([0-9]+),\s*MinWidth:\s*([0-9]+),\s*MinHeight:\s*([0-9]+)`)
	// viewportSize — размер окна проектов Playwright.
	viewportSize = regexp.MustCompile(`viewport:\s*\{\s*width:\s*([0-9]+),\s*height:\s*([0-9]+)\s*\}`)
	// windowMention — размер, названный в тексте рядом со словами «минимальный», «стартовый»,
	// «обязательный» или «окно/окне/окна». Окончание после «окн» проверяется отдельно: «окном
	// плана, кадром 1920×1080» говорит о кадре видео, а не об окне приложения.
	windowMention = regexp.MustCompile(`(?i)(минимальн[а-яё]*|стартов[а-яё]*|обязательн[а-яё]*|окн[оеа](?:[^а-яё.;]|$))[^0-9.;]{0,40}?([0-9]{3,4})×([0-9]{3,4})`)
	// checkLabelTS, checkLabelGo — названия проверок в текстах renderer и Go.
	checkLabelTS = regexp.MustCompile(`^\s*([a-zA-Z]+)Label:\s*'([^']+)',`)
	checkLabelGo = regexp.MustCompile(`^\s*text([A-Za-z]+)Label\s*=\s*"([^"]+)"`)
	// checkMention — названия проверок в тексте: «проверка «X», «Y» и «Z»», «в строке «X» на
	// странице «Проверки»» и ««Проверки» → «X»». Название проверки начинается с заглавной буквы:
	// «проверки «на всякий случай»» — обычная речь.
	checkList    = regexp.MustCompile(`проверк[а-яё]*\s+((?:«[А-ЯЁ][^»]*»(?:,\s*|\s+и\s+)?)+)`)
	checkRow     = regexp.MustCompile(`строке\s+«([^»]+)»\s+на\s+странице\s+«Проверки»`)
	checkArrow   = regexp.MustCompile(`«Проверки»\s*→\s*«([^»]+)»`)
	quotedPhrase = regexp.MustCompile(`«([^»]+)»`)
)

// windowSize — стартовый и минимальный размер окна из main.go; они обязаны совпадать.
func windowSize(root string) (string, error) {
	data, err := os.ReadFile(filepath.Join(root, "main.go"))
	if err != nil {
		return "", err
	}
	m := windowGeometry.FindSubmatch(data)
	if m == nil {
		return "", fmt.Errorf("main.go: не найдена геометрия окна Width/Height/MinWidth/MinHeight")
	}
	if string(m[1]) != string(m[3]) || string(m[2]) != string(m[4]) {
		return "", fmt.Errorf("main.go: стартовый размер %s×%s не совпадает с минимальным %s×%s", m[1], m[2], m[3], m[4])
	}
	return string(m[1]) + "×" + string(m[2]), nil
}

// checkLabels — названия проверок renderer (frontend/src/shared/texts/checks.ts) и Go
// (internal/checks/texts.go) по ключу; наборы должны совпадать.
func checkLabels(root string) (map[string]bool, []Problem, error) {
	read := func(rel string, pattern *regexp.Regexp) (map[string]string, error) {
		data, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(rel)))
		if err != nil {
			return nil, err
		}
		labels := map[string]string{}
		for _, line := range strings.Split(string(data), "\n") {
			if m := pattern.FindStringSubmatch(line); m != nil {
				labels[strings.ToLower(m[1])] = m[2]
			}
		}
		return labels, nil
	}
	ts, err := read("frontend/src/shared/texts/checks.ts", checkLabelTS)
	if err != nil {
		return nil, nil, err
	}
	goLabels, err := read("internal/checks/texts.go", checkLabelGo)
	if err != nil {
		return nil, nil, err
	}
	var problems []Problem
	keys := map[string]bool{}
	for key := range ts {
		keys[key] = true
	}
	for key := range goLabels {
		keys[key] = true
	}
	sorted := make([]string, 0, len(keys))
	for key := range keys {
		sorted = append(sorted, key)
	}
	sort.Strings(sorted)
	known := map[string]bool{}
	for _, key := range sorted {
		if ts[key] != goLabels[key] {
			problems = append(problems, Problem{"internal/checks/texts.go", 0, fmt.Sprintf("название проверки %s: в Go «%s», в frontend/src/shared/texts/checks.ts «%s»", key, goLabels[key], ts[key])})
		}
		if ts[key] != "" {
			known[ts[key]] = true
		}
	}
	return known, problems, nil
}

// consistencyFiles — документы, в которых сверяются значения: проверяемые Markdown-файлы и
// встроенные (README шаблона, промпты, документы провайдеров) — именно README шаблона отстают
// при переименовании, — а также конфигурация Playwright.
func consistencyFiles(root string) ([]string, error) {
	files := []string{"frontend/playwright.config.ts"}
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
		if checkedDoc(rel) || embeddedDoc(rel) {
			files = append(files, rel)
		}
		return nil
	})
	sort.Strings(files[1:])
	return files, err
}

// CheckConsistency сверяет с кодом размер окна и названия проверок в документах и README шаблона,
// а во встроенных документах (которые Check пропускает) ищет и ссылки на приватный план.
func CheckConsistency(root string) ([]Problem, error) {
	size, err := windowSize(root)
	if err != nil {
		return nil, err
	}
	known, problems, err := checkLabels(root)
	if err != nil {
		return nil, err
	}
	files, err := consistencyFiles(root)
	if err != nil {
		return nil, err
	}
	for _, rel := range files {
		data, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(rel)))
		if err != nil {
			return nil, err
		}
		for n, line := range strings.Split(string(data), "\n") {
			add := func(format string, args ...any) {
				problems = append(problems, Problem{rel, n + 1, fmt.Sprintf(format, args...)})
			}
			for _, m := range windowMention.FindAllStringSubmatch(line, -1) {
				if got := m[2] + "×" + m[3]; got != size {
					add("размер окна %s, в main.go %s", got, size)
				}
			}
			for _, m := range viewportSize.FindAllStringSubmatch(line, -1) {
				if got := m[1] + "×" + m[2]; got != size {
					add("окно проверки %s, в main.go %s", got, size)
				}
			}
			var labels []string
			for _, m := range checkList.FindAllStringSubmatch(line, -1) {
				for _, q := range quotedPhrase.FindAllStringSubmatch(m[1], -1) {
					labels = append(labels, q[1])
				}
			}
			for _, pattern := range []*regexp.Regexp{checkRow, checkArrow} {
				for _, m := range pattern.FindAllStringSubmatch(line, -1) {
					labels = append(labels, m[1])
				}
			}
			for _, label := range labels {
				if !known[label] {
					add("проверки «%s» нет на странице «Проверки»", label)
				}
			}
			if embeddedDoc(rel) && planMarker.MatchString(line) {
				add(textPlanMarker)
			}
		}
	}
	return problems, nil
}
