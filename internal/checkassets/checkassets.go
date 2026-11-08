// Package checkassets — перенос tools/check_assets/check_assets.py замороженного оригинала:
// проверка всех выбранных комплектов assets/shots/M*/manifest.json проекта (validate_package,
// internal/assetpackage) и сводка по их числу.
//
// У оригинала нет argparse и try: аргументы после --project игнорируются, любой отказ (нет
// реестра, комплект вне реестра, изменённый файл) — необработанное исключение с трассировкой и
// кодом 1. Пакет только читает файлы проекта.
package checkassets

import (
	"path/filepath"

	"songframe-go/internal/assetpackage"
	"songframe-go/internal/pycompat"
	"songframe-go/internal/pytool"
	"songframe-go/internal/sceneregistry"
)

// Motion — элемент load_motion(): путь принятого монтажа от корня проекта и число кадров.
type Motion struct {
	Path   string
	Frames any
}

// LoadMotion — load_motion(): готовность выводится из локального комплекта; общий индекс —
// производное представление и не подменяет рецепт или монтажное время плана.
func LoadMotion(root string) (map[string]Motion, error) {
	data, err := sceneregistry.Load(root)
	if err != nil {
		return nil, err
	}
	scenes := pycompat.NewSet()
	items, _ := pycompat.Iter(data.Value("scenes"))
	for _, item := range items {
		if err := scenes.Add(item.(*pycompat.Dict).Value("id")); err != nil {
			return nil, err
		}
	}
	result := map[string]Motion{}
	manifests := pycompat.Glob(pycompat.JoinPath(root, "assets", "shots"), "M*/manifest.json")
	pycompat.SortPaths(manifests)
	for _, path := range manifests {
		sid := pycompat.PathName(filepath.Dir(path))
		if !scenes.Contains(sid) {
			return nil, pycompat.New(pycompat.ValueError, sid+": ассет отсутствует в реестре сцен.")
		}
		document, err := assetpackage.ValidatePackage(path, sid, root)
		if err != nil {
			return nil, err
		}
		edit := document.Value("accepted_edit").(*pycompat.Dict)
		video := edit.Value("video")
		location, err := pycompat.Item(video, "path")
		if err != nil {
			return nil, err
		}
		name, isString := location.(string)
		if !isString {
			return nil, pycompat.Raise(pycompat.TypeError, "unsupported operand type(s) for /: 'PosixPath' and '%s'", pycompat.TypeName(location))
		}
		relative, err := pycompat.RelativeTo(pycompat.JoinPath(filepath.Dir(path), name), root)
		if err != nil {
			return nil, err
		}
		result[sid] = Motion{Path: relative, Frames: edit.Value("frames")}
	}
	return result, nil
}

// Run — запуск check_assets.py на разрешённом корне проекта; args не разбираются.
func Run(root string, _ []string) pytool.Output {
	printer := &pytool.Printer{}
	motion, err := LoadMotion(root)
	if err != nil {
		return printer.Crash(err)
	}
	if err := printer.Print("Проверены все файлы " + pycompat.NewInt(int64(len(motion))).String() + " выбранных сцен; хеши и монтажные длительности совпадают."); err != nil {
		return printer.Crash(err)
	}
	return printer.Exit(0)
}
