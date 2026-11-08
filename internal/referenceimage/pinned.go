package referenceimage

import (
	"path/filepath"
	"sort"

	"songframe/internal/cast"
	"songframe/internal/dynvalue"
	"songframe/internal/production"
	"songframe/internal/sources"
)

// PinnedReferences — какие референсы описи закреплены производством: код референса → планы
// сохранённого реестра с готовыми материалами (принятый комплект или хотя бы один пакет), которые
// ссылаются на него (scenes[].references или card.primary_reference). Файлы закреплённого
// референса при смене типа не переносятся: путь входит в отпечатки карточек и запросы пакетов, и
// перенос сделал бы готовые материалы устаревшими.
//
// Если состояние производства не вычисляется (повреждённый реестр), закреплены все референсы
// описи с пустым списком планов: перенос без проверки мог бы испортить материалы. Ничего не пишет.
func PinnedReferences(project string) map[string][]string {
	result := map[string][]string{}
	states, err := production.ShotStates(project)
	if err != nil {
		for _, id := range manifestReferenceIDs(sources.ReadManifest(project)) {
			result[id] = []string{}
		}
		return result
	}
	scenes, _ := dynvalue.ReadJSONFile(filepath.Join(project, "plan", "scenes.json"))
	list, _ := dynvalue.AsArray(dynvalue.Get(scenes, "scenes"))
	for _, shot := range list {
		id := dynvalue.ToString(dynvalue.Get(shot, "id"))
		if !states[id].Produced {
			continue
		}
		used := map[string]bool{}
		references, _ := dynvalue.AsArray(dynvalue.Get(shot, "references"))
		for _, ref := range references {
			if text, ok := ref.(string); ok {
				used[text] = true
			}
		}
		if primary, ok := dynvalue.GetPath(shot, "card", "primary_reference").(string); ok {
			used[primary] = true
		}
		for ref := range used {
			result[ref] = append(result[ref], id)
		}
	}
	for ref := range result {
		sort.Strings(result[ref])
	}
	return result
}

// EntityKinds — код сущности кастинга → её тип для выбора типа нового референса на странице
// «Исходники». Без кастинга или при повреждённом — пусто. Ничего не пишет.
func EntityKinds(project string) map[string]string {
	result := map[string]string{}
	read := cast.Read(project)
	if read.Damaged || read.Missing {
		return result
	}
	entities, _ := dynvalue.AsArray(dynvalue.Get(read.Value, "entities"))
	for _, entity := range entities {
		id, idOK := dynvalue.Get(entity, "id").(string)
		kind, kindOK := dynvalue.Get(entity, "kind").(string)
		if idOK && kindOK {
			result[id] = kind
		}
	}
	return result
}

// manifestReferenceIDs — коды референсов описи (строковые), в порядке описи.
func manifestReferenceIDs(manifest any) []string {
	ids := []string{}
	references, _ := dynvalue.AsArray(dynvalue.Get(manifest, "references"))
	for _, ref := range references {
		if id, ok := dynvalue.Get(ref, "id").(string); ok {
			ids = append(ids, id)
		}
	}
	return ids
}

// pinnedSet — коды закреплённых референсов для sourceedit.SaveOptions.Pinned.
func pinnedSet(project string) map[string]bool {
	set := map[string]bool{}
	for id := range PinnedReferences(project) {
		set[id] = true
	}
	return set
}

// renameImages заменяет в images сущностей кастинга пути перенесённых файлов (moves: прежний путь →
// новый). document — независимая копия для записи; порядок и выбор изображений сохраняются.
func renameImages(document any, moves map[string]string) {
	if len(moves) == 0 {
		return
	}
	entities, _ := dynvalue.AsArray(dynvalue.Get(document, "entities"))
	for _, entity := range entities {
		images, _ := dynvalue.Get(entity, "images").(*dynvalue.Array)
		if images == nil {
			continue
		}
		for index, image := range images.Items {
			if text, ok := image.(string); ok {
				if target, moved := moves[text]; moved {
					images.Items[index] = target
				}
			}
		}
	}
}
