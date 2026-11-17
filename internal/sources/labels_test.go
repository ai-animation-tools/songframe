package sources

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"songframe/internal/dynvalue"
)

// Подписи видов Go совпадают с projectDataTexts.referenceViews: карточка кастинга и отчёт проверки
// называют изображение одинаково.
func TestReferenceViewsMatchFrontend(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "frontend", "src", "shared", "texts", "project-data.ts"))
	if err != nil {
		t.Fatal(err)
	}
	block := regexp.MustCompile(`(?s)referenceViews:\s*\{(.*?)\}`).FindSubmatch(data)
	if block == nil {
		t.Fatal("нет referenceViews в project-data.ts")
	}
	frontend := map[string]string{}
	for _, m := range regexp.MustCompile(`(\w+):\s*'([^']*)'`).FindAllSubmatch(block[1], -1) {
		frontend[string(m[1])] = string(m[2])
	}
	if len(frontend) != len(referenceViews) {
		t.Fatalf("видов в frontend %d, в Go %d", len(frontend), len(referenceViews))
	}
	for key, label := range frontend {
		if referenceViews[key] != label {
			t.Errorf("вид %s: в Go «%s», в frontend «%s»", key, referenceViews[key], label)
		}
	}
}

func TestFileLabels(t *testing.T) {
	file := func(view, note string) any {
		item := dynvalue.NewObject()
		item.Set("view", view)
		if note != "" {
			item.Set("note", note)
		}
		return item
	}
	long := "Общий план перед столкновением. Мальчик делает первый шаг с тротуара на дорогу."
	cases := []struct {
		name  string
		files []any
		want  []string
	}{
		{"одно изображение — имя", []any{file("other", "Вход")}, []string{"Вход"}},
		{"разные виды", []any{file("face", ""), file("full", "")}, []string{"Артём — Лицо", "Артём — В полный рост"}},
		{"совпавший вид — заметка", []any{file("other", "закрыта"), file("other", "")}, []string{"Артём — закрыта", "Артём — Другое"}},
		{"совпавшее начало заметки — номер", []any{file("other", long), file("other", long), file("side", "")}, []string{"Артём — Общий план перед столкновением (1)", "Артём — Общий план перед столкновением (2)", "Артём — Сбоку"}},
	}
	for _, item := range cases {
		got := FileLabels("Артём", item.files)
		if item.name == "одно изображение — имя" {
			got = FileLabels("Вход", item.files)
		}
		if strings.Join(got, "|") != strings.Join(item.want, "|") {
			t.Errorf("%s: %q, нужно %q", item.name, got, item.want)
		}
	}
}

func TestNoteLabel(t *testing.T) {
	for note, want := range map[string]string{
		"  пустой ракурс ": "пустой ракурс",
		"Столкновение осталось вне кадра. Мальчик":      "Столкновение осталось вне кадра",
		"Рабочий на заводе которого спасают при пожаре": "Рабочий на заводе которого спасают при",
		"": "",
	} {
		if got := NoteLabel(note); got != want {
			t.Errorf("NoteLabel(%q) = %q, нужно %q", note, got, want)
		}
	}
}
