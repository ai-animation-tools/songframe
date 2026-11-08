package productionworkflow

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"

	"songframe-go/internal/jscompat"
	"songframe-go/internal/projectfs"
)

// Узкий журнал замены рабочего пакета. Перед Apply
// изменяемая часть пакета копируется в каталог состояния, а намерение отката записывается в
// pending.json; после успеха журнал удаляется, после ошибки или обрыва процесса пакет
// возвращается к резерву. Платные попытки никогда не откатываются и не заменяются: пакет с
// отправленным видео или неопознанной оплатой Apply не трогает, а проверенные image-попытки
// (ImageRoots) остаются на месте — ни в резерв, ни поверх них ничего не копируется.
//
// Владение: каталог <LocalDir>/production-apply/<SHA-256 «проект\0пакет»>/ принадлежит одному
// применению; параллельные Apply одного плана исключает Workflow (busy), разные пакеты не
// пересекаются по каталогу. Восстановление при старте (RecoverInterrupted) выполняется до
// открытия окна, поэтому одновременно с Apply не идёт.

// ApplyFolder — каталог журналов замены пакета внутри каталога состояния приложения.
const ApplyFolder = "production-apply"

// pendingSchema — версия pending.json: пишется и читается только v2 (с защищёнными
// image-попытками), другие версии отклоняются.
const pendingSchema = 2

var journalName = regexp.MustCompile(`^[a-f0-9]{64}$`)

// protectedImage — снимок проверенной image-попытки на момент начала Apply: папка от пакета,
// SHA-256 запроса, опора и отпечатки всех её файлов (nil у папки: даже пустые каталоги
// попытки сохраняются). Сравнение с текущим деревом доказывает, что оригиналы не тронуты.
type protectedImage struct {
	ImageRoot
	Files *jscompat.Object
}

// tree — запись защищённой попытки в pending.json в порядке ключей { requestDir, requestSha256,
// frameId, files }.
func (p protectedImage) tree() *jscompat.Object {
	object := jscompat.NewObject()
	object.Set("requestDir", p.RequestDir)
	object.Set("requestSha256", p.RequestSha256)
	object.Set("frameId", p.FrameID)
	object.Set("files", p.Files)
	return object
}

// pending — намерение отката: проект (реальный путь), пакет от проекта, существовал ли пакет до
// Apply и защищённые image-попытки.
type pending struct {
	Project    string
	PackageDir string
	Existed    bool
	Protected  []protectedImage
}

// tree — pending.json в зафиксированном порядке ключей (байты журнала сверяет эталон).
func (p pending) tree() *jscompat.Object {
	images := make([]any, len(p.Protected))
	for index, image := range p.Protected {
		images[index] = image.tree()
	}
	object := jscompat.NewObject()
	object.Set("schemaVersion", float64(pendingSchema))
	object.Set("project", p.Project)
	object.Set("packageDir", p.PackageDir)
	object.Set("existed", p.Existed)
	object.Set("protectedImages", &jscompat.Array{Items: images})
	return object
}

// journalDirectory — каталог журнала пакета packageDir проекта project.
func journalDirectory(localDir, project, packageDir string) string {
	return filepath.Join(localDir, ApplyFolder, digestHex([]byte(project+"\x00"+packageDir)))
}

// applyPackagePath — packagePath журнала: путь внутри проекта, указывающий ровно на отдельный
// пакет. Текст отказа у журнала свой (productionTexts.main.apply.packageFolderRequired).
func applyPackagePath(project, path string) (string, error) {
	full, err := ProductionPath(project, path)
	if err != nil {
		return "", err
	}
	if !packageFolder.MatchString(rel(project, full)) {
		return "", errors.New(textApplyPackageFolderRequired)
	}
	return full, nil
}

// videoStage — этап пакета после отправки видео.
func videoStage(workflow *jscompat.Object) bool {
	return slices.Contains(videoStages, jscompat.ToString(workflow.Value("stage")))
}

// packagePaid сообщает, что пакет есть и уже отправлял видео либо содержит
// любую оплату, включая проверенные image-попытки. Резерв с такой оплатой не восстанавливается.
func packagePaid(directory string) (bool, error) {
	if !jscompat.Exists(directory) {
		return false, nil
	}
	workflow, err := packageWorkflow(directory)
	if err != nil {
		return false, err
	}
	if videoStage(workflow) {
		return true, nil
	}
	return attemptsPaid(directory, nil)
}

// imageFiles — отпечатки всех файлов и папок image-попытки directory (ключ —
// путь от неё с разделителем ОС). Ссылка или особый файл — отказ: их байты нельзя доказать.
// Ключи упорядочены по кодовым единицам UTF-16, а не localeCompare: порядок влияет только на
// байты pending.json, сравнение снимков от порядка не зависит.
func imageFiles(directory string) (*jscompat.Object, error) {
	entries := map[string]any{}
	var visit func(folder string) error
	visit = func(folder string) error {
		items, err := jscompat.ReadDir(folder)
		if err != nil {
			return err
		}
		for _, item := range items {
			path := filepath.Join(folder, item.Name())
			info, err := os.Lstat(path)
			if err != nil {
				return jscompat.FsError("lstat", path, err)
			}
			local := jscompat.Relative(directory, path)
			switch {
			case info.Mode()&os.ModeSymlink != 0:
				return errors.New(textImageContainsLink)
			case info.IsDir():
				entries[local] = nil
				if err := visit(path); err != nil {
					return err
				}
			case info.Mode().IsRegular():
				data, err := os.ReadFile(path)
				if err != nil {
					return jscompat.FsError("open", path, err)
				}
				entries[local] = digestHex(data)
			default:
				return errors.New(textImageFileTypeUnknown)
			}
		}
		return nil
	}
	if err := visit(directory); err != nil {
		return nil, err
	}
	keys := make([]string, 0, len(entries))
	for key := range entries {
		keys = append(keys, key)
	}
	slices.SortFunc(keys, compareUTF16)
	result := jscompat.NewObject()
	for _, key := range keys {
		result.Set(key, entries[key])
	}
	return result, nil
}

// protectImages — снимок проверенных image-попыток пакета directory перед Apply.
func protectImages(directory string) ([]protectedImage, error) {
	roots, err := ImageRoots(directory, nil)
	if err != nil {
		return nil, err
	}
	images := make([]protectedImage, 0, len(roots))
	for _, root := range roots {
		files, err := imageFiles(jscompat.Resolve(directory, root.RequestDir))
		if err != nil {
			return nil, err
		}
		images = append(images, protectedImage{ImageRoot: root, Files: files})
	}
	return images, nil
}

// roots — абсолютные папки защищённых попыток внутри пакета target.
func roots(target string, images []protectedImage) []string {
	result := make([]string, len(images))
	for index, image := range images {
		result[index] = jscompat.Resolve(target, image.RequestDir)
	}
	return result
}

// verifyImages проверяет, что история image-попыток пакета target (workflow — его
// workflow.json или доказательство из резерва) совпадает со снимком, файлы попыток не изменились,
// а нового видео или неизвестной оплаты в пакете нет. Снимки сравниваются как множества путей.
func verifyImages(target string, images []protectedImage, workflow *jscompat.Object) error {
	if workflow == nil {
		var err error
		if workflow, err = packageWorkflow(target); err != nil {
			return err
		}
	}
	current, err := ImageRoots(target, workflow)
	if err != nil {
		return err
	}
	if len(current) != len(images) {
		return errors.New(textProtectedImageHistoryChanged)
	}
	for _, image := range images {
		index := slices.IndexFunc(current, func(root ImageRoot) bool { return root.RequestDir == image.RequestDir })
		if index < 0 || current[index].RequestSha256 != image.RequestSha256 || current[index].FrameID != image.FrameID {
			return errors.New(textProtectedImageChanged)
		}
		files, err := imageFiles(jscompat.Resolve(target, image.RequestDir))
		if err != nil {
			return err
		}
		if !jscompat.DeepStrictEqual(files, image.Files) {
			return errors.New(textProtectedImageChanged)
		}
	}
	excluded := make([]string, len(current))
	for index, root := range current {
		excluded[index] = jscompat.Resolve(target, root.RequestDir)
	}
	paid, err := attemptsPaid(target, excluded)
	if err != nil {
		return err
	}
	if videoStage(workflow) || paid {
		return errors.New(textPackageContainsPaidRequest)
	}
	return nil
}

// copyMutable рекурсивно копирует изменяемую часть пакета source в target без защищённых
// image-попыток. Папки создаются (в том числе пустые), файлы перезаписываются с
// правами источника. Ссылок в пакете нет: снимок предложения их отклоняет, резерв их не содержит.
func copyMutable(source, target string, images []protectedImage) error {
	excluded := roots(source, images)
	var copyTree func(from, to string) error
	copyTree = func(from, to string) error {
		if slices.ContainsFunc(excluded, func(root string) bool { return nested(from, root) }) {
			return nil
		}
		info, err := os.Lstat(from)
		if err != nil {
			return jscompat.FsError("lstat", from, err)
		}
		switch {
		case info.IsDir():
			if err := os.MkdirAll(to, info.Mode().Perm()); err != nil {
				return err
			}
			entries, err := jscompat.ReadDir(from)
			if err != nil {
				return err
			}
			for _, entry := range entries {
				if err := copyTree(filepath.Join(from, entry.Name()), filepath.Join(to, entry.Name())); err != nil {
					return err
				}
			}
			return nil
		case info.Mode().IsRegular():
			return copyFile(from, to, info.Mode().Perm())
		}
		return fmt.Errorf("%s: %s", textPackageLink(from), info.Mode().Type())
	}
	return copyTree(source, target)
}

// copyFile копирует байты файла с правами perm; существующий файл перезаписывается.
func copyFile(from, to string, perm fs.FileMode) error {
	source, err := os.Open(from)
	if err != nil {
		return jscompat.FsError("open", from, err)
	}
	defer source.Close()
	target, err := os.OpenFile(to, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, perm)
	if err != nil {
		return jscompat.FsError("open", to, err)
	}
	if _, err := io.Copy(target, source); err != nil {
		_ = target.Close()
		return err
	}
	if err := target.Close(); err != nil {
		return err
	}
	return os.Chmod(to, perm)
}

// removeMutable удаляет только изменяемую часть пакета; ни пакет
// целиком, ни папки защищённых image-попыток не заменяются (папки-предки попыток остаются).
func removeMutable(target string, images []protectedImage) error {
	if !jscompat.Exists(target) {
		return nil
	}
	protected := roots(target, images)
	var visit func(directory string) error
	visit = func(directory string) error {
		entries, err := jscompat.ReadDir(directory)
		if err != nil {
			return err
		}
		for _, entry := range entries {
			path := filepath.Join(directory, entry.Name())
			if slices.Contains(protected, path) {
				continue
			}
			if entry.IsDir() && slices.ContainsFunc(protected, func(root string) bool { return nested(root, path) }) {
				if err := visit(path); err != nil {
					return err
				}
			} else if err := os.RemoveAll(path); err != nil {
				return err
			}
		}
		return nil
	}
	return visit(target)
}

// restore возвращает пакет к резерву журнала directory. Отказывает, сохраняя
// журнал, если проект недоступен, резерва нет, защищённые попытки изменились или в пакете
// (резерве) появилась оплата.
func restore(directory string, record pending) error {
	if !jscompat.Exists(filepath.Join(record.Project, "plan", "project.json")) {
		return errors.New(textApplyProjectUnavailable)
	}
	target, err := applyPackagePath(record.Project, record.PackageDir)
	if err != nil {
		return err
	}
	backup := filepath.Join(directory, "package")
	if record.Existed && !jscompat.Exists(backup) {
		return errors.New(textApplyBackupMissing)
	}
	// Обрыв после удаления изменяемых файлов оставляет оригиналы на месте, но временно убирает
	// workflow.json. Только в этом случае его резерв доказывает прежнюю историю; существующий
	// чужой workflow.json резервом не подменяется.
	proofDir := target
	if record.Existed && !jscompat.Exists(filepath.Join(target, "workflow.json")) {
		proofDir = backup
	}
	proof, err := packageWorkflow(proofDir)
	if err != nil {
		return err
	}
	if err := verifyImages(target, record.Protected, proof); err != nil {
		return err
	}
	if record.Existed {
		paid, err := packagePaid(backup)
		if err != nil {
			return err
		}
		if paid {
			return errors.New(textApplyPaidBackupBlocksRecovery)
		}
	}
	if err := removeMutable(target, record.Protected); err != nil {
		return err
	}
	if record.Existed {
		return copyMutable(backup, target, record.Protected)
	}
	if jscompat.Exists(target) {
		return os.Remove(target)
	}
	return nil
}

// errorString — вид ошибки в текстах журнала: «Error: сообщение» (формат зафиксирован эталоном).
func errorString(err error) string { return "Error: " + err.Error() }

// applyPackage выполняет apply над пакетом target проекта
// project (реальный путь) под журналом замены. Пакет с отправленным видео или неизвестной
// оплатой и пакет, ждущий решения по image-попытке, не меняются. Ошибка apply или проверки
// защищённых попыток откатывает пакет к резерву; если откат не удался, журнал остаётся для
// восстановления при следующем запуске. Обрыв процесса внутри apply оставляет pending.json.
// pending.json пишется атомарно: обрыв посреди записи не оставляет нечитаемый журнал, который
// блокировал бы восстановление и следующие Apply пакета.
func applyPackage(localDir, project, target string, apply func() error) error {
	packageDir, err := applyPackagePath(project, target)
	if err != nil {
		return err
	}
	if PackageVideoPaid(packageDir) {
		return errors.New(textApplyPaidVideoRequiresRetry)
	}
	workflow, err := packageWorkflow(packageDir)
	if err != nil {
		return err
	}
	if slices.Contains([]string{"image_request_choice", "image_submitted", "image_downloaded"}, jscompat.ToString(workflow.Value("stage"))) {
		return errors.New(textApplyResolveImageAttemptFirst)
	}
	directory := journalDirectory(localDir, project, packageDir)
	pendingPath := filepath.Join(directory, "pending.json")
	if jscompat.Exists(pendingPath) {
		return errors.New(textApplyPreviousUnrecovered)
	}
	images, err := protectImages(packageDir)
	if err != nil {
		return err
	}
	if err := os.RemoveAll(directory); err != nil {
		return err
	}
	if err := os.MkdirAll(directory, 0o777); err != nil {
		return err
	}
	record := pending{Project: project, PackageDir: jscompat.Relative(project, packageDir), Existed: jscompat.Exists(packageDir), Protected: images}
	if record.Existed {
		if err := copyMutable(packageDir, filepath.Join(directory, "package"), images); err != nil {
			return err
		}
	}
	if err := projectfs.WriteFile(pendingPath, []byte(jscompat.Stringify(record.tree())), 0o666); err != nil {
		return err
	}
	if err := apply(); err == nil {
		err = verifyImages(packageDir, images, nil)
		if err != nil {
			return rollback(directory, record, err)
		}
	} else {
		return rollback(directory, record, err)
	}
	// Сначала убирается намерение отката: оставшийся резерв не откатит успешно завершённый Apply.
	if err := os.Remove(pendingPath); err != nil {
		return err
	}
	return os.RemoveAll(directory)
}

// rollback — откат applyPackage после ошибки: откат к резерву и исходная ошибка, либо ошибка
// с обоими текстами, если откат не удался (журнал тогда остаётся).
func rollback(directory string, record pending, cause error) error {
	if err := restore(directory, record); err != nil {
		return errors.New(textApplyRecoveryFailed(errorString(cause), errorString(err)))
	}
	if err := os.RemoveAll(directory); err != nil {
		return errors.New(textApplyRecoveryFailed(errorString(cause), errorString(err)))
	}
	return cause
}

// readPending — разбор pending.json с проверками: только v2, абсолютный проект,
// относительный пакет, снимки защищённых попыток без выхода за их папку.
func readPending(path string) (pending, error) {
	value, err := readJSON(path)
	if err != nil {
		return pending{}, err
	}
	object, ok := value.(*jscompat.Object)
	project, projectOK := jscompat.Get(value, "project").(string)
	packageDir, packageOK := jscompat.Get(value, "packageDir").(string)
	existed, existedOK := jscompat.Get(value, "existed").(bool)
	if !ok || object.Value("schemaVersion") != float64(pendingSchema) || !projectOK || !jscompat.IsAbs(project) || !packageOK ||
		jscompat.IsAbs(packageDir) || !existedOK {
		return pending{}, errors.New(textRecoveryRecordInvalid)
	}
	items, ok := jscompat.AsArray(object.Value("protectedImages"))
	if !ok {
		return pending{}, errors.New(textProtectedImagesSnapshotInvalid)
	}
	record := pending{Project: project, PackageDir: packageDir, Existed: existed, Protected: []protectedImage{}}
	for _, item := range items {
		requestDir, dirOK := jscompat.Get(item, "requestDir").(string)
		sha, shaOK := jscompat.Get(item, "requestSha256").(string)
		frame, frameOK := jscompat.Get(item, "frameId").(string)
		files, filesOK := jscompat.Get(item, "files").(*jscompat.Object)
		if !jscompat.IsRecord(item) || !dirOK || requestDir == "" || jscompat.IsAbs(requestDir) ||
			slices.Contains(strings.Split(filepath.Clean(requestDir), string(os.PathSeparator)), "..") ||
			!shaOK || !sha256Pattern.MatchString(sha) || !frameOK || !frameIDPattern.MatchString(frame) || !filesOK {
			return pending{}, errors.New(textProtectedImagesSnapshotInvalid)
		}
		for _, key := range files.Keys() {
			hash := files.Value(key)
			if text, isString := hash.(string); hash != nil && (!isString || !sha256Pattern.MatchString(text)) {
				return pending{}, errors.New(textProtectedImagesSnapshotInvalid)
			}
		}
		record.Protected = append(record.Protected, protectedImage{ImageRoot: ImageRoot{RequestDir: requestDir, RequestSha256: sha, FrameID: frame}, Files: files})
	}
	return record, nil
}

// RecoverInterrupted до открытия проектов
// восстанавливает только явно записанные незавершённые замены пакетов (каталоги с pending.json)
// в каталоге состояния localDir. Сбой одного журнала не мешает остальным; журнал с ошибкой
// остаётся для разбора, а итоговая ошибка перечисляет причины. Каталоги без pending.json — резерв
// уже завершённого Apply — не трогаются: следующий Apply того же пакета их заменит.
func RecoverInterrupted(localDir string) error {
	base := filepath.Join(localDir, ApplyFolder)
	entries, err := os.ReadDir(base)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	failures := []string{}
	for _, entry := range entries {
		if !journalName.MatchString(entry.Name()) {
			continue
		}
		directory := filepath.Join(base, entry.Name())
		path := filepath.Join(directory, "pending.json")
		if !jscompat.Exists(path) {
			continue
		}
		if err := recoverOne(directory, path); err != nil {
			failures = append(failures, errorString(err))
		}
	}
	if len(failures) > 0 {
		return errors.New(textApplyRecoveryAllFailed(strings.Join(failures, " ")))
	}
	return nil
}

// recoverOne — восстановление одного журнала directory.
func recoverOne(directory, path string) error {
	record, err := readPending(path)
	if err != nil {
		return err
	}
	target, err := applyPackagePath(record.Project, record.PackageDir)
	if err != nil {
		return err
	}
	if digestHex([]byte(jscompat.Resolve(record.Project)+"\x00"+target)) != filepath.Base(directory) {
		return errors.New(textRecoveryPathMismatch)
	}
	if err := restore(directory, record); err != nil {
		return err
	}
	if err := os.Remove(path); err != nil {
		return err
	}
	return os.RemoveAll(directory)
}
