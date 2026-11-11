package projectfs

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

// TestMarshalJSONProjectFormat сверяет байты MarshalJSON с образцом формата проекта: порядок
// полей, пустые коллекции, неэкранированные HTML-символы и U+2028/U+2029, короткие \b и \f, числа.
func TestMarshalJSONProjectFormat(t *testing.T) {
	value := struct {
		B int               `json:"b"`
		A []int             `json:"a"`
		O map[string]int    `json:"o"`
		S string            `json:"s"`
		N []float64         `json:"n"`
		Z *int              `json:"z"`
		E []json.RawMessage `json:"e"`
	}{1, []int{}, map[string]int{}, "<a&b> \u2028\u2029 \b\f\n\t\u0001 \\u2028 ё", []float64{1.5, 1e21, 1e-7, 0.1}, nil, []json.RawMessage{json.RawMessage(`{"x":true}`)}}
	expected := "{\n  \"b\": 1,\n  \"a\": [],\n  \"o\": {},\n  \"s\": \"<a&b> \u2028\u2029 \\b\\f\\n\\t\\u0001 \\\\u2028 ё\",\n  \"n\": [\n    1.5,\n    1e+21,\n    1e-7,\n    0.1\n  ],\n  \"z\": null,\n  \"e\": [\n    {\n      \"x\": true\n    }\n  ]\n}\n"
	data, err := MarshalJSON(value)
	if err != nil || string(data) != expected {
		t.Fatalf("%v\n%q\n%q", err, data, expected)
	}
}

// TestWriteJSONReplacesAndPreservesMode проверяет замену, права существующего файла
// и 0600 для нового, а также отсутствие временных файлов после записи.
func TestWriteJSONReplacesAndPreservesMode(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "вложенная", "doc.json")
	if err := WriteJSON(path, map[string]int{"a": 1}); err != nil {
		t.Fatal(err)
	}
	info, _ := os.Stat(path)
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("права нового файла %v", info.Mode().Perm())
	}
	if err := os.Chmod(path, 0o640); err != nil {
		t.Fatal(err)
	}
	if err := WriteJSON(path, map[string]int{"a": 2}); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(path)
	info, _ = os.Stat(path)
	if string(data) != "{\n  \"a\": 2\n}\n" || info.Mode().Perm() != 0o640 {
		t.Fatalf("%q %v", data, info.Mode().Perm())
	}
	entries, _ := os.ReadDir(filepath.Dir(path))
	if len(entries) != 1 {
		t.Fatalf("остались временные файлы: %v", entries)
	}
}

// TestWriteJSONFailureKeepsOldFile имитирует сбой посреди записи и при fsync:
// прежний файл остаётся целым, временный удаляется, ошибка называет путь.
func TestWriteJSONFailureKeepsOldFile(t *testing.T) {
	for name, inject := range map[string]func(){
		"запись": func() {
			writeData = func(file *os.File, data []byte) error {
				file.Write(data[:len(data)/2])
				return errors.New("диск заполнен")
			}
		},
		"fsync": func() { syncFile = func(*os.File) error { return errors.New("ошибка ввода-вывода") } },
	} {
		t.Run(name, func(t *testing.T) {
			directory := t.TempDir()
			path := filepath.Join(directory, "doc.json")
			if err := WriteJSON(path, map[string]string{"state": "прежний"}); err != nil {
				t.Fatal(err)
			}
			before, _ := os.ReadFile(path)
			originalWrite, originalSync := writeData, syncFile
			defer func() { writeData, syncFile = originalWrite, originalSync }()
			inject()
			err := WriteJSON(path, map[string]string{"state": strings.Repeat("новый", 1000)})
			if err == nil || !strings.Contains(err.Error(), path) {
				t.Fatal(err)
			}
			after, _ := os.ReadFile(path)
			if string(after) != string(before) {
				t.Fatalf("прежний файл повреждён: %q", after)
			}
			entries, _ := os.ReadDir(directory)
			if len(entries) != 1 {
				t.Fatalf("остался временный файл: %v", entries)
			}
		})
	}
}

// TestReadJSON различает отсутствие, повреждение и не-объект.
func TestReadJSON(t *testing.T) {
	directory := t.TempDir()
	var value map[string]any
	if found, err := ReadJSON(filepath.Join(directory, "нет.json"), &value); found || err != nil {
		t.Fatal(found, err)
	}
	for text, message := range map[string]string{"{broken": "Не удалось прочитать", "5": "ожидался JSON-объект", "null": "ожидался JSON-объект"} {
		path := filepath.Join(directory, "bad.json")
		os.WriteFile(path, []byte(text), 0o600)
		if found, err := ReadJSON(path, &value); !found || err == nil || !strings.Contains(err.Error(), message) {
			t.Fatal(text, found, err)
		}
	}
	path := filepath.Join(directory, "ok.json")
	os.WriteFile(path, []byte(`{"a":1}`), 0o600)
	if found, err := ReadJSON(path, &value); !found || err != nil || value["a"] != float64(1) {
		t.Fatal(found, err, value)
	}
}

// TestCheckWriteBlocksPendingJournals: публикация в процессе и нечитаемый журнал запрещают
// запись, завершённый журнал — нет. WriteProjectJSON при запрете файл не создаёт.
func TestCheckWriteBlocksPendingJournals(t *testing.T) {
	root := t.TempDir()
	if err := CheckWrite(root); err != nil {
		t.Fatal(err)
	}
	journal := filepath.Join(root, "plan", "montage-history", "0123", "journal.json")
	os.MkdirAll(filepath.Dir(journal), 0o755)
	os.WriteFile(journal, []byte(`{"state":"rolled_back"}`), 0o600)
	if err := CheckWrite(root); err != nil {
		t.Fatal(err)
	}
	for _, text := range []string{`{"state":"publishing"}`, `{broken`} {
		os.WriteFile(journal, []byte(text), 0o600)
		err := WriteProjectJSON(root, "plan/audio/timing.json", map[string]int{})
		var blocked *BlockedError
		if !errors.As(err, &blocked) || len(blocked.Problems) != 1 || !strings.Contains(err.Error(), "montage-history/0123") {
			t.Fatal(text, err)
		}
		if _, statErr := os.Stat(filepath.Join(root, "plan", "audio", "timing.json")); !os.IsNotExist(statErr) {
			t.Fatal("запрещённая запись создала файл")
		}
	}
	os.WriteFile(journal, []byte(`{"state":"done"}`), 0o600)
	if err := WriteProjectJSON(root, "plan/audio/timing.json", map[string]int{}); err != nil {
		t.Fatal(err)
	}
}

// TestWriteProjectJSONRejectsEscape не даёт записать файл вне папки проекта.
func TestWriteProjectJSONRejectsEscape(t *testing.T) {
	root := t.TempDir()
	for _, rel := range []string{"../outside.json", "/abs.json", ""} {
		if err := WriteProjectJSON(root, rel, 1); err == nil {
			t.Fatal(rel)
		}
	}
}

// TestWriteFailedMessage — сбой записи в папке проекта называет путь от неё и причину по-русски,
// а исходная ошибка остаётся доступной errors.Is.
func TestWriteFailedMessage(t *testing.T) {
	project := t.TempDir()
	if err := os.MkdirAll(filepath.Join(project, "plan"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(project, "plan", "project.json"), []byte(`{"name":"Клип"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(project, "plan", "scenes"), []byte("файл"), 0o644); err != nil {
		t.Fatal(err)
	}
	err := WriteFile(filepath.Join(project, "plan", "scenes", "M01.json"), []byte("{}"), 0)
	want := "Не удалось сохранить «plan/scenes/M01.json» в папке проекта: не каталог. Проверьте доступ на запись к папке."
	if err == nil || err.Error() != want || !errors.Is(err, syscall.ENOTDIR) {
		t.Fatalf("сбой записи: %v", err)
	}
}
