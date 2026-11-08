package exportbundle

import (
	"bytes"
	"math/big"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"

	"songframe/internal/toolrt"
)

// shotColumns — столбцы shots.csv по порядку.
var shotColumns = []string{
	"shot", "status", "song_in_tc", "song_out_tc", "song_in_s", "song_out_s", "duration_s", "frames_30",
	"original", "original_fps", "original_duration_s", "source_shot", "rebuild_input", "source_in_s",
	"source_out_s", "source_grid_fps", "source_in_frame_native", "source_out_frame_native", "speed",
	"speed_ratio", "hold_first_s", "hold_last_s", "still_time_s", "repeat_full_cycles",
	"repeat_tail_frames", "repeat_cycle_frames", "accepted_clip", "lipsync", "speech_wav", "audio_recipe",
	"prompt", "inputs", "card", "camera", "action", "continuity", "original_sha256", "accepted_sha256",
}

// lyricColumns — столбцы lyrics.csv.
var lyricColumns = []string{"id", "source_line", "text", "start_tc", "end_tc", "start_s", "end_s", "note"}

// writeText записывает текст в UTF-8 с окончаниями строк текстового режима. Файл создаётся до
// кодирования, поэтому текст с одиночным суррогатом оставляет пустой файл и исключение toolrt
// UnicodeEncodeError.
func writeText(path, text string) error {
	if err := os.WriteFile(path, nil, 0o666); err != nil {
		return toolrt.OSErrorFrom(err, path)
	}
	data, err := toolrt.EncodeUTF8(toolrt.TextMode(text))
	if err != nil {
		return err
	}
	if err := os.WriteFile(path, data, 0o666); err != nil {
		return toolrt.OSErrorFrom(err, path)
	}
	return nil
}

// csvCell — значение ячейки до записи: список соединяется через «; », float округляется, остальное
// не меняется.
func csvCell(value any) (any, error) {
	switch item := value.(type) {
	case []any:
		parts := make([]string, len(item))
		for index, part := range item {
			text, ok := part.(string)
			if !ok {
				return nil, toolrt.Raise(toolrt.TypeError, "sequence item %d: expected str instance, %s found", index, toolrt.TypeName(part))
			}
			parts[index] = text
		}
		return strings.Join(parts, "; "), nil
	case float64:
		return round6(item), nil
	}
	return value, nil
}

// csvField — поле строки CSV: nil — пусто, остальное — строковая запись toolrt.Str. В кавычки
// поле берётся только при разделителе, кавычке и символах окончания строки; кавычка удваивается.
func csvField(value any) string {
	if value == nil {
		return ""
	}
	text := toolrt.Str(value)
	if !strings.ContainsAny(text, ",\"\r\n") {
		return text
	}
	return `"` + strings.ReplaceAll(text, `"`, `""`) + `"`
}

// csvRow — строка CSV с окончанием \r\n, отсутствующий столбец — пустое поле.
func csvRow(row *toolrt.Dict, columns []string) (string, error) {
	cells := map[string]any{}
	for _, key := range row.Keys() {
		for _, column := range columns {
			if column == key {
				cell, err := csvCell(row.Value(key))
				if err != nil {
					return "", err
				}
				cells[key] = cell
			}
		}
	}
	fields := make([]string, len(columns))
	for index, column := range columns {
		if cell, ok := cells[column]; ok {
			fields[index] = csvField(cell)
		}
	}
	return strings.Join(fields, ",") + "\r\n", nil
}

// writeCSV — заголовок и строки CSV. Поток кодирует каждую строку отдельно, поэтому отказ на
// строке (позиция UnicodeEncodeError считается от её начала) оставляет в файле предыдущие.
func writeCSV(rows []*toolrt.Dict, path string, columns []string) error {
	var buffer bytes.Buffer
	buffer.WriteString(strings.Join(columns, ",") + "\r\n")
	var failure error
	for _, row := range rows {
		text, err := csvRow(row, columns)
		if err != nil {
			failure = err
			break
		}
		data, err := toolrt.EncodeUTF8(text)
		if err != nil {
			failure = err
			break
		}
		buffer.Write(data)
	}
	if err := os.WriteFile(path, buffer.Bytes(), 0o666); err != nil {
		return toolrt.OSErrorFrom(err, path)
	}
	return failure
}

// reel — имя катушки EDL из номера плана: точки заменены на «_», ровно 8 символов (обрезка или
// пробелы справа).
func reel(sid string) string {
	runes := toolrt.Runes(strings.ReplaceAll(sid, ".", "_"))
	if len(runes) > 8 {
		runes = runes[:8]
	}
	return toolrt.FromRunes(runes) + strings.Repeat(" ", 8-len(runes))
}

// eventLine — строка события EDL.
func eventLine(number int, shot string, stamps ...string) string {
	return pad(big.NewInt(int64(number)), 3) + "  " + reel(shot) + " V     C        " + strings.Join(stamps, " ")
}

// repeatList — длины событий полных повторов: cycle, повторённый count раз; count — целое toolrt
// или bool, иначе TypeError.
func repeatList(cycle, count any) ([]any, error) {
	if !toolrt.IsInt(count) {
		return nil, toolrt.Raise(toolrt.TypeError, "can't multiply sequence by non-int of type '%s'", toolrt.TypeName(count))
	}
	value, err := toolrt.Sub(count, toolrt.NewInt(0))
	if err != nil {
		return nil, err
	}
	total, ok := value.(toolrt.Int).Int64()
	if !ok {
		return nil, toolrt.New(toolrt.OverflowError, "cannot fit 'int' into an index-sized integer")
	}
	lengths := []any{}
	for index := int64(0); index < total; index++ {
		lengths = append(lengths, cycle)
	}
	return lengths, nil
}

// repeatEvents — события полного цикла и хвоста: EDL не умеет задавать цикл одной строкой, поэтому
// каждый повтор получает своё событие с непрерывными таймкодами песни. Возвращает строки и номер
// последнего события. Вычисления идут через float (формат зафиксирован эталоном): длина делится
// на 30, а секунды снова становятся таймкодом через строковую запись float (toolrt.Str).
func repeatEvents(row *toolrt.Dict, number int) ([]string, int, error) {
	shot := row.Value("shot").(string)
	cycle, count, tail := row.Value("repeat_cycle_frames"), row.Value("repeat_full_cycles"), row.Value("repeat_tail_frames")
	lengths, err := repeatList(cycle, count)
	if err != nil {
		return nil, 0, err
	}
	if toolrt.Truthy(tail) {
		lengths = append(lengths, tail)
	}
	frames, err := framesAt(row.Value("song_in_s"), frameGrid)
	if err != nil {
		return nil, 0, err
	}
	var cursor any = toolrt.IntFromBig(frames)
	lines := []string{"* REPEAT " + shot + ": полных циклов " + toolrt.Str(count) + ", хвост " + toolrt.Str(tail) +
		" кадров, цикл " + toolrt.Str(cycle) + " кадров"}
	frameRate := toolrt.NewInt(fps)
	sourceIn := row.Value("source_in_s")
	var r reader
	divide := func(value any) any {
		if r.err != nil {
			return nil
		}
		result, err := toolrt.TrueDiv(value, frameRate)
		return keep[any](&r, result, err)
	}
	add := func(left, right any) any {
		if r.err != nil {
			return nil
		}
		result, err := toolrt.Add(left, right)
		return keep(&r, result, err)
	}
	for _, length := range lengths {
		number++
		from := r.timecode(sourceIn)
		to := r.timecode(add(sourceIn, divide(length)))
		songIn := r.timecode(divide(cursor))
		next := add(cursor, length)
		songOut := r.timecode(divide(next))
		if r.err != nil {
			return nil, 0, r.err
		}
		lines = append(lines, eventLine(number, shot, from, to, songIn, songOut), "* FROM CLIP NAME: "+toolrt.Str(row.Value("rebuild_input")))
		cursor = next
	}
	return lines, number, nil
}

// videoLines — строки EDL плана с видео. Возвращает их и номер последнего события.
func videoLines(row *toolrt.Dict, number int) ([]string, int, error) {
	shot := row.Value("shot").(string)
	sourceIn, err := timecode(row.Value("source_in_s"))
	if err != nil {
		return nil, 0, err
	}
	var lines []string
	if row.Value("repeat_cycle_frames") != "" {
		if lines, number, err = repeatEvents(row, number); err != nil {
			return nil, 0, err
		}
	} else {
		number++
		sourceOut, err := timecode(row.Value("source_out_s"))
		if err != nil {
			return nil, 0, err
		}
		lines = append(lines, eventLine(number, shot, sourceIn, sourceOut, row.Value("song_in_tc").(string), row.Value("song_out_tc").(string)),
			"* FROM CLIP NAME: "+toolrt.Str(row.Value("rebuild_input")))
	}
	speed := row.Value("speed").(float64)
	still := row.Value("still_time_s")
	if speed != 1 && speed != 0 && still == "" {
		lines = append(lines, "M2   "+reel(shot)+" "+speedField(fps*speed)+strings.Repeat(" ", 16)+sourceIn)
	}
	first, last := row.Value("hold_first_s").(float64), row.Value("hold_last_s").(float64)
	if toolrt.Truthy(first) || toolrt.Truthy(last) {
		lines = append(lines, "* HOLD first "+formatG(first)+"s, last "+formatG(last)+"s")
	}
	if moment, ok := still.(float64); ok {
		lines = append(lines, "* STILL frame at "+formatG(moment)+"s of "+toolrt.Str(row.Value("rebuild_input")))
	}
	lines = append(lines, "* ORIGINAL: "+toolrt.Str(row.Value("original"))+" ("+toolrt.Str(row.Value("original_fps"))+
		"); source grid "+formatG(row.Value("source_grid_fps").(float64))+" fps, native frames "+
		toolrt.Str(row.Value("source_in_frame_native"))+"-"+toolrt.Str(row.Value("source_out_frame_native")), "")
	return lines, number, nil
}

// writeEDL — EDL CMX3600 на 30 кадров/с non-drop. Планы без видео — комментарии без событий.
func writeEDL(bundle *toolrt.Dict, path string) error {
	name := toolrt.Str(bundle.Value("project").(*toolrt.Dict).Value("name"))
	lines := []string{"TITLE: " + name + " animatic", "FCM: NON-DROP FRAME", ""}
	number := 0
	for _, row := range rowsOf(bundle) {
		if row.Value("status") != "video" {
			lines = append(lines, "* CARD "+toolrt.Str(row.Value("shot"))+" "+toolrt.Str(row.Value("song_in_tc"))+" "+
				toolrt.Str(row.Value("song_out_tc"))+": видео не сгенерировано, в аниматике карточка", "")
			continue
		}
		added, next, err := videoLines(row, number)
		if err != nil {
			return err
		}
		lines = append(lines, added...)
		number = next
	}
	return writeText(path, strings.Join(lines, "\n")+"\n")
}

// quoteAttr — значение атрибута XML в кавычках: экранируются &, <, > и управляющие \n, \r, \t;
// внешняя кавычка выбирается так, чтобы не экранировать её без необходимости.
func quoteAttr(text string) string {
	data := strings.NewReplacer("&", "&amp;", ">", "&gt;", "<", "&lt;", "\n", "&#10;", "\r", "&#13;", "\t", "&#9;").Replace(text)
	if strings.Contains(data, `"`) {
		if strings.Contains(data, "'") {
			return `"` + strings.ReplaceAll(data, `"`, "&quot;") + `"`
		}
		return "'" + data + "'"
	}
	return `"` + data + `"`
}

// quoteURI — процентное кодирование байтов пути: всё, кроме латиницы, цифр и «_.-~/», — %XX.
func quoteURI(path string) string {
	var builder strings.Builder
	for _, value := range []byte(path) {
		switch {
		case value >= 'a' && value <= 'z', value >= 'A' && value <= 'Z', value >= '0' && value <= '9',
			strings.IndexByte("_.-~/", value) >= 0:
			builder.WriteByte(value)
		default:
			builder.WriteString("%" + strings.ToUpper(strconv.FormatInt(int64(value)+0x100, 16)[1:]))
		}
	}
	return builder.String()
}

// fileURI — URI схемы file для абсолютного пути в записи через «/» с томом volume: POSIX —
// file:///a/b, диск Windows — file:///c:/a/b (двоеточие тома не кодируется), сеть — file://host/share.
func fileURI(slashed, volume string) string {
	switch {
	case len(volume) == 2 && volume[1] == ':':
		return "file:///" + volume + quoteURI(slashed[2:])
	case volume != "":
		return "file:" + quoteURI(slashed)
	}
	return "file://" + quoteURI(slashed)
}

// pathJoin — путь base с компонентом part из JSON: нестроковая часть — TypeError оператора
// деления пути с именем класса пути ОС.
func pathJoin(base string, part any) (string, error) {
	text, ok := part.(string)
	if !ok {
		name := "PosixPath"
		if runtime.GOOS == "windows" {
			name = "WindowsPath"
		}
		return "", toolrt.Raise(toolrt.TypeError, "unsupported operand type(s) for /: '%s' and '%s'", name, toolrt.TypeName(part))
	}
	return toolrt.JoinPath(base, text), nil
}

// mediaPlace — откуда timeline.fcpxml берёт медиа. Абсолютный путь привязал бы пакет к этой машине,
// поэтому файл внутри portable записывается относительно папки пакета: portable — сам пакет с
// копиями либо проект, в котором лежит пакет без копий (тогда переносится весь проект). Пустой
// portable и файл вне его — пакет вне проекта без копий и песня снаружи: опоры для относительного
// пути нет, остаётся абсолютный URI файла.
type mediaPlace struct {
	root     string
	bundle   string
	portable string
}

// mediaURI — src медиа в FCPXML: URI файла с разрешёнными ссылками, относительный внутри portable.
func (place mediaPlace) mediaURI(path any) (string, error) {
	joined, err := pathJoin(place.root, path)
	if err != nil {
		return "", err
	}
	resolved := toolrt.ResolvePath(joined)
	if place.portable != "" && toolrt.IsRelativeTo(resolved, place.portable) {
		if relative, err := filepath.Rel(place.bundle, resolved); err == nil {
			return quoteURI(filepath.ToSlash(relative)), nil
		}
	}
	return fileURI(filepath.ToSlash(resolved), filepath.VolumeName(resolved)), nil
}

// timelineItem — asset и элемент spine одного плана FCPXML.
func timelineItem(row *toolrt.Dict, place mediaPlace) (asset, clip string, err error) {
	shot := row.Value("shot").(string)
	id := "c" + strings.ReplaceAll(shot, ".", "_")
	offset, err := rational(row.Value("song_in_s"))
	if err != nil {
		return "", "", err
	}
	duration := toolrt.Str(row.Value("frames_30")) + "/30s"
	if row.Value("status") == "video" {
		uri, err := place.mediaURI(row.Value("accepted_clip"))
		if err != nil {
			return "", "", err
		}
		asset = `    <asset id="` + id + `" name=` + quoteAttr(shot) + ` src=` + quoteAttr(uri) +
			` start="0s" duration="` + duration + `" hasVideo="1" format="r1"/>`
		clip = `<asset-clip ref="` + id + `" name=` + quoteAttr(shot) + ` offset="` + offset + `" start="0s" duration="` + duration + `"`
		return asset, clip, nil
	}
	uri, err := place.mediaURI(row.Value("card"))
	if err != nil {
		return "", "", err
	}
	asset = `    <asset id="` + id + `" name=` + quoteAttr(shot) + ` src=` + quoteAttr(uri) + ` start="0s" duration="0s" hasVideo="1" format="r1"/>`
	clip = `<video ref="` + id + `" name=` + quoteAttr(shot+" (карточка)") + ` offset="` + offset + `" start="0s" duration="` + duration + `"`
	return asset, clip, nil
}

// writeFCPXML — FCPXML: шкала аниматика из принятых клипов и карточек по порядку, песня —
// связанным клипом первого плана на дорожке -1.
func writeFCPXML(bundle *toolrt.Dict, path string, place mediaPlace) error {
	total, err := rational(bundle.Value("song_end_s"))
	if err != nil {
		return err
	}
	song, err := place.mediaURI(bundle.Value("song"))
	if err != nil {
		return err
	}
	assets := []string{`    <asset id="song" name="song" src=` + quoteAttr(song) + ` start="0s" duration="` + total +
		`" hasAudio="1" audioSources="1" audioChannels="2" audioRate="44100"/>`}
	spine := []string{}
	for index, row := range rowsOf(bundle) {
		asset, clip, err := timelineItem(row, place)
		if err != nil {
			return err
		}
		assets = append(assets, asset)
		if index > 0 {
			spine = append(spine, "        "+clip+"/>")
			continue
		}
		closing := "        </video>"
		if row.Value("status") == "video" {
			closing = "        </asset-clip>"
		}
		spine = append(spine, "        "+clip+">",
			`          <asset-clip ref="song" lane="-1" name="song" offset="0s" start="0s" duration="`+total+`"/>`, closing)
	}
	name := toolrt.Str(bundle.Value("project").(*toolrt.Dict).Value("name"))
	document := []string{
		`<?xml version="1.0" encoding="UTF-8"?>`,
		"<!DOCTYPE fcpxml>",
		`<fcpxml version="1.8">`,
		"  <resources>",
		`    <format id="r1" name="FFVideoFormat1080p30" frameDuration="1/30s" width="1920" height="1080"/>`,
	}
	document = append(document, assets...)
	document = append(document,
		"  </resources>",
		"  <library><event name="+quoteAttr(name)+"><project name="+quoteAttr(name+" animatic")+">",
		`    <sequence format="r1" duration="`+total+`" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="44100">`,
		"      <spine>")
	document = append(document, spine...)
	document = append(document, "      </spine>", "    </sequence>", "  </project></event></library>", "</fcpxml>")
	return writeText(path, strings.Join(document, "\n")+"\n")
}

// readme — README.md пакета: пояснение полей и оговорки для монтажёра.
func readme(bundle *toolrt.Dict, copied int) string {
	rows := rowsOf(bundle)
	videos := videoCount(rows)
	files := "- Пути в таблицах относительны к корню папки проекта; файлы не копировались."
	if copied > 0 {
		files = "- `media/` — копии исходников, если пакет собран с `--copy`; `timeline.fcpxml` ссылается на них относительными путями, поэтому папку пакета можно передавать целиком."
	}
	status := "без примечаний"
	if value := bundle.Value("timing_status"); toolrt.Truthy(value) {
		status = toolrt.Str(value)
	}
	lines := []string{
		"# " + toolrt.Str(bundle.Value("project").(*toolrt.Dict).Value("name")) + " — пакет для монтажёра",
		"",
		"Планов " + strconv.Itoa(len(rows)) + ", с видео " + strconv.Itoa(videos) + ", карточек " + strconv.Itoa(len(rows)-videos) + ". " +
			"Песня целиком: `" + toolrt.Str(bundle.Value("song")) + "`, длительность " + toolrt.FormatFixed(bundle.Value("song_end_s").(float64), 4) + " с. " +
			"Шкала аниматика — 30 кадров/с, таймкоды non-drop от начала песни. " +
			"Аниматик — демо: все монтажные решения в нём предварительные.",
		"",
		"## Файлы",
		"",
		"- `shots.csv` — одна строка на план: таймкоды песни, оригинал " +
			"генерации, выбранный участок, скорость, удержания, кадры-опоры, " +
			"промпт, WAV липсинка.",
		"- `timeline.edl` — CMX3600 на 30 кадров/с: события указывают на " +
			"вход рецепта (`rebuild_input`), source in/out даны на сетке 30 " +
			"кадров/с после конвертации, как в `shots.csv`; строки `M2` " +
			"отмечают изменение скорости, комментарии — удержания и " +
			"стоп-кадры. Карточки — комментарии без событий.",
		"- `timeline.fcpxml` — точная шкала аниматика из принятых клипов " +
			"30 кадров/с и карточек, песня связанным клипом; открывается в " +
			"Final Cut Pro, DaVinci Resolve, Premiere Pro.",
		"- `lyrics.csv` — строки песни с оценками времени из разметки проекта; границы не подтверждены на слух.",
		"- `bundle.json` — те же данные для скриптов.",
		files,
		"",
		"## Как читать интервалы",
		"",
		"- Оригиналы генерации сохраняют собственную частоту кадров (`original_fps`, например 24 кадра/с). " +
			"Поля `source_in_s`/`source_out_s` — секунды выбранного участка " +
			"на сетке `source_grid_fps` после конвертации в 30 кадров/с; " +
			"`source_in_frame_native`/`source_out_frame_native` — те же " +
			"границы в кадрах исходной частоты (начало включительно, конец " +
			"исключительно).",
		"- `speed` — множитель скорости принятого монтажа (1,0 — без " +
			"изменения; 0 — стоп-кадр), `hold_first_s`/`hold_last_s` — " +
			"удержание первого и последнего кадра участка, `still_time_s` — " +
			"момент стоп-кадра во входе рецепта.",
		"- `repeat_full_cycles`, `repeat_tail_frames`, `repeat_cycle_frames` — число полных повторов, " +
			"кадров последнего хвоста и кадров одного цикла. EDL содержит отдельное событие для каждого " +
			"повтора и хвоста; FCPXML использует точный принятый клип.",
		"- Планы с `source_shot`, отличным от `shot`, собраны из чужой " +
			"генерации; `rebuild_input` " +
			"указывает фактический вход.",
		"- Для речевых планов (`lipsync`) `speech_wav` — точный срез " +
			"песни, с которым синхронизированы губы; `audio_recipe` описывает " +
			"срез по сэмплам.",
		"- Звук внутри оригиналов генерации в монтаже не используется; музыка — исходная песня.",
		"",
		"## Оговорки",
		"",
		"- Хеши SHA-256 в `shots.csv` позволяют проверить, что получены именно те файлы.",
		"- Карточки — условные изображения для демо, не кадры будущих планов.",
		"- Разметка строк: " + status + ".",
		"",
	}
	return strings.Join(lines, "\n")
}
