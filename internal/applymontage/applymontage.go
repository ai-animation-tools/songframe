// Package applymontage применяет ручной монтаж (MontageDraft) к принятым комплектам
// assets/shots одной транзакцией (инструмент apply_montage).
//
// Применение проверяет черновик (только видео original или текущего accepted_edit соседних сцен в
// исходном порядке, внешние границы окна и исходная песня реестра, длины на сетке 30 кадров/с с
// исключённым правым краем), считает фильтры обрезки тем же buildreview.Prepare, что и экспорт
// пробы, рендерит клипы в staging (копия plan/assets/source в plan/montage-history/<id>/staging),
// пишет туда новые manifest.json с revisions/<id>/{video.mp4,previous-manifest.json}, реестр с
// перенесёнными внутренними стыками, статус производства с перенесённым принятием и производные
// представления. Перед публикацией повторно сверяются SHA реестра, выбранных манифестов, статуса
// производства и входов; журнал journal.json и резервные копии before/ позволяют откатить
// прерванную публикацию (Recover) — с остановкой, если файл после сбоя изменён вручную.
// Прежние клипы и оригиналы не перезаписываются.
//
// Вывод CLI (Run) — тексты, коды и JSON зафиксированы эталоном testdata/golden/apply-montage.
// Восстановление этого же журнала без инструмента при открытии проекта выполняет internal/montage.
package applymontage

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"

	"songframe-go/internal/assetpackage"
	"songframe-go/internal/buildreview"
	"songframe-go/internal/mediacmd"
	"songframe-go/internal/pycompat"
	"songframe-go/internal/pytool"
	"songframe-go/internal/sceneregistry"
	"songframe-go/internal/sceneviews"
)

// History — папка журналов транзакций монтажа от корня проекта.
const History = "plan/montage-history"

// Тексты отказов (ValueError, печатаются как есть).
const (
	AudioPolicy      = "Звук генератора сохранён в оригинале; в монтаже используется непрерывная исходная песня."
	RebuildNote      = "Принятые байты восстанавливаются копированием video; повтор фильтров сохраняет монтаж, но не обещает побайтово одинаковое перекодирование."
	FPSConversion    = "Выбор кадров без интерполяции движения."
	textBadEdit      = "Принятый монтаж имеет неверный формат или число кадров."
	textMedia        = "Ошибка обработки медиа; исходники не изменены, сырой вывод скрыт."
	textRegistry     = "Реестр сцен изменился. Заново откройте материалы монтажа."
	textBadDraft     = "Неверный MontageDraft или пустой монтаж."
	textDraftFields  = "Неизвестные поля MontageDraft."
	textNoAudio      = "Не задан участок исходной песни."
	textAudioFields  = "Неизвестные поля audio."
	textTrackOnly    = "Применение использует только исходную песню реестра."
	textVideoOnly    = "Применять можно только видео существующих принятых сцен."
	textClipFields   = "Неизвестные поля участка монтажа."
	textClipRepeat   = "Сцена повторяется или неверно описан участок."
	textEmptyClip    = "Конец участка должен быть больше начала."
	textRelative     = "Источник монтажа задаётся относительным путём проекта."
	textNeighbours   = "Для применения нужны соседние сцены в исходном порядке."
	textOuterBounds  = "Применение сохраняет внешние границы выбранных сцен."
	textFillWindow   = "Длины участков должны непрерывно заполнить окно песни."
	textExtraAudio   = "В монтажном клипе появилась лишняя звуковая дорожка."
	textStatusMoved  = "Статус производства изменился во время монтажа. Повторите применение."
	textSourceMoved  = "Источник монтажа изменился во время рендера."
	textBackupBroken = "Повреждена резервная копия монтажа: "
)

func textPackageChanged(sid string) string {
	return sid + ": комплект изменился. Заново откройте материалы монтажа."
}
func textPackageRequired(sid string) string {
	return sid + ": для применения нужен принятый комплект."
}
func textSourceChoice(sid string) string {
	return sid + ": выберите original или текущий принятый клип этой сцены."
}

func valueError(message string) error { return pycompat.New(pycompat.ValueError, message) }

// Точки подмены для тестов сбоев: рендер клипа,
// публикация файла и откат. В работе не меняются.
var (
	renderEditHook  = RenderEdit
	publishFileHook = PublishFile
	restoreHook     = restore
)

// NewID — uuid4().hex: ID транзакции и ревизии. Тесты эталонов подменяют его ID из эталона.
var NewID = func() string {
	data := make([]byte, 16)
	_, _ = rand.Read(data)
	data[6] = data[6]&0x0f | 0x40
	data[8] = data[8]&0x3f | 0x80
	return hex.EncodeToString(data)
}

// active — число выполняющихся в процессе применений и восстановлений. Оригинал не откатывал
// журнал при открытии проекта, пока шло задание apply_montage: живая публикация не прерванная.
// Здесь инструмент выполняется в процессе приложения, поэтому признак ведёт сам пакет.
var active struct {
	sync.Mutex
	count int
}

// Active сообщает, выполняется ли сейчас применение монтажа или CLI-восстановление в этом
// процессе. Тогда восстановление при открытии проекта (internal/montage) пропускается.
func Active() bool {
	active.Lock()
	defer active.Unlock()
	return active.count > 0
}

func enter() func() {
	active.Lock()
	active.count++
	active.Unlock()
	return func() {
		active.Lock()
		active.count--
		active.Unlock()
	}
}

// dict — значение как словарь Python или nil.
func dict(value any) *pycompat.Dict {
	result, _ := value.(*pycompat.Dict)
	return result
}

// item — container[key] с исключениями Python.
func item(container any, key string) (any, error) { return pycompat.Item(container, key) }

// text — str(value) для конкатенации строк: не-строка — TypeError, как `"..." + value`.
func text(value any) (string, error) {
	result, ok := value.(string)
	if !ok {
		return "", pycompat.Raise(pycompat.TypeError, `can only concatenate str (not "%s") to str`, pycompat.TypeName(value))
	}
	return result, nil
}

// join — Path(base) / relative для пути журнала или проекта с разделителем «/».
func join(base, relative string) string { return pycompat.JoinPath(base, relative) }

// saveJournal — save_journal(directory, journal): journal.json той же заменой одним rename.
func saveJournal(directory string, journal *pycompat.Dict) error {
	data, err := JSONBytes(journal)
	if err != nil {
		return err
	}
	return ReplaceBytes(filepath.Join(directory, "journal.json"), data)
}

// restore — restore(directory, journal, root): откат по журналу. Сначала проверяется весь набор:
// каждый файл совпадает со старым или новым SHA-256, а резервная копия — со старым; посторонняя
// правка после сбоя останавливает откат до первой записи. Затем файлы возвращаются в обратном
// порядке (новые — удаляются), журнал получает state rolled_back. Повторяем после обрыва.
func restore(directory string, journal *pycompat.Dict, root string) error {
	filesValue, err := item(journal, "files")
	if err != nil {
		return err
	}
	files, err := pycompat.Iter(filesValue)
	if err != nil {
		return err
	}
	type entry struct {
		path   string
		before any
	}
	entries := []entry{}
	for _, raw := range files {
		pathValue, err := item(raw, "path")
		if err != nil {
			return err
		}
		name, err := text(pathValue)
		if err != nil {
			return err
		}
		before, err := item(raw, "before")
		if err != nil {
			return err
		}
		after, err := item(raw, "after")
		if err != nil {
			return err
		}
		current, err := DigestOrNone(join(root, name))
		if err != nil {
			return err
		}
		if !pycompat.Equal(current, before) && !pycompat.Equal(current, after) {
			return valueError("После прерывания изменён файл " + name + "; сохранён журнал " + directory)
		}
		if before != nil {
			backup, err := DigestOrNone(join(filepath.Join(directory, "before"), name))
			if err != nil {
				return err
			}
			if !pycompat.Equal(backup, before) {
				return valueError(textBackupBroken + name)
			}
		}
		entries = append(entries, entry{path: name, before: before})
	}
	for index := len(entries) - 1; index >= 0; index-- {
		target := join(root, entries[index].path)
		if entries[index].before == nil {
			if err := os.Remove(target); err != nil && !os.IsNotExist(err) {
				return pycompat.OSErrorFrom(err, target)
			}
			continue
		}
		backup := join(filepath.Join(directory, "before"), entries[index].path)
		data, err := os.ReadFile(backup)
		if err != nil {
			return pycompat.OSErrorFrom(err, backup)
		}
		if err := ReplaceBytes(target, data); err != nil {
			return err
		}
	}
	journal.Set("state", "rolled_back")
	return saveJournal(directory, journal)
}

// Recover — recover(root): откатывает все журналы plan/montage-history/*/journal.json в
// состоянии publishing (по порядку имён) и удаляет их staging. Остальные журналы не трогаются.
// Ошибка разбора журнала или конфликт останавливают восстановление.
func Recover(root string) error {
	defer enter()()
	return recoverJournals(root)
}

func recoverJournals(root string) error {
	paths := pycompat.Glob(join(root, History), "*/journal.json")
	pycompat.SortPaths(paths)
	for _, path := range paths {
		value, err := pycompat.LoadJSONFile(path)
		if err != nil {
			return err
		}
		state, err := item(value, "state")
		if err != nil {
			return err
		}
		if pycompat.Equal(state, "publishing") {
			journal, ok := value.(*pycompat.Dict)
			if !ok {
				return pycompat.Raise(pycompat.TypeError, "'%s' object does not support item assignment", pycompat.TypeName(value))
			}
			if err := restoreHook(filepath.Dir(path), journal, root); err != nil {
				return err
			}
			_ = os.RemoveAll(filepath.Join(filepath.Dir(path), "staging"))
		}
	}
	return nil
}

// assertBaseline — assert_baseline(draft, root): реестр и манифесты выбранных сцен совпадают со
// снимком черновика. Проверяется до рендера и ещё раз перед первой записью публикации.
func assertBaseline(draft *pycompat.Dict, root string) error {
	digest, err := sha(join(root, sceneregistry.ScenesPath))
	if err != nil {
		return err
	}
	if !pycompat.Equal(digest, draft.Value("base_scenes_sha256")) {
		return valueError(textRegistry)
	}
	clips, err := pycompat.Iter(draft.Value("clips"))
	if err != nil {
		return err
	}
	snapshot := dict(draft.Value("base_manifest_sha256"))
	for _, clip := range clips {
		sidValue, err := item(clip, "scene")
		if err != nil {
			return err
		}
		sid, err := text(sidValue)
		if err != nil {
			return err
		}
		path := join(root, "assets/shots/"+sid+"/manifest.json")
		if !pycompat.IsFile(path) {
			return valueError(textPackageChanged(sid))
		}
		digest, err := sha(path)
		if err != nil {
			return err
		}
		expected, _ := pycompat.DictGet(snapshot, sid, nil)
		if !pycompat.Equal(digest, expected) {
			return valueError(textPackageChanged(sid))
		}
	}
	return nil
}

// integer — integer(value, name, minimum) build_review: точный int (не bool) не меньше minimum.
func integer(value any, name string, minimum int64) (pycompat.Int, error) {
	number, ok := value.(pycompat.Int)
	if !ok || number.Big().Cmp(pycompat.NewInt(minimum).Big()) < 0 {
		return pycompat.Int{}, valueError("Неверное целое поле " + name + ".")
	}
	return number, nil
}

// unknownKeys — set(value) - allowed не пусто для словаря.
func unknownKeys(value *pycompat.Dict, allowed ...string) bool {
	known := map[string]bool{}
	for _, name := range allowed {
		known[name] = true
	}
	for _, key := range value.Keys() {
		if !known[key] {
			return true
		}
	}
	return false
}

// pathParts — Path(name).parts без корня и диска: компоненты по «/» (и «\» в Windows).
func pathParts(name string) []string {
	return strings.FieldsFunc(name, func(r rune) bool { return r == '/' || r == os.PathSeparator })
}

// samePath — равенство Path: в Windows без учёта регистра, как PureWindowsPath.
func samePath(a, b string) bool {
	if runtime.GOOS == "windows" {
		return strings.EqualFold(a, b)
	}
	return a == b
}

// prepared — результат prepare_draft: новый реестр, проверенные комплекты по порядку участков и
// рецепт build_review (фильтры, длины, SHA входов).
type prepared struct {
	candidate *pycompat.Dict
	shots     []string
	packages  map[string]*pycompat.Dict
	plan      *pycompat.Dict
}

// prepareDraft проверяет черновик и строит рецепт обрезки; ничего не записывает.
func prepareDraft(ctx context.Context, value any, root string) (*pycompat.Dict, prepared, error) {
	draft := dict(value)
	if draft == nil {
		return nil, prepared{}, valueError(textBadDraft)
	}
	_, nameOK := draft.Value("name").(string)
	clipsValue, clipsOK := draft.Value("clips").([]any)
	_, baseOK := draft.Value("base_manifest_sha256").(*pycompat.Dict)
	_, scenesOK := draft.Value("base_scenes_sha256").(string)
	if !pycompat.Equal(draft.Value("schema_version"), pycompat.NewInt(1)) || !nameOK || !clipsOK || len(clipsValue) == 0 || !baseOK || !scenesOK {
		return nil, prepared{}, valueError(textBadDraft)
	}
	if unknownKeys(draft, "schema_version", "name", "audio", "clips", "base_manifest_sha256", "base_scenes_sha256") {
		return nil, prepared{}, valueError(textDraftFields)
	}
	audio := dict(draft.Value("audio"))
	if audio == nil {
		return nil, prepared{}, valueError(textNoAudio)
	}
	if unknownKeys(audio, "path", "start_frame", "end_frame_exclusive") {
		return nil, prepared{}, valueError(textAudioFields)
	}
	start, err := integer(audio.Value("start_frame"), "audio.start_frame", 0)
	if err != nil {
		return nil, prepared{}, err
	}
	end, err := integer(audio.Value("end_frame_exclusive"), "audio.end_frame_exclusive", 1)
	if err != nil {
		return nil, prepared{}, err
	}
	registry, err := sceneregistry.Load(root)
	if err != nil {
		return nil, prepared{}, err
	}
	registryAudio, err := item(registry, "audio")
	if err != nil {
		return nil, prepared{}, err
	}
	track, err := pycompat.DictGet(registryAudio, "path", "source/track.mp3")
	if err != nil {
		return nil, prepared{}, err
	}
	if !pycompat.Equal(audio.Value("path"), track) {
		return nil, prepared{}, valueError(textTrackOnly)
	}
	scenes, err := pycompat.Iter(registry.Value("scenes"))
	if err != nil {
		return nil, prepared{}, err
	}
	byID := map[string]int{}
	for index, scene := range scenes {
		id, err := item(scene, "id")
		if err != nil {
			return nil, prepared{}, err
		}
		key, err := pycompat.HashKey(id)
		if err != nil {
			return nil, prepared{}, err
		}
		byID[key] = index
	}
	result := prepared{packages: map[string]*pycompat.Dict{}}
	positions := []int{}
	requests := []any{}
	for _, clipValue := range clipsValue {
		clip := dict(clipValue)
		if clip == nil || !pycompat.Equal(clip.Value("kind"), "video") {
			return nil, prepared{}, valueError(textVideoOnly)
		}
		key, err := pycompat.HashKey(clip.Value("scene"))
		if err != nil {
			return nil, prepared{}, err
		}
		position, known := byID[key]
		if !known {
			return nil, prepared{}, valueError(textVideoOnly)
		}
		if unknownKeys(clip, "id", "scene", "path", "kind", "source_start_frame", "source_end_frame_exclusive", "source_frames") {
			return nil, prepared{}, valueError(textClipFields)
		}
		// Код из реестра — строка (sceneregistry.Validate), значит и сцена участка — строка.
		sid, _ := clip.Value("scene").(string)
		_, idOK := clip.Value("id").(string)
		pathText, pathOK := clip.Value("path").(string)
		if result.packages[sid] != nil || !idOK || !pathOK {
			return nil, prepared{}, valueError(textClipRepeat)
		}
		positions = append(positions, position)
		first, err := integer(clip.Value("source_start_frame"), "source_start_frame", 0)
		if err != nil {
			return nil, prepared{}, err
		}
		last, err := integer(clip.Value("source_end_frame_exclusive"), "source_end_frame_exclusive", 1)
		if err != nil {
			return nil, prepared{}, err
		}
		if last.Big().Cmp(first.Big()) <= 0 {
			return nil, prepared{}, valueError(textEmptyClip)
		}
		parent := false
		for _, part := range pathParts(pathText) {
			parent = parent || part == ".."
		}
		if filepath.IsAbs(pathText) || parent {
			return nil, prepared{}, valueError(textRelative)
		}
		manifestPath := join(root, "assets/shots/"+sid+"/manifest.json")
		if !pycompat.IsFile(manifestPath) {
			return nil, prepared{}, valueError(textPackageRequired(sid))
		}
		pkg, err := assetpackage.ValidatePackage(manifestPath, sid, root)
		if err != nil {
			return nil, prepared{}, err
		}
		result.packages[sid] = pkg
		result.shots = append(result.shots, sid)
		path := pycompat.ResolvePath(join(root, pathText))
		allowed := false
		for _, keys := range [][2]string{{"generation", "original"}, {"accepted_edit", "video"}} {
			section, err := item(pkg, keys[0])
			if err != nil {
				return nil, prepared{}, err
			}
			descriptor, err := item(section, keys[1])
			if err != nil {
				return nil, prepared{}, err
			}
			file, err := assetpackage.DescriptorFile(filepath.Dir(manifestPath), dict(descriptor), root)
			if err != nil {
				return nil, prepared{}, err
			}
			allowed = allowed || samePath(file, path)
		}
		if !allowed {
			return nil, prepared{}, valueError(textSourceChoice(sid))
		}
		requests = append(requests, pytool.Record(
			"scene", sid, "kind", "video", "path", pathText,
			"source_start_frame", first, "source_end_frame_exclusive", last,
		))
	}
	for index, position := range positions {
		if position != positions[0]+index {
			return nil, prepared{}, valueError(textNeighbours)
		}
	}
	firstScene, lastScene := scenes[positions[0]], scenes[positions[len(positions)-1]]
	startFrame, err := item(firstScene, "start_frame")
	if err != nil {
		return nil, prepared{}, err
	}
	endFrame, err := item(lastScene, "end_frame_exclusive")
	if err != nil {
		return nil, prepared{}, err
	}
	if !pycompat.Equal(start, startFrame) || !pycompat.Equal(end, endFrame) {
		return nil, prepared{}, valueError(textOuterBounds)
	}
	total := pycompat.NewInt(0).Big()
	for _, request := range requests {
		record := request.(*pycompat.Dict)
		total.Add(total, record.Value("source_end_frame_exclusive").(pycompat.Int).Big())
		total.Sub(total, record.Value("source_start_frame").(pycompat.Int).Big())
	}
	window := end.Big()
	window.Sub(window, start.Big())
	if total.Cmp(window) != 0 {
		return nil, prepared{}, valueError(textFillWindow)
	}
	if err := assertBaseline(draft, root); err != nil {
		return nil, prepared{}, err
	}
	plan, err := buildreview.Prepare(ctx, pytool.Record(
		"schema_version", pycompat.NewInt(1), "shots", requests,
		"audio", pytool.Record("path", track, "start_frame", start),
	), root)
	if err != nil {
		return nil, prepared{}, err
	}
	candidate := pycompat.DeepCopy(registry).(*pycompat.Dict)
	candidateScenes := candidate.Value("scenes").([]any)
	planShots := plan.Value("shots").([]any)
	cursor := start.Big()
	for index, position := range positions {
		scene := candidateScenes[position].(*pycompat.Dict)
		scene.Set("start_frame", pycompat.IntFromBig(cursor))
		cursor.Add(cursor, planShots[index].(*pycompat.Dict).Value("frames").(pycompat.Int).Big())
		scene.Set("end_frame_exclusive", pycompat.IntFromBig(cursor))
	}
	initial, err := sceneregistry.InitialStatesFor(root)
	if err != nil {
		return nil, prepared{}, err
	}
	if _, err := sceneregistry.Validate(candidate, initial); err != nil {
		return nil, prepared{}, err
	}
	result.candidate = candidate
	result.plan = plan
	return draft, result, nil
}

// Descriptor — {"path", "sha256", "bytes"} файла name в папке directory (accept_shot.descriptor).
func Descriptor(directory, name string) (*pycompat.Dict, error) {
	path := join(directory, name)
	digest, err := sha(path)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(path)
	if err != nil {
		return nil, pycompat.OSErrorFrom(err, path)
	}
	return pytool.Record("path", name, "sha256", digest, "bytes", pycompat.NewInt(info.Size())), nil
}

// Media — run(argv) build_review: stdout программы; ненулевой код — ValueError без сырого вывода.
func Media(ctx context.Context, program string, args ...string) ([]byte, error) {
	result, err := mediacmd.Run(ctx, program, args...)
	if err != nil {
		return nil, err
	}
	if result.Code != 0 {
		return nil, valueError(textMedia)
	}
	return result.Stdout, nil
}

// probe — потоки и формат ffprobe значением pycompat (как в build_review).
func probe(ctx context.Context, path string) (any, error) {
	data, err := Media(ctx, mediacmd.FFprobe(), "-v", "error", "-show_streams", "-show_format", "-of", "json", path)
	if err != nil {
		return nil, err
	}
	decoded, err := pycompat.DecodeUTF8(data)
	if err != nil {
		return nil, err
	}
	return pycompat.LoadsJSON(decoded)
}

// streams — probe(...)["streams"] списком.
func streams(meta any) ([]any, error) {
	value, err := item(meta, "streams")
	if err != nil {
		return nil, err
	}
	return pycompat.Iter(value)
}

// RenderEdit — accept_shot.render_edit: участок по фильтру кодируется ENCODE build_animatic без
// звука ровно в frames кадров (run/probe build_animatic, как у accept_shot); результат обязан быть
// 1920×1080, 30/1 и иметь ровно frames кадров.
func RenderEdit(ctx context.Context, original, filter string, frames pycompat.Int, target string) error {
	args := append([]string{"-v", "error", "-nostdin", "-n", "-threads", "2", "-i", original, "-map", "0:v:0", "-vf", filter},
		mediacmd.Encode...)
	args = append(args, "-frames:v", frames.String(), target)
	if _, err := mediacmd.AnimaticRun(ctx, mediacmd.FFmpeg(), args...); err != nil {
		return err
	}
	probed, err := mediacmd.AnimaticProbe(ctx, target)
	if err != nil {
		return err
	}
	list, err := streams(probed)
	if err != nil {
		return err
	}
	for _, stream := range list {
		codec, err := item(stream, "codec_type")
		if err != nil {
			return err
		}
		if !pycompat.Equal(codec, "video") {
			continue
		}
		values := make([]any, 4)
		for index, key := range []string{"width", "height", "r_frame_rate", "nb_frames"} {
			if values[index], err = item(stream, key); err != nil {
				return err
			}
		}
		count, err := pyInt(values[3])
		if err != nil {
			return err
		}
		if !pycompat.Equal(values[0], pycompat.NewInt(1920)) || !pycompat.Equal(values[1], pycompat.NewInt(1080)) ||
			!pycompat.Equal(values[2], "30/1") || !pycompat.Equal(count, frames) {
			return valueError(textBadEdit)
		}
		return nil
	}
	return pycompat.New("StopIteration", "")
}

// pyInt — int(value) для nb_frames ffprobe (строка или число).
func pyInt(value any) (pycompat.Int, error) {
	switch number := value.(type) {
	case pycompat.Int:
		return number, nil
	case string:
		if parsed, ok := pycompat.ParseIntText(number); ok {
			return parsed, nil
		}
		return pycompat.Int{}, pycompat.Raise(pycompat.ValueError, "invalid literal for int() with base 10: %s", pycompat.Repr(number))
	}
	return pycompat.Int{}, pycompat.Raise(pycompat.TypeError, "int() argument must be a string, a bytes-like object or a real number, not '%s'", pycompat.TypeName(value))
}

// editManifest — копия принятого комплекта с новым accepted_edit по участку item
// рецепта. Рецепт повтора читает сохранённые байты выбранного источника, поэтому срез прежнего
// accepted_edit не повторяет его цепочку ещё одним lossy проходом.
func editManifest(ctx context.Context, pkg *pycompat.Dict, sourceName string, item *pycompat.Dict, directory, videoName, version, revision string) (*pycompat.Dict, error) {
	manifest := pycompat.DeepCopy(pkg).(*pycompat.Dict)
	video, err := Descriptor(directory, videoName)
	if err != nil {
		return nil, err
	}
	source, err := Descriptor(directory, sourceName)
	if err != nil {
		return nil, err
	}
	frames := item.Value("frames").(pycompat.Int)
	duration, err := pycompat.TrueDiv(frames, pycompat.NewInt(30))
	if err != nil {
		return nil, err
	}
	meta, err := probe(ctx, join(directory, sourceName))
	if err != nil {
		return nil, err
	}
	list, err := streams(meta)
	if err != nil {
		return nil, err
	}
	var sourceFPS any
	found := false
	for _, stream := range list {
		codec, err := pycompat.Item(stream, "codec_type")
		if err != nil {
			return nil, err
		}
		if pycompat.Equal(codec, "video") {
			if sourceFPS, err = pycompat.Item(stream, "r_frame_rate"); err != nil {
				return nil, err
			}
			found = true
			break
		}
	}
	if !found {
		return nil, pycompat.New("StopIteration", "")
	}
	previous, err := Descriptor(directory, "revisions/"+revision+"/previous-manifest.json")
	if err != nil {
		return nil, err
	}
	edit := pytool.Record(
		"video", video,
		"fps", pycompat.NewInt(30),
		"frames", frames,
		"duration_seconds", duration,
		"source_interval_seconds", item.Value("source_interval_seconds"),
		"source_interval_end_exclusive", true,
		"source_frame_grid_fps", pycompat.NewInt(30),
		"still_source_time_seconds", nil,
		"source_frame_interval_exclusive", []any{item.Value("source_start_frame"), item.Value("source_end_frame_exclusive")},
		"speed", pytool.Record(
			"factor", 1.0,
			"ratio", "1",
			"selected_source_seconds", duration,
			"motion_output_seconds", duration,
			"duration_change_seconds", 0.0,
		),
		"hold_first_seconds", 0.0,
		"hold_last_seconds", 0.0,
		"audio_policy", AudioPolicy,
		"montage_source", video,
		"source_fps", sourceFPS,
		"fps_conversion", FPSConversion,
		"rebuild", pytool.Record(
			"stages", []any{pytool.Record("input", sourceName, "filter", item.Value("filter"), "frames", frames)},
			"source", source,
			"ffmpeg_version", version,
			"note", RebuildNote,
		),
		"montage_revision", pytool.Record("id", revision, "previous_manifest", previous),
	)
	manifest.Set("accepted_edit", edit)
	return manifest, nil
}

// fixedViews — производные представления, которые публикуются вместе с монтажом (view_paths).
var fixedViews = []string{
	"ROADMAP.md",
	"plan/edit-list.md",
	"plan/storyboard.md",
	"plan/context/characters.md",
	"plan/audio/timing.md",
	"assets/shots/manifest.json",
	"plan/animatic/cards/manifest.json",
}

// ViewPaths — view_paths(stage, root): постоянные представления, README комплектов и карточки
// обоих деревьев (удалённая в staging карточка тоже публикуется — удалением).
func ViewPaths(stage, root string, names map[string]bool) {
	for _, name := range fixedViews {
		names[name] = true
	}
	for _, base := range []string{root, stage} {
		for _, pattern := range [][2]string{{"assets/shots", "M*/README.md"}, {"plan/animatic/cards", "*.png"}} {
			for _, path := range pycompat.Glob(join(base, pattern[0]), pattern[1]) {
				relative, err := pycompat.RelativeTo(path, base)
				if err == nil {
					names[filepath.ToSlash(relative)] = true
				}
			}
		}
	}
}

// carriedAcceptance — новый статус производства или nil. Граница плана входит в его
// постановку: принятие переносится только тем
// планам монтажа, что приняты по текущей постановке; план, уже устаревший до монтажа, остаётся
// stale. Статус переписывается и при сверенной source_review (Apply обновит её SHA видео).
func carriedAcceptance(root string, candidate *pycompat.Dict, shots []string, ready *pycompat.Dict) (*pycompat.Dict, error) {
	status, err := sceneregistry.ReadProductionStatus(root)
	if err != nil {
		return nil, err
	}
	accepted, err := sceneregistry.AcceptedFingerprints(status)
	if err != nil {
		return nil, err
	}
	initial, err := sceneregistry.InitialStatesFor(root)
	if err != nil {
		return nil, err
	}
	current, err := sceneregistry.Load(root)
	if err != nil {
		return nil, err
	}
	before, err := sceneregistry.SceneFingerprints(current, initial)
	if err != nil {
		return nil, err
	}
	after, err := sceneregistry.SceneFingerprints(candidate, initial)
	if err != nil {
		return nil, err
	}
	updates := pycompat.NewDict()
	reviewed := false
	for _, sid := range shots {
		completed := pycompat.Equal(ready.Value(sid), sceneregistry.Completed)
		previous, err := item(before, sid)
		if err != nil {
			return nil, err
		}
		next, err := item(after, sid)
		if err != nil {
			return nil, err
		}
		if completed && pycompat.Equal(accepted.Value(sid), previous) && !pycompat.Equal(previous, next) {
			updates.Set(sid, next)
		}
	}
	for _, sid := range shots {
		if !pycompat.Equal(ready.Value(sid), sceneregistry.Completed) {
			continue
		}
		var base any = pycompat.NewDict()
		if pycompat.Truthy(status) {
			base = status
		}
		shotsValue, err := pycompat.DictGet(base, "shots", pycompat.NewDict())
		if err != nil {
			return nil, err
		}
		record, err := pycompat.DictGet(shotsValue, sid, pycompat.NewDict())
		if err != nil {
			return nil, err
		}
		has, err := pycompat.Contains(record, "source_review")
		if err != nil {
			return nil, err
		}
		if has {
			reviewed = true
			break
		}
	}
	if updates.Len() == 0 && !reviewed {
		return nil, nil
	}
	return sceneregistry.WithAcceptedFingerprints(status, updates, false)
}

// Apply — транзакция ручного монтажа. Сначала восстанавливает
// прерванные публикации, затем проверяет черновик, рендерит и собирает новое состояние в staging,
// повторно сверяет входы и публикует. Сбой до публикации оставляет журнал failed без изменений
// проекта; сбой во время публикации откатывает уже записанные файлы. Результат — словарь
// {status, revision, shots, scene_registry_sha256, history, views_updated}.
func Apply(ctx context.Context, draftValue any, rootPath string, updateViews bool) (*pycompat.Dict, error) {
	defer enter()()
	root := pycompat.ResolvePath(rootPath)
	if err := recoverJournals(root); err != nil {
		return nil, err
	}
	draft, prepared, err := prepareDraft(ctx, draftValue, root)
	if err != nil {
		return nil, err
	}
	statusPath := join(root, sceneregistry.ProductionStatus)
	statusDigest, err := DigestOrNone(statusPath)
	if err != nil {
		return nil, err
	}
	acceptance, err := sceneregistry.ProjectShotAcceptance(root, nil)
	if err != nil {
		return nil, err
	}
	ready := acceptance.States
	status, err := carriedAcceptance(root, prepared.candidate, prepared.shots, ready)
	if err != nil {
		return nil, err
	}
	transaction := NewID()
	directory := join(root, History+"/"+transaction)
	if err := os.MkdirAll(filepath.Dir(directory), 0o777); err != nil {
		return nil, pycompat.OSErrorFrom(err, directory)
	}
	if err := os.Mkdir(directory, 0o777); err != nil {
		return nil, pycompat.OSErrorFrom(err, directory)
	}
	stage := filepath.Join(directory, "staging")
	data, err := JSONBytes(draft)
	if err != nil {
		return nil, err
	}
	if err := ReplaceBytes(filepath.Join(directory, "draft.json"), data); err != nil {
		return nil, err
	}
	journal := pytool.Record("schema_version", pycompat.NewInt(1), "id", transaction, "state", "preparing", "files", []any{})
	if err := saveJournal(directory, journal); err != nil {
		return nil, err
	}
	publishing := false
	err = func() error {
		if err := stageProject(root, stage); err != nil {
			return err
		}
		// При неизменных границах сохраняются даже форматирование и SHA реестра.
		current, err := sceneregistry.Load(root)
		if err != nil {
			return err
		}
		if !pycompat.Equal(prepared.candidate, current) {
			data, err := JSONBytes(prepared.candidate)
			if err != nil {
				return err
			}
			if err := ReplaceBytes(join(stage, sceneregistry.ScenesPath), data); err != nil {
				return err
			}
		}
		output, err := Media(ctx, mediacmd.FFmpeg(), "-version")
		if err != nil {
			return err
		}
		version := pycompat.DecodeReplace(output)
		if lines := pycompat.SplitLines(version); len(lines) > 0 {
			version = lines[0]
		} else {
			return pycompat.New(pycompat.IndexError, "list index out of range")
		}
		clips := draft.Value("clips").([]any)
		planShots := prepared.plan.Value("shots").([]any)
		for index := range clips {
			sid := prepared.shots[index]
			shot := planShots[index].(*pycompat.Dict)
			asset := join(stage, "assets/shots/"+sid)
			revision := join(asset, "revisions/"+transaction)
			if err := os.MkdirAll(filepath.Dir(revision), 0o777); err != nil {
				return pycompat.OSErrorFrom(err, revision)
			}
			if err := os.Mkdir(revision, 0o777); err != nil {
				return pycompat.OSErrorFrom(err, revision)
			}
			if err := CopyFile(filepath.Join(asset, "manifest.json"), filepath.Join(revision, "previous-manifest.json")); err != nil {
				return err
			}
			relative, err := pycompat.RelativeTo(shot.Value("path").(string), join(root, "assets/shots/"+sid))
			if err != nil {
				return err
			}
			sourceName := filepath.ToSlash(relative)
			videoName := "revisions/" + transaction + "/video.mp4"
			input, err := assetpackage.DescriptorFile(asset, pytool.Record("path", sourceName), stage)
			if err != nil {
				return err
			}
			if err := renderEditHook(ctx, input, shot.Value("filter").(string), shot.Value("frames").(pycompat.Int), join(asset, videoName)); err != nil {
				return err
			}
			manifest, err := editManifest(ctx, prepared.packages[sid], sourceName, shot, asset, videoName, version, transaction)
			if err != nil {
				return err
			}
			data, err := JSONBytes(manifest)
			if err != nil {
				return err
			}
			if err := ReplaceBytes(filepath.Join(asset, "manifest.json"), data); err != nil {
				return err
			}
			if _, err := assetpackage.ValidatePackage(filepath.Join(asset, "manifest.json"), sid, stage); err != nil {
				return err
			}
			meta, err := probe(ctx, join(asset, videoName))
			if err != nil {
				return err
			}
			list, err := streams(meta)
			if err != nil {
				return err
			}
			for _, stream := range list {
				codec, err := item(stream, "codec_type")
				if err != nil {
					return err
				}
				if pycompat.Equal(codec, "audio") {
					return valueError(textExtraAudio)
				}
			}
			if status != nil && pycompat.Equal(ready.Value(sid), sceneregistry.Completed) {
				record := dict(dict(status.Value("shots")).Value(sid))
				if review := dict(record.Value("source_review")); record != nil && review != nil {
					// Apply подтверждает новый монтаж, но не меняет сверенную постановку и источник.
					edit := dict(manifest.Value("accepted_edit"))
					review.Set("accepted_video_sha256", dict(edit.Value("video")).Value("sha256"))
				}
			}
		}
		// Статус публикуется вместе с монтажом до обновления представлений.
		if status != nil {
			data, err := JSONBytes(status)
			if err != nil {
				return err
			}
			if err := ReplaceBytes(join(stage, sceneregistry.ProductionStatus), data); err != nil {
				return err
			}
		}
		if updateViews {
			// Ненулевой код update_scene_views — CalledProcessError: CLI показывает его скрытым
			// общим текстом.
			if output := sceneviews.Run(stage, []string{}); output.Code != 0 {
				return pycompat.New("CalledProcessError", "update_scene_views returned non-zero exit status")
			}
		}
		names := map[string]bool{sceneregistry.ScenesPath: true, sceneregistry.ProductionStatus: true}
		for _, sid := range prepared.shots {
			names["assets/shots/"+sid+"/manifest.json"] = true
		}
		if updateViews {
			ViewPaths(stage, root, names)
		}
		sorted := make([]string, 0, len(names))
		for name := range names {
			sorted = append(sorted, name)
		}
		sort.Strings(sorted)
		files := []any{}
		for _, name := range sorted {
			before, err := DigestOrNone(join(root, name))
			if err != nil {
				return err
			}
			after, err := DigestOrNone(join(stage, name))
			if err != nil {
				return err
			}
			if pycompat.Equal(before, after) {
				continue
			}
			if before != nil {
				backup := join(filepath.Join(directory, "before"), name)
				if err := os.MkdirAll(filepath.Dir(backup), 0o777); err != nil {
					return pycompat.OSErrorFrom(err, backup)
				}
				if err := CopyFile(join(root, name), backup); err != nil {
					return err
				}
			}
			files = append(files, pytool.Record("path", name, "before", before, "after", after))
			journal.Set("files", files)
		}
		// Все входы сверяются после рендера и непосредственно перед первой записью выбранного
		// состояния: устаревший черновик не затронет ни одного соседа.
		if err := assertBaseline(draft, root); err != nil {
			return err
		}
		digest, err := DigestOrNone(statusPath)
		if err != nil {
			return err
		}
		if !pycompat.Equal(digest, statusDigest) {
			return valueError(textStatusMoved)
		}
		for _, sid := range prepared.shots {
			if _, err := assetpackage.ValidatePackage(join(root, "assets/shots/"+sid+"/manifest.json"), sid, root); err != nil {
				return err
			}
		}
		inputs := append(append([]any{}, planShots...), prepared.plan.Value("audio"))
		for _, input := range inputs {
			record := input.(*pycompat.Dict)
			digest, err := sha(record.Value("path").(string))
			if err != nil {
				return err
			}
			if !pycompat.Equal(digest, record.Value("sha256")) {
				return valueError(textSourceMoved)
			}
		}
		journal.Set("state", "publishing")
		if err := saveJournal(directory, journal); err != nil {
			return err
		}
		publishing = true
		for _, sid := range prepared.shots {
			source := join(stage, "assets/shots/"+sid+"/revisions/"+transaction)
			target := join(root, "assets/shots/"+sid+"/revisions/"+transaction)
			if err := os.Mkdir(filepath.Dir(target), 0o777); err != nil && !os.IsExist(err) {
				return pycompat.OSErrorFrom(err, filepath.Dir(target))
			}
			if err := os.Rename(source, target); err != nil {
				return pycompat.OSErrorFrom(err, source)
			}
		}
		for _, raw := range files {
			name := raw.(*pycompat.Dict).Value("path").(string)
			if err := publishFileHook(join(stage, name), join(root, name)); err != nil {
				return err
			}
		}
		for _, sid := range prepared.shots {
			if _, err := assetpackage.ValidatePackage(join(root, "assets/shots/"+sid+"/manifest.json"), sid, root); err != nil {
				return err
			}
		}
		journal.Set("state", "committed")
		return saveJournal(directory, journal)
	}()
	if err != nil {
		if publishing {
			if restoreErr := restoreHook(directory, journal, root); restoreErr != nil {
				err = restoreErr
			}
		} else {
			journal.Set("state", "failed")
			if saveErr := saveJournal(directory, journal); saveErr != nil {
				err = saveErr
			}
		}
	}
	// Staging не является принятой версией: после успеха или полного отката остаются только
	// журнал, резервные копии и неизменяемые ревизии выбранных сцен.
	switch journal.Value("state") {
	case "committed", "rolled_back", "failed":
		_ = os.RemoveAll(stage)
	}
	if err != nil {
		return nil, err
	}
	shots := make([]any, len(prepared.shots))
	for index, sid := range prepared.shots {
		shots[index] = sid
	}
	registryDigest, err := sha(join(root, sceneregistry.ScenesPath))
	if err != nil {
		return nil, err
	}
	return pytool.Record(
		"status", "applied",
		"revision", transaction,
		"shots", shots,
		"scene_registry_sha256", registryDigest,
		"history", History+"/"+transaction,
		"views_updated", updateViews,
	), nil
}
