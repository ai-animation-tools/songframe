package repodocs

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestConsistency — размер окна и названия проверок в документах и README шаблона совпадают с
// кодом, во встроенных документах нет ссылок на приватный план.
func TestConsistency(t *testing.T) {
	problems, err := CheckConsistency(repoRoot)
	if err != nil {
		t.Fatal(err)
	}
	if len(problems) > 0 {
		var b strings.Builder
		for _, p := range problems {
			b.WriteString(p.String())
			b.WriteByte('\n')
		}
		t.Fatalf("документы расходятся с кодом (%d):\n%s", len(problems), b.String())
	}
}

// TestConsistencyFindsDrift проверяет саму сверку на синтетическом репозитории: каждое
// расхождение находится, а верные упоминания и обычная речь проходят.
func TestConsistencyFindsDrift(t *testing.T) {
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
	write("main.go", "package main\n\nvar w = Opts{Width: 1320, Height: 860, MinWidth: 1320, MinHeight: 860}\n")
	write("frontend/playwright.config.ts", "{ use: { viewport: { width: 1320, height: 860 } } },\n{ use: { viewport: { width: 1280, height: 720 } } },\n")
	write("frontend/src/shared/texts/checks.ts", "export const checksTexts = {\n  assetsLabel: 'Комплекты планов',\n  viewsLabel: 'Карточки и списки',\n};\n")
	write("internal/checks/texts.go", "package checks\n\nconst (\n\ttextAssetsLabel = \"Комплекты планов\"\n\ttextViewsLabel = \"Карточки\"\n)\n")
	write("docs/ui.md", strings.Join([]string{
		"Минимальное и стартовое окно — **1320×860**; меньшие размеры 960×640 не входят.",
		"Приложение открывает окно 1400×900.",
		"Оригинал совпадает с окном плана, кадром 1920×1080.",
		"Выполните проверку «Комплекты планов» и проверки «на всякий случай» не добавляйте.",
	}, "\n"))
	write("resources/templates/project/README.md", "Перед сборкой выполнить проверку «Комплекты сцен»; строка «Карточки и списки» на странице «Проверки».\nРаскладка шага 41.2.\n")

	problems, err := CheckConsistency(root)
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, p := range problems {
		got = append(got, p.String())
	}
	want := []string{
		"internal/checks/texts.go:0: название проверки views: в Go «Карточки», в frontend/src/shared/texts/checks.ts «Карточки и списки»",
		"frontend/playwright.config.ts:2: окно проверки 1280×720, в main.go 1320×860",
		"docs/ui.md:2: размер окна 1400×900, в main.go 1320×860",
		"resources/templates/project/README.md:1: проверки «Комплекты сцен» нет на странице «Проверки»",
		"resources/templates/project/README.md:2: ссылка на приватный план разработки: опишите причину без номера решения, задачи или шага",
	}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("найдено:\n%s\nожидалось:\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
}
