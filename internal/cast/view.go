package cast

import (
	"encoding/json"
	"path/filepath"
	"strings"

	"songframe-go/internal/jscompat"
	"songframe-go/internal/sources"
)

// View — CastView контракта frontend/src/shared/types.ts, ответ cast.view.
// Документы без схемы передаются как есть (порядок ключей и неизвестные поля сохраняются).
type View struct {
	// Cast — кастинг после проекции описаний и дополнения словаря свойств или null.
	Cast json.RawMessage `json:"cast"`
	// Manifest — опись исходников схемы 1 или null.
	Manifest json.RawMessage `json:"manifest"`
	// ImagePaths — абсолютный путь изображения по пути внутри source (кастинг и опись).
	ImagePaths map[string]string `json:"imagePaths"`
	Problems   []string          `json:"problems"`
}

// joinSource — join(project, 'source', path) с проверкой аргумента node:path.
func joinSource(project string, value any) (string, error) {
	path, err := jscompat.PathArg("path", value)
	if err != nil {
		return "", err
	}
	return filepath.Join(project, "source", filepath.FromSlash(path)), nil
}

// ViewProject — viewCast: кастинг для страницы «Кастинг» и выбора изображений на «Исходниках».
// Ничего не пишет. Проблемы: повреждённый файл, ошибки Validate, описание из исходников, которое
// разошлось с сохранённой копией, и референсы без сущности. Ошибка — исключение оригинала на
// документе другой формы.
func ViewProject(project string) (View, error) {
	problems := []string{}
	manifest := sources.ReadManifest(project)
	read := Read(project)
	var current any
	if read.Damaged {
		problems = append(problems, textFileDamaged)
	} else if jscompat.Truthy(read.Value) {
		found, err := Validate(read.Value)
		if err != nil {
			return View{}, err
		}
		problems = append(problems, found...)
		stored, ok := jscompat.ReadJSONFile(Path(project))
		if !ok {
			return View{}, &jscompat.TypeError{Message: "plan/cast.json недоступен для повторного чтения"}
		}
		drift, err := descriptionDrifts(stored, manifest)
		if err != nil {
			return View{}, err
		}
		if len(drift) > 0 {
			problems = append(problems, textDescriptionFromSources1+strings.Join(drift, ", ")+textDescriptionFromSources2)
		}
		ensured, err := EnsureProperties(read.Value, LoadDefaults())
		if err != nil {
			return View{}, err
		}
		current = ensured
		entities, _ := jscompat.AsArray(ensured.Value("entities"))
		// `new Set(manifest?.references.map((r) => r.id) ?? [])`: у описи без массива references — TypeError.
		known := &valueSet{}
		var references []any
		if manifest != nil {
			list, ok := jscompat.AsArray(jscompat.Get(manifest, "references"))
			if !ok {
				return View{}, &jscompat.TypeError{Message: "manifest.references.map is not a function"}
			}
			references = list
		}
		for _, ref := range references {
			id, err := jscompat.Prop(ref, "id")
			if err != nil {
				return View{}, err
			}
			known.add(id)
		}
		fresh := []string{}
		for _, id := range known.items {
			present := false
			for _, entity := range entities {
				if jscompat.StrictEqual(jscompat.Get(entity, "id"), id) {
					present = true
					break
				}
			}
			if !present {
				fresh = append(fresh, jscompat.ToString(id))
			}
		}
		if len(fresh) > 0 {
			problems = append(problems, textReferencesMissing(fresh))
		}
	}
	images := map[string]string{}
	if current != nil {
		entities, err := jscompat.Iterate(jscompat.Coalesce(jscompat.Get(current, "entities"), &jscompat.Array{}))
		if err != nil {
			return View{}, err
		}
		for _, entity := range entities {
			list, err := jscompat.Prop(entity, "images")
			if err != nil {
				return View{}, err
			}
			items, err := jscompat.Iterate(list)
			if err != nil {
				return View{}, err
			}
			for _, image := range items {
				path, err := joinSource(project, image)
				if err != nil {
					return View{}, err
				}
				images[jscompat.ToString(image)] = path
			}
		}
	}
	references, err := jscompat.Iterate(jscompat.Coalesce(jscompat.Get(manifest, "references"), &jscompat.Array{}))
	if err != nil {
		return View{}, err
	}
	for _, ref := range references {
		files, err := jscompat.Prop(ref, "files")
		if err != nil {
			return View{}, err
		}
		items, err := jscompat.Iterate(files)
		if err != nil {
			return View{}, err
		}
		for _, file := range items {
			value, err := jscompat.Prop(file, "path")
			if err != nil {
				return View{}, err
			}
			path, err := joinSource(project, value)
			if err != nil {
				return View{}, err
			}
			images[jscompat.ToString(value)] = path
		}
	}
	castValue := json.RawMessage("null")
	if current != nil {
		castValue = jscompat.Raw(current)
	}
	manifestValue := json.RawMessage("null")
	if manifest != nil {
		manifestValue = jscompat.Raw(manifest)
	}
	return View{Cast: castValue, Manifest: manifestValue, ImagePaths: images, Problems: problems}, nil
}

// descriptionDrifts — castDescriptionDrifts: коды сущностей, чьё сохранённое описание отличается
// от описания связанного референса описи. Без массива entities или описи — пусто.
func descriptionDrifts(stored, manifest any) ([]string, error) {
	entities, ok := jscompat.AsArray(jscompat.Get(stored, "entities"))
	if !ok || !jscompat.Truthy(manifest) {
		return nil, nil
	}
	projected, err := ProjectDescriptions(stored, manifest)
	if err != nil {
		return nil, err
	}
	current, _ := jscompat.AsArray(jscompat.Get(projected, "entities"))
	ids := []string{}
	for index, entity := range entities {
		if !jscompat.StrictEqual(jscompat.Get(entity, "appearance"), jscompat.Get(current[index], "appearance")) {
			ids = append(ids, jscompat.ToString(jscompat.Get(entity, "id")))
		}
	}
	return ids, nil
}
