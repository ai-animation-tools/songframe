// Package sources читает опись исходников source/manifest.json. Документ возвращается деревом
// dynvalue без схемы: потребители (статус, кастинг, разметка) проверяют только нужные им поля, а
// неизвестные поля сохраняются.
package sources

import (
	"errors"
	"path/filepath"

	"songframe/internal/dynvalue"
)

// ManifestInvalid — текст sourcesTexts.main.manifestInvalid.
const ManifestInvalid = "source/manifest.json повреждён или другой версии."

// ManifestPath — путь описи внутри проекта.
func ManifestPath(project string) string {
	return filepath.Join(project, "source", "manifest.json")
}

// ReadManifest возвращает опись схемы 1 или nil: отсутствие, битый JSON и другая версия
// неразличимы. Подходит любое истинное значение, у которого schema_version — число 1.
func ReadManifest(project string) any {
	data, ok := dynvalue.ReadJSONFile(ManifestPath(project))
	if !ok || !dynvalue.Truthy(data) || !dynvalue.StrictEqual(dynvalue.Get(data, "schema_version"), 1.0) {
		return nil
	}
	return data
}

// DescriptionManifest — опись, из которой кастинг берёт канонические описания сущностей.
// Отсутствующий файл даёт nil без ошибки; существующий, но непригодный (не та схема, references
// не массив, ссылка без строкового id или с нестроковым description) — ошибку ManifestInvalid.
func DescriptionManifest(project string) (any, error) {
	if !dynvalue.Exists(ManifestPath(project)) {
		return nil, nil
	}
	manifest := ReadManifest(project)
	references, ok := dynvalue.AsArray(dynvalue.Get(manifest, "references"))
	if manifest == nil || !ok {
		return nil, errors.New(ManifestInvalid)
	}
	for _, ref := range references {
		description := dynvalue.Get(ref, "description")
		if !dynvalue.Truthy(ref) || dynvalue.TypeOf(dynvalue.Get(ref, "id")) != "string" ||
			(description != dynvalue.Undefined && dynvalue.TypeOf(description) != "string") {
			return nil, errors.New(ManifestInvalid)
		}
	}
	return manifest, nil
}
