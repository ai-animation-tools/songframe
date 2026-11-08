package cast

import (
	"encoding/json"
	"path/filepath"
	"strings"

	"songframe/internal/dynvalue"
	"songframe/internal/sources"
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

// joinSource — путь project/source/path с проверкой аргумента path (dynvalue.PathArg).
func joinSource(project string, value any) (string, error) {
	path, err := dynvalue.PathArg("path", value)
	if err != nil {
		return "", err
	}
	return filepath.Join(project, "source", filepath.FromSlash(path)), nil
}

// ViewProject — кастинг для страницы «Кастинг» и выбора изображений на «Исходниках».
// Ничего не пишет. Проблемы: повреждённый файл, ошибки Validate, описание из исходников, которое
// разошлось с сохранённой копией, и референсы без сущности. Ошибка — TypeError dynvalue на
// документе другой формы.
func ViewProject(project string) (View, error) {
	problems := []string{}
	manifest := sources.ReadManifest(project)
	read := Read(project)
	var current any
	if read.Damaged {
		problems = append(problems, textFileDamaged)
	} else if dynvalue.Truthy(read.Value) {
		found, err := Validate(read.Value)
		if err != nil {
			return View{}, err
		}
		problems = append(problems, found...)
		stored, ok := dynvalue.ReadJSONFile(Path(project))
		if !ok {
			return View{}, &dynvalue.TypeError{Message: "plan/cast.json недоступен для повторного чтения"}
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
		entities, _ := dynvalue.AsArray(ensured.Value("entities"))
		// Коды референсов описи; у описи без массива references — TypeError.
		known := &valueSet{}
		var references []any
		if manifest != nil {
			list, ok := dynvalue.AsArray(dynvalue.Get(manifest, "references"))
			if !ok {
				return View{}, &dynvalue.TypeError{Message: "manifest.references.map is not a function"}
			}
			references = list
		}
		for _, ref := range references {
			id, err := dynvalue.Prop(ref, "id")
			if err != nil {
				return View{}, err
			}
			known.add(id)
		}
		fresh := []string{}
		for _, id := range known.items {
			present := false
			for _, entity := range entities {
				if dynvalue.StrictEqual(dynvalue.Get(entity, "id"), id) {
					present = true
					break
				}
			}
			if !present {
				fresh = append(fresh, dynvalue.ToString(id))
			}
		}
		if len(fresh) > 0 {
			problems = append(problems, textReferencesMissing(fresh))
		}
	}
	images := map[string]string{}
	if current != nil {
		entities, err := dynvalue.Iterate(dynvalue.Coalesce(dynvalue.Get(current, "entities"), &dynvalue.Array{}))
		if err != nil {
			return View{}, err
		}
		for _, entity := range entities {
			list, err := dynvalue.Prop(entity, "images")
			if err != nil {
				return View{}, err
			}
			items, err := dynvalue.Iterate(list)
			if err != nil {
				return View{}, err
			}
			for _, image := range items {
				path, err := joinSource(project, image)
				if err != nil {
					return View{}, err
				}
				images[dynvalue.ToString(image)] = path
			}
		}
	}
	references, err := dynvalue.Iterate(dynvalue.Coalesce(dynvalue.Get(manifest, "references"), &dynvalue.Array{}))
	if err != nil {
		return View{}, err
	}
	for _, ref := range references {
		files, err := dynvalue.Prop(ref, "files")
		if err != nil {
			return View{}, err
		}
		items, err := dynvalue.Iterate(files)
		if err != nil {
			return View{}, err
		}
		for _, file := range items {
			value, err := dynvalue.Prop(file, "path")
			if err != nil {
				return View{}, err
			}
			path, err := joinSource(project, value)
			if err != nil {
				return View{}, err
			}
			images[dynvalue.ToString(value)] = path
		}
	}
	castValue := json.RawMessage("null")
	if current != nil {
		castValue = dynvalue.Raw(current)
	}
	manifestValue := json.RawMessage("null")
	if manifest != nil {
		manifestValue = dynvalue.Raw(manifest)
	}
	return View{Cast: castValue, Manifest: manifestValue, ImagePaths: images, Problems: problems}, nil
}

// descriptionDrifts — коды сущностей, чьё сохранённое описание отличается
// от описания связанного референса описи. Без массива entities или описи — пусто.
func descriptionDrifts(stored, manifest any) ([]string, error) {
	entities, ok := dynvalue.AsArray(dynvalue.Get(stored, "entities"))
	if !ok || !dynvalue.Truthy(manifest) {
		return nil, nil
	}
	projected, err := ProjectDescriptions(stored, manifest)
	if err != nil {
		return nil, err
	}
	current, _ := dynvalue.AsArray(dynvalue.Get(projected, "entities"))
	ids := []string{}
	for index, entity := range entities {
		if !dynvalue.StrictEqual(dynvalue.Get(entity, "appearance"), dynvalue.Get(current[index], "appearance")) {
			ids = append(ids, dynvalue.ToString(dynvalue.Get(entity, "id")))
		}
	}
	return ids, nil
}
