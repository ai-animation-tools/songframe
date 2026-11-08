package deriveshot

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"math/big"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"songframe/internal/applymontage"
	"songframe/internal/assetpackage"
	"songframe/internal/sceneregistry"
	"songframe/internal/sceneviews"
	"songframe/internal/toolcli"
	"songframe/internal/toolrt"
)

// Тексты отказов транзакции приёмки (ValueError).
const (
	textKitAfterCrash     = "После аварии изменён комплект; журнал: "
	textKitBackupBroken   = "Повреждена резервная копия комплекта; журнал: "
	textRetiredAfterCrash = "После аварии изменён архив комплекта; журнал: "
	textBackupBroken      = "Повреждена резервная копия "
	textOtherShot         = "Рабочая папка относится к другому плану."
	textAcceptedChanged   = "Ранее принятый результат уже изменён; соберите новую пробу."
	textReplaceRequired   = "У плана уже есть комплект; для замены требуется --replace."
	textRaceChanged       = "Выбранный комплект или статус производства изменился. Повторите приёмку."
	textGenerationChanged = "Изменился исходник комплекта: "
)

// descriptorKey — кортеж (root, path) множества зарегистрированных файлов.
func descriptorKey(item *toolrt.Dict) (string, error) {
	path, err := toolrt.Item(item, "path")
	if err != nil {
		return "", err
	}
	scope, err := toolrt.HashKey(descriptorRoot(item))
	if err != nil {
		return "", err
	}
	name, err := toolrt.HashKey(path)
	if err != nil {
		return "", err
	}
	return scope + "\x00" + name, nil
}

// descriptorRoot — поле root дескриптора; без поля — "asset".
func descriptorRoot(item *toolrt.Dict) any {
	if value, found := item.Get("root"); found {
		return value
	}
	return "asset"
}

// extendList — дописывает items в список owner[key], создавая пустой список, если ключа нет.
func extendList(owner *toolrt.Dict, key string, items []any) error {
	value, found := owner.Get(key)
	if !found {
		value = []any{}
	}
	list, ok := value.([]any)
	if !ok {
		return attributeError(value, "extend")
	}
	owner.Set(key, append(list, items...))
	return nil
}

// copyGeneration копирует достижимые исходники в новый комплект, сохраняя JSON и
// файлы root:source без чужой истории и README. Файлы, достижимые только через JSON, регистрируются
// в манифесте и остаются под штатной проверкой хешей, а не становятся бесхозными копиями.
func copyGeneration(pkg *toolrt.Dict, sourceDirectory, target, root string) (*toolrt.Dict, error) {
	value, err := toolrt.Item(pkg, "generation")
	if err != nil {
		return nil, err
	}
	copied := toolrt.DeepCopy(value)
	queue := []*toolrt.Dict{}
	collect := func(item *toolrt.Dict) error {
		queue = append(queue, toolrt.DeepCopy(item).(*toolrt.Dict))
		return nil
	}
	if err := assetpackage.Descriptors(copied, collect); err != nil {
		return nil, err
	}
	registered := map[string]bool{}
	for _, item := range queue {
		key, err := descriptorKey(item)
		if err != nil {
			return nil, err
		}
		registered[key] = true
	}
	done := map[string]bool{}
	discovered := []any{}
	for len(queue) > 0 {
		item := queue[len(queue)-1]
		queue = queue[:len(queue)-1]
		source, err := assetpackage.DescriptorFile(sourceDirectory, item, root)
		if err != nil {
			return nil, err
		}
		pathValue, err := toolrt.Item(item, "path")
		if err != nil {
			return nil, err
		}
		name, err := pathText(pathValue)
		if err != nil {
			return nil, err
		}
		digest, err := applymontage.DigestOrNone(source)
		if err != nil {
			return nil, err
		}
		recorded, err := toolrt.Item(item, "sha256")
		if err != nil {
			return nil, err
		}
		if digest == nil || !toolrt.Equal(digest, recorded) {
			return nil, valueError(textGenerationChanged + name)
		}
		key, err := descriptorKey(item)
		if err != nil {
			return nil, err
		}
		if !registered[key] {
			registered[key] = true
			discovered = append(discovered, toolrt.DeepCopy(item))
		}
		if toolrt.Equal(descriptorRoot(item), "source") || done[name] {
			continue
		}
		destination, err := assetpackage.LocalFile(target, name)
		if err != nil {
			return nil, err
		}
		if err := os.MkdirAll(filepath.Dir(destination), 0o777); err != nil {
			return nil, toolrt.OSErrorFrom(err, filepath.Dir(destination))
		}
		if err := applymontage.CopyFile(source, destination); err != nil {
			return nil, err
		}
		done[name] = true
		if strings.ToLower(toolrt.PathSuffix(source)) == ".json" {
			document, err := readJSON(source)
			if err != nil {
				return nil, err
			}
			if err := assetpackage.Descriptors(document, collect); err != nil {
				return nil, err
			}
		}
	}
	generation, err := dictOf(copied, "update")
	if err != nil {
		return nil, err
	}
	if len(discovered) > 0 {
		if preparation := generation.Value("preparation"); toolrt.Truthy(preparation) {
			owner, err := dictOf(preparation, "setdefault")
			if err != nil {
				return nil, err
			}
			err = extendList(owner, "files", discovered)
			if err != nil {
				return nil, err
			}
		} else if err := extendList(generation, "auxiliary_references", discovered); err != nil {
			return nil, err
		}
	}
	return generation, nil
}

// divided — value / 30 числом с плавающей точкой.
func divided(value toolrt.Int) (float64, error) { return toolrt.TrueDiv(value, fps) }

// ratioFloat — ближайшее к дроби число двойной точности.
func ratioFloat(value *big.Rat) float64 {
	result, _ := value.Float64()
	return result
}

// makeManifest — манифест нового комплекта. Пути исходной генерации сохраняются:
// неизменяемый JSON может ссылаться на video.mp4 или edit-source.mp4, поэтому свои файлы занимают
// отдельное свободное имя derived-output[-N].
func makeManifest(result *checkedResult, target, candidate, root string) (*toolrt.Dict, error) {
	preview, plan := result.preview, result.plan
	sourceDirectory := toolrt.JoinPath(root, "assets/shots", preview.Value("source_shot").(string))
	generation, err := copyGeneration(result.state.pkg, sourceDirectory, target, root)
	if err != nil {
		return nil, err
	}
	for _, key := range []string{"source_shot", "source_scene_sha256", "source_accepted_video_sha256"} {
		generation.Set(key, preview.Value(key))
	}
	folder := "derived-output"
	for suffix := 0; toolrt.Exists(filepath.Join(sourceDirectory, folder)) || toolrt.Exists(filepath.Join(target, folder)); {
		suffix++
		folder = "derived-output-" + toolrt.Str(toolrt.NewInt(int64(suffix)))
	}
	if err := os.Mkdir(filepath.Join(target, folder), 0o777); err != nil {
		return nil, toolrt.OSErrorFrom(err, filepath.Join(target, folder))
	}
	sourceName, videoName := folder+"/edit-source.mp4", folder+"/video.mp4"
	if err := applymontage.CopyFile(result.state.source, filepath.Join(target, sourceName)); err != nil {
		return nil, err
	}
	if err := applymontage.CopyFile(candidate, filepath.Join(target, videoName)); err != nil {
		return nil, err
	}
	frames, err := wholeNumber(preview.Value("target_frames"))
	if err != nil {
		return nil, err
	}
	length := toolrt.IntFromBig(new(big.Int).Sub(plan.last.Big(), plan.first.Big()))
	duration, err := divided(frames)
	if err != nil {
		return nil, err
	}
	selected, err := divided(length)
	if err != nil {
		return nil, err
	}
	firstTime, err := divided(plan.first)
	if err != nil {
		return nil, err
	}
	lastTime, err := divided(plan.last)
	if err != nil {
		return nil, err
	}
	video, err := applymontage.Descriptor(target, videoName)
	if err != nil {
		return nil, err
	}
	rebuildSource, err := applymontage.Descriptor(target, sourceName)
	if err != nil {
		return nil, err
	}
	filter, err := toolrt.Item(result.receipt, "filter")
	if err != nil {
		return nil, err
	}
	version, err := toolrt.Item(result.receipt, "ffmpeg_version")
	if err != nil {
		return nil, err
	}
	recipe, err := toolrt.Item(preview, "recipe")
	if err != nil {
		return nil, err
	}
	mode := recipe.(*toolrt.Dict).Value("mode")
	var stillTime any
	motion := duration
	if mode == "still" {
		stillTime, motion = firstTime, 0.0
	}
	edit := toolcli.Record(
		"video", video,
		"fps", fps,
		"frames", frames,
		"duration_seconds", duration,
		"source_interval_seconds", []any{firstTime, lastTime},
		"source_interval_end_exclusive", true,
		"source_frame_grid_fps", fps,
		"source_frame_interval_exclusive", []any{plan.first, plan.last},
		"still_source_time_seconds", stillTime,
		"speed", toolcli.Record(
			"factor", ratioFloat(plan.factor),
			"ratio", plan.factor.RatString(),
			"selected_source_seconds", selected,
			"motion_output_seconds", motion,
			"duration_change_seconds", duration-selected,
		),
		"hold_first_seconds", 0.0,
		"hold_last_seconds", 0.0,
		"audio_policy", applymontage.AudioPolicy,
		"montage_source", video,
		"source_fps", "30/1",
		"fps_conversion", applymontage.FPSConversion,
		"rebuild", toolcli.Record(
			"source", rebuildSource,
			"stages", []any{toolcli.Record("input", sourceName, "filter", filter, "frames", frames)},
			"ffmpeg_version", version,
			"note", applymontage.RebuildNote,
		),
	)
	if mode == "repeat" {
		cycles, tail := new(big.Int).QuoRem(frames.Big(), length.Big(), new(big.Int))
		edit.Set("repeat", toolcli.Record(
			"full_cycles", toolrt.IntFromBig(cycles),
			"tail_frames", toolrt.IntFromBig(tail),
			"cycle_frames", length,
		))
	}
	return toolcli.Record(
		"schema_version", toolrt.NewInt(1),
		"shot", preview.Value("shot"),
		"kind", "derived_video",
		"generation", generation,
		"accepted_edit", edit,
	), nil
}

// walkFiles — рекурсивный список файлов directory: в каталоги-ссылки не заходит, ссылка на файл
// считается файлом. Нечитаемый каталог пропускается без ошибки.
func walkFiles(directory string, paths *[]string) {
	entries, err := os.ReadDir(directory)
	if err != nil {
		return
	}
	for _, entry := range entries {
		path := filepath.Join(directory, entry.Name())
		if entry.IsDir() {
			walkFiles(path, paths)
		} else if toolrt.IsFile(path) {
			*paths = append(*paths, path)
		}
	}
}

// treeFiles — относительный путь → SHA-256 файлов directory в порядке toolrt.SortPaths;
// отсутствующая папка — nil.
func treeFiles(directory string) (any, error) {
	if !toolrt.Exists(directory) {
		return nil, nil
	}
	paths := []string{}
	walkFiles(directory, &paths)
	toolrt.SortPaths(paths)
	files := toolrt.NewDict()
	for _, path := range paths {
		digest, err := assetpackage.FileSHA256(path)
		if err != nil {
			return nil, err
		}
		name, err := relative(path, directory)
		if err != nil {
			return nil, err
		}
		files.Set(name, digest)
	}
	return files, nil
}

// treeDigest — отпечаток целой папки directory: он нужен журналу для безопасного
// повторяемого rename и отката.
func treeDigest(directory string) (any, error) {
	entries, err := treeFiles(directory)
	if err != nil || entries == nil {
		return nil, err
	}
	files := entries.(*toolrt.Dict)
	list := []any{}
	for _, key := range files.Keys() {
		list = append(list, []any{key, files.Value(key)})
	}
	data, err := applymontage.JSONBytes(list)
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:]), nil
}

// saveJournal — запись журнала: файл заменяется одним rename.
func saveJournal(directory string, journal *toolrt.Dict) error {
	data, err := applymontage.JSONBytes(journal)
	if err != nil {
		return err
	}
	return applymontage.ReplaceBytes(filepath.Join(directory, "journal.json"), data)
}

// journalFile — запись списка files журнала: путь и отпечатки до и после.
type journalFile struct {
	path          string
	before, after any
}

// journalFiles — journal["files"] как записи с проверенными типами.
func journalFiles(journal *toolrt.Dict) ([]journalFile, error) {
	value, err := toolrt.Item(journal, "files")
	if err != nil {
		return nil, err
	}
	list, err := toolrt.Iter(value)
	if err != nil {
		return nil, err
	}
	files := make([]journalFile, 0, len(list))
	for _, item := range list {
		fields := [3]any{}
		for index, key := range []string{"path", "before", "after"} {
			if fields[index], err = toolrt.Item(item, key); err != nil {
				return nil, err
			}
		}
		name, err := pathText(fields[0])
		if err != nil {
			return nil, err
		}
		files = append(files, journalFile{name, fields[1], fields[2]})
	}
	return files, nil
}

// kitField — путь из journal["directory"] относительно корня проекта.
func kitField(kit any, key, root string) (string, error) {
	value, err := toolrt.Item(kit, key)
	if err != nil {
		return "", err
	}
	name, err := pathText(value)
	if err != nil {
		return "", err
	}
	return toolrt.JoinPath(root, name), nil
}

// matches — value равно (toolrt.Equal) одному из candidates.
func matches(value any, candidates ...any) bool {
	for _, candidate := range candidates {
		if toolrt.Equal(value, candidate) {
			return true
		}
	}
	return false
}

// restore — сначала сверяет весь набор и только затем
// восстанавливает комплект и документы; повтор безопасен. Копия комплекта возвращается отдельным
// rename, поэтому авария во время копирования не оставляет наполовину восстановленный комплект.
func restore(directory string, journal *toolrt.Dict, root string) error {
	kit, err := toolrt.Item(journal, "directory")
	if err != nil {
		return err
	}
	target, err := kitField(kit, "path", root)
	if err != nil {
		return err
	}
	backup, err := kitField(kit, "backup", root)
	if err != nil {
		return err
	}
	retired, err := kitField(kit, "retired", root)
	if err != nil {
		return err
	}
	before, err := toolrt.Item(kit, "before")
	if err != nil {
		return err
	}
	after, err := toolrt.Item(kit, "after")
	if err != nil {
		return err
	}
	current, err := treeDigest(target)
	if err != nil {
		return err
	}
	if !matches(current, nil, before, after) {
		return valueError(textKitAfterCrash + directory)
	}
	if before != nil {
		digest, err := treeDigest(backup)
		if err != nil {
			return err
		}
		if !toolrt.Equal(digest, before) {
			return valueError(textKitBackupBroken + directory)
		}
	}
	if toolrt.Exists(retired) {
		digest, err := treeDigest(retired)
		if err != nil {
			return err
		}
		if !toolrt.Equal(digest, before) {
			return valueError(textRetiredAfterCrash + directory)
		}
	}
	files, err := journalFiles(journal)
	if err != nil {
		return err
	}
	for _, entry := range files {
		digest, err := applymontage.DigestOrNone(toolrt.JoinPath(root, entry.path))
		if err != nil {
			return err
		}
		if !matches(digest, entry.before, entry.after) {
			return valueError("После аварии изменён файл " + entry.path + "; журнал: " + directory)
		}
		if entry.before != nil {
			saved, err := applymontage.DigestOrNone(toolrt.JoinPath(directory, "before", entry.path))
			if err != nil {
				return err
			}
			if !toolrt.Equal(saved, entry.before) {
				return valueError(textBackupBroken + entry.path)
			}
		}
	}
	if !toolrt.Equal(current, before) {
		pending := filepath.Join(directory, "restore-kit")
		_ = os.RemoveAll(pending)
		if before != nil {
			if err := copyTree(backup, pending, "", applymontage.CopyWithStat); err != nil {
				return err
			}
		}
		_ = os.RemoveAll(target)
		if before != nil {
			if err := os.MkdirAll(filepath.Dir(target), 0o777); err != nil {
				return toolrt.OSErrorFrom(err, filepath.Dir(target))
			}
			if err := os.Rename(pending, target); err != nil {
				return toolrt.OSErrorFrom(err, pending)
			}
		}
	}
	for index := len(files) - 1; index >= 0; index-- {
		entry := files[index]
		path := toolrt.JoinPath(root, entry.path)
		if entry.before == nil {
			if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
				return toolrt.OSErrorFrom(err, path)
			}
			continue
		}
		saved := toolrt.JoinPath(directory, "before", entry.path)
		data, err := os.ReadFile(saved)
		if err != nil {
			return toolrt.OSErrorFrom(err, saved)
		}
		if err := applymontage.ReplaceBytes(path, data); err != nil {
			return err
		}
	}
	_ = os.RemoveAll(retired)
	journal.Set("state", "rolled_back")
	return saveJournal(directory, journal)
}

// journals — журналы транзакций History/*/journal.json проекта в порядке toolrt.SortPaths.
func journals(root string) []string {
	paths := toolrt.Glob(toolrt.JoinPath(root, History), "*/journal.json")
	toolrt.SortPaths(paths)
	return paths
}

// Recover — откатывает все журналы в состоянии publishing и возвращает ответ CLI.
func Recover(root string) (*toolrt.Dict, error) {
	recovered := []any{}
	for _, path := range journals(root) {
		value, err := readJSON(path)
		if err != nil {
			return nil, err
		}
		state, err := toolrt.Item(value, "state")
		if err != nil {
			return nil, err
		}
		if !toolrt.Equal(state, "publishing") {
			continue
		}
		journal := value.(*toolrt.Dict)
		if err := restoreHook(filepath.Dir(path), journal, root); err != nil {
			return nil, err
		}
		_ = os.RemoveAll(filepath.Join(filepath.Dir(path), "staging"))
		id, err := toolrt.Item(journal, "id")
		if err != nil {
			return nil, err
		}
		recovered = append(recovered, id)
	}
	return toolcli.Record("status", "recovered", "transactions", recovered), nil
}

// stageExclusions — служебные папки, не входящие в staging. Исключения принадлежат конкретным
// папкам проекта: совпавшее имя внутри source или подготовки не делает исходник временным.
var stageExclusions = map[string]map[string]bool{
	"plan":          {"derived": true, "derived-history": true, "montage-history": true},
	"assets":        {"replaced": true},
	"plan/animatic": {".cache": true},
}

// copyTree — копия дерева, как shutil.copytree без symlinks: ссылки разыменовываются,
// права каталогов переносятся. name — путь source от корня проекта для исключений stageExclusions;
// пустой — без исключений.
func copyTree(source, target, name string, copyFile func(from, to string) error) error {
	info, err := os.Stat(source)
	if err != nil {
		return toolrt.OSErrorFrom(err, source)
	}
	if err := os.MkdirAll(target, 0o777); err != nil {
		return toolrt.OSErrorFrom(err, target)
	}
	entries, err := os.ReadDir(source)
	if err != nil {
		return toolrt.OSErrorFrom(err, source)
	}
	for _, entry := range entries {
		if stageExclusions[name][entry.Name()] {
			continue
		}
		from, to := filepath.Join(source, entry.Name()), filepath.Join(target, entry.Name())
		stat, err := os.Stat(from)
		if err != nil {
			return toolrt.OSErrorFrom(err, from)
		}
		if stat.IsDir() {
			child := ""
			if name != "" {
				child = name + "/" + entry.Name()
			}
			err = copyTree(from, to, child, copyFile)
		} else {
			err = copyFile(from, to)
		}
		if err != nil {
			return err
		}
	}
	_ = os.Chmod(target, info.Mode().Perm())
	return nil
}

// CopyKit — копия резерва комплекта с метаданными файлов: откат при открытии проекта возвращает её
// отдельным rename, как и CLI recover.
func CopyKit(source, target string) error {
	return copyTree(source, target, "", applymontage.CopyWithStat)
}

// stageProject — копия plan, assets и source проекта root в stage без служебных папок и
// ROADMAP.md, если они есть. Большие медиа связываются жёсткими ссылками (CopyInput).
func stageProject(root, stage string) error {
	for _, folder := range []string{"plan", "assets", "source"} {
		if !toolrt.IsDir(filepath.Join(root, folder)) {
			continue
		}
		if err := copyTree(filepath.Join(root, folder), filepath.Join(stage, folder), folder, applymontage.CopyInput); err != nil {
			return err
		}
	}
	if roadmap := filepath.Join(root, "ROADMAP.md"); toolrt.IsFile(roadmap) {
		return applymontage.CopyFile(roadmap, filepath.Join(stage, "ROADMAP.md"))
	}
	return nil
}

// moveDirectory публикует папку: прежний комплект уходит в архив,
// новый занимает его место. Отдельная точка для проверки сбоя между двумя переносами.
func moveDirectory(source, target, retired string) error {
	if toolrt.Exists(target) {
		if err := os.MkdirAll(filepath.Dir(retired), 0o777); err != nil {
			return toolrt.OSErrorFrom(err, filepath.Dir(retired))
		}
		if err := os.Rename(target, retired); err != nil {
			return toolrt.OSErrorFrom(err, target)
		}
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o777); err != nil {
		return toolrt.OSErrorFrom(err, filepath.Dir(target))
	}
	if err := os.Rename(source, target); err != nil {
		return toolrt.OSErrorFrom(err, source)
	}
	return nil
}

// idempotent — ответ на повтор подтверждения после успешной публикации: ничего не пишет. Проверяется
// и выбранный комплект, чтобы старый токен не принял чужую замену. nil — такого журнала нет.
func idempotent(root, shot, confirm string) (*toolrt.Dict, error) {
	for _, path := range journals(root) {
		value, err := readJSON(path)
		if err != nil {
			return nil, err
		}
		previous, err := dictOf(value, "get")
		if err != nil {
			return nil, err
		}
		if !toolrt.Equal(previous.Value("result_token"), confirm) {
			continue
		}
		state, err := toolrt.Item(previous, "state")
		if err != nil {
			return nil, err
		}
		if !toolrt.Equal(state, "committed") {
			continue
		}
		kit, err := toolrt.Item(previous, "directory")
		if err != nil {
			return nil, err
		}
		target, err := kitField(kit, "path", root)
		if err != nil {
			return nil, err
		}
		if _, err := assetpackage.ValidatePackage(filepath.Join(target, "manifest.json"), shot, root); err != nil {
			return nil, err
		}
		digest, err := treeDigest(target)
		if err != nil {
			return nil, err
		}
		after, err := toolrt.Item(kit, "after")
		if err != nil {
			return nil, err
		}
		if !toolrt.Equal(digest, after) {
			return nil, valueError(textAcceptedChanged)
		}
		history, err := relative(filepath.Dir(path), root)
		if err != nil {
			return nil, err
		}
		return toolcli.Record("status", "accepted", "shot", shot, "result_token", confirm, "history", history, "idempotent", true), nil
	}
	return nil, nil
}

// prepareStage наполняет staging новым комплектом, статусом и представлениями и заполняет в журнале
// список файлов и сведения о папке комплекта. Прежний комплект и документы сохраняются в резервах.
func prepareStage(result *checkedResult, status *toolrt.Dict, journal *toolrt.Dict, history, stage, target, retired, directory, root string) (any, error) {
	shot := result.preview.Value("shot").(string)
	if err := stageProject(root, stage); err != nil {
		return nil, err
	}
	stagedKit := toolrt.JoinPath(stage, "assets/shots", shot)
	_ = os.RemoveAll(stagedKit)
	if err := os.MkdirAll(stagedKit, 0o777); err != nil {
		return nil, toolrt.OSErrorFrom(err, stagedKit)
	}
	manifest, err := makeManifest(result, stagedKit, filepath.Join(directory, "candidate.mp4"), root)
	if err != nil {
		return nil, err
	}
	data, err := applymontage.JSONBytes(manifest)
	if err != nil {
		return nil, err
	}
	if err := applymontage.ReplaceBytes(filepath.Join(stagedKit, "manifest.json"), data); err != nil {
		return nil, err
	}
	if data, err = applymontage.JSONBytes(status); err != nil {
		return nil, err
	}
	if err := applymontage.ReplaceBytes(toolrt.JoinPath(stage, sceneregistry.ProductionStatus), data); err != nil {
		return nil, err
	}
	if _, err := assetpackage.ValidatePackage(filepath.Join(stagedKit, "manifest.json"), shot, stage); err != nil {
		return nil, err
	}
	// Ненулевой код update_scene_views — исключение CalledProcessError: CLI показывает его скрытым
	// общим текстом.
	if output := sceneviews.Run(stage, []string{}); output.Code != 0 {
		return nil, toolrt.New("CalledProcessError", "update_scene_views returned non-zero exit status")
	}
	names := map[string]bool{sceneregistry.ProductionStatus: true}
	applymontage.ViewPaths(stage, root, names)
	// README новой сцены публикуется вместе с целой папкой, не отдельным файлом.
	sorted := []string{}
	for name := range names {
		if !strings.HasPrefix(name, "assets/shots/"+shot+"/") {
			sorted = append(sorted, name)
		}
	}
	sort.Strings(sorted)
	files := []any{}
	for _, name := range sorted {
		live := toolrt.JoinPath(root, name)
		before, err := applymontage.DigestOrNone(live)
		if err != nil {
			return nil, err
		}
		after, err := applymontage.DigestOrNone(toolrt.JoinPath(stage, name))
		if err != nil {
			return nil, err
		}
		if toolrt.Equal(before, after) {
			continue
		}
		if before != nil {
			backup := toolrt.JoinPath(history, "before", name)
			if err := os.MkdirAll(filepath.Dir(backup), 0o777); err != nil {
				return nil, toolrt.OSErrorFrom(err, filepath.Dir(backup))
			}
			if err := applymontage.CopyFile(live, backup); err != nil {
				return nil, err
			}
		}
		files = append(files, toolcli.Record("path", name, "before", before, "after", after))
	}
	journal.Set("files", files)
	backup := filepath.Join(history, "before-kit")
	before, err := treeDigest(target)
	if err != nil {
		return nil, err
	}
	if before != nil {
		if err := copyTree(target, backup, "", applymontage.CopyWithStat); err != nil {
			return nil, err
		}
	}
	targetName, err := relative(target, root)
	if err != nil {
		return nil, err
	}
	backupName, err := relative(backup, root)
	if err != nil {
		return nil, err
	}
	retiredName, err := relative(retired, root)
	if err != nil {
		return nil, err
	}
	after, err := treeDigest(stagedKit)
	if err != nil {
		return nil, err
	}
	beforeFiles, err := treeFiles(target)
	if err != nil {
		return nil, err
	}
	afterFiles, err := treeFiles(stagedKit)
	if err != nil {
		return nil, err
	}
	journal.Set("directory", toolcli.Record(
		"path", targetName,
		"before", before,
		"after", after,
		"backup", backupName,
		"retired", retiredName,
		"before_files", beforeFiles,
		"after_files", afterFiles,
	))
	return before, nil
}

// accept публикует показанные байты пробы workDir транзакцией.
// Отмена задания действует до начала публикации и оставляет журнал failed; начатая публикация
// завершается (несколько rename) либо откатывается по журналу.
func accept(ctx context.Context, workDir, confirm string, replace bool, root string) (*toolrt.Dict, error) {
	if _, err := Recover(root); err != nil {
		return nil, err
	}
	directory, err := projectPath(root, workDir, "plan/derived")
	if err != nil {
		return nil, err
	}
	result, err := checkResult(directory, confirm, root)
	if err != nil {
		return nil, err
	}
	shot := result.preview.Value("shot").(string)
	if filepath.Dir(directory) != toolrt.JoinPath(root, "plan/derived", shot) {
		return nil, valueError(textOtherShot)
	}
	repeated, err := idempotent(root, shot, confirm)
	if err != nil || repeated != nil {
		return repeated, err
	}
	target := toolrt.JoinPath(root, "assets/shots", shot)
	if toolrt.Exists(target) && !replace {
		return nil, valueError(textReplaceRequired)
	}
	statusPath := toolrt.JoinPath(root, sceneregistry.ProductionStatus)
	statusDigest, err := applymontage.DigestOrNone(statusPath)
	if err != nil {
		return nil, err
	}
	current, err := sceneregistry.ReadProductionStatus(root)
	if err != nil {
		return nil, err
	}
	status, err := sceneregistry.WithAcceptedFingerprints(current, toolcli.Record(shot, result.preview.Value("target_scene_sha256")), true)
	if err != nil {
		return nil, err
	}
	transaction := NewID()
	history := toolrt.JoinPath(root, History, transaction)
	if err := os.MkdirAll(history, 0o777); err != nil {
		return nil, toolrt.OSErrorFrom(err, history)
	}
	stage := filepath.Join(history, "staging")
	retired := toolrt.JoinPath(root, "assets/replaced", shot, transaction)
	workName, err := relative(directory, root)
	if err != nil {
		return nil, err
	}
	journal := toolcli.Record(
		"schema_version", toolrt.NewInt(1),
		"id", transaction,
		"shot", shot,
		"state", "preparing",
		"result_token", confirm,
		"work_dir", workName,
		"files", []any{},
	)
	if err := saveJournal(history, journal); err != nil {
		return nil, err
	}
	publishing := false
	err = func() error {
		before, err := prepareStage(result, status, journal, history, stage, target, retired, directory, root)
		if err != nil {
			return err
		}
		if _, err := checkResult(directory, confirm, root); err != nil {
			return err
		}
		digest, err := applymontage.DigestOrNone(statusPath)
		if err != nil {
			return err
		}
		tree, err := treeDigest(target)
		if err != nil {
			return err
		}
		if !toolrt.Equal(digest, statusDigest) || !toolrt.Equal(tree, before) {
			return valueError(textRaceChanged)
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		journal.Set("state", "publishing")
		if err := saveJournal(history, journal); err != nil {
			return err
		}
		publishing = true
		stagedKit := toolrt.JoinPath(stage, "assets/shots", shot)
		if err := publishDirectory(stagedKit, target, retired); err != nil {
			return err
		}
		files, err := journalFiles(journal)
		if err != nil {
			return err
		}
		for _, entry := range files {
			if err := publishFile(toolrt.JoinPath(stage, entry.path), toolrt.JoinPath(root, entry.path)); err != nil {
				return err
			}
		}
		if _, err := validatePublished(filepath.Join(target, "manifest.json"), shot, root); err != nil {
			return err
		}
		journal.Set("state", "committed")
		return saveJournal(history, journal)
	}()
	if err != nil {
		if publishing {
			if failure := restoreHook(history, journal, root); failure != nil {
				err = failure
			}
		} else {
			journal.Set("state", "failed")
			if failure := saveJournal(history, journal); failure != nil {
				err = failure
			}
		}
	}
	if state := journal.Value("state"); state == "committed" || state == "rolled_back" || state == "failed" {
		_ = os.RemoveAll(stage)
	}
	if err != nil {
		return nil, err
	}
	name, err := relative(history, root)
	if err != nil {
		return nil, err
	}
	return toolcli.Record("status", "accepted", "shot", shot, "result_token", confirm, "history", name, "idempotent", false, "views_updated", true), nil
}
