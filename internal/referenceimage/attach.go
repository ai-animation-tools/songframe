package referenceimage

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"songframe/internal/cast"
	"songframe/internal/dynvalue"
	"songframe/internal/mediafile"
	"songframe/internal/projectfs"
	"songframe/internal/sourceedit"
	"songframe/internal/sources"
)

// Тексты публикации принятого референса (referenceImageTexts,
// frontend/src/shared/texts/reference-images.ts).
const (
	textManifestMissing = "Сначала сохраните исходники проекта на странице «Исходники»."
	textEntityMissing   = "Сущность больше не существует. Обновите кастинг и выберите её заново."
	textImageInvalid    = "Оригинал изображения отсутствует или имеет неверный формат."
)

// Result — ReferenceImageResult контракта: принятый полный оригинал сессии референса. Path —
// файл в архиве попытки plan/reference-images/<ID>/…, Prompt — точный отправленный промпт.
type Result struct {
	ID     string `json:"id"`
	Path   string `json:"path"`
	Prompt string `json:"prompt"`
}

// now — время updated_at описи; точка подмены для эталонов.
var now = time.Now

// copyAttached — копирование оригинала в source/; точка подмены для теста отката.
var copyAttached = copyOriginal

// saveAttachedCast — запись кастинга после описи; точка подмены для теста отката.
var saveAttachedCast = func(project string, document any) error {
	_, err := cast.Save(project, document)
	return err
}

var kindDirPattern = regexp.MustCompile(`^[a-z][a-z0-9_-]*$`)

// Attach — referenceImages.attach: добавляет принятый полный
// оригинал к сохранённой сущности кастинга и в исходники, не заменяя прежние изображения.
//
// Файл копируется в source/<папка типа>/<сущность>-generated-<ID сессии><расширение>, рядом —
// точный промпт (<файл>.prompt.txt). В описи референс сущности получает новый вид (full, если
// видов ещё не было, иначе other) с SHA-256 и размером скопированных байтов, в кастинге путь
// дописывается в images сущности. Если у сущности ещё нет референса, он создаётся с её
// названием и описанием; тип world хранится среди референсов стиля, а тип без своей папки
// получает свободную папку с суффиксом -2, -3, … без переименования прежних данных.
//
// Оригинал архива не меняется. Повтор для того же результата (renderer упал после ответа)
// ничего не пишет. Отказ после начала записи возвращает точные байты описи и кастинга и удаляет
// только созданные этим вызовом файлы.
func Attach(project, entityID string, result Result) error {
	manifestValue := sources.ReadManifest(project)
	manifest, ok := manifestValue.(*dynvalue.Object)
	if !ok {
		return errors.New(textManifestMissing)
	}
	read := cast.Read(project)
	if read.Damaged || !dynvalue.Truthy(read.Value) {
		return errors.New(textCastInvalid)
	}
	document, err := cast.Normalize(read.Value, cast.LoadDefaults())
	if err != nil {
		return err
	}
	entities, _ := dynvalue.AsArray(document.Value("entities"))
	var entity *dynvalue.Object
	for _, item := range entities {
		if candidate, _ := item.(*dynvalue.Object); candidate != nil && dynvalue.StrictEqual(candidate.Value("id"), entityID) {
			entity = candidate
			break
		}
	}
	if entity == nil {
		return errors.New(textEntityMissing)
	}
	if !mediafile.ExtensionMatches(result.Path) {
		return errors.New(textImageInvalid)
	}
	kinds, ok := manifest.Value("kinds").(*dynvalue.Array)
	if !ok || len(kinds.Items) == 0 {
		kinds = defaultKinds()
	}
	manifest.Set("kinds", kinds)
	references, ok := manifest.Value("references").(*dynvalue.Array)
	if !ok {
		return &dynvalue.TypeError{Message: "manifest.references.find is not a function"}
	}
	var ref *dynvalue.Object
	for _, item := range references.Items {
		if dynvalue.StrictEqual(dynvalue.Get(item, "id"), entityID) {
			ref, _ = item.(*dynvalue.Object)
			break
		}
	}
	if ref == nil {
		kindID := entity.Value("kind")
		if kindID == "world" {
			kindID = "style"
		}
		if findKind(kinds, kindID) == nil {
			addKind(kinds, dynvalue.ToString(kindID))
		}
		ref = dynvalue.NewObject()
		ref.Set("id", entity.Value("id"))
		ref.Set("kind", kindID)
		ref.Set("name", entity.Value("name"))
		ref.Set("short_name", entity.Value("short_name"))
		ref.Set("description", entity.Value("appearance"))
		ref.Set("prompt", nil)
		ref.Set("files", &dynvalue.Array{Items: []any{}})
		references.Items = append(references.Items, ref)
	}
	typed, err := typedKinds(kinds)
	if err != nil {
		return err
	}
	if problems := sourceedit.ValidateKinds(typed); len(problems) > 0 {
		return errors.New(strings.Join(problems, " "))
	}
	kind := findKind(kinds, ref.Value("kind"))
	dir, _ := dynvalue.Get(kind, "dir").(string)
	if kind == nil || !kindDirPattern.MatchString(dir) {
		return errors.New(textCastInvalid)
	}
	files, ok := ref.Value("files").(*dynvalue.Array)
	if !ok {
		return &dynvalue.TypeError{Message: "ref.files.some is not a function"}
	}
	images, _ := entity.Value("images").(*dynvalue.Array)
	relative := dir + "/" + dynvalue.ToString(entity.Value("id")) + "-generated-" + result.ID + strings.ToLower(filepath.Ext(result.Path))
	source := filepath.Join(project, "source")
	imagePath := filepath.Join(source, filepath.FromSlash(relative))
	prompt := relative + ".prompt.txt"
	promptPath := filepath.Join(source, filepath.FromSlash(prompt))
	listed := hasPath(files, relative)
	if listed && contains(images.Items, relative) {
		return nil
	}
	if err := projectfs.CheckWrite(project); err != nil {
		return err
	}
	manifestPath := sources.ManifestPath(project)
	oldManifest, err := os.ReadFile(manifestPath)
	if err != nil {
		return dynvalue.FsError("open", manifestPath, err)
	}
	oldCast, err := os.ReadFile(cast.Path(project))
	if err != nil {
		return dynvalue.FsError("open", cast.Path(project), err)
	}
	imageExisted := dynvalue.Exists(imagePath)
	promptExisted := dynvalue.Exists(promptPath)
	err = func() error {
		if err := os.MkdirAll(filepath.Dir(imagePath), 0o777); err != nil {
			return err
		}
		if !imageExisted {
			if err := copyAttached(result.Path, imagePath); err != nil {
				return err
			}
		}
		if !promptExisted {
			if err := projectfs.WriteFile(promptPath, []byte(result.Prompt), 0); err != nil {
				return err
			}
		}
		if !listed {
			data, err := os.ReadFile(imagePath)
			if err != nil {
				return dynvalue.FsError("open", imagePath, err)
			}
			sum := sha256.Sum256(data)
			view := "full"
			if len(files.Items) > 0 {
				view = "other"
			}
			file := dynvalue.NewObject()
			file.Set("path", relative)
			file.Set("sha256", hex.EncodeToString(sum[:]))
			file.Set("bytes", float64(len(data)))
			file.Set("view", view)
			file.Set("note", "")
			file.Set("prompt", prompt)
			files.Items = append(files.Items, file)
		}
		if !contains(images.Items, relative) {
			images.Items = append(images.Items, relative)
		}
		manifest.Set("updated_at", now().UTC().Format("2006-01-02T15:04:05.000Z"))
		if err := projectfs.WriteFile(manifestPath, []byte(dynvalue.StringifyIndent(manifest, "  ")+"\n"), 0); err != nil {
			return err
		}
		return saveAttachedCast(project, document)
	}()
	if err != nil {
		// Откат: точные прежние байты обоих документов и удаление только созданных файлов.
		if restoreErr := projectfs.WriteFile(manifestPath, oldManifest, 0); restoreErr != nil {
			return restoreErr
		}
		if restoreErr := projectfs.WriteFile(cast.Path(project), oldCast, 0); restoreErr != nil {
			return restoreErr
		}
		if !imageExisted {
			_ = os.Remove(imagePath)
		}
		if !promptExisted {
			_ = os.Remove(promptPath)
		}
		return err
	}
	return nil
}

// defaultKinds — копия DEFAULT_SOURCE_KINDS в виде значений описи.
func defaultKinds() *dynvalue.Array {
	items := make([]any, len(sourceedit.DefaultKinds))
	for index, kind := range sourceedit.DefaultKinds {
		items[index] = kindObject(kind.ID, kind.Label, kind.Dir)
	}
	return &dynvalue.Array{Items: items}
}

// kindObject — тип исходника {id, label, dir}; порядок ключей входит в байты описи.
func kindObject(id, label, dir string) *dynvalue.Object {
	object := dynvalue.NewObject()
	object.Set("id", id)
	object.Set("label", label)
	object.Set("dir", dir)
	return object
}

// findKind — первый тип описи с кодом id.
func findKind(kinds *dynvalue.Array, id any) any {
	for _, kind := range kinds.Items {
		if dynvalue.StrictEqual(dynvalue.Get(kind, "id"), id) {
			return kind
		}
	}
	return nil
}

// addKind добавляет тип для кода кастинга. Тип кастинга открыт: его код или штатная папка уже
// могут принадлежать другому типу исходника, поэтому выбирается свободная папка base, base-2, …
func addKind(kinds *dynvalue.Array, id string) {
	var fallback *sourceedit.Kind
	for index := range sourceedit.DefaultKinds {
		if sourceedit.DefaultKinds[index].ID == id {
			fallback = &sourceedit.DefaultKinds[index]
		}
	}
	base := id
	if fallback != nil {
		base = fallback.Dir
	}
	dir := base
	taken := func(dir string) bool {
		for _, kind := range kinds.Items {
			if dynvalue.StrictEqual(dynvalue.Get(kind, "dir"), dir) {
				return true
			}
		}
		return false
	}
	for suffix := 2; taken(dir); suffix++ {
		dir = base + "-" + strconv.Itoa(suffix)
	}
	if fallback != nil {
		kinds.Items = append(kinds.Items, kindObject(fallback.ID, fallback.Label, dir))
		return
	}
	kinds.Items = append(kinds.Items, kindObject(id, id, dir))
}

// typedKinds — типы описи для sourceedit.ValidateKinds. Код и папка приводятся к строке перед
// проверкой регулярным выражением; нестроковая подпись — TypeError.
func typedKinds(kinds *dynvalue.Array) ([]sourceedit.Kind, error) {
	result := make([]sourceedit.Kind, 0, len(kinds.Items))
	for _, item := range kinds.Items {
		label, ok := dynvalue.Get(item, "label").(string)
		if !ok {
			return nil, &dynvalue.TypeError{Message: "kind.label.trim is not a function"}
		}
		result = append(result, sourceedit.Kind{ID: dynvalue.ToString(dynvalue.Get(item, "id")), Label: label, Dir: dynvalue.ToString(dynvalue.Get(item, "dir"))})
	}
	return result, nil
}

// hasPath — у одного из файлов path равен path.
func hasPath(files *dynvalue.Array, path string) bool {
	for _, file := range files.Items {
		if dynvalue.StrictEqual(dynvalue.Get(file, "path"), path) {
			return true
		}
	}
	return false
}

// copyOriginal создаёт новый файл с байтами и правами источника.
func copyOriginal(from, to string) error {
	source, err := os.Open(from)
	if err != nil {
		return err
	}
	defer source.Close()
	info, err := source.Stat()
	if err != nil {
		return err
	}
	return writeCopy(source, to, info.Mode().Perm())
}

// writeCopy пишет поток в новый файл с правами perm; при ошибке файл удаляется.
func writeCopy(source io.Reader, to string, perm os.FileMode) error {
	target, err := os.OpenFile(to, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, perm)
	if err != nil {
		return err
	}
	_, err = io.Copy(target, source)
	if closeErr := target.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		_ = os.Remove(to)
	}
	return err
}
