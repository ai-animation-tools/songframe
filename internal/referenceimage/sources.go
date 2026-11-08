// Package referenceimage согласует запись референсов исходников и сущностей кастинга: они делят
// одни файлы в source/, поэтому их запись согласуется здесь, а не в internal/sourceedit (форма
// «Исходники») или internal/cast (документ кастинга).
//
// Пакет содержит сохранение исходников с синхронизацией кастинга (sources.go), публикацию
// принятого изображения референса (attach.go), а также чтение выбранных опор (inputs.go) и
// контекста конструктора промпта (context.go) для генерации обложки и референсов
// (internal/covergen).
package referenceimage

import (
	"context"
	"encoding/json"
	"errors"

	"songframe/internal/cast"
	"songframe/internal/dynvalue"
	"songframe/internal/sourceedit"
	"songframe/internal/sources"
)

// Тексты referenceImageTexts, которые возвращает сохранение исходников.
// restoreFailed общий с публикацией описаний и принадлежит internal/cast (cast.RestoreFailed).
const (
	textImageInUse  = "Изображение используется сущностью. Сначала уберите его из выбора на странице «Кастинг», затем удалите из исходников."
	textCastInvalid = "Не удалось прочитать кастинг проекта. Исправьте данные перед принятием изображения."
)

// saveCast — запись кастинга после сохранения исходников; точка подмены для тестов отката.
var saveCast = func(project string, document any) error {
	_, err := cast.Save(project, document)
	return err
}

// SaveSources — sources.save: сохраняет форму «Исходники» и, если в проекте есть кастинг,
// согласует его с новой описью. Возвращает записанную опись.
//
// Без plan/cast.json (или с JSON null/ложным значением в нём) это обычное sourceedit.Save. С
// кастингом шаги идут по порядку (он определяет, какой отказ увидит пользователь):
//  1. повреждённый кастинг (не разбирается или непригодна опись) — отказ castInvalid, кастинг
//     другой структуры — отказ его нормализации; оба раньше проверки формы;
//  2. удаление из исходников изображения, выбранного у сущности, — отказ imageInUse: сначала
//     выбор снимают на странице «Кастинг», иначе кастинг ссылался бы на отсутствующий файл;
//  3. исходники сохраняются, описания референсов проецируются в appearance сущностей, новые
//     виды референса добавляются в images сущности с тем же кодом, кастинг записывается через
//     cast.Save (нормализация, проверка файлов изображений, публикация описаний).
//
// Файлы референса, сменившего тип, переезжают в папку нового типа
// (sourceedit.SaveOptions), а пути в images кастинга заменяются на новые. Референсы, которые
// используют планы с готовыми материалами (PinnedReferences), остаются на месте.
//
// Любая ошибка после начала записи возвращает source/ и plan/cast.json к прежнему состоянию из
// резерва (snapshot); если это не удалось, ошибка restoreFailed называет папку резерва, и резерв
// остаётся на диске. Отказы до записи ничего не меняют и резерв не создают.
func SaveSources(ctx context.Context, project string, input sourceedit.Input, ffprobe sourceedit.DurationProbe) (json.RawMessage, error) {
	previous := sources.ReadManifest(project)
	read := cast.Read(project)
	if read.Damaged {
		return nil, errors.New(textCastInvalid)
	}
	pinned := pinnedSet(project)
	if !dynvalue.Truthy(read.Value) {
		manifest, _, err := sourceedit.SaveManifest(ctx, project, input, ffprobe, sourceedit.SaveOptions{Pinned: pinned})
		if err != nil {
			return nil, err
		}
		return dynvalue.Raw(manifest), nil
	}
	// Результат нормализации не нужен: она только проверяет документ, а записывает его cast.Save.
	if _, err := cast.Normalize(read.Value, cast.LoadDefaults()); err != nil {
		return nil, err
	}
	inUse, err := removesSelectedImage(read.Value, previous, input)
	if err != nil {
		return nil, err
	}
	if inUse {
		return nil, errors.New(textImageInUse)
	}

	// Резерв создаётся только после проверки формы и шлюза записи — перед первой записью.
	var backup *snapshot
	manifest, moves, err := sourceedit.SaveManifest(ctx, project, input, ffprobe, sourceedit.SaveOptions{
		BeforeWrite: func() error {
			var err error
			backup, err = takeSnapshot(project)
			return err
		},
		Pinned: pinned,
	})
	if err == nil {
		var synced any
		if synced, err = withNewImages(read.Value, previous, input, manifest, moves); err == nil {
			err = saveCast(project, synced)
		}
	}
	if err != nil {
		if backup != nil {
			if restoreErr := backup.restore(); restoreErr != nil {
				return nil, cast.RestoreFailed(backup.dir, restoreErr)
			}
			backup.remove()
		}
		return nil, err
	}
	backup.remove()
	return dynvalue.Raw(manifest), nil
}

// removesSelectedImage сообщает, удаляет ли форма файл прежней описи, выбранный в images
// какой-либо сущности. Удалённым считается путь прежней описи, которого нет среди existingPath
// формы. document уже проверен cast.Normalize: сущности — объекты с массивом строк images.
func removesSelectedImage(document, previous any, input sourceedit.Input) (bool, error) {
	known := map[string]bool{}
	if previous != nil {
		references, err := dynvalue.Iterate(dynvalue.Get(previous, "references"))
		if err != nil {
			return false, err
		}
		for _, ref := range references {
			paths, err := filePaths(ref)
			if err != nil {
				return false, err
			}
			for path := range paths {
				known[path] = true
			}
		}
	}
	kept := map[string]bool{}
	for _, ref := range input.References {
		for _, file := range ref.Files {
			if file.ExistingPath != nil && *file.ExistingPath != "" {
				kept[*file.ExistingPath] = true
			}
		}
	}
	entities, _ := dynvalue.AsArray(dynvalue.Get(document, "entities"))
	for _, entity := range entities {
		images, _ := dynvalue.AsArray(dynvalue.Get(entity, "images"))
		for _, image := range images {
			if path, _ := image.(string); known[path] && !kept[path] {
				return true, nil
			}
		}
	}
	return false, nil
}

// withNewImages строит кастинг для записи: независимая копия document с описаниями из новой
// описи (cast.ProjectDescriptions), где пути перенесённых файлов (moves) заменены новыми, а в
// images сущности дописаны новые виды её референса. Перенесённый файл не новый: выбор
// пользователя не расширяется.
//
// Новым считается файл, пришедший из формы новым (sourcePath), или путь, которого не было у
// референса в прежней описи. Именно ввод, а не только путь: новый вид может занять имя
// удалённого невыбранного файла, и по одному пути его не отличить от прежнего. Прежние виды не
// добавляются: images — сохранённый выбор пользователя, а не список доступных видов. Сущности без
// референса и референсы без сущности не меняются; сущность из референса создаёт только cast.Init.
func withNewImages(document, previous any, input sourceedit.Input, manifest *dynvalue.Object, moves map[string]string) (any, error) {
	projected, err := cast.ProjectDescriptions(dynvalue.DeepClone(document), manifest)
	if err != nil {
		return nil, err
	}
	renameImages(projected, moves)
	movedTo := map[string]bool{}
	for _, target := range moves {
		movedTo[target] = true
	}
	previousRefs, _ := dynvalue.AsArray(dynvalue.Get(previous, "references"))
	manifestRefs, _ := dynvalue.AsArray(manifest.Value("references"))
	entities, _ := dynvalue.AsArray(dynvalue.Get(projected, "entities"))
	for _, entity := range entities {
		id := dynvalue.Get(entity, "id")
		ref := findByID(manifestRefs, id)
		if ref == nil {
			continue
		}
		old := map[string]bool{}
		if previousRef := findByID(previousRefs, id); previousRef != nil {
			if old, err = filePaths(previousRef); err != nil {
				return nil, err
			}
		}
		var incoming []sourceedit.FileInput
		for _, item := range input.References {
			if dynvalue.StrictEqual(item.ID, id) {
				incoming = item.Files
				break
			}
		}
		// Сущность — копия из DeepClone/Spread, images — её собственный массив строк (проверен Normalize).
		images, _ := dynvalue.Get(entity, "images").(*dynvalue.Array)
		files, _ := dynvalue.AsArray(dynvalue.Get(ref, "files"))
		for index, file := range files {
			path, _ := dynvalue.Get(file, "path").(string)
			fresh := index < len(incoming) && incoming[index].SourcePath != nil && *incoming[index].SourcePath != ""
			if (fresh || !old[path]) && !movedTo[path] && images != nil && !contains(images.Items, path) {
				images.Items = append(images.Items, path)
			}
		}
	}
	return projected, nil
}

// findByID — первый референс с кодом id или nil.
func findByID(refs []any, id any) any {
	for _, ref := range refs {
		if dynvalue.StrictEqual(dynvalue.Get(ref, "id"), id) {
			return ref
		}
	}
	return nil
}

// filePaths — строковые пути ref.files[].path. Не массив files или пустой элемент — TypeError
// dynvalue с текстом, зафиксированным эталоном. Нестроковые пути пропускаются: их не совпадёт ни
// одно изображение кастинга (это строки).
func filePaths(ref any) (map[string]bool, error) {
	files, err := dynvalue.Prop(ref, "files")
	if err != nil {
		return nil, err
	}
	list, ok := dynvalue.AsArray(files)
	if !ok {
		return nil, &dynvalue.TypeError{Message: "ref.files: ожидается список"}
	}
	paths := map[string]bool{}
	for _, file := range list {
		path, err := dynvalue.Prop(file, "path")
		if err != nil {
			return nil, err
		}
		if text, ok := path.(string); ok {
			paths[text] = true
		}
	}
	return paths, nil
}

// contains — есть ли среди элементов строка value.
func contains(items []any, value string) bool {
	for _, item := range items {
		if text, ok := item.(string); ok && text == value {
			return true
		}
	}
	return false
}
