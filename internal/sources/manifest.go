// Package sources читает опись исходников source/manifest.json. Документ возвращается деревом
// jscompat без схемы: потребители (статус, кастинг, разметка) проверяют только нужные им поля, а
// неизвестные поля сохраняются.
package sources

import (
	"errors"
	"path/filepath"

	"songframe-go/internal/jscompat"
)

// ManifestInvalid — текст sourcesTexts.main.manifestInvalid.
const ManifestInvalid = "source/manifest.json повреждён или другой версии."

// ManifestPath — путь описи внутри проекта.
func ManifestPath(project string) string {
	return filepath.Join(project, "source", "manifest.json")
}

// ReadManifest возвращает опись схемы 1 или nil: отсутствие, битый JSON и другая версия
// неразличимы. Любое истинное значение с schema_version === 1 подходит.
func ReadManifest(project string) any {
	data, ok := jscompat.ReadJSONFile(ManifestPath(project))
	if !ok || !jscompat.Truthy(data) || !jscompat.StrictEqual(jscompat.Get(data, "schema_version"), 1.0) {
		return nil
	}
	return data
}

// DescriptionManifest — опись, из которой кастинг берёт канонические описания сущностей.
// Отсутствующий файл даёт nil без ошибки; существующий, но непригодный (не та схема, references
// не массив, ссылка без строкового id или с нестроковым description) — ошибку ManifestInvalid.
func DescriptionManifest(project string) (any, error) {
	if !jscompat.Exists(ManifestPath(project)) {
		return nil, nil
	}
	manifest := ReadManifest(project)
	references, ok := jscompat.AsArray(jscompat.Get(manifest, "references"))
	if manifest == nil || !ok {
		return nil, errors.New(ManifestInvalid)
	}
	for _, ref := range references {
		description := jscompat.Get(ref, "description")
		if !jscompat.Truthy(ref) || jscompat.TypeOf(jscompat.Get(ref, "id")) != "string" ||
			(description != jscompat.Undefined && jscompat.TypeOf(description) != "string") {
			return nil, errors.New(ManifestInvalid)
		}
	}
	return manifest, nil
}
