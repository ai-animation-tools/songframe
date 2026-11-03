package project

import (
	"crypto/sha256"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// fixture создаёт синтетический проект без журналов: реальные проекты тесту не нужны.
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

// Известные незавершённые и нечитаемые журналы распознаются, а проверка ничего не пишет и не откатывает.
func TestPendingJournalsBlocksPublishingAndMalformed(t *testing.T) {
	for _, kind := range []string{"montage-history", "derived-history"} {
		for _, journal := range []string{`{"state":"publishing"}`, `{broken`} {
			t.Run(kind+journal, func(t *testing.T) {
				root := fixture(t)
				write(t, root, "plan/"+kind+"/0123456789abcdef0123456789abcdef/journal.json", journal)
				before := tree(t, root)
				if problems := PendingJournals(root); len(problems) != 1 {
					t.Fatalf("журнал не распознан: %v", problems)
				}
				if !reflect.DeepEqual(before, tree(t, root)) {
					t.Fatal("выполнена запись или откат")
				}
			})
		}
	}
	root := fixture(t)
	write(t, root, "plan/montage-history/done/journal.json", `{"state":"rolled_back"}`)
	if problems := PendingJournals(root); problems == nil || len(problems) != 0 {
		t.Fatalf("завершённый журнал: %#v", problems)
	}
}
