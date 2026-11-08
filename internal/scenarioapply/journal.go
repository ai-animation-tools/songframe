// Package scenarioapply — хранилище многофайловой публикации семейства «сценарий» (кастинг,
// трактовка, реестр, опись исходников и их производные виды) с журналом и восстановлением после
// сбоя. Само применение предложений агента (проверка в копии, штатные инструменты) выполняет
// internal/scenarioworkflow и публикует через Store.Publish.
//
// Устройство. Журнал живёт в каталоге состояния приложения, вне проекта:
// scenario-apply/<sha256(абсолютный путь проекта)>/pending.json и резервы <i>.bak. До первой
// замены сохраняются прежние байты каждого файла (или факт его отсутствия), права и SHA-256
// прежнего и нового содержимого. Пока pending.json существует, шлюз записи projectfs запрещает
// любую запись в проект (Store.WriteProblems), а восстановление выполняется при старте приложения
// (RecoverAll) и при открытии проекта (Recover) до снятия запрета.
//
// Перед откатом каждый файл сверяется с журналом. Допустимы только прежнее и опубликованное
// содержимое; всё иное — внешняя правка после сбоя, её восстановление не перезаписывает: ничего
// не трогается, журнал и резервы остаются, запись в проект запрещена до ручного разрешения.
package scenarioapply

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strings"

	"songframe/internal/projectfs"
	"songframe/internal/status"
)

// fixedViews — производные виды с постоянными путями.
var fixedViews = []string{
	"ROADMAP.md",
	"plan/edit-list.md",
	"plan/storyboard.md",
	"plan/context/characters.md",
	"plan/audio/timing.md",
	"assets/shots/manifest.json",
	"plan/animatic/cards/manifest.json",
}

// canonical — канонические документы семейства «сценарий».
var canonical = []string{"plan/cast.json", "plan/treatment.json", "plan/scenes.json", "source/manifest.json"}

var (
	shotReadme   = regexp.MustCompile(`^assets/shots/M\d{2}(?:\.\d+)?/README\.md$`)
	animaticCard = regexp.MustCompile(`^plan/animatic/cards/[^/]+\.png$`)
	sha256Hex    = regexp.MustCompile(`^[a-f0-9]{64}$`)
)

// relativePath — безопасный относительный путь с прямыми слешами: без абсолютного начала,
// обратных слешей, NUL, двоеточия (диск Windows) и сегментов «.»/«..».
func relativePath(path string) bool {
	if path == "" || filepath.IsAbs(path) || strings.HasPrefix(path, "/") || strings.ContainsAny(path, "\\\x00:") {
		return false
	}
	for _, part := range strings.Split(path, "/") {
		if part == "" || part == "." || part == ".." {
			return false
		}
	}
	return true
}

// RelativePath — путь файла относительно проекта с прямыми слешами; общий для пакетов сценария.
func RelativePath(path string) bool { return relativePath(path) }

// AllowedTarget — может ли публикация сценария менять этот файл проекта.
func AllowedTarget(path string) bool {
	return relativePath(path) && (slices.Contains(canonical, path) || slices.Contains(fixedViews, path) ||
		shotReadme.MatchString(path) || animaticCard.MatchString(path))
}

// lstat — lstat без ошибки для отсутствующего пути.
func lstat(path string) (fs.FileInfo, error) {
	info, err := os.Lstat(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	return info, err
}

// checkedPath — путь файла проекта, по которому копирование и восстановление не пойдут по
// ссылкам: каждый существующий сегмент — обычный каталог, последний — обычный файл.
func checkedPath(project, relative string) (string, error) {
	if !relativePath(relative) {
		return "", errors.New(textInvalidRelativePath(relative))
	}
	parts := strings.Split(relative, "/")
	for index := 1; index <= len(parts); index++ {
		name := strings.Join(parts[:index], "/")
		info, err := lstat(filepath.Join(project, filepath.FromSlash(name)))
		if err != nil {
			return "", err
		}
		if info == nil {
			continue
		}
		directory := index < len(parts)
		if info.Mode()&fs.ModeSymlink != 0 || (directory && !info.IsDir()) || (!directory && !info.Mode().IsRegular()) {
			return "", errors.New(textOrdinaryPathRequired(name, directory))
		}
	}
	return filepath.Join(project, filepath.FromSlash(relative)), nil
}

// CheckedPath — путь файла проекта для применения сценария без перехода по ссылкам; его
// использует и проверка в копии internal/scenarioworkflow.
func CheckedPath(project, relative string) (string, error) { return checkedPath(project, relative) }

// ReadFile — байты файла проекта по CheckedPath или nil, если файла нет.
func ReadFile(project, relative string) ([]byte, error) { return readCurrent(project, relative) }

// readCurrent — байты файла проекта или nil, если его нет.
func readCurrent(project, relative string) ([]byte, error) {
	path, err := checkedPath(project, relative)
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	return data, err
}

// digest — SHA-256 содержимого; nil (файла нет) даёт nil.
func digest(data []byte) *string {
	if data == nil {
		return nil
	}
	sum := sha256.Sum256(data)
	text := hex.EncodeToString(sum[:])
	return &text
}

func sameDigest(left, right *string) bool {
	if left == nil || right == nil {
		return left == right
	}
	return *left == *right
}

// Change — замена одного файла публикации: Next — новые байты, nil удаляет файл.
type Change struct {
	Path string
	Next []byte
}

// entry — запись журнала о файле публикации.
type entry struct {
	// Path — путь внутри проекта с прямыми слешами.
	Path string `json:"path"`
	// Backup — имя резерва «<i>.bak» в каталоге журнала или null, если файла до публикации не было.
	Backup *string `json:"backup"`
	// Mode — права прежнего файла (0..0o777); отсутствует вместе с файлом.
	Mode *uint32 `json:"mode,omitempty"`
	// Before и Next — SHA-256 прежнего и опубликованного содержимого (null — файла нет).
	// По ним восстановление отличает свою незавершённую замену от внешней правки.
	Before *string `json:"before"`
	Next   *string `json:"next"`
}

// journal — pending.json в каталоге состояния приложения.
type journal struct {
	SchemaVersion int     `json:"schemaVersion"`
	Project       string  `json:"project"`
	Files         []entry `json:"files"`
}

// Store — журнал публикаций сценария в каталоге состояния приложения. Нулевое значение не
// используется; создаётся NewStore. Методы безопасны для последовательного вызова из сервисов;
// одновременную публикацию одного проекта исключает вызывающий (одно окно, одно действие).
type Store struct {
	localDir string
}

// NewStore — хранилище в каталоге состояния localDir.
func NewStore(localDir string) Store { return Store{localDir: localDir} }

// directory — каталог журнала проекта: sha256 абсолютного пути.
func (s Store) directory(project string) string {
	sum := sha256.Sum256([]byte(project))
	return filepath.Join(s.localDir, "scenario-apply", hex.EncodeToString(sum[:]))
}

// absolute — абсолютный нормализованный путь проекта.
func absolute(project string) (string, error) {
	if project == "" {
		return "", fmt.Errorf("не задана папка проекта")
	}
	return filepath.Abs(project)
}

// Pending — есть ли у проекта незавершённая публикация.
func (s Store) Pending(project string) bool {
	path, err := absolute(project)
	if err != nil {
		return false
	}
	_, err = os.Lstat(filepath.Join(s.directory(path), "pending.json"))
	return err == nil
}

// WriteProblems — проверка для шлюза записи projectfs: при незавершённой публикации запись в
// проект запрещена, пока восстановление не вернёт согласованное состояние файлов.
func (s Store) WriteProblems(project string) []string {
	if s.Pending(project) {
		return []string{textRecoveryPending}
	}
	return nil
}

// Точки подмены для проверок сбоя (A-11): запись резерва, замена или удаление файла проекта и
// удаление журнала после публикации.
var (
	writeBackup   = func(path string, data []byte) error { return projectfs.WriteFile(path, data, 0o600) }
	replaceFile   = func(path string, data []byte, mode os.FileMode) error { return projectfs.WriteFile(path, data, mode) }
	removeFile    = func(path string) error { return ignoreMissing(os.Remove(path)) }
	removeJournal = os.Remove
)

func ignoreMissing(err error) error {
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	return err
}

// Changes — из кандидатов остаются только файлы, чьё содержимое
// действительно меняется (удаление отсутствующего и запись тех же байтов отбрасываются).
func (s Store) Changes(project string, candidates []Change) ([]Change, error) {
	result := []Change{}
	for _, candidate := range candidates {
		previous, err := readCurrent(project, candidate.Path)
		if err != nil {
			return nil, err
		}
		if (previous == nil && candidate.Next == nil) || (previous != nil && candidate.Next != nil && bytes.Equal(previous, candidate.Next)) {
			continue
		}
		result = append(result, candidate)
	}
	return result, nil
}

// begin сохраняет резервы и журнал до первой замены. Сбой здесь не трогает проект и не оставляет
// журнала (остатки резервов без pending.json убираются следующей публикацией).
func (s Store) begin(project string, changes []Change) (string, journal, error) {
	directory := s.directory(project)
	pendingPath := filepath.Join(directory, "pending.json")
	if _, err := os.Lstat(pendingPath); err == nil {
		return "", journal{}, errors.New(textRecoveryPending)
	}
	clearBackups(directory)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return "", journal{}, err
	}
	record := journal{SchemaVersion: 1, Project: project, Files: []entry{}}
	seen := map[string]bool{}
	for index, change := range changes {
		if !AllowedTarget(change.Path) {
			return "", journal{}, errors.New(textUnsupportedFile(change.Path))
		}
		if seen[change.Path] {
			return "", journal{}, errors.New(textDuplicateFile(change.Path))
		}
		seen[change.Path] = true
		path, err := checkedPath(project, change.Path)
		if err != nil {
			return "", journal{}, err
		}
		previous, err := readCurrent(project, change.Path)
		if err != nil {
			return "", journal{}, err
		}
		item := entry{Path: change.Path, Before: digest(previous), Next: digest(change.Next)}
		if previous != nil {
			name := fmt.Sprintf("%d.bak", index)
			if err := writeBackup(filepath.Join(directory, name), previous); err != nil {
				return "", journal{}, err
			}
			item.Backup = &name
			if info, err := os.Stat(path); err == nil {
				mode := uint32(info.Mode().Perm())
				item.Mode = &mode
			}
		}
		record.Files = append(record.Files, item)
	}
	data, err := json.MarshalIndent(record, "", "  ")
	if err != nil {
		return "", journal{}, err
	}
	if err := projectfs.WriteFile(pendingPath, append(data, '\n'), 0o600); err != nil {
		return "", journal{}, err
	}
	return directory, record, nil
}

// apply заменяет файлы проекта по порядку публикации.
func apply(project string, changes []Change) error {
	for _, change := range changes {
		target, err := checkedPath(project, change.Path)
		if err != nil {
			return err
		}
		if change.Next == nil {
			err = removeFile(target)
		} else {
			err = replaceFile(target, change.Next, 0)
		}
		if err != nil {
			return err
		}
	}
	return nil
}

// Publish — резервы и журнал, затем замены. Сбой замены сразу
// откатывает уже заменённые файлы и возвращает исходную ошибку; если откат не удался, журнал
// остаётся (запись в проект запрещена до восстановления) и ошибка объясняет обе причины. Пустой
// список ничего не делает. Запись проверяет шлюз projectfs (журналы других областей).
func (s Store) Publish(project string, changes []Change) error {
	if len(changes) == 0 {
		return nil
	}
	project, err := absolute(project)
	if err != nil {
		return err
	}
	if s.Pending(project) {
		return errors.New(textRecoveryPending)
	}
	if err := projectfs.CheckWrite(project); err != nil {
		return err
	}
	directory, record, err := s.begin(project, changes)
	if err != nil {
		return err
	}
	pendingPath := filepath.Join(directory, "pending.json")
	err = apply(project, changes)
	if err == nil {
		err = removeJournal(pendingPath)
	}
	if err != nil {
		if restoreErr := restore(directory, record); restoreErr != nil {
			return errors.New(textRecoveryIncomplete(err.Error(), restoreErr.Error()))
		}
		if removeErr := removeJournal(pendingPath); removeErr != nil {
			return errors.New(textRecoveryIncomplete(err.Error(), removeErr.Error()))
		}
		clearBackups(directory)
		return err
	}
	clearBackups(directory)
	return nil
}

// clearBackups убирает каталог журнала; ошибка не важна — остатки без pending.json безопасны.
func clearBackups(directory string) { _ = os.RemoveAll(directory) }

// restore — откат по журналу. Сначала проверяются проект и пути, читаются все резервы и
// сверяется текущее состояние каждого файла: только «прежнее» или «опубликованное». Любой иной
// файл — внешняя правка: ничего не меняется, ошибка-конфликт. Затем файлы, отличные от прежних,
// получают байты и права резерва либо удаляются, если до публикации их не было.
func restore(directory string, record journal) error {
	project := record.Project
	if info, err := os.Stat(project); err != nil || !info.IsDir() || status.ReadMarker(project) == nil {
		return errors.New(textRecoveryProjectUnavailable(project))
	}
	if _, err := checkedPath(project, "plan/project.json"); err != nil {
		return err
	}
	originals := make([][]byte, len(record.Files))
	for index, item := range record.Files {
		if item.Backup == nil {
			continue
		}
		data, err := os.ReadFile(filepath.Join(directory, *item.Backup))
		if err != nil {
			return err
		}
		if !sameDigest(digest(data), item.Before) {
			return errors.New(textBackupDamaged(item.Path))
		}
		originals[index] = data
	}
	pending := []int{}
	for index, item := range record.Files {
		current, err := readCurrent(project, item.Path)
		if err != nil {
			return err
		}
		state := digest(current)
		switch {
		case sameDigest(state, item.Before):
		case sameDigest(state, item.Next):
			pending = append(pending, index)
		default:
			return errors.New(textRecoveryConflict(item.Path, directory))
		}
	}
	problems := []string{}
	for _, index := range pending {
		item := record.Files[index]
		target, err := checkedPath(project, item.Path)
		if err == nil {
			if originals[index] == nil {
				err = removeFile(target)
			} else {
				mode := os.FileMode(0)
				if item.Mode != nil {
					mode = os.FileMode(*item.Mode)
				}
				err = replaceFile(target, originals[index], mode)
			}
		}
		if err != nil {
			problems = append(problems, item.Path+": "+err.Error())
		}
	}
	if len(problems) > 0 {
		return errors.New(strings.Join(problems, " "))
	}
	return nil
}

// readJournal читает и проверяет pending.json каталога: формат, принадлежность каталогу,
// допустимые пути без повторов, имена резервов, права и отпечатки.
func (s Store) readJournal(directory string) (journal, error) {
	data, err := os.ReadFile(filepath.Join(directory, "pending.json"))
	if err != nil {
		return journal{}, err
	}
	var record journal
	invalid := errors.New(textRecoveryFormatInvalid)
	if json.Unmarshal(data, &record) != nil || record.SchemaVersion != 1 || !filepath.IsAbs(record.Project) ||
		s.directory(filepath.Clean(record.Project)) != directory || len(record.Files) == 0 {
		return journal{}, invalid
	}
	seen := map[string]bool{}
	for index, item := range record.Files {
		validDigest := func(value *string) bool { return value == nil || sha256Hex.MatchString(*value) }
		if !AllowedTarget(item.Path) || seen[item.Path] || !validDigest(item.Before) || !validDigest(item.Next) ||
			(item.Backup != nil && *item.Backup != fmt.Sprintf("%d.bak", index)) || (item.Backup == nil) != (item.Before == nil) ||
			(item.Mode != nil && *item.Mode > 0o777) {
			return journal{}, invalid
		}
		seen[item.Path] = true
	}
	return record, nil
}

// recoverDirectory восстанавливает одну незавершённую публикацию; без pending.json — ничего.
func (s Store) recoverDirectory(directory string) error {
	pendingPath := filepath.Join(directory, "pending.json")
	if _, err := os.Lstat(pendingPath); err != nil {
		return nil
	}
	record, err := s.readJournal(directory)
	if err != nil {
		return err
	}
	if err := restore(directory, record); err != nil {
		return err
	}
	if err := removeJournal(pendingPath); err != nil {
		return err
	}
	clearBackups(directory)
	return nil
}

// Recover — восстановление публикации одного проекта; вызывается при открытии проекта до того,
// как он станет текущим. Ошибка в формате recoveryFailed; журнал и резервы при ней сохраняются.
func (s Store) Recover(project string) error {
	path, err := absolute(project)
	if err != nil {
		return err
	}
	directory := s.directory(path)
	if err := s.recoverDirectory(directory); err != nil {
		return errors.New(textRecoveryFailed(filepath.Base(directory) + ": " + err.Error()))
	}
	return nil
}

// RecoverAll — при старте приложения восстанавливает все
// незавершённые публикации каталога состояния. Сбой одной не мешает остальным; ошибки собираются
// в одно сообщение recoveryFailed.
func (s Store) RecoverAll() error {
	base := filepath.Join(s.localDir, "scenario-apply")
	entries, err := os.ReadDir(base)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	names := []string{}
	for _, item := range entries {
		if item.IsDir() && sha256Hex.MatchString(item.Name()) {
			names = append(names, item.Name())
		}
	}
	sort.Strings(names)
	failures := []string{}
	for _, name := range names {
		if err := s.recoverDirectory(filepath.Join(base, name)); err != nil {
			failures = append(failures, name+": "+err.Error())
		}
	}
	if len(failures) > 0 {
		return errors.New(textRecoveryFailed(strings.Join(failures, " ")))
	}
	return nil
}

// RegisterWriteCheck подключает Store к шлюзу записи projectfs под именем «scenario-apply»:
// пока у проекта есть pending.json, любая запись в него запрещена.
func (s Store) RegisterWriteCheck() { projectfs.SetWriteCheck("scenario-apply", s.WriteProblems) }
