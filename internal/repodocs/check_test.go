package repodocs

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// repoRoot — корень репозитория относительно папки пакета.
const repoRoot = "../.."

// TestDocsReferences не даёт документации сослаться на то, чего в репозитории нет: файлы, якоря,
// переменные окружения, задачи и скрипты. Падение означает, что код или документ изменились
// несогласованно; исправлять нужно документ (или код, если документ описывает правило продукта).
func TestDocsReferences(t *testing.T) {
	problems, err := Check(repoRoot)
	if err != nil {
		t.Fatal(err)
	}
	if len(problems) > 0 {
		var b strings.Builder
		for _, p := range problems {
			b.WriteString(p.String())
			b.WriteByte('\n')
		}
		t.Fatalf("документация расходится с репозиторием (%d):\n%s", len(problems), b.String())
	}
}

// TestNoHistoryInSources не даёт истории прежней версии вернуться в код и комментарии.
func TestNoHistoryInSources(t *testing.T) {
	problems, err := CheckSources(repoRoot)
	if err != nil {
		t.Fatal(err)
	}
	if len(problems) > 0 {
		var b strings.Builder
		for _, p := range problems {
			b.WriteString(p.String())
			b.WriteByte('\n')
		}
		t.Fatalf("история прежней версии в исходниках (%d):\n%s", len(problems), b.String())
	}
}

// TestCheckFindsDrift проверяет саму проверку на синтетическом репозитории: каждое правило должно
// сработать на своём нарушении и промолчать на верной ссылке.
func TestCheckFindsDrift(t *testing.T) {
	root := t.TempDir()
	write := func(rel, text string) {
		t.Helper()
		p := filepath.Join(root, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("Taskfile.yml", "version: '3'\ntasks:\n  check:go:\n    cmds: []\n")
	write("frontend/package.json", `{"scripts": {"typecheck": "tsc"}, "devDependencies": {"@playwright/test": "1"}}`)
	write("internal/x/x.go", "package x\n\nconst env = \"SONGFRAME_KNOWN\"\n")
	write("docs/a.md", "# Заголовок `кода» и «кавычки»\n\n## Повтор\n\n## Повтор\n")
	write("docs/b.md", strings.Join([]string{
		"[ok](a.md#заголовок-кода-и-кавычки) [ok2](a.md#повтор-1) [ok3](../internal/x/x.go)",
		"[битая](missing.md) [якорь](a.md#нет) [сосед](../../spec/AGENTS.md)",
		"`internal/x/x.go` `internal/y/y.go` `internal/providers/<id>/`",
		"SONGFRAME_KNOWN SONGFRAME_GONE `wails3 task check:go` `wails3 task check:gone`",
		"`yarn typecheck` `yarn install` `yarn playwright` `yarn release` `frontend/dist/index.html`",
		"```sh",
		"[в блоке кода](missing2.md) `internal/z/z.go` wails3 task gone:in-fence",
		"```",
	}, "\n"))
	write("resources/skills/s/SKILL.md", "`plan/scenes.json` `internal/q/q.go` [нет](missing.md)\n")
	write("resources/skills/README.md", "[нет](missing.md)\n")
	write("README.md", "# R\n\nСтек Electron.\n\n## История\n\nПрежде был Electron.\n")
	write("internal/x/old.go", "package x\n\n// Как в Electron-версии.\n")

	problems, err := Check(root)
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, p := range problems {
		got = append(got, p.String())
	}
	want := []string{
		"README.md:3: упоминание прежней версии: история — только в разделе «История» README",
		"docs/b.md:2: ссылка на несуществующий docs/missing.md",
		"docs/b.md:2: в docs/a.md нет якоря #нет",
		"docs/b.md:3: путь `internal/y/y.go` не существует",
		"docs/b.md:4: переменная SONGFRAME_GONE не встречается в исходниках",
		"docs/b.md:4: задачи `wails3 task check:gone` нет в Taskfile.yml",
		"docs/b.md:5: скрипта `yarn release` нет в frontend/package.json",
		"docs/b.md:7: задачи `wails3 task gone:in-fence` нет в Taskfile.yml",
		"resources/skills/README.md:1: ссылка на несуществующий resources/skills/missing.md",
	}
	src, err := CheckSources(root)
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range src {
		got = append(got, p.String())
	}
	want = append(want, "internal/x/old.go:3: упоминание прежней версии: история — только в разделе «История» README")
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("найдено:\n%s\nожидалось:\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
}
