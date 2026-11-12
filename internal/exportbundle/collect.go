package exportbundle

import (
	"math/big"

	"songframe/internal/sceneregistry"
	"songframe/internal/toolcli"
	"songframe/internal/toolrt"
)

// reader — последовательное чтение полей значений проекта: первая ошибка запоминается,
// дальнейшие обращения ничего не делают. Так порядок вычисления (какое исключение возникнет на
// неполных данных) остаётся порядком вызовов, а код не повторяет проверку после каждого поля.
type reader struct {
	err error
	// fps — частота кадров проекта для таймкодов; нужна только reader.timecode.
	fps int64
}

// keep — результат операции: ошибка запоминается, значение отдаётся дальше.
func keep[T any](r *reader, value T, err error) T {
	if err != nil && r.err == nil {
		r.err = err
	}
	return value
}

// item — значение по цепочке ключей (toolrt.GetItem): отсутствующий ключ — KeyError.
func (r *reader) item(container any, keys ...string) any {
	for _, key := range keys {
		if r.err != nil {
			return nil
		}
		value, err := toolrt.GetItem(container, key)
		container = keep(r, value, err)
	}
	return container
}

// get — значение ключа словаря или fallback, если ключа нет (toolrt.DictGet).
func (r *reader) get(container any, key string, fallback any) any {
	if r.err != nil {
		return nil
	}
	value, err := toolrt.DictGet(container, key, fallback)
	return keep(r, value, err)
}

// float — значение, приведённое к float (toolrt.Float), для строки пакета.
func (r *reader) float(value any) any {
	if r.err != nil {
		return nil
	}
	number, err := toolrt.Float(value)
	return keep(r, any(number), err)
}

// timecode — таймкод значения (функция timecode пакета).
func (r *reader) timecode(value any) string {
	if r.err != nil {
		return ""
	}
	text, err := timecode(value, r.fps)
	return keep(r, text, err)
}

// frames — число кадров значения на частоте rate (framesAt) целым toolrt; без частоты — nil.
func (r *reader) frames(value any, rate *big.Rat) any {
	if r.err != nil || rate == nil {
		return nil
	}
	frames, err := framesAt(value, rate)
	if err != nil {
		return keep[any](r, nil, err)
	}
	return toolrt.IntFromBig(frames)
}

// orEmpty — само значение, если оно истинно, иначе пустой словарь.
func orEmpty(value any) any {
	if toolrt.Truthy(value) {
		return value
	}
	return toolrt.NewDict()
}

// unpackPair — два элемента списка, словаря или строки. Иной тип — TypeError, другое число
// элементов — ValueError; тексты исключений зафиксированы эталоном.
func unpackPair(value any) (any, any, error) {
	switch value.(type) {
	case []any, *toolrt.Dict, string:
	default:
		return nil, nil, toolrt.Raise(toolrt.TypeError, "нельзя распаковать: %s", toolrt.TypeName(value))
	}
	items, err := toolrt.Iter(value)
	if err != nil {
		return nil, nil, err
	}
	switch {
	case len(items) < 2:
		return nil, nil, toolrt.Raise(toolrt.ValueError, "ожидалось 2 значения, получено %d", len(items))
	case len(items) > 2:
		return nil, nil, toolrt.New(toolrt.ValueError, "ожидалось 2 значения, получено больше")
	}
	return items[0], items[1], nil
}

// nativeFPS — собственная частота входа рецепта. Она известна, только если вход — сам оригинал
// видео; иначе секунды участка лежат на сетке после конвертации.
func nativeFPS(edit, media any, fps int64) (*big.Rat, error) {
	var r reader
	rate := r.get(edit, "source_fps", nil)
	if !toolrt.Truthy(rate) {
		rate = r.get(orEmpty(media), "r_frame_rate", nil)
	}
	if r.err != nil {
		return nil, r.err
	}
	original := false
	if toolrt.Truthy(rate) {
		original = toolrt.Equal(stageValue(&r, edit, "input"), "original.mp4")
		if r.err != nil {
			return nil, r.err
		}
	}
	if !original {
		grid := r.get(edit, "source_frame_grid_fps", nil)
		if r.err != nil {
			return nil, r.err
		}
		if !toolrt.Truthy(grid) {
			grid = toolrt.NewInt(fps)
		}
		return fractionOf(grid)
	}
	return parseFraction(toolrt.Str(rate))
}

// stageValue — поле key первого этапа rebuild.stages рецепта монтажа.
func stageValue(r *reader, edit any, key string) any {
	stages := r.item(edit, "rebuild", "stages")
	if r.err != nil {
		return nil
	}
	first, err := toolrt.GetItem(stages, toolrt.NewInt(0))
	return r.item(keep(r, first, err), key)
}

// shotPath — путь файла комплекта плана от корня проекта: assets/shots/<план>/<имя>.
func shotPath(sid string, name any) string {
	return "assets/shots/" + sid + "/" + toolrt.Str(name)
}

// inputPaths — столбец inputs: пути входов генерации от корня проекта.
func inputPaths(r *reader, sid string, generation any) []any {
	listed := r.item(generation, "inputs")
	if r.err != nil {
		return nil
	}
	items, err := toolrt.Iter(listed)
	keep(r, items, err)
	paths := []any{}
	for _, input := range items {
		root := r.get(input, "root", "asset")
		name := r.item(input, "path")
		if r.err != nil {
			return nil
		}
		if toolrt.Equal(root, "asset") {
			paths = append(paths, shotPath(sid, name))
		} else {
			paths = append(paths, "source/"+toolrt.Str(name))
		}
	}
	return paths
}

// addVideo дополняет строку плана с манифестом полями оригинала генерации и принятого монтажа.
// Значения вычисляются в порядке полей строки: он определяет, какая ошибка возникнет первой.
func addVideo(row *toolrt.Dict, sid, folder string, kit any, fps int64) error {
	r := reader{fps: fps}
	generation := r.item(kit, "generation")
	edit := r.item(kit, "accepted_edit")
	media := r.get(generation, "original_media", nil)
	if r.err != nil {
		return r.err
	}
	rate, err := nativeFPS(edit, media, fps)
	if err != nil {
		return err
	}
	stageInput := stageValue(&r, edit, "input")
	interval := r.item(edit, "source_interval_seconds")
	if r.err != nil {
		return r.err
	}
	sourceIn, sourceOut, err := unpackPair(interval)
	if err != nil {
		return err
	}
	still := r.get(edit, "still_source_time_seconds", nil)

	set := func(key string, value any) {
		if r.err == nil {
			row.Set(key, value)
		}
	}
	set("status", "video")
	set("card", "")
	set("original", shotPath(sid, r.item(generation, "original", "path")))
	set("original_sha256", r.item(generation, "original", "sha256"))
	details := orEmpty(r.get(generation, "original_media", nil))
	set("original_fps", r.get(details, "r_frame_rate", ""))
	duration := r.get(details, "duration", nil)
	if !toolrt.Truthy(duration) {
		duration = toolrt.NewInt(0)
	}
	seconds := r.float(duration)
	if !toolrt.Truthy(seconds) {
		seconds = ""
	}
	set("original_duration_s", seconds)
	set("source_shot", r.get(generation, "source_shot", sid))
	set("accepted_clip", shotPath(sid, r.item(edit, "video", "path")))
	set("accepted_sha256", r.item(edit, "video", "sha256"))
	set("rebuild_input", shotPath(sid, stageInput))
	set("source_in_s", r.float(sourceIn))
	set("source_out_s", r.float(sourceOut))
	if r.err == nil {
		grid, err := ratFloat(rate)
		set("source_grid_fps", keep(&r, grid, err))
	}
	set("source_in_frame_native", r.frames(sourceIn, rate))
	set("source_out_frame_native", r.frames(sourceOut, rate))
	set("speed", r.float(r.item(edit, "speed", "factor")))
	set("speed_ratio", r.item(edit, "speed", "ratio"))
	set("hold_first_s", r.float(r.get(edit, "hold_first_seconds", toolrt.NewInt(0))))
	set("hold_last_s", r.float(r.get(edit, "hold_last_seconds", toolrt.NewInt(0))))
	if still != nil {
		set("still_time_s", r.float(still))
	} else {
		set("still_time_s", "")
	}
	repeat := orEmpty(r.get(edit, "repeat", nil))
	set("repeat_full_cycles", r.get(repeat, "full_cycles", ""))
	set("repeat_tail_frames", r.get(repeat, "tail_frames", ""))
	set("repeat_cycle_frames", r.get(repeat, "cycle_frames", ""))
	set("prompt", shotPath(sid, r.item(generation, "prompt", "path")))
	if toolrt.Truthy(r.get(generation, "request", nil)) {
		set("request", shotPath(sid, r.item(generation, "request", "path")))
	} else {
		set("request", "")
	}
	set("inputs", inputPaths(&r, sid, generation))
	if toolrt.Truthy(r.get(generation, "audio", nil)) {
		set("speech_wav", shotPath(sid, r.item(generation, "audio", "path")))
	} else {
		set("speech_wav", "")
	}
	if toolrt.IsFile(toolrt.JoinPath(folder, "audio-recipe.json")) {
		set("audio_recipe", shotPath(sid, "audio-recipe.json"))
	} else {
		set("audio_recipe", "")
	}
	set("filter", stageValue(&r, edit, "filter"))
	return r.err
}

// shotRow — строка плана: карточка, а при наличии манифеста комплекта — принятое видео.
func shotRow(root string, scene *toolrt.Dict, fps int64) (*toolrt.Dict, error) {
	r := reader{fps: fps}
	sid, _ := scene.Value("id").(string)
	folder := toolrt.JoinPath(root, "assets/shots", sid)
	row := toolrt.NewDict()
	set := func(key string, value any) {
		if r.err == nil {
			row.Set(key, value)
		}
	}
	set("shot", sid)
	set("title", r.get(scene, "title", ""))
	set("sequence", r.item(scene, "sequence"))
	set("song_in_s", r.float(r.item(scene, "start")))
	set("song_out_s", r.float(r.item(scene, "end")))
	set("duration_s", r.float(r.item(scene, "duration")))
	set(framesKey(fps), r.item(scene, "frames"))
	set("song_in_tc", r.timecode(r.item(scene, "start")))
	set("song_out_tc", r.timecode(r.item(scene, "end")))
	set("camera", r.item(scene, "camera"))
	set("action", r.item(scene, "action"))
	set("continuity", r.item(scene, "continuity"))
	set("lipsync", toolrt.Truthy(r.get(scene, "lipsync", nil)))
	set("status", "card")
	set("card", "plan/animatic/cards/"+sid+".png")
	if r.err != nil {
		return nil, r.err
	}
	manifest := toolrt.JoinPath(folder, "manifest.json")
	if toolrt.IsFile(manifest) {
		kit, err := toolrt.LoadJSONFile(manifest)
		if err != nil {
			return nil, err
		}
		if err := addVideo(row, sid, folder, kit, fps); err != nil {
			return nil, err
		}
	}
	return row, nil
}

// sourceText — строка песни с номером number (с единицы), если номер — целое toolrt (bool тоже
// считается целым) в пределах текста; иначе пусто.
func sourceText(lines []string, number any) string {
	if !toolrt.IsInt(number) {
		return ""
	}
	value, err := toolrt.Sub(number, toolrt.NewInt(0))
	if err != nil {
		return ""
	}
	index, ok := value.(toolrt.Int).Int64()
	if !ok || index <= 0 || index > int64(len(lines)) {
		return ""
	}
	return toolrt.Strip(lines[index-1])
}

// lyricRow — строка песни с оценками времени из разметки проекта.
func lyricRow(line any, text []string, fps int64) (*toolrt.Dict, error) {
	r := reader{fps: fps}
	number := r.get(line, "source_line", nil)
	row := toolrt.NewDict()
	row.Set("id", r.item(line, "id"))
	row.Set("source_line", number)
	row.Set("text", sourceText(text, number))
	start := r.item(line, "start")
	end := r.item(line, "end")
	row.Set("start_s", start)
	row.Set("end_s", end)
	row.Set("start_tc", r.timecode(start))
	row.Set("end_tc", r.timecode(end))
	row.Set("note", r.get(line, "note", ""))
	return row, r.err
}

// lyricRows — строки разметки и текст песни: без файлов разметка пуста.
func lyricRows(timing any, text []string, fps int64) ([]any, error) {
	var r reader
	listed := r.get(timing, "lines", []any{})
	if r.err != nil {
		return nil, r.err
	}
	lines, err := toolrt.Iter(listed)
	if err != nil {
		return nil, err
	}
	rows := []any{}
	for _, line := range lines {
		row, err := lyricRow(line, text, fps)
		if err != nil {
			return nil, err
		}
		rows = append(rows, row)
	}
	return rows, nil
}

// collect — все данные пакета из реестра, проекта, манифестов и разметки.
func collect(root string) (*toolrt.Dict, error) {
	registry, err := sceneregistry.Load(root)
	if err != nil {
		return nil, err
	}
	project, err := sceneregistry.LoadProject(root, false)
	if err != nil {
		return nil, err
	}
	if err := sceneregistry.SameFPS(root, registry); err != nil {
		return nil, err
	}
	fps := sceneregistry.FPS(registry.Value("fps"))
	initial, err := sceneregistry.InitialStatesFor(root)
	if err != nil {
		return nil, err
	}
	scenes, err := sceneregistry.Shots(registry, initial)
	if err != nil {
		return nil, err
	}
	var timing any = toolcli.Record("lines", []any{})
	if path := toolrt.JoinPath(root, "plan/audio/timing.json"); toolrt.IsFile(path) {
		if timing, err = toolrt.LoadJSONFile(path); err != nil {
			return nil, err
		}
	}
	text := []string{}
	if path := toolrt.JoinPath(root, "source/text.md"); toolrt.IsFile(path) {
		content, err := toolrt.ReadText(path)
		if err != nil {
			return nil, err
		}
		text = toolrt.SplitLines(content)
	}
	rows := make([]any, 0, len(scenes))
	for _, scene := range scenes {
		row, err := shotRow(root, scene, fps)
		if err != nil {
			return nil, err
		}
		rows = append(rows, row)
	}
	lyrics, err := lyricRows(timing, text, fps)
	if err != nil {
		return nil, err
	}
	var r reader
	song := r.item(registry, "audio", "path")
	end := r.float(r.item(registry, "audio", "end_seconds"))
	references := r.item(registry, "references")
	status := r.get(timing, "status", "")
	if r.err != nil {
		return nil, r.err
	}
	return toolcli.Record(
		"project", project,
		"fps", toolrt.NewInt(fps),
		"song", song,
		"song_end_s", end,
		"references", references,
		"shots", rows,
		"lyrics", lyrics,
		"timing_status", status,
	), nil
}
