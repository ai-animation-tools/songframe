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

	"songframe-go/internal/applymontage"
	"songframe-go/internal/assetpackage"
	"songframe-go/internal/pycompat"
	"songframe-go/internal/pytool"
	"songframe-go/internal/sceneregistry"
	"songframe-go/internal/sceneviews"
)

// Тексты транзакции приёмки (ValueError оригинала).
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
func descriptorKey(item *pycompat.Dict) (string, error) {
	path, err := pycompat.Item(item, "path")
	if err != nil {
		return "", err
	}
	scope, err := pycompat.HashKey(descriptorRoot(item))
	if err != nil {
		return "", err
	}
	name, err := pycompat.HashKey(path)
	if err != nil {
		return "", err
	}
	return scope + "\x00" + name, nil
}

// descriptorRoot — item.get("root", "asset").
func descriptorRoot(item *pycompat.Dict) any {
	if value, found := item.Get("root"); found {
		return value
	}
	return "asset"
}

// extendList — dict.setdefault(key, []).extend(items).
func extendList(owner *pycompat.Dict, key string, items []any) error {
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

// copyGeneration — copy_generation: копирует достижимые исходники в новый комплект, сохраняя JSON и
// файлы root:source без чужой истории и README. Файлы, достижимые только через JSON, регистрируются
// в манифесте и остаются под штатной проверкой хешей, а не становятся бесхозными копиями.
func copyGeneration(pkg *pycompat.Dict, sourceDirectory, target, root string) (*pycompat.Dict, error) {
	value, err := pycompat.Item(pkg, "generation")
	if err != nil {
		return nil, err
	}
	copied := pycompat.DeepCopy(value)
	queue := []*pycompat.Dict{}
	collect := func(item *pycompat.Dict) error {
		queue = append(queue, pycompat.DeepCopy(item).(*pycompat.Dict))
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
		pathValue, err := pycompat.Item(item, "path")
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
		recorded, err := pycompat.Item(item, "sha256")
		if err != nil {
			return nil, err
		}
		if digest == nil || !pycompat.Equal(digest, recorded) {
			return nil, valueError(textGenerationChanged + name)
		}
		key, err := descriptorKey(item)
		if err != nil {
			return nil, err
		}
		if !registered[key] {
			registered[key] = true
			discovered = append(discovered, pycompat.DeepCopy(item))
		}
		if pycompat.Equal(descriptorRoot(item), "source") || done[name] {
			continue
		}
		destination, err := assetpackage.LocalFile(target, name)
		if err != nil {
			return nil, err
		}
		if err := os.MkdirAll(filepath.Dir(destination), 0o777); err != nil {
			return nil, pycompat.OSErrorFrom(err, filepath.Dir(destination))
		}
		if err := applymontage.CopyFile(source, destination); err != nil {
			return nil, err
		}
		done[name] = true
		if strings.ToLower(pycompat.PathSuffix(source)) == ".json" {
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
		if preparation := generation.Value("preparation"); pycompat.Truthy(preparation) {
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
func divided(value pycompat.Int) (float64, error) { return pycompat.TrueDiv(value, fps) }

// ratioFloat — float(Fraction): ближайшее число двойной точности.
func ratioFloat(value *big.Rat) float64 {
	result, _ := value.Float64()
	return result
}

// makeManifest — make_manifest: манифест нового комплекта. Пути исходной генерации сохраняются:
// неизменяемый JSON может ссылаться на video.mp4 или edit-source.mp4, поэтому свои файлы занимают
// отдельное свободное имя derived-output[-N].
func makeManifest(result *checkedResult, target, candidate, root string) (*pycompat.Dict, error) {
	preview, plan := result.preview, result.plan
	sourceDirectory := pycompat.JoinPath(root, "assets/shots", preview.Value("source_shot").(string))
	generation, err := copyGeneration(result.state.pkg, sourceDirectory, target, root)
	if err != nil {
		return nil, err
	}
	for _, key := range []string{"source_shot", "source_scene_sha256", "source_accepted_video_sha256"} {
		generation.Set(key, preview.Value(key))
	}
	folder := "derived-output"
	for suffix := 0; pycompat.Exists(filepath.Join(sourceDirectory, folder)) || pycompat.Exists(filepath.Join(target, folder)); {
		suffix++
		folder = "derived-output-" + pycompat.Str(pycompat.NewInt(int64(suffix)))
	}
	if err := os.Mkdir(filepath.Join(target, folder), 0o777); err != nil {
		return nil, pycompat.OSErrorFrom(err, filepath.Join(target, folder))
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
	length := pycompat.IntFromBig(new(big.Int).Sub(plan.last.Big(), plan.first.Big()))
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
	filter, err := pycompat.Item(result.receipt, "filter")
	if err != nil {
		return nil, err
	}
	version, err := pycompat.Item(result.receipt, "ffmpeg_version")
	if err != nil {
		return nil, err
	}
	recipe, err := pycompat.Item(preview, "recipe")
	if err != nil {
		return nil, err
	}
	mode := recipe.(*pycompat.Dict).Value("mode")
	var stillTime any
	motion := duration
	if mode == "still" {
		stillTime, motion = firstTime, 0.0
	}
	edit := pytool.Record(
		"video", video,
		"fps", fps,
		"frames", frames,
		"duration_seconds", duration,
		"source_interval_seconds", []any{firstTime, lastTime},
		"source_interval_end_exclusive", true,
		"source_frame_grid_fps", fps,
		"source_frame_interval_exclusive", []any{plan.first, plan.last},
		"still_source_time_seconds", stillTime,
		"speed", pytool.Record(
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
		"rebuild", pytool.Record(
			"source", rebuildSource,
			"stages", []any{pytool.Record("input", sourceName, "filter", filter, "frames", frames)},
			"ffmpeg_version", version,
			"note", applymontage.RebuildNote,
		),
	)
	if mode == "repeat" {
		cycles, tail := new(big.Int).QuoRem(frames.Big(), length.Big(), new(big.Int))
		edit.Set("repeat", pytool.Record(
			"full_cycles", pycompat.IntFromBig(cycles),
			"tail_frames", pycompat.IntFromBig(tail),
			"cycle_frames", length,
		))
	}
	return pytool.Record(
		"schema_version", pycompat.NewInt(1),
		"shot", preview.Value("shot"),
		"kind", "derived_video",
		"generation", generation,
		"accepted_edit", edit,
	), nil
}

// walkFiles — rglob("*") с is_file(): в каталоги-ссылки не заходит, ссылка на файл считается
// файлом. Нечитаемый каталог пропускается, как у pathlib.
func walkFiles(directory string, paths *[]string) {
	entries, err := os.ReadDir(directory)
	if err != nil {
		return
	}
	for _, entry := range entries {
		path := filepath.Join(directory, entry.Name())
		if entry.IsDir() {
			walkFiles(path, paths)
		} else if pycompat.IsFile(path) {
			*paths = append(*paths, path)
		}
	}
}

// treeFiles — tree_files(directory): относительный путь → SHA-256 в порядке sorted(pathlib);
// отсутствующая папка — nil.
func treeFiles(directory string) (any, error) {
	if !pycompat.Exists(directory) {
		return nil, nil
	}
	paths := []string{}
	walkFiles(directory, &paths)
	pycompat.SortPaths(paths)
	files := pycompat.NewDict()
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

// treeDigest — tree_digest(directory): отпечаток целой папки нужен журналу для безопасного
// повторяемого rename и отката.
func treeDigest(directory string) (any, error) {
	entries, err := treeFiles(directory)
	if err != nil || entries == nil {
		return nil, err
	}
	files := entries.(*pycompat.Dict)
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

// saveJournal — save_journal: журнал заменяется одним rename.
func saveJournal(directory string, journal *pycompat.Dict) error {
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
func journalFiles(journal *pycompat.Dict) ([]journalFile, error) {
	value, err := pycompat.Item(journal, "files")
	if err != nil {
		return nil, err
	}
	list, err := pycompat.Iter(value)
	if err != nil {
		return nil, err
	}
	files := make([]journalFile, 0, len(list))
	for _, item := range list {
		fields := [3]any{}
		for index, key := range []string{"path", "before", "after"} {
			if fields[index], err = pycompat.Item(item, key); err != nil {
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
	value, err := pycompat.Item(kit, key)
	if err != nil {
		return "", err
	}
	name, err := pathText(value)
	if err != nil {
		return "", err
	}
	return pycompat.JoinPath(root, name), nil
}

// matches — value in (candidates…) по равенству Python.
func matches(value any, candidates ...any) bool {
	for _, candidate := range candidates {
		if pycompat.Equal(value, candidate) {
			return true
		}
	}
	return false
}

// restore — restore(directory, journal, root): сначала сверяет весь набор и только затем
// восстанавливает комплект и документы; повтор безопасен. Копия комплекта возвращается отдельным
// rename, поэтому авария во время копирования не оставляет наполовину восстановленный комплект.
func restore(directory string, journal *pycompat.Dict, root string) error {
	kit, err := pycompat.Item(journal, "directory")
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
	before, err := pycompat.Item(kit, "before")
	if err != nil {
		return err
	}
	after, err := pycompat.Item(kit, "after")
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
		if !pycompat.Equal(digest, before) {
			return valueError(textKitBackupBroken + directory)
		}
	}
	if pycompat.Exists(retired) {
		digest, err := treeDigest(retired)
		if err != nil {
			return err
		}
		if !pycompat.Equal(digest, before) {
			return valueError(textRetiredAfterCrash + directory)
		}
	}
	files, err := journalFiles(journal)
	if err != nil {
		return err
	}
	for _, entry := range files {
		digest, err := applymontage.DigestOrNone(pycompat.JoinPath(root, entry.path))
		if err != nil {
			return err
		}
		if !matches(digest, entry.before, entry.after) {
			return valueError("После аварии изменён файл " + entry.path + "; журнал: " + directory)
		}
		if entry.before != nil {
			saved, err := applymontage.DigestOrNone(pycompat.JoinPath(directory, "before", entry.path))
			if err != nil {
				return err
			}
			if !pycompat.Equal(saved, entry.before) {
				return valueError(textBackupBroken + entry.path)
			}
		}
	}
	if !pycompat.Equal(current, before) {
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
				return pycompat.OSErrorFrom(err, filepath.Dir(target))
			}
			if err := os.Rename(pending, target); err != nil {
				return pycompat.OSErrorFrom(err, pending)
			}
		}
	}
	for index := len(files) - 1; index >= 0; index-- {
		entry := files[index]
		path := pycompat.JoinPath(root, entry.path)
		if entry.before == nil {
			if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
				return pycompat.OSErrorFrom(err, path)
			}
			continue
		}
		saved := pycompat.JoinPath(directory, "before", entry.path)
		data, err := os.ReadFile(saved)
		if err != nil {
			return pycompat.OSErrorFrom(err, saved)
		}
		if err := applymontage.ReplaceBytes(path, data); err != nil {
			return err
		}
	}
	_ = os.RemoveAll(retired)
	journal.Set("state", "rolled_back")
	return saveJournal(directory, journal)
}

// journals — sorted((root / HISTORY).glob("*/journal.json")).
func journals(root string) []string {
	paths := pycompat.Glob(pycompat.JoinPath(root, History), "*/journal.json")
	pycompat.SortPaths(paths)
	return paths
}

// Recover — recover(root): откатывает все журналы в состоянии publishing и возвращает ответ CLI.
func Recover(root string) (*pycompat.Dict, error) {
	recovered := []any{}
	for _, path := range journals(root) {
		value, err := readJSON(path)
		if err != nil {
			return nil, err
		}
		state, err := pycompat.Item(value, "state")
		if err != nil {
			return nil, err
		}
		if !pycompat.Equal(state, "publishing") {
			continue
		}
		journal := value.(*pycompat.Dict)
		if err := restoreHook(filepath.Dir(path), journal, root); err != nil {
			return nil, err
		}
		_ = os.RemoveAll(filepath.Join(filepath.Dir(path), "staging"))
		id, err := pycompat.Item(journal, "id")
		if err != nil {
			return nil, err
		}
		recovered = append(recovered, id)
	}
	return pytool.Record("status", "recovered", "transactions", recovered), nil
}

// stageExclusions — служебные папки, не входящие в staging. Исключения принадлежат конкретным
// папкам проекта: совпавшее имя внутри source или подготовки не делает исходник временным.
var stageExclusions = map[string]map[string]bool{
	"plan":          {"derived": true, "derived-history": true, "montage-history": true},
	"assets":        {"replaced": true},
	"plan/animatic": {".cache": true},
}

// copyTree — shutil.copytree(source, target, copy_function=…) без symlinks: ссылки разыменовываются,
// права каталогов переносятся. name — путь source от корня проекта для исключений stageExclusions;
// пустой — без исключений.
func copyTree(source, target, name string, copyFile func(from, to string) error) error {
	info, err := os.Stat(source)
	if err != nil {
		return pycompat.OSErrorFrom(err, source)
	}
	if err := os.MkdirAll(target, 0o777); err != nil {
		return pycompat.OSErrorFrom(err, target)
	}
	entries, err := os.ReadDir(source)
	if err != nil {
		return pycompat.OSErrorFrom(err, source)
	}
	for _, entry := range entries {
		if stageExclusions[name][entry.Name()] {
			continue
		}
		from, to := filepath.Join(source, entry.Name()), filepath.Join(target, entry.Name())
		stat, err := os.Stat(from)
		if err != nil {
			return pycompat.OSErrorFrom(err, from)
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

// stageProject — stage_project(root, stage): копия plan, assets и source без служебных папок и
// ROADMAP.md, если они есть. Большие медиа связываются жёсткими ссылками (CopyInput).
func stageProject(root, stage string) error {
	for _, folder := range []string{"plan", "assets", "source"} {
		if !pycompat.IsDir(filepath.Join(root, folder)) {
			continue
		}
		if err := copyTree(filepath.Join(root, folder), filepath.Join(stage, folder), folder, applymontage.CopyInput); err != nil {
			return err
		}
	}
	if roadmap := filepath.Join(root, "ROADMAP.md"); pycompat.IsFile(roadmap) {
		return applymontage.CopyFile(roadmap, filepath.Join(stage, "ROADMAP.md"))
	}
	return nil
}

// moveDirectory — publish_directory(source, target, retired): прежний комплект уходит в архив,
// новый занимает его место. Отдельная точка для проверки сбоя между двумя переносами.
func moveDirectory(source, target, retired string) error {
	if pycompat.Exists(target) {
		if err := os.MkdirAll(filepath.Dir(retired), 0o777); err != nil {
			return pycompat.OSErrorFrom(err, filepath.Dir(retired))
		}
		if err := os.Rename(target, retired); err != nil {
			return pycompat.OSErrorFrom(err, target)
		}
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o777); err != nil {
		return pycompat.OSErrorFrom(err, filepath.Dir(target))
	}
	if err := os.Rename(source, target); err != nil {
		return pycompat.OSErrorFrom(err, source)
	}
	return nil
}

// idempotent — ответ на повтор подтверждения после успешной публикации: ничего не пишет. Проверяется
// и выбранный комплект, чтобы старый токен не принял чужую замену. nil — такого журнала нет.
func idempotent(root, shot, confirm string) (*pycompat.Dict, error) {
	for _, path := range journals(root) {
		value, err := readJSON(path)
		if err != nil {
			return nil, err
		}
		previous, err := dictOf(value, "get")
		if err != nil {
			return nil, err
		}
		if !pycompat.Equal(previous.Value("result_token"), confirm) {
			continue
		}
		state, err := pycompat.Item(previous, "state")
		if err != nil {
			return nil, err
		}
		if !pycompat.Equal(state, "committed") {
			continue
		}
		kit, err := pycompat.Item(previous, "directory")
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
		after, err := pycompat.Item(kit, "after")
		if err != nil {
			return nil, err
		}
		if !pycompat.Equal(digest, after) {
			return nil, valueError(textAcceptedChanged)
		}
		history, err := relative(filepath.Dir(path), root)
		if err != nil {
			return nil, err
		}
		return pytool.Record("status", "accepted", "shot", shot, "result_token", confirm, "history", history, "idempotent", true), nil
	}
	return nil, nil
}

// prepareStage наполняет staging новым комплектом, статусом и представлениями и заполняет в журнале
// список файлов и сведения о папке комплекта. Прежний комплект и документы сохраняются в резервах.
func prepareStage(result *checkedResult, status *pycompat.Dict, journal *pycompat.Dict, history, stage, target, retired, directory, root string) (any, error) {
	shot := result.preview.Value("shot").(string)
	if err := stageProject(root, stage); err != nil {
		return nil, err
	}
	stagedKit := pycompat.JoinPath(stage, "assets/shots", shot)
	_ = os.RemoveAll(stagedKit)
	if err := os.MkdirAll(stagedKit, 0o777); err != nil {
		return nil, pycompat.OSErrorFrom(err, stagedKit)
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
	if err := applymontage.ReplaceBytes(pycompat.JoinPath(stage, sceneregistry.ProductionStatus), data); err != nil {
		return nil, err
	}
	if _, err := assetpackage.ValidatePackage(filepath.Join(stagedKit, "manifest.json"), shot, stage); err != nil {
		return nil, err
	}
	// Штатный update_scene_views оригинала запускался отдельным процессом с check=True: ненулевой
	// код — CalledProcessError (скрытый текст CLI).
	if output := sceneviews.Run(stage, []string{}); output.Code != 0 {
		return nil, pycompat.New("CalledProcessError", "update_scene_views returned non-zero exit status")
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
		live := pycompat.JoinPath(root, name)
		before, err := applymontage.DigestOrNone(live)
		if err != nil {
			return nil, err
		}
		after, err := applymontage.DigestOrNone(pycompat.JoinPath(stage, name))
		if err != nil {
			return nil, err
		}
		if pycompat.Equal(before, after) {
			continue
		}
		if before != nil {
			backup := pycompat.JoinPath(history, "before", name)
			if err := os.MkdirAll(filepath.Dir(backup), 0o777); err != nil {
				return nil, pycompat.OSErrorFrom(err, filepath.Dir(backup))
			}
			if err := applymontage.CopyFile(live, backup); err != nil {
				return nil, err
			}
		}
		files = append(files, pytool.Record("path", name, "before", before, "after", after))
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
	journal.Set("directory", pytool.Record(
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

// accept — accept(work_dir, confirm, replace, root): публикует показанные байты транзакцией.
// Отмена задания действует до начала публикации и оставляет журнал failed; начатая публикация
// завершается (несколько rename) либо откатывается по журналу.
func accept(ctx context.Context, workDir, confirm string, replace bool, root string) (*pycompat.Dict, error) {
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
	if filepath.Dir(directory) != pycompat.JoinPath(root, "plan/derived", shot) {
		return nil, valueError(textOtherShot)
	}
	repeated, err := idempotent(root, shot, confirm)
	if err != nil || repeated != nil {
		return repeated, err
	}
	target := pycompat.JoinPath(root, "assets/shots", shot)
	if pycompat.Exists(target) && !replace {
		return nil, valueError(textReplaceRequired)
	}
	statusPath := pycompat.JoinPath(root, sceneregistry.ProductionStatus)
	statusDigest, err := applymontage.DigestOrNone(statusPath)
	if err != nil {
		return nil, err
	}
	current, err := sceneregistry.ReadProductionStatus(root)
	if err != nil {
		return nil, err
	}
	status, err := sceneregistry.WithAcceptedFingerprints(current, pytool.Record(shot, result.preview.Value("target_scene_sha256")), true)
	if err != nil {
		return nil, err
	}
	transaction := NewID()
	history := pycompat.JoinPath(root, History, transaction)
	if err := os.MkdirAll(history, 0o777); err != nil {
		return nil, pycompat.OSErrorFrom(err, history)
	}
	stage := filepath.Join(history, "staging")
	retired := pycompat.JoinPath(root, "assets/replaced", shot, transaction)
	workName, err := relative(directory, root)
	if err != nil {
		return nil, err
	}
	journal := pytool.Record(
		"schema_version", pycompat.NewInt(1),
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
		if !pycompat.Equal(digest, statusDigest) || !pycompat.Equal(tree, before) {
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
		stagedKit := pycompat.JoinPath(stage, "assets/shots", shot)
		if err := publishDirectory(stagedKit, target, retired); err != nil {
			return err
		}
		files, err := journalFiles(journal)
		if err != nil {
			return err
		}
		for _, entry := range files {
			if err := publishFile(pycompat.JoinPath(stage, entry.path), pycompat.JoinPath(root, entry.path)); err != nil {
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
	return pytool.Record("status", "accepted", "shot", shot, "result_token", confirm, "history", name, "idempotent", false, "views_updated", true), nil
}
