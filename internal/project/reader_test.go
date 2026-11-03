package project

import (
	"crypto/sha256"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// fixture создаёт только синтетические документы и байты: реальные проекты тесту не нужны.
func fixture(t *testing.T) string {
	t.Helper()
	root := filepath.Join(t.TempDir(), "Клип с пробелами")
	write(t, root, "plan/project.json", `{"name":"Проверка","unknown":{"keep":true}}`)
	write(t, root, "source/text.md", "[Куплет]\r\n\r\nПервая строка\r\nВторая строка\n")
	write(t, root, "source/manifest.json", `{"schema_version":1,"track":{"sha256":"abc","duration_seconds":3.5}}`)
	write(t, root, "source/track.mp3", "синтетические байты")
	write(t, root, "plan/audio/timing.json", `{"lines":[{"source_line":3,"start":0.25,"end":1.5,"verified":true}],"unknown":{"value":null}}`)
	return root
}

// write создаёт документ fixture и явно останавливает тест при ошибке диска.
func write(t *testing.T, root, path, text string) {
	t.Helper()
	target := filepath.Join(root, filepath.FromSlash(path))
	if err := os.MkdirAll(filepath.Dir(target), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target, []byte(text), 0600); err != nil {
		t.Fatal(err)
	}
}

// tree учитывает имена, типы и содержимое файлов: создание служебного JSON тоже нарушит сравнение.
func tree(t *testing.T, root string) map[string]string {
	t.Helper()
	result := map[string]string{}
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		relative, _ := filepath.Rel(root, path)
		if entry.IsDir() {
			result[relative] = "directory"
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		hash := sha256.Sum256(data)
		result[relative] = string(hash[:])
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return result
}

// Чтение сохраняет байты, nullable/неизвестные поля и физические строки после переноса папки.
func TestReadPreservesProjectAndMovedUnicodePaths(t *testing.T) {
	root := fixture(t)
	before := tree(t, root)
	value, err := (Reader{}).Read(root)
	if err != nil {
		t.Fatal(err)
	}
	if value.Blocked || len(value.Problems) != 0 || value.Track == nil || value.Track.Path != filepath.Join(root, "source", "track.mp3") {
		t.Fatalf("снимок: %+v", value)
	}
	if value.LyricsText != "[Куплет]\r\n\r\nПервая строка\r\nВторая строка\n" {
		t.Fatal("изменены физические строки")
	}
	if value.TrackSha256 == nil || *value.TrackSha256 != "abc" || value.Duration == nil || *value.Duration != 3.5 {
		t.Fatal("потеря метаданных трека")
	}
	if !strings.Contains(string(value.Timing), `"unknown":{"value":null}`) {
		t.Fatal("потеря неизвестного поля")
	}
	if !reflect.DeepEqual(before, tree(t, root)) {
		t.Fatal("проект изменился после чтения")
	}
	moved := filepath.Join(filepath.Dir(root), "Перенесённый клип")
	if err := os.Rename(root, moved); err != nil {
		t.Fatal(err)
	}
	next, err := (Reader{}).Read(moved)
	if err != nil || next.Track == nil || next.Track.Path != filepath.Join(moved, "source", "track.mp3") {
		t.Fatalf("перенос: %+v %v", next, err)
	}
	if !reflect.DeepEqual(before, tree(t, moved)) {
		t.Fatal("повторное чтение изменило проект")
	}
}

// Повреждённые документы дают проблемы страницы, а некорректный маркер запрещает открытие.
func TestReadMalformedAndMissingDocuments(t *testing.T) {
	root := fixture(t)
	write(t, root, "plan/audio/timing.json", `{"lines":[null]}`)
	write(t, root, "source/manifest.json", `{"schema_version":2}`)
	if err := os.Remove(filepath.Join(root, "source", "track.mp3")); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(root, "source", "text.md")); err != nil {
		t.Fatal(err)
	}
	before := tree(t, root)
	value, err := (Reader{}).Read(root)
	if err != nil || value.Blocked || len(value.Problems) != 4 || value.Track != nil || string(value.Timing) != "null" {
		t.Fatalf("повреждённые документы: %+v %v", value, err)
	}
	data, err := json.Marshal(value)
	if err != nil || !strings.Contains(string(data), `"trackSha256":null`) || !strings.Contains(string(data), `"duration":null`) {
		t.Fatalf("nullable DTO: %s %v", data, err)
	}
	if !reflect.DeepEqual(before, tree(t, root)) {
		t.Fatal("повреждённые документы изменились")
	}
	write(t, root, "plan/project.json", `{"name":null}`)
	if _, err := (Reader{}).Read(root); err == nil {
		t.Fatal("неверный маркер принят")
	}
}

// Известные незавершённые/нечитаемые журналы не допускают частичного просмотра и не откатываются.
func TestReadBlocksPendingAndMalformedJournals(t *testing.T) {
	for _, kind := range []string{"montage-history", "derived-history"} {
		for _, journal := range []string{`{"state":"publishing"}`, `{broken`} {
			t.Run(kind+journal, func(t *testing.T) {
				root := fixture(t)
				write(t, root, "plan/"+kind+"/0123456789abcdef0123456789abcdef/journal.json", journal)
				before := tree(t, root)
				value, err := (Reader{}).Read(root)
				if err != nil || !value.Blocked || len(value.Problems) != 1 || value.Track != nil || value.LyricsText != "" || string(value.Timing) != "null" {
					t.Fatalf("журнал не блокирует: %+v %v", value, err)
				}
				if !reflect.DeepEqual(before, tree(t, root)) {
					t.Fatal("выполнена запись или откат")
				}
			})
		}
	}
	root := fixture(t)
	write(t, root, "plan/montage-history/done/journal.json", `{"state":"rolled_back"}`)
	if value, err := (Reader{}).Read(root); err != nil || value.Blocked {
		t.Fatalf("завершённый журнал: %+v %v", value, err)
	}
}

// Ограничение размера предотвращает чтение случайного большого файла в память, не обрезая документ.
func TestReadLimitedRejectsOversizedDocument(t *testing.T) {
	root := fixture(t)
	file, err := os.OpenFile(filepath.Join(root, "source", "text.md"), os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	if err := file.Truncate((8 << 20) + 1); err != nil {
		t.Fatal(err)
	}
	file.Close()
	value, err := (Reader{}).Read(root)
	if err != nil || value.LyricsText != "" || len(value.Problems) != 1 || !strings.Contains(value.Problems[0], "больше допустимых") {
		t.Fatalf("лимит: %+v %v", value, err)
	}
}
