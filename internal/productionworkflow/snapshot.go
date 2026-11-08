package productionworkflow

import (
	"errors"
	"os"
	"slices"
	"strings"

	"songframe-go/internal/filedigest"
	"songframe-go/internal/jscompat"
	"songframe-go/internal/sourceinputs"
)

// snapshotBase — входы, которые есть в снимке любого предложения: настройки, реестр, кастинг,
// трактовка и опись исходников.
var snapshotBase = []string{"plan/project.json", "plan/scenes.json", "plan/cast.json", "plan/treatment.json", sourceinputs.ManifestPath}

// requiredFileDigest — SHA-256 файла через общий кэш filedigest; недоступный файл — ошибка, а не
// «нет файла»: устаревание тогда определяется явно.
func requiredFileDigest(path string) (string, error) {
	hash, ok := filedigest.File(path)
	if !ok {
		return "", errors.New(textFileUnreadable(path))
	}
	return hash, nil
}

// Snapshot — отпечатки входов предложения в порядке сортировки путей по кодовым единицам UTF-16.
// Ключ — путь от проекта (каталог — с завершающим «/»), значение — SHA-256 файла, SHA-256
// JSON отсортированного списка имён каталога, отпечаток описи исходников без обложки или null,
// если пути нет. Обходит packageDir и target целиком; ссылка внутри пакета — ошибка packageLink.
// packageDir "" — пакета нет.
func Snapshot(project, packageDir, target string, allowed []string) (*jscompat.Object, error) {
	paths := map[string]bool{}
	for _, path := range snapshotBase {
		paths[path] = true
	}
	for _, path := range allowed {
		paths[path] = true
	}
	var walk func(path string) error
	walk = func(path string) error {
		local := rel(project, path)
		if !jscompat.Exists(path) {
			paths[local] = true
			return nil
		}
		info, err := os.Lstat(path)
		if err != nil {
			return jscompat.FsError("lstat", path, err)
		}
		switch {
		case info.Mode()&os.ModeSymlink != 0:
			return errors.New(textPackageLink(local))
		case info.IsDir():
			paths[local+"/"] = true
			names, err := sortedNames(path)
			if err != nil {
				return err
			}
			for _, name := range names {
				if err := walk(path + string(os.PathSeparator) + name); err != nil {
					return err
				}
			}
		case info.Mode().IsRegular():
			paths[local] = true
		}
		return nil
	}
	if packageDir != "" {
		if err := walk(packageDir); err != nil {
			return nil, err
		}
	}
	if target != packageDir {
		if err := walk(target); err != nil {
			return nil, err
		}
	}
	keys := make([]string, 0, len(paths))
	for path := range paths {
		keys = append(keys, path)
	}
	slices.SortFunc(keys, compareUTF16)
	result := jscompat.NewObject()
	for _, path := range keys {
		value, err := snapshotValue(project, path)
		if err != nil {
			return nil, err
		}
		result.Set(path, value)
	}
	return result, nil
}

// snapshotValue — значение одного пути снимка (string или nil).
func snapshotValue(project, path string) (any, error) {
	if path == sourceinputs.ManifestPath {
		// Обложка оформляет проект и не меняет входы уже подготовленного предложения.
		value, ok, err := sourceinputs.Digest(project)
		if err != nil || !ok {
			return nil, err
		}
		return value, nil
	}
	full, err := ProductionPath(project, path)
	if err != nil {
		return nil, err
	}
	if !jscompat.Exists(full) {
		return nil, nil
	}
	if strings.HasSuffix(path, "/") {
		names, err := sortedNames(full)
		if err != nil {
			return nil, err
		}
		items := make([]any, len(names))
		for index, name := range names {
			items[index] = name
		}
		return digestHex([]byte(jscompat.Stringify(&jscompat.Array{Items: items}))), nil
	}
	return requiredFileDigest(full)
}

// sortedNames — readdirSync(path).sort(): имена каталога в порядке кодовых единиц UTF-16.
func sortedNames(path string) ([]string, error) {
	entries, err := jscompat.ReadDir(path)
	if err != nil {
		return nil, err
	}
	names := make([]string, len(entries))
	for index, entry := range entries {
		names[index] = entry.Name()
	}
	slices.SortFunc(names, compareUTF16)
	return names, nil
}

// compareUTF16 — сравнение Array.prototype.sort по умолчанию.
func compareUTF16(left, right string) int {
	switch {
	case left == right:
		return 0
	case jscompat.LessUTF16(left, right):
		return -1
	}
	return 1
}

// SameSnapshot сообщает, что текущий снимок входов записи совпадает с сохранённым
// (сравнение JSON.stringify, то есть и порядка ключей). Ошибка снимка возвращается: вызывающий
// считает предложение устаревшим.
func SameSnapshot(project string, stored *Stored) (bool, error) {
	rules := stored.Rules()
	current, err := Snapshot(project, stored.PackageDir(), stored.Target(), rules.AllowedPaths)
	if err != nil {
		return false, err
	}
	return jscompat.Stringify(current) == jscompat.Stringify(stored.Tree.Value("hashes")), nil
}

// imagesChanged — изображение готового предложения опор пропало или изменилось.
func imagesChanged(stored *Stored) bool {
	hashes := stored.ImageHashes()
	if hashes == nil {
		return false
	}
	for _, path := range hashes.Keys() {
		hash, ok := filedigest.File(path)
		if !jscompat.Exists(path) || !ok || hash != hashes.Value(path) {
			return true
		}
	}
	return false
}
