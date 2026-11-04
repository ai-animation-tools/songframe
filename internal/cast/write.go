package cast

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"songframe-go/internal/jscompat"
	"songframe-go/internal/projectfs"
	"songframe-go/internal/sources"
)

// now — источник времени updated_at описи; тесты подменяют его фиксированным значением эталонов.
var now = time.Now

// writeFile — атомарная замена файла проекта (права существующего сохраняются, новый — 0600, как
// writeAtomicBytes оригинала). Точка подмены для тестов сбоя посреди публикации.
var writeFile = func(path string, data []byte) error { return projectfs.WriteFile(path, data, 0) }

// encode — байты файла: JSON.stringify(value, null, 2) и перевод строки.
func encode(value any) []byte { return []byte(jscompat.StringifyIndent(value, "  ") + "\n") }

// FromSources — castFromSources: кастинг из референсов описи. Существующие сущности сохраняют
// свои правки и порядок изображений, получая только описание референса; новые референсы
// становятся сущностями (тип world или неверный тип — prop). Без сущности world она добавляется
// первой. Результат дополнен словарём свойств; existing не меняется.
func FromSources(manifest, existing any, defaults Defaults) (*jscompat.Object, error) {
	var cast *jscompat.Object
	if jscompat.Truthy(existing) {
		cast, _ = jscompat.AsObject(jscompat.DeepClone(existing))
	}
	if cast == nil {
		if jscompat.Truthy(existing) {
			// Истинное значение не-объект (строка, число): `cast.entities.map` оригинала — TypeError.
			return nil, &jscompat.TypeError{Message: "cast.entities.map is not a function"}
		}
		cast = jscompat.NewObject()
		cast.Set("schema_version", 1.0)
		cast.Set("entities", &jscompat.Array{Items: []any{jscompat.DeepClone(defaults.World)}})
		cast.Set("properties", jscompat.DeepClone(defaults.Default))
	}
	entities, ok := cast.Value("entities").(*jscompat.Array)
	if !ok {
		return nil, &jscompat.TypeError{Message: "cast.entities.map is not a function"}
	}
	// byId — `new Map(cast.entities.map((e) => [e.id, e]))`: при повторе кода побеждает последняя сущность.
	type pair struct {
		id     any
		entity any
	}
	var byID []pair
	find := func(id any) (any, bool) {
		for index := len(byID) - 1; index >= 0; index-- {
			if jscompat.StrictEqual(byID[index].id, id) {
				return byID[index].entity, true
			}
		}
		return nil, false
	}
	for _, entity := range entities.Items {
		id, err := jscompat.Prop(entity, "id")
		if err != nil {
			return nil, err
		}
		byID = append(byID, pair{id, entity})
	}
	references, err := jscompat.Iterate(jscompat.Get(manifest, "references"))
	if err != nil {
		return nil, err
	}
	for _, ref := range references {
		files, ok := jscompat.AsArray(jscompat.Get(ref, "files"))
		if !ok {
			return nil, &jscompat.TypeError{Message: "ref.files.map is not a function"}
		}
		images := make([]any, len(files))
		for index, file := range files {
			path, err := jscompat.Prop(file, "path")
			if err != nil {
				return nil, err
			}
			images[index] = path
		}
		id := jscompat.Get(ref, "id")
		if entity, found := find(id); found {
			// Список source — доступные виды, а images — сохранённый выбор; порядок и пустой выбор не сбрасываем.
			object, ok := jscompat.AsObject(entity)
			if !ok {
				return nil, &jscompat.TypeError{Message: "Cannot set properties of non-object entity (setting 'appearance')"}
			}
			object.Set("appearance", jscompat.Coalesce(jscompat.Get(ref, "description"), ""))
			continue
		}
		kind := jscompat.Get(ref, "kind")
		if !slugTest(kind) || jscompat.StrictEqual(kind, WorldID) {
			kind = "prop"
		}
		name := jscompat.Get(ref, "name")
		short := jscompat.Get(ref, "short_name")
		if !jscompat.Truthy(short) {
			short = name
		}
		created := jscompat.NewObject()
		created.Set("id", id)
		created.Set("kind", kind)
		created.Set("name", name)
		created.Set("short_name", short)
		created.Set("role", "")
		// Отсутствующее описание остаётся undefined, как в оригинале: Normalize отклонит такую сущность.
		created.Set("appearance", jscompat.Get(ref, "description"))
		created.Set("images", &jscompat.Array{Items: images})
		created.Set("initial_state", jscompat.NewObject())
		entities.Items = append(entities.Items, created)
		byID = append(byID, pair{id, created})
	}
	hasWorld := false
	for _, entity := range entities.Items {
		if jscompat.StrictEqual(jscompat.Get(entity, "kind"), WorldID) {
			hasWorld = true
			break
		}
	}
	if !hasWorld {
		entities.Items = append([]any{jscompat.DeepClone(defaults.World)}, entities.Items...)
	}
	return EnsureProperties(cast, defaults)
}

// Init — cast.init (initCast): создаёт кастинг из референсов исходников или дополняет
// существующий, затем записывает его через Save-путь. Повреждённый кастинг заменяется новым,
// как в оригинале. Без описи — ошибка, файлы не меняются.
func Init(project string) (*jscompat.Object, error) {
	manifest := sources.ReadManifest(project)
	if manifest == nil {
		return nil, errors.New(textManifestMissing)
	}
	read := Read(project)
	var existing any
	if !read.Damaged && !read.Missing {
		existing = read.Value
	}
	defaults := LoadDefaults()
	cast, err := FromSources(manifest, existing, defaults)
	if err != nil {
		return nil, err
	}
	return write(project, cast, defaults)
}

// Save — cast.save (writeCast): нормализует и проверяет документ, проверяет наличие изображений в
// source и публикует cast.json вместе с описанием референсов в описи (descriptionPlan). Возвращает
// записанный кастинг. Отказ не меняет файлы.
func Save(project string, input any) (*jscompat.Object, error) {
	return write(project, input, LoadDefaults())
}

func write(project string, input any, defaults Defaults) (*jscompat.Object, error) {
	normalized, err := Normalize(input, defaults)
	if err != nil {
		return nil, err
	}
	entities, _ := jscompat.AsArray(normalized.Value("entities"))
	for _, entity := range entities {
		images, _ := jscompat.AsArray(jscompat.Get(entity, "images"))
		for _, image := range images {
			path, err := joinSource(project, image)
			if err != nil {
				return nil, err
			}
			if !jscompat.Exists(path) {
				return nil, errors.New(textImageMissing(jscompat.ToString(jscompat.Get(entity, "name")), jscompat.ToString(image)))
			}
		}
	}
	manifest, err := sources.DescriptionManifest(project)
	if err != nil {
		return nil, err
	}
	plan, err := PlanDescriptions(normalized, manifest, true)
	if err != nil {
		return nil, err
	}
	if err := publish(project, plan); err != nil {
		return nil, err
	}
	return plan.Cast, nil
}

// DescriptionPlan — итог planCastDescriptions: опись с обновлёнными описаниями (nil без описи) и
// кастинг, спроецированный на неё. Используется записью кастинга и (в этапе 44) применением
// предложения трактовки.
type DescriptionPlan struct {
	Manifest any
	Cast     *jscompat.Object
}

// PlanDescriptions — planCastDescriptions. Описание связанного референса принадлежит описи, а
// appearance кастинга — его проекция. fromCast=true — явная запись из кастинга: appearance
// сущностей переносится в description референсов, а при изменении обновляется updated_at.
// Исходные cast и manifest не меняются.
func PlanDescriptions(cast *jscompat.Object, manifest any, fromCast bool) (DescriptionPlan, error) {
	var next any
	if manifest != nil {
		next = jscompat.DeepClone(manifest)
	}
	if next != nil && fromCast {
		entities, _ := jscompat.AsArray(cast.Value("entities"))
		references, _ := jscompat.AsArray(jscompat.Get(next, "references"))
		changed := false
		for _, ref := range references {
			var entity any
			found := false
			// `new Map(entities.map(...))`: последняя сущность с кодом побеждает.
			for index := len(entities) - 1; index >= 0; index-- {
				if jscompat.StrictEqual(jscompat.Get(entities[index], "id"), jscompat.Get(ref, "id")) {
					entity, found = entities[index], true
					break
				}
			}
			appearance := jscompat.Get(entity, "appearance")
			if found && jscompat.Truthy(entity) && !jscompat.StrictEqual(jscompat.Get(ref, "description"), appearance) {
				ref.(*jscompat.Object).Set("description", appearance)
				changed = true
			}
		}
		if changed {
			next.(*jscompat.Object).Set("updated_at", now().UTC().Format("2006-01-02T15:04:05.000Z"))
		}
	}
	projected, err := ProjectDescriptions(jscompat.DeepClone(cast), next)
	if err != nil {
		return DescriptionPlan{}, err
	}
	object, _ := jscompat.AsObject(projected)
	return DescriptionPlan{Manifest: next, Cast: object}, nil
}

// fileChange — одна замена публикации: путь внутри проекта, прежние байты (nil — файла не было) и новые.
type fileChange struct {
	rel    string
	before []byte
	next   []byte
}

// publish — publishCastDescriptionPlan: узкая публикация двух JSON. Опись (canonical-описание)
// пишется до кастинга, поэтому прерванный процесс всегда оставляет читаемую пару: кастинг
// проецирует описание из описи при каждом чтении. Сбой записи восстанавливает прежние байты;
// если и восстановление не удалось, прежние байты сохраняются во временный резерв, путь которого
// входит в ошибку. Запись разрешена только шлюзом projectfs.
func publish(project string, plan DescriptionPlan) error {
	values := []fileChange{{rel: "plan/cast.json", next: encode(plan.Cast)}}
	if plan.Manifest != nil {
		current, err := sources.DescriptionManifest(project)
		if err != nil {
			return err
		}
		if jscompat.Stringify(current) != jscompat.Stringify(plan.Manifest) {
			values = append(values, fileChange{rel: "source/manifest.json", next: encode(plan.Manifest)})
		}
	}
	var changes []fileChange
	for _, change := range values {
		previous, err := os.ReadFile(filepath.Join(project, filepath.FromSlash(change.rel)))
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		if err == nil {
			change.before = previous
			if bytes.Equal(previous, change.next) {
				continue
			}
		}
		changes = append(changes, change)
	}
	if len(changes) == 0 {
		return nil
	}
	if err := projectfs.CheckWrite(project); err != nil {
		return err
	}
	for index := len(changes) - 1; index >= 0; index-- {
		change := changes[index]
		if err := writeFile(filepath.Join(project, filepath.FromSlash(change.rel)), change.next); err != nil {
			if restoreErr := restore(project, changes); restoreErr != nil {
				return restoreErr
			}
			return err
		}
	}
	return nil
}

// restore возвращает прежние байты всех файлов публикации (отсутствовавший файл удаляется).
// При ошибке прежние байты сохраняются в отдельной временной папке, и её путь сообщается.
func restore(project string, changes []fileChange) error {
	var failure error
	for _, change := range changes {
		path := filepath.Join(project, filepath.FromSlash(change.rel))
		var err error
		if change.before == nil {
			err = os.Remove(path)
			if errors.Is(err, os.ErrNotExist) {
				err = nil
			}
		} else {
			err = writeFile(path, change.before)
		}
		if err != nil {
			failure = err
			break
		}
	}
	if failure == nil {
		return nil
	}
	backup, err := os.MkdirTemp("", "songframe-description-save-")
	if err == nil {
		for index, change := range changes {
			if change.before != nil {
				err = errors.Join(err, os.WriteFile(filepath.Join(backup, fmt.Sprintf("%d.json", index)), change.before, 0o600))
			}
		}
	}
	return RestoreFailed(backup, errors.Join(failure, err))
}

// RestoreFailed — referenceImageTexts.restoreFailed: откат после ошибки не удался, прежние данные
// оставлены в резерве backup. reason выводится как String(error) в JS («Error: …»). Текст общий
// для публикации описаний и сохранения исходников с кастингом (internal/referenceimage).
func RestoreFailed(backup string, reason error) error {
	return fmt.Errorf("%s%s: Error: %v", textRestoreFailedPrefix, backup, reason)
}
