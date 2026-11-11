package cast

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"songframe/internal/dynvalue"
	"songframe/internal/projectfs"
	"songframe/internal/sources"
)

// now — источник времени updated_at описи; тесты подменяют его фиксированным значением эталонов.
var now = time.Now

// writeFile — атомарная замена файла проекта (права существующего сохраняются, новый — 0600).
// Точка подмены для тестов сбоя посреди публикации.
var writeFile = func(path string, data []byte) error { return projectfs.WriteFile(path, data, 0) }

// encode — байты файла: JSON с отступом в два пробела и перевод строки.
func encode(value any) []byte { return []byte(dynvalue.StringifyIndent(value, "  ") + "\n") }

// FromSources строит кастинг из референсов описи. Существующие сущности сохраняют
// свои правки и порядок изображений, получая только описание референса; новые референсы
// становятся сущностями (тип world или неверный тип — prop). Без сущности world она добавляется
// первой. Результат дополнен словарём свойств; existing не меняется.
func FromSources(manifest, existing any, defaults Defaults) (*dynvalue.Object, error) {
	var cast *dynvalue.Object
	if dynvalue.Truthy(existing) {
		cast, _ = dynvalue.AsObject(dynvalue.DeepClone(existing))
	}
	if cast == nil {
		if dynvalue.Truthy(existing) {
			// Истинное значение не-объект (строка, число) — TypeError: у него нет списка entities.
			return nil, &dynvalue.TypeError{Message: "cast.entities: ожидается список"}
		}
		cast = dynvalue.NewObject()
		cast.Set("schema_version", 1.0)
		cast.Set("entities", &dynvalue.Array{Items: []any{dynvalue.DeepClone(defaults.World)}})
		cast.Set("properties", dynvalue.DeepClone(defaults.Default))
	}
	entities, ok := cast.Value("entities").(*dynvalue.Array)
	if !ok {
		return nil, &dynvalue.TypeError{Message: "cast.entities: ожидается список"}
	}
	// byId — сущности по коду: при повторе кода побеждает последняя сущность.
	type pair struct {
		id     any
		entity any
	}
	var byID []pair
	find := func(id any) (any, bool) {
		for index := len(byID) - 1; index >= 0; index-- {
			if dynvalue.StrictEqual(byID[index].id, id) {
				return byID[index].entity, true
			}
		}
		return nil, false
	}
	for _, entity := range entities.Items {
		id, err := dynvalue.Prop(entity, "id")
		if err != nil {
			return nil, err
		}
		byID = append(byID, pair{id, entity})
	}
	references, err := dynvalue.Iterate(dynvalue.Get(manifest, "references"))
	if err != nil {
		return nil, err
	}
	for _, ref := range references {
		files, ok := dynvalue.AsArray(dynvalue.Get(ref, "files"))
		if !ok {
			return nil, &dynvalue.TypeError{Message: "ref.files: ожидается список"}
		}
		images := make([]any, len(files))
		for index, file := range files {
			path, err := dynvalue.Prop(file, "path")
			if err != nil {
				return nil, err
			}
			images[index] = path
		}
		id := dynvalue.Get(ref, "id")
		if entity, found := find(id); found {
			// Список source — доступные виды, а images — сохранённый выбор; порядок и пустой выбор не сбрасываем.
			object, ok := dynvalue.AsObject(entity)
			if !ok {
				return nil, &dynvalue.TypeError{Message: "нельзя задать поле 'appearance': значение не объект"}
			}
			object.Set("appearance", dynvalue.Coalesce(dynvalue.Get(ref, "description"), ""))
			continue
		}
		kind := dynvalue.Get(ref, "kind")
		if !slugTest(kind) || dynvalue.StrictEqual(kind, WorldID) {
			kind = "prop"
		}
		name := dynvalue.Get(ref, "name")
		short := dynvalue.Get(ref, "short_name")
		if !dynvalue.Truthy(short) {
			short = name
		}
		created := dynvalue.NewObject()
		created.Set("id", id)
		created.Set("kind", kind)
		created.Set("name", name)
		created.Set("short_name", short)
		created.Set("role", "")
		// Отсутствующее описание остаётся незаданным: Normalize отклонит такую сущность.
		created.Set("appearance", dynvalue.Get(ref, "description"))
		created.Set("images", &dynvalue.Array{Items: images})
		created.Set("initial_state", dynvalue.NewObject())
		entities.Items = append(entities.Items, created)
		byID = append(byID, pair{id, created})
	}
	hasWorld := false
	for _, entity := range entities.Items {
		if dynvalue.StrictEqual(dynvalue.Get(entity, "kind"), WorldID) {
			hasWorld = true
			break
		}
	}
	if !hasWorld {
		entities.Items = append([]any{dynvalue.DeepClone(defaults.World)}, entities.Items...)
	}
	return EnsureProperties(cast, defaults)
}

// Init — cast.init: создаёт кастинг из референсов исходников или дополняет
// существующий, затем записывает его через Save-путь. Повреждённый кастинг заменяется новым.
// Без описи — ошибка, файлы не меняются.
func Init(project string) (*dynvalue.Object, error) {
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

// Save — cast.save: нормализует и проверяет документ, проверяет наличие изображений в
// source и публикует cast.json вместе с описанием референсов в описи (descriptionPlan) и картой
// references реестра сцен (ScenesWithReferences). Возвращает
// записанный кастинг. Отказ не меняет файлы.
func Save(project string, input any) (*dynvalue.Object, error) {
	return write(project, input, LoadDefaults())
}

func write(project string, input any, defaults Defaults) (*dynvalue.Object, error) {
	normalized, err := Normalize(input, defaults)
	if err != nil {
		return nil, err
	}
	entities, _ := dynvalue.AsArray(normalized.Value("entities"))
	for _, entity := range entities {
		images, _ := dynvalue.AsArray(dynvalue.Get(entity, "images"))
		for _, image := range images {
			path, err := joinSource(project, image)
			if err != nil {
				return nil, err
			}
			if !dynvalue.Exists(path) {
				return nil, errors.New(textImageMissing(dynvalue.ToString(dynvalue.Get(entity, "name")), dynvalue.ToString(image)))
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

// DescriptionPlan — итог PlanDescriptions: опись с обновлёнными описаниями (nil без описи) и
// кастинг, спроецированный на неё. Используется записью кастинга и применением предложения
// трактовки.
type DescriptionPlan struct {
	Manifest any
	Cast     *dynvalue.Object
}

// PlanDescriptions согласует описания кастинга и описи. Описание связанного референса
// принадлежит описи, а appearance кастинга — его проекция. fromCast=true — явная запись из кастинга: appearance
// сущностей переносится в description референсов, а при изменении обновляется updated_at.
// Исходные cast и manifest не меняются.
func PlanDescriptions(cast *dynvalue.Object, manifest any, fromCast bool) (DescriptionPlan, error) {
	var next any
	if manifest != nil {
		next = dynvalue.DeepClone(manifest)
	}
	if next != nil && fromCast {
		entities, _ := dynvalue.AsArray(cast.Value("entities"))
		references, _ := dynvalue.AsArray(dynvalue.Get(next, "references"))
		changed := false
		for _, ref := range references {
			var entity any
			found := false
			// Как в FromSources: при повторе кода побеждает последняя сущность.
			for index := len(entities) - 1; index >= 0; index-- {
				if dynvalue.StrictEqual(dynvalue.Get(entities[index], "id"), dynvalue.Get(ref, "id")) {
					entity, found = entities[index], true
					break
				}
			}
			appearance := dynvalue.Get(entity, "appearance")
			if found && dynvalue.Truthy(entity) && !dynvalue.StrictEqual(dynvalue.Get(ref, "description"), appearance) {
				ref.(*dynvalue.Object).Set("description", appearance)
				changed = true
			}
		}
		if changed {
			next.(*dynvalue.Object).Set("updated_at", now().UTC().Format("2006-01-02T15:04:05.000Z"))
		}
	}
	projected, err := ProjectDescriptions(dynvalue.DeepClone(cast), next)
	if err != nil {
		return DescriptionPlan{}, err
	}
	object, _ := dynvalue.AsObject(projected)
	return DescriptionPlan{Manifest: next, Cast: object}, nil
}

// fileChange — одна замена публикации: путь внутри проекта, прежние байты (nil — файла не было) и новые.
type fileChange struct {
	rel    string
	before []byte
	next   []byte
}

// ScenesPath — реестр сцен относительно папки проекта: его карту references выводит кастинг.
const ScenesPath = "plan/scenes.json"

// ScenesWithReferences — новые байты plan/scenes.json, в которых карта references заменена картой
// из кастинга castValue (References). nil — менять нечего: реестра нет, он не разбирается как
// объект (его покажет проверка реестра) или карта уже совпадает. Карта полностью выводится из
// кастинга, поэтому каждая запись кастинга обновляет её вместе с собой, а постановка планов
// остаётся как есть; списки references планов не трогаются.
func ScenesWithReferences(project string, castValue any) ([]byte, error) {
	path := filepath.Join(project, filepath.FromSlash(ScenesPath))
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, dynvalue.FsError("open", path, err)
	}
	parsed, err := dynvalue.Parse([]byte(dynvalue.DecodeUTF8(data)))
	if err != nil {
		return nil, nil
	}
	scenes, ok := dynvalue.AsObject(parsed)
	if !ok {
		return nil, nil
	}
	references, err := References(castValue)
	if err != nil {
		return nil, err
	}
	if dynvalue.Stringify(scenes.Value("references")) == dynvalue.Stringify(references) {
		return nil, nil
	}
	scenes.Set("references", references)
	return encode(scenes), nil
}

// publish — узкая публикация JSON кастинга. Опись (canonical-описание)
// пишется до кастинга, поэтому прерванный процесс всегда оставляет читаемую пару: кастинг
// проецирует описание из описи при каждом чтении. Карта references реестра сцен пишется
// последней: прерывание до неё оставляет прежнюю карту, расхождение показывает проверка реестра. Сбой записи восстанавливает прежние байты;
// если и восстановление не удалось, прежние байты сохраняются во временный резерв, путь которого
// входит в ошибку. Запись разрешена только шлюзом projectfs.
func publish(project string, plan DescriptionPlan) error {
	values := []fileChange{{rel: "plan/cast.json", next: encode(plan.Cast)}}
	scenes, err := ScenesWithReferences(project, plan.Cast)
	if err != nil {
		return err
	}
	if scenes != nil {
		values = append([]fileChange{{rel: ScenesPath, next: scenes}}, values...)
	}
	if plan.Manifest != nil {
		current, err := sources.DescriptionManifest(project)
		if err != nil {
			return err
		}
		if dynvalue.Stringify(current) != dynvalue.Stringify(plan.Manifest) {
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
// оставлены в резерве backup, после двоеточия — причина reason. Текст общий
// для публикации описаний и сохранения исходников с кастингом (internal/referenceimage).
func RestoreFailed(backup string, reason error) error {
	return fmt.Errorf("%s%s: %v", textRestoreFailedPrefix, backup, reason)
}
