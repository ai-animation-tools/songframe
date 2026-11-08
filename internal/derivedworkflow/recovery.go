package derivedworkflow

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"songframe/internal/deriveshot"
	"songframe/internal/dynvalue"
	"songframe/internal/montage"
	"songframe/internal/projectfs"
)

// Восстановление прерванной приёмки без инструмента: журнал
// plan/derived-history/<id>/journal.json в состоянии publishing откатывается до открытия проекта.
// В отличие от CLI recover здесь журналу не доверяют: откат трогает только файлы публикации, и весь
// набор со всеми резервами сверяется до первой записи.

// publicationDocuments — постоянные файлы, которые публикует приёмка.
var publicationDocuments = map[string]bool{
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
	readmeTarget = regexp.MustCompile(`^assets/shots/M\d{2}(?:\.\d+)?/README\.md$`)
	cardTarget   = regexp.MustCompile(`^plan/animatic/cards/[^/]+\.png$`)
	journalName  = regexp.MustCompile(`^(?:[a-f0-9]{32}|[a-f0-9-]{36})$`)
)

// publicationFile — путь относится к набору публикации: чужой файл откат не трогает.
func publicationFile(path string) bool {
	return publicationDocuments[path] || readmeTarget.MatchString(path) || cardTarget.MatchString(path)
}

// localPath — относительный путь без «..», «.», пустых частей и обратных косых черт.
func localPath(value any) bool {
	path, ok := value.(string)
	if !ok || path == "" || strings.Contains(path, `\`) || strings.HasPrefix(path, "/") {
		return false
	}
	for _, part := range strings.Split(path, "/") {
		if part == ".." || part == "" || part == "." {
			return false
		}
	}
	return true
}

// descriptorMap — before_files/after_files: относительный путь → SHA-256; иначе nil.
func descriptorMap(value any) map[string]string {
	object, ok := dynvalue.AsObject(value)
	if !ok || !dynvalue.IsRecord(value) {
		return nil
	}
	result := map[string]string{}
	for _, key := range object.Keys() {
		sha, ok := object.Value(key).(string)
		if !localPath(key) || !ok || !shaPattern.MatchString(sha) {
			return nil
		}
		result[key] = sha
	}
	return result
}

// treeHashes — путь → SHA-256 содержимого папки или nil, если её нет. Ссылка внутри
// или сам путь не-папка — отказ: резерв восстановления обязан быть обычным деревом файлов.
func treeHashes(path string) (map[string]string, error) {
	if !dynvalue.Exists(path) {
		return nil, nil
	}
	if info, err := os.Lstat(path); err != nil {
		return nil, dynvalue.FsError("lstat", path, err)
	} else if !info.IsDir() {
		return nil, errors.New(textRecoveryFailed(path))
	}
	result := map[string]string{}
	var walk func(directory, prefix string) error
	walk = func(directory, prefix string) error {
		entries, err := dynvalue.ReadDir(directory)
		if err != nil {
			return err
		}
		for _, entry := range entries {
			name := entry.Name()
			if prefix != "" {
				name = prefix + "/" + entry.Name()
			}
			path := filepath.Join(directory, entry.Name())
			switch {
			case entry.Type()&os.ModeSymlink != 0:
				return errors.New(textRecoveryFailed(directory))
			case entry.IsDir():
				if err := walk(path, name); err != nil {
					return err
				}
			case entry.Type().IsRegular():
				digest, err := montage.Digest(path)
				if err != nil {
					return err
				}
				result[name] = *digest
			}
		}
		return nil
	}
	return result, walk(path, "")
}

// sameTree — снимки папок совпадают по составу и SHA-256; nil (папки нет) равно только nil.
func sameTree(left, right map[string]string) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	if len(left) != len(right) {
		return false
	}
	for path, digest := range left {
		if value, ok := right[path]; !ok || value != digest {
			return false
		}
	}
	return true
}

// recoveryFile — запись files журнала с прочитанным и проверенным резервом.
type recoveryFile struct {
	path  string
	bytes []byte
}

// checkedFiles проверяет форму files журнала: только файлы публикации без повторов и с верными SHA.
func checkedFiles(files []any) bool {
	seen := map[string]bool{}
	for _, file := range files {
		path := dynvalue.Get(file, "path")
		if !dynvalue.Truthy(file) || !localPath(path) || !publicationFile(path.(string)) || seen[path.(string)] {
			return false
		}
		seen[path.(string)] = true
		for _, key := range []string{"before", "after"} {
			value := dynvalue.Get(file, key)
			if text, ok := value.(string); value != nil && (!ok || !shaPattern.MatchString(text)) {
				return false
			}
		}
	}
	return true
}

// shaEqual — current совпадает с SHA журнала (before/after): строка SHA или null (файла нет).
func shaEqual(current *string, value any) bool {
	if current == nil {
		return value == nil
	}
	return dynvalue.StrictEqual(*current, value)
}

// rollback возвращает один журнал publishing: проверки, затем комплект, файлы, журнал и staging.
func rollback(project, name, directory, path string, journal *dynvalue.Object) error {
	fail := errors.New(textRecoveryFailed(path))
	shot := journal.Value("shot")
	files, filesOK := dynvalue.AsArray(journal.Value("files"))
	if !dynvalue.StrictEqual(journal.Value("schema_version"), 1.0) || !dynvalue.StrictEqual(journal.Value("id"), name) ||
		!shotPattern.MatchString(dynvalue.ToString(shot)) || !filesOK || !dynvalue.IsRecord(journal.Value("directory")) {
		return fail
	}
	kit, _ := dynvalue.AsObject(journal.Value("directory"))
	beforeValue, afterValue := kit.Value("before_files"), kit.Value("after_files")
	before, after := descriptorMap(beforeValue), descriptorMap(afterValue)
	shotName := dynvalue.ToString(shot)
	if !dynvalue.StrictEqual(kit.Value("path"), "assets/shots/"+shotName) ||
		!dynvalue.StrictEqual(kit.Value("backup"), "plan/derived-history/"+name+"/before-kit") ||
		!dynvalue.StrictEqual(kit.Value("retired"), "assets/replaced/"+shotName+"/"+name) ||
		(beforeValue != nil && before == nil) || after == nil {
		return fail
	}
	if !checkedFiles(files) {
		return fail
	}
	target := filepath.Join(project, "assets", "shots", shotName)
	backup := filepath.Join(directory, "before-kit")
	retired := filepath.Join(project, "assets", "replaced", shotName, name)
	current, err := treeHashes(target)
	if err != nil {
		return err
	}
	if current != nil && !sameTree(current, before) && !sameTree(current, after) {
		return fail
	}
	if before != nil {
		saved, err := treeHashes(backup)
		if err != nil {
			return err
		}
		if !sameTree(saved, before) {
			return fail
		}
	}
	if dynvalue.Exists(retired) {
		saved, err := treeHashes(retired)
		if err != nil {
			return err
		}
		if !sameTree(saved, before) {
			return fail
		}
	}
	backups := make([]recoveryFile, len(files))
	for index, file := range files {
		name := dynvalue.Get(file, "path").(string)
		live, err := montage.Digest(filepath.Join(project, filepath.FromSlash(name)))
		if err != nil {
			return err
		}
		fileBefore := dynvalue.Get(file, "before")
		if !shaEqual(live, fileBefore) && !shaEqual(live, dynvalue.Get(file, "after")) {
			return fail
		}
		backups[index].path = name
		if fileBefore == nil {
			continue
		}
		saved := filepath.Join(directory, "before", filepath.FromSlash(name))
		data, err := os.ReadFile(saved)
		if err != nil {
			return montage.ReadError(saved, err)
		}
		sum := sha256.Sum256(data)
		if hex.EncodeToString(sum[:]) != fileBefore {
			return fail
		}
		backups[index].bytes = data
	}
	if before == nil {
		if err := os.RemoveAll(target); err != nil {
			return err
		}
	} else {
		temporary := filepath.Join(directory, "restore-kit")
		if err := os.RemoveAll(temporary); err != nil {
			return err
		}
		if err := deriveshot.CopyKit(backup, temporary); err != nil {
			return err
		}
		if err := os.RemoveAll(target); err != nil {
			return err
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o777); err != nil {
			return err
		}
		if err := os.Rename(temporary, target); err != nil {
			return err
		}
	}
	for index := len(backups) - 1; index >= 0; index-- {
		path := filepath.Join(project, filepath.FromSlash(backups[index].path))
		if backups[index].bytes == nil {
			if err := os.RemoveAll(path); err != nil {
				return err
			}
		} else if err := projectfs.WriteFile(path, backups[index].bytes, 0); err != nil {
			return err
		}
	}
	if err := os.RemoveAll(retired); err != nil {
		return err
	}
	// { ...journal, state: 'rolled_back' }: ключ state остаётся на своём месте.
	rolled := journal.Clone()
	rolled.Set("state", "rolled_back")
	if err := projectfs.WriteFile(path, encode(rolled), 0); err != nil {
		return err
	}
	return os.RemoveAll(filepath.Join(directory, "staging"))
}

// RecoverApplications — откатывает журналы publishing. Запись
// идёт мимо шлюза проекта: шлюз как раз запрещает запись, пока журнал publishing. Изменённый после
// сбоя файл останавливает откат, данные и журнал сохраняются. Повторный вызов ничего не меняет.
func RecoverApplications(project string) error {
	history := filepath.Join(project, "plan", "derived-history")
	if !dynvalue.Exists(history) {
		return nil
	}
	entries, err := dynvalue.ReadDir(history)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if !entry.IsDir() || !journalName.MatchString(entry.Name()) {
			continue
		}
		directory := filepath.Join(history, entry.Name())
		path := filepath.Join(directory, "journal.json")
		value, err := montage.ReadJournal(path)
		if err != nil {
			return err
		}
		journal, isObject := dynvalue.AsObject(value)
		if !isObject || !dynvalue.StrictEqual(journal.Value("state"), "publishing") {
			continue
		}
		if err := rollback(project, entry.Name(), directory, path, journal); err != nil {
			return err
		}
	}
	return nil
}

// toolActive — признак выполняющейся команды инструмента; точка подмены теста живой публикации.
var toolActive = deriveshot.Active

// RecoverOpened — восстановление при открытии проекта: живую публикацию не
// откатываем — пока в этом процессе выполняется derive_shot над проектом, журнал принадлежит ему.
func RecoverOpened(project string) error {
	if toolActive(project) {
		return nil
	}
	return RecoverApplications(project)
}

// RecoverProjects — восстановление при запуске приложения: текущий проект и проекты истории
// каталога состояния localDir; первая ошибка прерывает обход.
func RecoverProjects(localDir string) error {
	return montage.EachKnownProject(localDir, RecoverApplications)
}
