package montage

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"syscall"

	"songframe-go/internal/applymontage"
	"songframe-go/internal/jscompat"
	"songframe-go/internal/projectfs"
	"songframe-go/internal/store"
)

// Восстановление прерванной публикации ручного монтажа без инструмента: журнал
// plan/montage-history/<id>/journal.json в состоянии publishing откатывается
// по резервам before/ до того, как проект станет текущим. Журнал пишет internal/applymontage.

// fixedTargets — постоянные файлы, которые публикует применение монтажа.
var fixedTargets = map[string]bool{
	"plan/scenes.json":                  true,
	"plan/production-status.json":       true,
	"ROADMAP.md":                        true,
	"plan/edit-list.md":                 true,
	"plan/storyboard.md":                true,
	"plan/context/characters.md":        true,
	"plan/audio/timing.md":              true,
	"assets/shots/manifest.json":        true,
	"plan/animatic/cards/manifest.json": true,
}

var (
	journalName   = regexp.MustCompile(`^[a-f0-9]{32}$`)
	journalSha    = regexp.MustCompile(`^[a-f0-9]{64}$`)
	shotTarget    = regexp.MustCompile(`^assets/shots/M\d{2}(?:\.\d+)?/(manifest\.json|README\.md)$`)
	cardTarget    = regexp.MustCompile(`^plan/animatic/cards/M\d{2}(?:\.\d+)?\.png$`)
	errNotJournal = errors.New("not a journal")
)

// targetAllowed — файл журнала относится к набору публикации монтажа: чужой путь (исходники,
// оригиналы) откат не трогает.
func targetAllowed(path string) bool {
	return fixedTargets[path] || shotTarget.MatchString(path) || cardTarget.MatchString(path)
}

// Digest — SHA-256 файла или nil, если пути нет; каталог — ошибка чтения node:fs.
func Digest(path string) (*string, error) {
	if !jscompat.Exists(path) {
		return nil, nil
	}
	value, err := fileHash(path)
	if err != nil {
		return nil, err
	}
	return &value, nil
}

// ReadJournal — readLocalJson(path): nil без ошибки для отсутствующего файла; повреждённый JSON и
// примитив — ошибка «Не удалось прочитать <путь>: <причина>…». Массив допускается (typeof object).
func ReadJournal(path string) (any, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, syscall.ENOENT) {
		return nil, nil
	}
	if err != nil {
		return nil, errors.New(textLocalReadFailed(path, ReadError(path, err).Error()))
	}
	value, err := jscompat.Parse([]byte(jscompat.DecodeUTF8(data)))
	if err != nil {
		return nil, errors.New(textLocalReadFailed(path, err.Error()))
	}
	if _, isObject := jscompat.AsObject(value); !isObject && !jscompat.IsArray(value) {
		return nil, errors.New(textLocalReadFailed(path, objectExpected))
	}
	return value, nil
}

// journalEntry — запись files журнала: путь и SHA-256 до/после (nil — файла не было/нет).
type journalEntry struct {
	path          string
	before, after *string
}

// shaField — before/after записи: null или SHA-256 строчными буквами.
func shaField(value any) (*string, bool) {
	if value == nil {
		return nil, true
	}
	text, ok := value.(string)
	if !ok || !journalSha.MatchString(text) {
		return nil, false
	}
	return &text, true
}

// journalFiles — проверка журнала: схема 1, id равен имени папки, files — массив записей с
// разрешёнными неповторяющимися путями и корректными SHA. Иначе errNotJournal.
func journalFiles(journal *jscompat.Object, name string) ([]journalEntry, error) {
	files, ok := jscompat.AsArray(journal.Value("files"))
	if !jscompat.StrictEqual(journal.Value("schema_version"), 1.0) || !jscompat.StrictEqual(journal.Value("id"), name) || !ok {
		return nil, errNotJournal
	}
	entries := []journalEntry{}
	seen := map[string]bool{}
	for _, item := range files {
		if !jscompat.Truthy(item) {
			return nil, errNotJournal
		}
		path, ok := jscompat.Get(item, "path").(string)
		if !ok || !targetAllowed(path) {
			return nil, errNotJournal
		}
		before, beforeOK := shaField(jscompat.Get(item, "before"))
		after, afterOK := shaField(jscompat.Get(item, "after"))
		if !beforeOK || !afterOK {
			return nil, errNotJournal
		}
		entries = append(entries, journalEntry{path: path, before: before, after: after})
	}
	for _, entry := range entries {
		if seen[entry.path] {
			return nil, errNotJournal
		}
		seen[entry.path] = true
	}
	return entries, nil
}

// sameDigest — current === expected для SHA или null.
func sameDigest(current, expected *string) bool {
	if current == nil || expected == nil {
		return current == nil && expected == nil
	}
	return *current == *expected
}

// RecoverApplications — recoverMontageApplications(project): каждый журнал (папка с именем из 32
// строчных hex) в состоянии publishing откатывается. Весь набор файлов проверяется до первой
// записи: файл, изменённый после сбоя, или повреждённый резерв останавливает восстановление, и
// последующая ручная правка не теряется. Затем файлы возвращаются в обратном порядке (новые —
// удаляются), журнал получает state rolled_back, staging удаляется. Запись идёт мимо шлюза
// проекта: шлюз как раз запрещает запись, пока журнал publishing. Повторный вызов ничего не меняет.
func RecoverApplications(project string) error {
	history := filepath.Join(project, "plan", "montage-history")
	if !jscompat.Exists(history) {
		return nil
	}
	entries, err := jscompat.ReadDir(history)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if !entry.IsDir() || !journalName.MatchString(entry.Name()) {
			continue
		}
		directory := filepath.Join(history, entry.Name())
		path := filepath.Join(directory, "journal.json")
		value, err := ReadJournal(path)
		if err != nil {
			return err
		}
		if value == nil || !jscompat.StrictEqual(jscompat.Get(value, "state"), "publishing") {
			continue
		}
		journal, _ := jscompat.AsObject(value)
		files, err := journalFiles(journal, entry.Name())
		if err != nil {
			return errors.New(textUnknownJournal(path))
		}
		backups := make([][]byte, len(files))
		for index, file := range files {
			current, err := Digest(filepath.Join(project, filepath.FromSlash(file.path)))
			if err != nil {
				return err
			}
			if !sameDigest(current, file.before) && !sameDigest(current, file.after) {
				return errors.New(textRecoveryFileChanged(file.path, directory))
			}
			if file.before == nil {
				continue
			}
			backup := filepath.Join(directory, "before", filepath.FromSlash(file.path))
			data, err := os.ReadFile(backup)
			if err != nil {
				return ReadError(backup, err)
			}
			sum := sha256.Sum256(data)
			if hex.EncodeToString(sum[:]) != *file.before {
				return errors.New(textRecoveryBackupCorrupt(file.path, directory))
			}
			backups[index] = data
		}
		for index := len(files) - 1; index >= 0; index-- {
			target := filepath.Join(project, filepath.FromSlash(files[index].path))
			if files[index].before == nil {
				// rmSync(path, { force: true }): отсутствующий файл — не ошибка.
				if err := os.Remove(target); err != nil && !errors.Is(err, syscall.ENOENT) {
					return jscompat.FsError("rm", target, err)
				}
				continue
			}
			if err := projectfs.WriteFile(target, backups[index], 0); err != nil {
				return err
			}
		}
		// { ...journal, state: 'rolled_back' }: ключ state остаётся на своём месте.
		rolled := journal.Clone()
		rolled.Set("state", "rolled_back")
		if err := projectfs.WriteFile(path, encode(rolled), 0); err != nil {
			return err
		}
		if err := os.RemoveAll(filepath.Join(directory, "staging")); err != nil {
			return err
		}
	}
	return nil
}

// RecoverOpened — восстановление при открытии проекта: живую публикацию
// не откатываем — пока в этом процессе выполняется apply_montage, журнал publishing принадлежит ей.
func RecoverOpened(project string) error {
	if applymontage.Active() {
		return nil
	}
	return RecoverApplications(project)
}

// RecoverProjects — восстановление при запуске приложения: текущий проект и все проекты истории
// каталога состояния localDir. Первая ошибка прерывает обход; вызывающий снимает текущий проект.
func RecoverProjects(localDir string) error { return EachKnownProject(localDir, RecoverApplications) }

// EachKnownProject вызывает visit для текущего проекта и проектов истории каталога состояния
// localDir, по одному разу, в порядке «текущий, затем история». Первая ошибка (чтение состояния или
// конфликт журнала) прерывает обход. Общий обход восстановления монтажа и производных планов.
func EachKnownProject(localDir string, visit func(project string) error) error {
	state := store.NewLocalState(localDir)
	current, err := state.Current()
	if err != nil {
		return err
	}
	history, err := state.History()
	if err != nil {
		return err
	}
	seen := map[string]bool{}
	projects := []string{current}
	for _, item := range history {
		projects = append(projects, item.Path)
	}
	for _, project := range projects {
		if project == "" || seen[project] {
			continue
		}
		seen[project] = true
		if err := visit(project); err != nil {
			return err
		}
	}
	return nil
}
