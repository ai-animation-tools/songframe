package repodocs

import (
	"errors"
	"fmt"
	"go/doc"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"
)

// CodeMapFile — путь карты кода от корня репозитория.
const CodeMapFile = "docs/code-map.md"

// pagesDir — каталог страниц интерфейса; каждая его папка обязана быть в одной из Areas.
const pagesDir = "frontend/src/renderer/pages"

// goPackages возвращает каталоги Go-пакетов репозитория (пути от корня, «.» — корень). Каталоги
// testdata и зависимости не обходятся: в них нет пакетов приложения.
func goPackages(root string) ([]string, error) {
	seen := map[string]bool{}
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if p != root && (skippedDirs[d.Name()] || d.Name() == "testdata" || d.Name() == "frontend") {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(d.Name(), ".go") || strings.HasSuffix(d.Name(), "_test.go") {
			return nil
		}
		rel, err := filepath.Rel(root, filepath.Dir(p))
		if err != nil {
			return err
		}
		seen[filepath.ToSlash(rel)] = true
		return nil
	})
	dirs := make([]string, 0, len(seen))
	for dir := range seen {
		dirs = append(dirs, dir)
	}
	sort.Strings(dirs)
	return dirs, err
}

// packageSynopsis возвращает первое предложение комментария пакета без вступления «Package имя».
// Пустая строка означает, что комментария нет: это ошибка карты (правило комментариев AGENTS.md).
func packageSynopsis(root, dir string) (string, error) {
	files, err := filepath.Glob(filepath.Join(root, filepath.FromSlash(dir), "*.go"))
	if err != nil {
		return "", err
	}
	sort.Strings(files)
	fset := token.NewFileSet()
	var text strings.Builder
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		file, err := parser.ParseFile(fset, f, nil, parser.PackageClauseOnly|parser.ParseComments)
		if err != nil {
			return "", err
		}
		if file.Doc != nil {
			text.WriteString(file.Doc.Text())
		}
	}
	var p doc.Package
	s := p.Synopsis(text.String())
	s = regexp.MustCompile(`^Package \S+\s+(—\s+)?`).ReplaceAllString(s, "")
	if r, size := utf8.DecodeRuneInString(s); size > 0 {
		s = string(unicode.ToUpper(r)) + s[size:]
	}
	return s, nil
}

var (
	jsDoc         = regexp.MustCompile(`(?s)/\*\*(.*?)\*/`)
	sentenceEnd   = regexp.MustCompile(`^(.*?[.!?…])(\s|$)`)
	importOrBlank = regexp.MustCompile(`^(import\b|\s*$|//)`)
)

// jsDocText превращает тело комментария /** … */ в одну строку без звёздочек.
func jsDocText(body string) string {
	var parts []string
	for _, l := range strings.Split(body, "\n") {
		l = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(l), "*"))
		if l != "" {
			parts = append(parts, l)
		}
	}
	return strings.Join(parts, " ")
}

// firstSentence оставляет первое предложение описания.
func firstSentence(s string) string {
	if m := sentenceEnd.FindStringSubmatch(s); m != nil {
		return m[1]
	}
	return s
}

// pageSynopsis возвращает назначение страницы: первое предложение комментария, который стоит
// прямо перед `export function <Страница>`, а если его нет — первого комментария /** */ среди
// импортов в начале файла (описание модуля страницы).
func pageSynopsis(root, page string) (string, error) {
	data, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(pagesDir), page, page+".tsx"))
	if err != nil {
		return "", err
	}
	src := string(data)
	if i := strings.Index(src, "\nexport function "+page+"("); i >= 0 {
		head := strings.TrimRight(src[:i], " \t\n")
		if strings.HasSuffix(head, "*/") {
			if j := strings.LastIndex(head, "/**"); j >= 0 {
				return firstSentence(jsDocText(head[j+3 : len(head)-2])), nil
			}
		}
	}
	// Комментарий модуля: первый /** */, перед которым только импорты и пустые строки.
	for _, loc := range jsDoc.FindAllStringSubmatchIndex(src, -1) {
		for _, l := range strings.Split(src[:loc[0]], "\n") {
			if !importOrBlank.MatchString(l) && !strings.HasPrefix(strings.TrimSpace(l), "}") &&
				!regexp.MustCompile(`^\s+\S`).MatchString(l) {
				return "", nil
			}
		}
		return firstSentence(jsDocText(src[loc[2]:loc[3]])), nil
	}
	return "", nil
}

// relLink — ссылка из docs/code-map.md на путь от корня репозитория (с якорем или без).
func relLink(target string) string {
	file, anchor, hasAnchor := strings.Cut(target, "#")
	rel, err := filepath.Rel("docs", filepath.FromSlash(file))
	if err != nil {
		rel = file
	}
	rel = filepath.ToSlash(rel)
	if hasAnchor {
		rel += "#" + anchor
	}
	return rel
}

// cell экранирует текст для ячейки таблицы Markdown.
func cell(s string) string { return strings.ReplaceAll(s, "|", `\|`) }

// RenderCodeMap собирает карту кода из Areas и проверяет её инварианты: каждый Go-пакет и каждая
// страница принадлежат ровно одной области, перечисленные пути и документы существуют, у пакетов
// и страниц есть описания. Нарушения возвращаются одной ошибкой со списком.
func RenderCodeMap(root string) (string, error) {
	var errs []error
	fail := func(format string, args ...any) { errs = append(errs, fmt.Errorf(format, args...)) }

	pkgs, err := goPackages(root)
	if err != nil {
		return "", err
	}
	entries, err := os.ReadDir(filepath.Join(root, filepath.FromSlash(pagesDir)))
	if err != nil {
		return "", err
	}
	owner := map[string]string{}
	claim := func(kind, name, area string) {
		if prev, ok := owner[kind+name]; ok {
			fail("%s %s указан в двух областях: «%s» и «%s»", kind, name, prev, area)
		}
		owner[kind+name] = area
	}
	for _, a := range Areas {
		for _, p := range a.Packages {
			claim("пакет", p, a.Title)
		}
		for _, p := range a.Pages {
			claim("страница", p, a.Title)
		}
	}
	for _, p := range pkgs {
		if _, ok := owner["пакет"+p]; !ok {
			fail("пакет %s не отнесён ни к одной области internal/repodocs/areas.go", p)
		}
		delete(owner, "пакет"+p)
	}
	for _, e := range entries {
		if e.IsDir() {
			if _, ok := owner["страница"+e.Name()]; !ok {
				fail("страница %s не отнесена ни к одной области internal/repodocs/areas.go", e.Name())
			}
			delete(owner, "страница"+e.Name())
		}
	}
	var stale []string
	for k := range owner {
		stale = append(stale, k)
	}
	sort.Strings(stale)
	for _, k := range stale {
		fail("в areas.go указан несуществующий %s", strings.Replace(strings.Replace(k, "пакет", "пакет ", 1), "страница", "страница ", 1))
	}

	var b strings.Builder
	b.WriteString("# Карта кода\n\n")
	b.WriteString("<!-- Сгенерировано `wails3 task docs:map` из internal/repodocs/areas.go, комментариев `// Package` и описаний страниц. Не править вручную. -->\n\n")
	b.WriteString("Карта показывает, где лежит код каждой области и какие документы ей принадлежат. ")
	b.WriteString("После изменения поведения области обновите её документы в том же коммите (правило «Документация и код» в [AGENTS.md](../AGENTS.md)). ")
	b.WriteString("Назначение пакета — первое предложение его комментария `// Package`, страницы — комментария её компонента: чтобы поправить описание, правьте комментарий и перегенерируйте карту.\n")
	for _, a := range Areas {
		fmt.Fprintf(&b, "\n## %s\n\n", a.Title)
		if len(a.Docs) == 0 {
			b.WriteString("Отдельного документа нет: правила области описаны комментариями пакетов и страниц.\n")
		} else {
			links := make([]string, 0, len(a.Docs))
			for _, d := range a.Docs {
				file, _, _ := strings.Cut(d, "#")
				if _, err := os.Stat(filepath.Join(root, filepath.FromSlash(file))); err != nil {
					fail("область «%s»: документа %s нет", a.Title, file)
				}
				links = append(links, fmt.Sprintf("[%s](%s)", d, relLink(d)))
			}
			fmt.Fprintf(&b, "Документы: %s.\n", strings.Join(links, ", "))
		}
		if len(a.Packages) > 0 {
			b.WriteString("\n| Пакет | Назначение |\n| --- | --- |\n")
			for _, p := range a.Packages {
				s, err := packageSynopsis(root, p)
				if err != nil {
					fail("пакет %s: %v", p, err)
				} else if s == "" {
					fail("у пакета %s нет комментария // Package", p)
				}
				link := relLink(p)
				if p == "." {
					link = relLink("main.go")
				}
				fmt.Fprintf(&b, "| [`%s`](%s) | %s |\n", p, link, cell(s))
			}
		}
		if len(a.Pages) > 0 {
			b.WriteString("\n| Страница | Назначение |\n| --- | --- |\n")
			for _, p := range a.Pages {
				s, err := pageSynopsis(root, p)
				if err != nil {
					fail("страница %s: %v", p, err)
				} else if s == "" {
					fail("у страницы %s нет описания: комментарий /** */ перед export function %s", p, p)
				}
				fmt.Fprintf(&b, "| [`%s`](%s) | %s |\n", p, relLink(pagesDir+"/"+p+"/"+p+".tsx"), cell(s))
			}
		}
		if len(a.Paths) > 0 {
			links := make([]string, 0, len(a.Paths))
			for _, p := range a.Paths {
				if _, err := os.Stat(filepath.Join(root, filepath.FromSlash(p))); err != nil {
					fail("область «%s»: пути %s нет", a.Title, p)
				}
				links = append(links, fmt.Sprintf("[`%s`](%s)", p, relLink(p)))
			}
			fmt.Fprintf(&b, "\nЕщё: %s.\n", strings.Join(links, ", "))
		}
	}
	return b.String(), errors.Join(errs...)
}
