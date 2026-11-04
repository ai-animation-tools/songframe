package scenarioapply

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"songframe-go/internal/projectfs"
	"songframe-go/internal/scenario"
)

// Проверки A-11 для публикации сценария: сбой до, между и после замен, повторный запуск,
// конфликт с внешней правкой, сохранность неизвестных новых данных и запрет записи при конфликте.
// Все проверки — на временных проектах, без настоящих клипов.

// newProject — минимальный проект с маркером и документами сценария.
func newProject(t *testing.T) string {
	t.Helper()
	project := filepath.Join(t.TempDir(), "Клип с пробелом")
	files := map[string]string{
		"plan/project.json":   `{"name":"Тест"}` + "\n",
		"plan/cast.json":      `{"cast":"old"}` + "\n",
		"plan/treatment.json": `{"treatment":"old"}` + "\n",
		"plan/scenes.json":    `{"scenes":"old"}` + "\n",
		"ROADMAP.md":          "# Старый план\n",
	}
	for name, text := range files {
		path := filepath.Join(project, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(text), 0o640); err != nil {
			t.Fatal(err)
		}
	}
	return project
}

// newStore — хранилище в отдельном каталоге состояния, подключённое к шлюзу на время теста.
func newStore(t *testing.T) Store {
	t.Helper()
	store := NewStore(t.TempDir())
	store.RegisterWriteCheck()
	t.Cleanup(func() { projectfs.SetWriteCheck("scenario-apply", nil) })
	return store
}

// publication — типичная публикация: две замены, новый файл и удаление производного вида.
func publication() []Change {
	return []Change{
		{Path: "plan/cast.json", Next: []byte(`{"cast":"new"}` + "\n")},
		{Path: "plan/scenes.json", Next: []byte(`{"scenes":"new"}` + "\n")},
		{Path: "plan/storyboard.md", Next: []byte("# Раскадровка\n")},
		{Path: "ROADMAP.md", Next: nil},
	}
}

// tree — содержимое и права всех файлов проекта.
func tree(t *testing.T, root string) map[string]string {
	t.Helper()
	result := map[string]string{}
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return err
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		info, err := os.Stat(path)
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(root, path)
		result[filepath.ToSlash(rel)] = info.Mode().Perm().String() + " " + string(data)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func assertTree(t *testing.T, want, got map[string]string) {
	t.Helper()
	if len(want) != len(got) {
		t.Fatalf("состав файлов\n  ждали: %v\n  есть:  %v", want, got)
	}
	for path, value := range want {
		if got[path] != value {
			t.Fatalf("%s\n  ждали: %q\n  есть:  %q", path, value, got[path])
		}
	}
}

// expectedAfter — дерево после успешной публикации publication().
func expectedAfter(t *testing.T, before map[string]string) map[string]string {
	t.Helper()
	after := map[string]string{}
	for path, value := range before {
		after[path] = value
	}
	after["plan/cast.json"] = "-rw-r----- " + `{"cast":"new"}` + "\n"
	after["plan/scenes.json"] = "-rw-r----- " + `{"scenes":"new"}` + "\n"
	after["plan/storyboard.md"] = "-rw------- # Раскадровка\n"
	delete(after, "ROADMAP.md")
	return after
}

// writeBlocked проверяет, что обычная запись документа сценария запрещена шлюзом.
func writeBlocked(t *testing.T, project string) {
	t.Helper()
	err := scenario.WriteDocument(project, "plan/treatment.json", map[string]any{})
	var blocked *projectfs.BlockedError
	if !errors.As(err, &blocked) || !strings.Contains(err.Error(), textRecoveryPending) {
		t.Fatalf("запись не запрещена: %v", err)
	}
}

// failOn подменяет замену файлов проекта: вызов номер n и все последующие (если sticky)
// завершаются ошибкой. Возвращает счётчик вызовов.
func failOn(t *testing.T, n int, sticky bool) *int {
	t.Helper()
	calls := 0
	original := replaceFile
	replaceFile = func(path string, data []byte, mode os.FileMode) error {
		calls++
		if calls == n || (sticky && calls > n) {
			return errors.New("диск переполнен")
		}
		return original(path, data, mode)
	}
	t.Cleanup(func() { replaceFile = original })
	return &calls
}

func TestPublishReplacesFilesAndClearsJournal(t *testing.T) {
	project, store := newProject(t), newStore(t)
	before := tree(t, project)
	if err := store.Publish(project, publication()); err != nil {
		t.Fatal(err)
	}
	assertTree(t, expectedAfter(t, before), tree(t, project))
	if store.Pending(project) {
		t.Fatal("журнал остался после успешной публикации")
	}
	if _, err := os.Stat(store.directory(project)); !os.IsNotExist(err) {
		t.Fatalf("резервы не убраны: %v", err)
	}
	if err := scenario.WriteDocument(project, "plan/treatment.json", map[string]any{}); err != nil {
		t.Fatalf("запись после публикации: %v", err)
	}
}

func TestChangesSkipsUnchangedFiles(t *testing.T) {
	project, store := newProject(t), newStore(t)
	changes, err := store.Changes(project, []Change{
		{Path: "plan/cast.json", Next: []byte(`{"cast":"old"}` + "\n")},
		{Path: "plan/edit-list.md", Next: nil},
		{Path: "plan/scenes.json", Next: []byte("{}")},
	})
	if err != nil || len(changes) != 1 || changes[0].Path != "plan/scenes.json" {
		t.Fatalf("changes = %+v, %v", changes, err)
	}
	if err := store.Publish(project, nil); err != nil {
		t.Fatalf("пустая публикация: %v", err)
	}
}

// Сбой до первой замены (запись резерва) не трогает проект и не оставляет журнала.
func TestFailureBeforePublicationLeavesProject(t *testing.T) {
	project, store := newProject(t), newStore(t)
	before := tree(t, project)
	original := writeBackup
	writeBackup = func(string, []byte) error { return errors.New("нет места для резерва") }
	t.Cleanup(func() { writeBackup = original })
	if err := store.Publish(project, publication()); err == nil || !strings.Contains(err.Error(), "нет места") {
		t.Fatalf("ошибка резерва: %v", err)
	}
	assertTree(t, before, tree(t, project))
	if store.Pending(project) {
		t.Fatal("журнал создан до резервов")
	}
	writeBackup = original
	// Недопустимый путь отклоняется тоже до замен.
	err := store.Publish(project, []Change{{Path: "plan/cast.json", Next: []byte("{}")}, {Path: "plan/project.json", Next: []byte("{}")}})
	if err == nil || err.Error() != textUnsupportedFile("plan/project.json") {
		t.Fatalf("недопустимый файл: %v", err)
	}
	assertTree(t, before, tree(t, project))
}

// Сбой между заменами сразу откатывает уже заменённые файлы с их правами.
func TestFailureBetweenReplacementsRollsBack(t *testing.T) {
	project, store := newProject(t), newStore(t)
	before := tree(t, project)
	failOn(t, 2, false)
	err := store.Publish(project, publication())
	if err == nil || !strings.Contains(err.Error(), "диск переполнен") {
		t.Fatalf("ошибка замены: %v", err)
	}
	assertTree(t, before, tree(t, project))
	if store.Pending(project) {
		t.Fatal("журнал остался после успешного отката")
	}
}

// Сбой после всех замен (журнал не удалился) тоже откатывает публикацию целиком.
func TestFailureAfterPublicationRollsBack(t *testing.T) {
	project, store := newProject(t), newStore(t)
	before := tree(t, project)
	original := removeJournal
	calls := 0
	removeJournal = func(path string) error {
		calls++
		if calls == 1 {
			return errors.New("журнал занят")
		}
		return original(path)
	}
	t.Cleanup(func() { removeJournal = original })
	if err := store.Publish(project, publication()); err == nil || !strings.Contains(err.Error(), "журнал занят") {
		t.Fatalf("ошибка удаления журнала: %v", err)
	}
	assertTree(t, before, tree(t, project))
	if store.Pending(project) {
		t.Fatal("журнал остался")
	}
}

// Неудачный откат оставляет журнал: запись запрещена, восстановление при открытии и повторный
// запуск возвращают прежние файлы и снимают запрет.
func TestIncompleteRollbackBlocksWritesUntilRecovery(t *testing.T) {
	project, store := newProject(t), newStore(t)
	before := tree(t, project)
	original := replaceFile
	failOn(t, 2, true)
	err := store.Publish(project, publication())
	if err == nil || !strings.HasPrefix(err.Error(), "Применение сценария прервано: ") {
		t.Fatalf("ошибка неполного отката: %v", err)
	}
	if !store.Pending(project) {
		t.Fatal("журнал удалён без восстановления")
	}
	writeBlocked(t, project)
	if err := store.Publish(project, publication()); err == nil || err.Error() != textRecoveryPending {
		t.Fatalf("публикация поверх журнала: %v", err)
	}
	replaceFile = original
	if err := store.Recover(project); err != nil {
		t.Fatal(err)
	}
	assertTree(t, before, tree(t, project))
	if store.Pending(project) {
		t.Fatal("журнал остался после восстановления")
	}
	// Повторный запуск ничего не делает.
	if err := store.Recover(project); err != nil {
		t.Fatal(err)
	}
	if err := store.RecoverAll(); err != nil {
		t.Fatal(err)
	}
	assertTree(t, before, tree(t, project))
}

// crash оставляет состояние «процесс прерван после k замен»: резервы и журнал записаны,
// применены первые k изменений.
func crash(t *testing.T, store Store, project string, changes []Change, k int) {
	t.Helper()
	absolutePath, _ := filepath.Abs(project)
	if _, _, err := store.begin(absolutePath, changes); err != nil {
		t.Fatal(err)
	}
	if err := apply(absolutePath, changes[:k]); err != nil {
		t.Fatal(err)
	}
}

// Прерывание на любой фазе восстанавливается при старте; повторный запуск ничего не меняет.
func TestRecoverAllAfterCrashAtEveryPhase(t *testing.T) {
	changes := publication()
	for k := 0; k <= len(changes); k++ {
		project, store := newProject(t), newStore(t)
		before := tree(t, project)
		crash(t, store, project, changes, k)
		writeBlocked(t, project)
		if err := store.RecoverAll(); err != nil {
			t.Fatalf("k=%d: %v", k, err)
		}
		assertTree(t, before, tree(t, project))
		if err := store.RecoverAll(); err != nil {
			t.Fatalf("повтор k=%d: %v", k, err)
		}
		if err := store.Publish(project, changes); err != nil {
			t.Fatalf("публикация после восстановления k=%d: %v", k, err)
		}
		assertTree(t, expectedAfter(t, before), tree(t, project))
	}
}

// Внешняя правка после сбоя — конфликт: ни один файл не перезаписывается и не удаляется,
// журнал и резервы остаются, запись в частично опубликованный проект запрещена.
func TestRecoveryConflictKeepsExternalEdits(t *testing.T) {
	cases := []struct {
		name string
		edit func(project string)
		path string
	}{
		{"изменён опубликованный файл", func(project string) {
			_ = os.WriteFile(filepath.Join(project, "plan", "cast.json"), []byte(`{"cast":"руками"}`), 0o640)
		}, "plan/cast.json"},
		{"изменён новый файл", func(project string) {
			_ = os.WriteFile(filepath.Join(project, "plan", "storyboard.md"), []byte("# Новые данные\n"), 0o600)
		}, "plan/storyboard.md"},
		{"удалённый файл создан заново", func(project string) {
			_ = os.WriteFile(filepath.Join(project, "ROADMAP.md"), []byte("# Свой план\n"), 0o644)
		}, "ROADMAP.md"},
		{"не опубликованный ещё файл изменён", func(project string) {
			_ = os.WriteFile(filepath.Join(project, "plan", "scenes.json"), []byte(`{"scenes":"руками"}`), 0o640)
		}, "plan/scenes.json"},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			project, store := newProject(t), newStore(t)
			changes := publication()
			crash(t, store, project, changes, len(changes)-1)
			// Последняя замена (удаление ROADMAP) не выполнена: для случая с ROADMAP применяем её.
			if item.path == "ROADMAP.md" {
				if err := apply(project, changes[len(changes)-1:]); err != nil {
					t.Fatal(err)
				}
			}
			if item.path == "plan/scenes.json" {
				// Прерывание после первой замены: scenes.json ещё прежний, его правит пользователь.
				project, store = newProject(t), newStore(t)
				crash(t, store, project, changes, 1)
			}
			item.edit(project)
			edited := tree(t, project)
			err := store.Recover(project)
			if err == nil || !strings.Contains(err.Error(), item.path+" изменён после прерванного применения") {
				t.Fatalf("конфликт не обнаружен: %v", err)
			}
			assertTree(t, edited, tree(t, project))
			if !store.Pending(project) {
				t.Fatal("журнал удалён при конфликте")
			}
			writeBlocked(t, project)
			if err := store.RecoverAll(); err == nil {
				t.Fatal("старт не сообщил о конфликте")
			}
			assertTree(t, edited, tree(t, project))
		})
	}
}

// Проект перенесён или без маркера: восстановление не создаёт папку из резервов и сохраняет журнал.
func TestRecoveryProjectUnavailable(t *testing.T) {
	project, store := newProject(t), newStore(t)
	crash(t, store, project, publication(), 2)
	moved := project + "-перенесён"
	if err := os.Rename(project, moved); err != nil {
		t.Fatal(err)
	}
	err := store.RecoverAll()
	if err == nil || !strings.Contains(err.Error(), "Проект недоступен по прежнему пути") {
		t.Fatalf("ошибка недоступного проекта: %v", err)
	}
	if _, statErr := os.Stat(project); !os.IsNotExist(statErr) {
		t.Fatal("папка проекта создана из резервов")
	}
	if err := os.Rename(moved, project); err != nil {
		t.Fatal(err)
	}
	if err := store.RecoverAll(); err != nil {
		t.Fatalf("после возврата папки: %v", err)
	}
}

// Неверный журнал не восстанавливается и не удаляется.
func TestRecoveryRejectsInvalidJournal(t *testing.T) {
	project, store := newProject(t), newStore(t)
	crash(t, store, project, publication(), 1)
	pendingPath := filepath.Join(store.directory(project), "pending.json")
	data, _ := os.ReadFile(pendingPath)
	broken := strings.Replace(string(data), `"plan/cast.json"`, `"plan/project.json"`, 1)
	if err := os.WriteFile(pendingPath, []byte(broken), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := store.Recover(project); err == nil || !strings.Contains(err.Error(), textRecoveryFormatInvalid) {
		t.Fatalf("неверный журнал: %v", err)
	}
	if !store.Pending(project) {
		t.Fatal("журнал удалён")
	}
}

// Повреждённый резерв останавливает восстановление до любых замен.
func TestRecoveryRejectsDamagedBackup(t *testing.T) {
	project, store := newProject(t), newStore(t)
	crash(t, store, project, publication(), 2)
	published := tree(t, project)
	if err := os.WriteFile(filepath.Join(store.directory(project), "0.bak"), []byte("мусор"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := store.Recover(project); err == nil || !strings.Contains(err.Error(), "повреждена") {
		t.Fatalf("повреждённый резерв: %v", err)
	}
	assertTree(t, published, tree(t, project))
}

// Ссылка на месте файла публикации не разыменовывается.
func TestPublishRejectsSymlinks(t *testing.T) {
	project, store := newProject(t), newStore(t)
	outside := filepath.Join(t.TempDir(), "outside.json")
	if err := os.WriteFile(outside, []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(project, "plan", "cast.json")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(project, "plan", "cast.json")); err != nil {
		t.Skip("ссылки недоступны:", err)
	}
	err := store.Publish(project, publication())
	if err == nil || err.Error() != textOrdinaryPathRequired("plan/cast.json", false) {
		t.Fatalf("ссылка: %v", err)
	}
	if data, _ := os.ReadFile(outside); string(data) != "{}" {
		t.Fatal("файл вне проекта изменён")
	}
}
