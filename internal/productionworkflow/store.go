package productionworkflow

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"songframe/internal/dynvalue"
	"songframe/internal/projectfs"
	"songframe/internal/sceneregistry"
)

// Statuses — допустимые статусы записанного предложения (ProductionProposal.status):
// cancelled — пользователь остановил задание, interrupted — задание оборвалось или предложение
// отклонено, applied — предложение применено к пакету.
var Statuses = []string{"running", "ready", "invalid", "failed", "cancelled", "interrupted", "applied"}

// Stored — запись предложения одного плана в представлении
// dynvalue: { proposal, packageDir, target, hashes, rules, capabilities?, imageJob?, imageHashes? }.
// В памяти пути абсолютные (packageDir, target, ключи imageHashes, proposal.after.images[].path), а
// rules.project — реальный путь проекта: так с записью работают проверки и Apply. На диске Store
// хранит те же пути от проекта и без rules.project (см. Store). Дерево сохраняет порядок ключей,
// поэтому запись после изменения статуса пишется тем же JSON, что зафиксирован эталоном. Владелец —
// Workflow; Apply, восстановление после перезапуска и опоры читают и дополняют её через эти методы.
type Stored struct {
	Tree *dynvalue.Object
}

// Proposal — объект proposal записи (ProductionProposal): id, jobId, stage, status, stale,
// before, after и необязательные message, agentText, refused.
func (s *Stored) Proposal() *dynvalue.Object {
	proposal, _ := s.Tree.Value("proposal").(*dynvalue.Object)
	return proposal
}

// ID — proposal.id.
func (s *Stored) ID() string { value, _ := s.Proposal().Value("id").(string); return value }

// JobID — proposal.jobId: задание агента ("" — предложение без задания, импорт опор).
func (s *Stored) JobID() string { value, _ := s.Proposal().Value("jobId").(string); return value }

// Stage — proposal.stage: description, frames, prompt или request.
func (s *Stored) Stage() string { value, _ := s.Proposal().Value("stage").(string); return value }

// Status — proposal.status.
func (s *Stored) Status() string { return dynvalue.ToString(s.Proposal().Value("status")) }

// PackageDir — packageDir записи: пакет, из которого готовилось предложение; "" — null, новая
// подготовка без пакета.
func (s *Stored) PackageDir() string { value, _ := s.Tree.Value("packageDir").(string); return value }

// Target — target записи: пакет, в который Apply запишет результат (новый attempt-NN или тот же).
func (s *Stored) Target() string { value, _ := s.Tree.Value("target").(string); return value }

// Hashes — снимок входов на момент подготовки (см. Snapshot).
func (s *Stored) Hashes() *dynvalue.Object {
	hashes, _ := s.Tree.Value("hashes").(*dynvalue.Object)
	return hashes
}

// Rules — правила проверки ответа (ProposalRules), записанные при подготовке.
func (s *Stored) Rules() Rules { return RulesFromTree(s.Tree.Value("rules")) }

// Capabilities — объявления моделей провайдера видео на момент подготовки (Undefined — нет).
func (s *Stored) Capabilities() any { return s.Tree.Value("capabilities") }

// ImageJob — предложение опор, созданных заданием провайдера-агента.
func (s *Stored) ImageJob() bool { return s.Tree.Value("imageJob") == true }

// ImageHashes — SHA-256 копий изображений готового предложения опор по абсолютным путям; nil — нет.
func (s *Stored) ImageHashes() *dynvalue.Object {
	hashes, _ := s.Tree.Value("imageHashes").(*dynvalue.Object)
	return hashes
}

// active — предложение ещё ждёт решения: готовится или готово к применению.
func (s *Stored) active() bool {
	return s != nil && (s.Status() == "running" || s.Status() == "ready")
}

// images — кандидаты proposal.after.images (объекты { id, path }); nil — кандидатов нет.
func (s *Stored) images() []any {
	images, _ := dynvalue.AsArray(dynvalue.Get(s.Proposal().Value("after"), "images"))
	return images
}

// CheckStored проверяет запись плана, прочитанную из папки предложений проекта project (реальный
// путь), и переводит её пути в абсолютные. Принадлежность проекту следует из места записи, поэтому
// пути в ней только относительные: абсолютный путь или выход за проект делает запись чужой формы.
// nil — форма записи не та (её не показывают); ошибка — пакет записи вне plan/batches|awaiting.
func CheckStored(project string, value any) (*Stored, error) {
	tree, ok := value.(*dynvalue.Object)
	if !ok {
		return nil, nil
	}
	proposal, proposalOK := tree.Value("proposal").(*dynvalue.Object)
	_, hashesOK := tree.Value("hashes").(*dynvalue.Object)
	rules, rulesOK := tree.Value("rules").(*dynvalue.Object)
	_, targetOK := tree.Value("target").(string)
	packageDir := tree.Value("packageDir")
	_, packageOK := packageDir.(string)
	if !proposalOK || !hashesOK || !rulesOK || !targetOK || (packageDir != nil && !packageOK) {
		return nil, nil
	}
	if _, isString := proposal.Value("id").(string); !isString || !slices.Contains(Statuses, dynvalue.ToString(proposal.Value("status"))) {
		return nil, nil
	}
	if !absolutePaths(project, tree) {
		return nil, nil
	}
	rules.Set("project", project)
	stored := &Stored{Tree: tree}
	if _, err := PackagePath(project, stored.Target()); err != nil {
		return nil, err
	}
	if packageOK {
		if _, err := PackagePath(project, stored.PackageDir()); err != nil {
			return nil, err
		}
	}
	return stored, nil
}

// absolutePaths переводит на месте пути записи с диска (от проекта, с «/») в абсолютные: packageDir,
// target, ключи imageHashes и proposal.after.images[].path. false — путь не строка, абсолютный или
// выходит за проект.
func absolutePaths(project string, tree *dynvalue.Object) bool {
	absolute := func(value any) (string, bool) {
		path, ok := value.(string)
		if !ok || !isText(path) || dynvalue.IsAbs(path) || outside(path) {
			return "", false
		}
		return filepath.Join(project, filepath.FromSlash(path)), true
	}
	for _, name := range []string{"packageDir", "target"} {
		if value := tree.Value(name); value != nil {
			path, ok := absolute(value)
			if !ok {
				return false
			}
			tree.Set(name, path)
		}
	}
	if value := tree.Value("imageHashes"); value != dynvalue.Undefined {
		hashes, ok := value.(*dynvalue.Object)
		if !ok {
			return false
		}
		converted := dynvalue.NewObject()
		for _, key := range hashes.Keys() {
			path, ok := absolute(key)
			if !ok {
				return false
			}
			converted.Set(path, hashes.Value(key))
		}
		tree.Set("imageHashes", converted)
	}
	images, _ := dynvalue.AsArray(dynvalue.Get(dynvalue.Get(tree.Value("proposal"), "after"), "images"))
	for _, image := range images {
		object, isObject := image.(*dynvalue.Object)
		if !isObject {
			return false
		}
		path, ok := absolute(object.Value("path"))
		if !ok {
			return false
		}
		object.Set("path", path)
	}
	return true
}

// diskTree — копия дерева записи для файла: пути от проекта с «/», без rules.project. Дерево в
// памяти не меняется. Путь вне проекта — ошибка: кандидаты опор к этому моменту уже скопированы
// в проект (Store.pinCandidates), иначе запись перестала бы работать после переноса папки.
func diskTree(project string, stored *Stored) (*dynvalue.Object, error) {
	local := func(path string) (string, error) {
		value := rel(project, path)
		if value == "" || outside(value) {
			return "", errors.New(textPathOutsideProject(path))
		}
		return value, nil
	}
	tree := stored.Tree.Clone()
	for _, name := range []string{"packageDir", "target"} {
		if path, ok := tree.Value(name).(string); ok {
			value, err := local(path)
			if err != nil {
				return nil, err
			}
			tree.Set(name, value)
		}
	}
	if rules, ok := tree.Value("rules").(*dynvalue.Object); ok {
		rules = rules.Clone()
		rules.Delete("project")
		tree.Set("rules", rules)
	}
	if hashes := stored.ImageHashes(); hashes != nil {
		converted := dynvalue.NewObject()
		for _, path := range hashes.Keys() {
			value, err := local(path)
			if err != nil {
				return nil, err
			}
			converted.Set(value, hashes.Value(path))
		}
		tree.Set("imageHashes", converted)
	}
	if images := stored.images(); images != nil {
		converted := make([]any, len(images))
		for index, image := range images {
			object, isObject := image.(*dynvalue.Object)
			if !isObject {
				converted[index] = image
				continue
			}
			object = object.Clone()
			if path, ok := object.Value("path").(string); ok {
				value, err := local(path)
				if err != nil {
					return nil, err
				}
				object.Set("path", value)
			}
			converted[index] = object
		}
		proposal := stored.Proposal().Clone()
		after := proposal.Value("after").(*dynvalue.Object).Clone()
		after.Set("images", &dynvalue.Array{Items: converted})
		proposal.Set("after", after)
		tree.Set("proposal", proposal)
	}
	return tree, nil
}

// Store — записи предложений в папке проекта: <проект>/plan/batches/proposals/<план>.json и копии
// кандидатов опор готового предложения в <проект>/plan/batches/proposals/<план>/. Предложение
// описывает проект, поэтому лежит в нём рядом с рабочими пакетами, вне Git, и переживает перенос
// папки проекта: пути в записи — от проекта (см. CheckStored и diskTree). Один план держит не
// больше одной записи. Методы не синхронизированы: их вызывает Workflow под своим мьютексом.
type Store struct{}

// Folder — папка записей проекта project.
func (Store) Folder(project string) string {
	return filepath.Join(project, filepath.FromSlash(sceneregistry.ProposalsDir))
}

// validShot — код плана годится как имя файла записи: не пустой, без разделителей пути, NUL и
// служебных имён «.» и «..».
func validShot(shot string) bool {
	return shot != "" && shot != "." && shot != ".." && !strings.ContainsAny(shot, `/\`+"\x00")
}

// Path — путь записи плана shot.
func (s Store) Path(project, shot string) string {
	return filepath.Join(s.Folder(project), shot+".json")
}

// CopiesDir — папка копий кандидатов опор предложения плана shot.
func (s Store) CopiesDir(project, shot string) string {
	return filepath.Join(s.Folder(project), shot)
}

// Read возвращает проверенную запись плана с абсолютными путями или nil (нет файла, повреждена,
// отклонена, неверный код плана, пакет вне проекта).
func (s Store) Read(project, shot string) *Stored {
	if !validShot(shot) {
		return nil
	}
	value, err := readJSON(s.Path(project, shot))
	if err != nil {
		return nil
	}
	stored, err := CheckStored(project, value)
	if err != nil {
		return nil
	}
	return stored
}

// Write — атомарная запись предложения: JSON с отступом в два пробела, порядком ключей
// документа и переводом строки в конце (dynvalue), пути — от проекта. После записи из папки копий
// плана убираются файлы, на которые запись больше не ссылается.
func (s Store) Write(project, shot string, stored *Stored) error {
	if !validShot(shot) {
		return errors.New(textPathOutsideProject(shot))
	}
	// Запись лежит в проекте: как и остальные файлы проекта, её не пишут поверх незавершённой
	// многофайловой операции (шлюз projectfs.CheckWrite).
	if err := projectfs.CheckWrite(project); err != nil {
		return err
	}
	tree, err := diskTree(project, stored)
	if err != nil {
		return err
	}
	if err := writeJSON(s.Path(project, shot), tree); err != nil {
		return err
	}
	s.prune(project, shot, stored)
	return nil
}

// WriteDiscarded заменяет запись отметкой { schemaVersion: 1, discarded: id }: отклонённое
// предложение больше не читается, а история самого задания агента сохраняется. Копии кандидатов
// отклонённого предложения удаляются.
func (s Store) WriteDiscarded(project, shot, id string) error {
	if !validShot(shot) {
		return errors.New(textPathOutsideProject(shot))
	}
	if err := projectfs.CheckWrite(project); err != nil {
		return err
	}
	marker := dynvalue.NewObject()
	marker.Set("schemaVersion", float64(1))
	marker.Set("discarded", id)
	if err := writeJSON(s.Path(project, shot), marker); err != nil {
		return err
	}
	s.prune(project, shot, nil)
	return nil
}

// Remove удаляет запись плана вместе с копиями кандидатов (запись, которую уже нельзя показать).
func (s Store) Remove(project, shot string) {
	if !validShot(shot) {
		return
	}
	_ = os.Remove(s.Path(project, shot))
	s.prune(project, shot, nil)
}

// prune оставляет в папке копий плана только кандидатов неприменённого предложения stored (nil —
// ни одного) и удаляет опустевшую папку. Копии нужны лишь до решения по предложению: Apply
// переносит выбранные байты в пакет, отклонение и замена предложения делают их лишними. Ошибки
// удаления не мешают уже записанной записи: оставшийся файл уберёт следующая запись плана.
func (s Store) prune(project, shot string, stored *Stored) {
	folder := s.CopiesDir(project, shot)
	entries, err := os.ReadDir(folder)
	if err != nil {
		return
	}
	keep := map[string]bool{}
	if stored != nil && stored.Status() != "applied" {
		for _, image := range stored.images() {
			if path, ok := dynvalue.Get(image, "path").(string); ok {
				keep[filepath.Clean(path)] = true
			}
		}
	}
	left := 0
	for _, entry := range entries {
		path := filepath.Join(folder, entry.Name())
		if keep[path] {
			left++
			continue
		}
		if err := os.RemoveAll(path); err != nil {
			left++
		}
	}
	if left == 0 {
		_ = os.Remove(folder)
	}
}

// pinCandidates копирует кандидатов опор в папку копий плана (<опора><расширение>) и возвращает
// кандидатов с путями копий и SHA-256 их байтов по этим путям. Импортированный файл пользователь
// мог выбрать где угодно на диске, а кандидаты задания агента лежат в рабочей папке каталога
// состояния: копия в проекте делает предложение рабочим и после переноса папки проекта, а
// изменение самой копии — устаревшим. Байты читаются целиком до атомарной записи, поэтому
// повторный импорт той же копии её не портит.
func (s Store) pinCandidates(project, shot string, images []FrameCandidate) ([]FrameCandidate, *dynvalue.Object, error) {
	if !validShot(shot) {
		return nil, nil, errors.New(textPathOutsideProject(shot))
	}
	folder := s.CopiesDir(project, shot)
	result := make([]FrameCandidate, len(images))
	hashes := dynvalue.NewObject()
	for index, image := range images {
		data, err := os.ReadFile(image.Path)
		if err != nil {
			return nil, nil, dynvalue.FsError("open", image.Path, err)
		}
		target := filepath.Join(folder, image.ID+candidateExtension(image.Path, data))
		if err := projectfs.WriteFile(target, data, 0o666); err != nil {
			return nil, nil, err
		}
		hashes.Set(target, digestHex(data))
		result[index] = FrameCandidate{ID: image.ID, Path: target}
	}
	return result, hashes, nil
}

// candidateExtension — расширение копии кандидата: расширение исходного файла в нижнем регистре
// (его же получит файл опоры в пакете), без расширения — по заголовку PNG, JPEG или WebP.
func candidateExtension(path string, data []byte) string {
	if extension := extname(path); extension != "" {
		return extension
	}
	switch {
	case bytes.HasPrefix(data, pngSignature):
		return ".png"
	case len(data) >= 12 && string(data[0:4]) == "RIFF" && string(data[8:12]) == "WEBP":
		return ".webp"
	}
	return ".jpg"
}

// writeJSON — атомарная запись дерева dynvalue в формате writeProjectJSON; права существующего
// файла сохраняются, новый получает 0600.
func writeJSON(path string, value any) error {
	return projectfs.WriteFile(path, []byte(dynvalue.StringifyIndent(value, "  ")+"\n"), 0)
}

// readJSON — null (nil) при отсутствии файла; ошибка чтения или разбора возвращается.
func readJSON(path string) (any, error) {
	if !dynvalue.Exists(path) {
		return nil, nil
	}
	if err := dynvalue.ReadFileCheck(path); err != nil {
		return nil, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, dynvalue.FsError("open", path, err)
	}
	return dynvalue.Parse([]byte(dynvalue.DecodeUTF8(data)))
}
