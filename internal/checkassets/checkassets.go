// Package checkassets проверяет все выбранные комплекты assets/shots/M*/manifest.json проекта
// (validate_package, internal/assetpackage) и печатает сводку по их числу.
//
// Инструмент check_assets не разбирает аргументы: всё после --project игнорируется, любой отказ (нет
// реестра, комплект вне реестра, изменённый файл) — необработанная ошибка «Ошибка: <текст>» с
// кодом 1. Пакет только читает файлы проекта.
package checkassets

import (
	"path/filepath"

	"songframe/internal/assetpackage"
	"songframe/internal/sceneregistry"
	"songframe/internal/toolcli"
	"songframe/internal/toolrt"
)

// Motion — элемент LoadMotion: путь принятого монтажа от корня проекта и число кадров.
type Motion struct {
	Path   string
	Frames any
}

// LoadMotion — готовность выводится из локального комплекта; общий индекс —
// производное представление и не подменяет рецепт или монтажное время плана.
func LoadMotion(root string) (map[string]Motion, error) {
	data, err := sceneregistry.Load(root)
	if err != nil {
		return nil, err
	}
	scenes := toolrt.NewSet()
	items, _ := toolrt.Iter(data.Value("scenes"))
	for _, item := range items {
		if err := scenes.Add(item.(*toolrt.Dict).Value("id")); err != nil {
			return nil, err
		}
	}
	result := map[string]Motion{}
	manifests := toolrt.Glob(toolrt.JoinPath(root, "assets", "shots"), "M*/manifest.json")
	toolrt.SortPaths(manifests)
	for _, path := range manifests {
		sid := toolrt.PathName(filepath.Dir(path))
		if !scenes.Contains(sid) {
			return nil, toolrt.New(toolrt.ValueError, sid+": ассет отсутствует в реестре планов.")
		}
		document, err := assetpackage.ValidatePackage(path, sid, root)
		if err != nil {
			return nil, err
		}
		edit := document.Value("accepted_edit").(*toolrt.Dict)
		video := edit.Value("video")
		location, err := toolrt.Item(video, "path")
		if err != nil {
			return nil, err
		}
		name, isString := location.(string)
		if !isString {
			return nil, toolrt.Raise(toolrt.TypeError, "операция «/» неприменима: путь и %s", toolrt.TypeName(location))
		}
		relative, err := toolrt.RelativeTo(toolrt.JoinPath(filepath.Dir(path), name), root)
		if err != nil {
			return nil, err
		}
		result[sid] = Motion{Path: relative, Frames: edit.Value("frames")}
	}
	return result, nil
}

// Run запускает check_assets на разрешённом корне проекта; args не разбираются.
func Run(root string, _ []string) toolcli.Output {
	printer := &toolcli.Printer{}
	motion, err := LoadMotion(root)
	if err != nil {
		return printer.Crash(err)
	}
	if err := printer.Print("Проверены все файлы " + toolrt.NewInt(int64(len(motion))).String() + " выбранных планов; хеши и монтажные длительности совпадают."); err != nil {
		return printer.Crash(err)
	}
	return printer.Exit(0)
}
