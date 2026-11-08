package main

// Проверка разработчика: рецепты обработки SongFrame на явно выбранной паре FFmpeg/ffprobe,
// без проекта, моделей и сети. Синтетические WAV/PNG создаются здесь же, результаты
// проверяются по смыслу через ffprobe, а не по одному коду выхода FFmpeg. Каждая команда
// ограничена минутой и не читает stdin; временный каталог создаёт и удаляет вызывающий shell.

import (
	"bytes"
	"compress/zlib"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"hash/crc32"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// mediaCheck владеет путями проверяемой пары программ, рабочего каталога и манифеста.
type mediaCheck struct {
	ffmpeg, ffprobe string
	root            string
	manifest        string
}

// fail — смысловая ошибка проверки; завершает весь прогон ненулевым кодом.
func fail(format string, args ...any) error { return fmt.Errorf(format, args...) }

// run выполняет короткую операцию с ограничением в минуту и возвращает stdout. Ошибка
// содержит название операции и хвост диагностики программы.
func (m mediaCheck) run(label string, command ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	process := exec.CommandContext(ctx, command[0], command[1:]...)
	var stdout, stderr bytes.Buffer
	process.Stdout, process.Stderr = &stdout, &stderr
	err := process.Run()
	var exit *exec.ExitError
	if ctx.Err() != nil || (err != nil && !errors.As(err, &exit)) {
		if ctx.Err() != nil {
			err = ctx.Err()
		}
		return nil, fail("%s: не удалось выполнить команду: %v", label, err)
	}
	if err != nil {
		code := exit.ExitCode()
		if status, ok := exit.Sys().(syscall.WaitStatus); ok && status.Signaled() {
			code = -int(status.Signal())
		}
		diagnostic := []rune(strings.ToValidUTF8(stderr.String(), "�"))
		if len(diagnostic) > 4000 {
			diagnostic = diagnostic[len(diagnostic)-4000:]
		}
		return nil, fail("%s: код %d\n%s", label, code, string(diagnostic))
	}
	return stdout.Bytes(), nil
}

// encode запускает FFmpeg; -n запрещает замену существующих файлов во временном каталоге.
func (m mediaCheck) encode(label string, arguments ...string) ([]byte, error) {
	return m.run(label, append([]string{m.ffmpeg, "-hide_banner", "-v", "error", "-nostdin", "-n"}, arguments...)...)
}

// probeJSON читает JSON ffprobe с потоками, форматом и главами файла.
func (m mediaCheck) probe(path string) (map[string]any, error) {
	return m.probeArgs("Чтение метаданных", "-show_streams", "-show_format", "-show_chapters", "-of", "json", path)
}

// probeArgs запускает ffprobe только с локальным протоколом file и разбирает JSON.
func (m mediaCheck) probeArgs(label string, arguments ...string) (map[string]any, error) {
	output, err := m.run(label, append([]string{m.ffprobe, "-v", "error", "-protocol_whitelist", "file"}, arguments...)...)
	if err != nil {
		return nil, err
	}
	var result map[string]any
	if err := json.Unmarshal(output, &result); err != nil {
		return nil, fail("%s: неверный JSON ffprobe: %v", label, err)
	}
	return result, nil
}

// Доступ к полям JSON ffprobe: отсутствующее поле — ошибка с именем поля.
func member(value any, key string) (any, error) {
	if record, ok := value.(map[string]any); ok {
		if item, ok := record[key]; ok {
			return item, nil
		}
	}
	return nil, fail("в ответе ffprobe нет поля %s", key)
}

func memberText(value any, key string) (string, error) {
	item, err := member(value, key)
	if err != nil {
		return "", err
	}
	switch v := item.(type) {
	case string:
		return v, nil
	case float64:
		return strconv.FormatFloat(v, 'f', -1, 64), nil
	}
	return "", fail("поле ffprobe %s не строка", key)
}

func memberFloat(value any, key string) (float64, error) {
	text, err := memberText(value, key)
	if err != nil {
		return 0, err
	}
	number, err := strconv.ParseFloat(strings.TrimSpace(text), 64)
	if err != nil {
		return 0, fail("поле ffprobe %s не число: %q", key, text)
	}
	return number, nil
}

func memberInt(value any, key string) (int, error) {
	text, err := memberText(value, key)
	if err != nil {
		return 0, err
	}
	number, err := strconv.Atoi(strings.TrimSpace(text))
	if err != nil {
		return 0, fail("поле ffprobe %s не целое: %q", key, text)
	}
	return number, nil
}

// streams — массив streams из ответа ffprobe.
func streams(info map[string]any) ([]any, error) {
	item, err := member(info, "streams")
	if err != nil {
		return nil, err
	}
	list, _ := item.([]any)
	return list, nil
}

// streamOf — первый поток заданного типа (audio/video).
func streamOf(info map[string]any, kind string) (map[string]any, error) {
	list, err := streams(info)
	if err != nil {
		return nil, err
	}
	for _, item := range list {
		if stream, ok := item.(map[string]any); ok && stream["codec_type"] == kind {
			return stream, nil
		}
	}
	return nil, fail("в ответе ffprobe нет потока %s", kind)
}

// frameTimes — best_effort_timestamp_time всех кадров ответа ffprobe -show_frames.
func frameTimes(info map[string]any) ([]float64, error) {
	item, err := member(info, "frames")
	if err != nil {
		return nil, err
	}
	frames, _ := item.([]any)
	result := make([]float64, 0, len(frames))
	for _, frame := range frames {
		value, err := memberFloat(frame, "best_effort_timestamp_time")
		if err != nil {
			return nil, err
		}
		result = append(result, value)
	}
	return result, nil
}

var (
	featureLine  = regexp.MustCompile(`^\s*[A-Z.]{1,8}\s+(\S+)`)
	protocolLine = regexp.MustCompile(`^\s+[a-z0-9_]+\s*$`)
)

// listedFeatures разбирает таблицу FFmpeg/ffprobe, включая алиасы контейнеров и списки протоколов.
func (m mediaCheck) listedFeatures(command, option string) (map[string]bool, error) {
	output, err := m.run("Список возможностей "+option, command, "-hide_banner", option)
	if err != nil {
		return nil, err
	}
	present := map[string]bool{}
	text := strings.ReplaceAll(strings.ToValidUTF8(string(output), "�"), "\r\n", "\n")
	for _, line := range strings.FieldsFunc(text, func(r rune) bool { return r == '\n' || r == '\r' }) {
		if match := featureLine.FindStringSubmatch(line); match != nil {
			for _, name := range strings.Split(match[1], ",") {
				present[name] = true
			}
		} else if option == "-protocols" && protocolLine.MatchString(line) {
			present[strings.TrimSpace(line)] = true
		}
	}
	return present, nil
}

// requirement — требование к одному списку возможностей: группы взаимозаменяемых имён в
// порядке первого появления в манифесте.
type requirement struct {
	option string
	groups [][]string
	seen   map[string]bool
}

// checkLists читает требования из манифеста компонентов, сохраняя один источник для
// обнаружения. Списки не заменяют функциональные прогоны. Для MP3 допускаются обе штатные
// реализации декодера; lavfi находится в устройствах ввода, хотя в манифесте он указан вместе
// с demuxers. Кодировщики WebM самой проверкой не добавляются.
func (m mediaCheck) checkLists() error {
	versions := []string{}
	for _, pair := range [][2]string{{m.ffmpeg, "ffmpeg"}, {m.ffprobe, "ffprobe"}} {
		output, err := m.run("Версия "+pair[1], pair[0], "-version")
		if err != nil {
			return err
		}
		match := regexp.MustCompile(`(?m)^` + pair[1] + ` version (\S+)`).FindSubmatch(output)
		if match == nil {
			return fail("Не удалось определить версию %s.", pair[1])
		}
		versions = append(versions, string(match[1]))
	}
	if versions[0] != versions[1] {
		return fail("Версии пары FFmpeg/ffprobe не совпадают: %s", strings.Join(versions, ", "))
	}
	fmt.Println("Проверена версия пары FFmpeg/ffprobe: " + versions[0])
	manifest, err := readOrderedJSON(m.manifest)
	if err != nil {
		return err
	}
	categories := map[string]string{
		"decoders": "-decoders", "decoder_families": "-decoders", "encoders": "-encoders",
		"demuxers": "-demuxers", "muxers": "-muxers", "filters": "-filters", "protocols": "-protocols",
	}
	var required []*requirement
	byOption := map[string]*requirement{}
	capabilities, _ := manifest.get("capabilities")
	list, _ := capabilities.([]any)
	for _, item := range list {
		capability, _ := item.(object)
		probes, _ := capability.get("probes")
		recipes := false
		for _, probe := range asList(probes) {
			recipes = recipes || probe == "ffmpeg-recipes"
		}
		if !recipes {
			continue
		}
		features, _ := capability.get("features")
		featureMap, _ := features.(object)
		for _, category := range featureMap {
			if category.Key == "xfade_transitions" {
				continue // Варианты переходов проверяются реальными графами ниже.
			}
			if _, ok := categories[category.Key]; !ok {
				return fail("Неизвестная категория медиавозможностей: %s", category.Key)
			}
			for _, value := range asList(category.Value) {
				name, _ := value.(string)
				option := categories[category.Key]
				if category.Key == "demuxers" && name == "lavfi" {
					option = "-devices"
				}
				group := []string{name}
				if category.Key == "decoder_families" && name == "mp3" {
					group = []string{"mp3", "mp3float"}
				}
				entry := byOption[option]
				if entry == nil {
					entry = &requirement{option: option, seen: map[string]bool{}}
					byOption[option] = entry
					required = append(required, entry)
				}
				if key := strings.Join(group, "\x00"); !entry.seen[key] {
					entry.seen[key] = true
					entry.groups = append(entry.groups, group)
				}
			}
		}
	}
	if len(required) == 0 {
		return fail("В manifest отсутствуют требования проверки ffmpeg-recipes.")
	}
	for _, pair := range [][2]string{{m.ffmpeg, "ffmpeg"}, {m.ffprobe, "ffprobe"}} {
		for _, entry := range required {
			// ffprobe читает входы, декодирует реальные кадры и использует те же локальные протоколы.
			if pair[1] == "ffprobe" && entry.option != "-decoders" && entry.option != "-demuxers" && entry.option != "-protocols" {
				continue
			}
			present, err := m.listedFeatures(pair[0], entry.option)
			if err != nil {
				return err
			}
			var missing []string
			for _, group := range entry.groups {
				found := false
				for _, name := range group {
					found = found || present[name]
				}
				if !found {
					missing = append(missing, strings.Join(group, " либо "))
				}
			}
			sort.Strings(missing)
			if len(missing) > 0 {
				return fail("В %s не хватает возможностей %s: %s", pair[1], entry.option, strings.Join(missing, ", "))
			}
		}
	}
	return nil
}

// asList — значение JSON-массива или пустой список.
func asList(value any) []any {
	list, _ := value.([]any)
	return list
}

// toneWAV формирует PCM WAV 16 бит с тоном 440 Гц амплитудой 8000; отсчёты округляются
// к ближайшему чётному при равенстве.
func toneWAV(channels, rate, frames int) []byte {
	pi := math.Pi
	var samples bytes.Buffer
	for n := 0; n < frames; n++ {
		phase := 2 * pi
		phase *= 440
		phase *= float64(n)
		phase /= float64(rate)
		value := int16(math.RoundToEven(8000 * math.Sin(phase)))
		for c := 0; c < channels; c++ {
			binary.Write(&samples, binary.LittleEndian, value)
		}
	}
	var out bytes.Buffer
	data := samples.Bytes()
	out.WriteString("RIFF")
	binary.Write(&out, binary.LittleEndian, uint32(36+len(data)))
	out.WriteString("WAVEfmt ")
	for _, value := range []any{
		uint32(16), uint16(1), uint16(channels), uint32(rate),
		uint32(rate * channels * 2), uint16(channels * 2), uint16(16),
	} {
		binary.Write(&out, binary.LittleEndian, value)
	}
	out.WriteString("data")
	binary.Write(&out, binary.LittleEndian, uint32(len(data)))
	out.Write(data)
	return out.Bytes()
}

// solidPNG формирует RGB PNG одного цвета с CRC блоков, без внешних конвертеров.
func solidPNG(width, height int, color [3]byte) []byte {
	chunk := func(kind string, data []byte) []byte {
		var out bytes.Buffer
		binary.Write(&out, binary.BigEndian, uint32(len(data)))
		out.WriteString(kind)
		out.Write(data)
		binary.Write(&out, binary.BigEndian, crc32.ChecksumIEEE(append([]byte(kind), data...)))
		return out.Bytes()
	}
	var header bytes.Buffer
	for _, value := range []any{uint32(width), uint32(height), uint8(8), uint8(2), uint8(0), uint8(0), uint8(0)} {
		binary.Write(&header, binary.BigEndian, value)
	}
	row := append([]byte{0}, bytes.Repeat(color[:], width)...)
	var compressed bytes.Buffer
	writer := zlib.NewWriter(&compressed)
	writer.Write(bytes.Repeat(row, height))
	writer.Close()
	var out bytes.Buffer
	out.WriteString("\x89PNG\r\n\x1a\n")
	out.Write(chunk("IHDR", header.Bytes()))
	out.Write(chunk("IDAT", compressed.Bytes()))
	out.Write(chunk("IEND", nil))
	return out.Bytes()
}

// createSources создаёт исходники без testsrc/sine и дополнительных кодеков: 0,8 секунды
// стереотона 44,1 кГц и две картинки разного цвета для начального и конечного кадра перехода.
func (m mediaCheck) createSources() error {
	if err := os.WriteFile(filepath.Join(m.root, "Тон с пробелом.wav"), toneWAV(2, 44100, 35280), 0o666); err != nil {
		return err
	}
	for _, image := range []struct {
		name  string
		color [3]byte
	}{{"Первая опора.png", [3]byte{255, 0, 0}}, {"Последняя опора.png", [3]byte{0, 0, 255}}} {
		if err := os.WriteFile(filepath.Join(m.root, image.name), solidPNG(160, 90, image.color), 0o666); err != nil {
			return err
		}
	}
	return nil
}

// checkReadingFixtures проверяет чтение FLAC/WebM на закреплённых синтетических файлах.
// Фикстуры созданы один раз полным FFmpeg и сверяются по SHA/размеру до чтения, поэтому
// проверяемой сборке не нужны кодировщики FLAC, VP8/VP9, Vorbis/Opus.
func (m mediaCheck) checkReadingFixtures() error {
	directory := filepath.Join(filepath.Dir(filepath.Dir(filepath.Dir(m.manifest))), "testdata", "components")
	data, err := os.ReadFile(filepath.Join(directory, "hashes.json"))
	if err != nil {
		return err
	}
	var hashes map[string]struct {
		SHA256 string `json:"sha256"`
		Bytes  int    `json:"bytes"`
	}
	if err := json.Unmarshal(data, &hashes); err != nil {
		return err
	}
	expected := []struct{ name, audio, video string }{
		{"tiny.flac", "flac", ""}, {"vp8-vorbis.webm", "vorbis", "vp8"}, {"vp9-opus.webm", "opus", "vp9"},
	}
	known := len(hashes) == len(expected)
	for _, item := range expected {
		_, ok := hashes[item.name]
		known = known && ok
	}
	if !known {
		return fail("Неверный состав реестра синтетических медиафикстур.")
	}
	for _, item := range expected {
		path := filepath.Join(directory, item.name)
		content, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		sum := sha256.Sum256(content)
		if len(content) != hashes[item.name].Bytes || hex.EncodeToString(sum[:]) != hashes[item.name].SHA256 {
			return fail("Не совпадает размер или SHA-256 медиафикстуры %s", item.name)
		}
		info, err := m.probe(path)
		if err != nil {
			return err
		}
		audio, err := streamOf(info, "audio")
		if err != nil {
			return err
		}
		if audio["codec_name"] != item.audio {
			return fail("Неверный аудиокодек фикстуры %s", item.name)
		}
		pcm, err := m.encode("Чтение аудио "+item.name, "-i", path, "-map", "0:a:0", "-ac", "1", "-ar", "16000", "-f", "s16le", "pipe:1")
		if err != nil {
			return err
		}
		if len(pcm) < 4800 || len(pcm) > 8000 || len(pcm)%2 != 0 || !hasNonZero(pcm) {
			return fail("Неверное PCM-аудио фикстуры %s", item.name)
		}
		if item.video != "" {
			video, err := streamOf(info, "video")
			if err != nil {
				return err
			}
			width, _ := video["width"].(float64)
			height, _ := video["height"].(float64)
			if video["codec_name"] != item.video || width != 64 || height != 36 {
				return fail("Неверный видеопоток фикстуры %s", item.name)
			}
			frames, err := m.probeArgs("Чтение PTS "+item.name, "-select_streams", "v:0", "-show_frames",
				"-show_entries", "frame=best_effort_timestamp_time", "-of", "json", path)
			if err != nil {
				return err
			}
			pts, err := frameTimes(frames)
			if err != nil {
				return err
			}
			if len(pts) != 2 || math.IsInf(pts[0], 0) || math.IsNaN(pts[0]) || math.IsInf(pts[1], 0) || math.IsNaN(pts[1]) || !(pts[0] < pts[1]) {
				return fail("Неверные декодированные кадры или PTS фикстуры %s", item.name)
			}
		}
		if _, err := m.encode("Полное декодирование "+item.name, "-i", path, "-f", "null", "-"); err != nil {
			return err
		}
	}
	fmt.Println("Проверены SHA/размеры фикстур и реальное чтение FLAC, VP8/Vorbis, VP9/Opus и WebM.")
	return nil
}

// checkAudio кодирует MP3 и проверяет декодирование с ресэмплингом и штатную тишину.
func (m mediaCheck) checkAudio(wav, mp3 string) error {
	if _, err := m.encode("Кодирование MP3 и дополнение хвоста", "-i", wav, "-af", "apad=pad_dur=0.1", "-c:a", "libmp3lame", mp3); err != nil {
		return err
	}
	info, err := m.probe(mp3)
	if err != nil {
		return err
	}
	format, _ := member(info, "format")
	if duration, err := memberFloat(format, "duration"); err != nil {
		return err
	} else if !(duration > .8) {
		return fail("Неверная длительность MP3.")
	}
	for _, variant := range []struct {
		format                string
		channels, rate, width int
	}{{"s16le", 1, 16000, 2}, {"s16le", 2, 44100, 2}, {"f32le", 1, 16000, 4}, {"f32le", 2, 44100, 4}} {
		data, err := m.encode("Декодирование и ресэмплинг аудио", "-i", mp3, "-map", "0:a:0",
			"-ac", strconv.Itoa(variant.channels), "-ar", strconv.Itoa(variant.rate), "-f", variant.format, "pipe:1")
		if err != nil {
			return err
		}
		if len(data) <= int(.8*float64(variant.channels*variant.rate*variant.width)) || len(data)%(variant.channels*variant.width) != 0 {
			return fail("Некорректный размер декодированного аудио.")
		}
		if variant.format == "f32le" {
			for i := 0; i+4 <= len(data); i += 4 {
				value := float64(math.Float32frombits(binary.LittleEndian.Uint32(data[i:])))
				if math.IsInf(value, 0) || math.IsNaN(value) {
					return fail("Некорректные float-сэмплы.")
				}
			}
		}
	}
	silence := filepath.Join(m.root, "Тишина.wav")
	if _, err := m.encode("Штатная проверка тишины", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-t", "0.1", "-c:a", "pcm_s16le", silence); err != nil {
		return err
	}
	info, err = m.probe(silence)
	if err != nil {
		return err
	}
	format, _ = member(info, "format")
	if duration, err := memberFloat(format, "duration"); err != nil {
		return err
	} else if !(math.Abs(duration-.1) < .001) {
		return fail("Неверная длительность тишины.")
	}
	fmt.Println("Проверены MP3, WAV, PCM s16le/f32le, mono/stereo и ресэмплинг.")
	return nil
}

// commonVideo — общие параметры кодирования монтажных клипов.
var commonVideo = []string{"-an", "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-threads", "2",
	"-pix_fmt", "yuv420p", "-r", "30", "-video_track_timescale", "15360", "-map_metadata", "-1"}

// checkMontage проверяет монтаж с масштабом и удержаниями, производные режимы и переходы.
func (m mediaCheck) checkMontage(first, last, clip string) error {
	// Нормализация, обрезка, скорость и удержания совпадают с группой build_review/accept_shot.
	graph := "fps=30,trim=start_frame=0:end_frame=12,setpts=(PTS-STARTPTS)/2,fps=30," +
		"tpad=stop_mode=clone:stop=1,trim=end_frame=6,setpts=N/(30*TB)," +
		"scale=1920:1080:force_original_aspect_ratio=decrease:flags=lanczos," +
		"pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,setsar=1,format=yuv420p," +
		"tpad=start_mode=clone:start=3:stop_mode=clone:stop=3,settb=1/30"
	arguments := append([]string{"-loop", "1", "-framerate", "30", "-i", first, "-vf", graph}, commonVideo...)
	if _, err := m.encode("Монтаж с масштабом и удержаниями", append(arguments, "-frames:v", "12", clip)...); err != nil {
		return err
	}
	info, err := m.probe(clip)
	if err != nil {
		return err
	}
	video, err := streamOf(info, "video")
	if err != nil {
		return err
	}
	frames, err := memberInt(video, "nb_frames")
	if err != nil {
		return err
	}
	width, _ := video["width"].(float64)
	height, _ := video["height"].(float64)
	if width != 1920 || height != 1080 || video["r_frame_rate"] != "30/1" || frames != 12 {
		return fail("Неверные параметры монтажного клипа.")
	}
	timeBase, err := memberText(video, "time_base")
	if err != nil {
		return err
	}
	_, scale, _ := strings.Cut(timeBase, "/")
	if value, err := strconv.Atoi(scale); err != nil || value != 15360 {
		return fail("Неверная временная шкала MP4.")
	}
	// Все четыре режима derive_shot используют подмножество этих преобразований.
	for _, mode := range []struct {
		name, filters string
		frames        int
	}{
		{"Срез", "fps=30,trim=start_frame=2:end_frame=8,setpts=PTS-STARTPTS", 6},
		{"Ускорение", "fps=30,trim=end_frame=12,setpts=PTS*6/12,fps=30:round=near", 6},
		{"Замедление", "fps=30,trim=end_frame=6,setpts=PTS*12/6,fps=30:round=near", 12},
		{"Стоп-кадр", "fps=30,trim=start_frame=2:end_frame=3,setpts=PTS-STARTPTS,loop=loop=-1:size=1:start=0,trim=end_frame=6,setpts=N/(30*TB)", 6},
		{"Повтор", "fps=30,trim=start_frame=2:end_frame=5,setpts=PTS-STARTPTS,loop=loop=-1:size=3:start=0,trim=end_frame=8,setpts=N/(30*TB)", 8},
	} {
		raw, err := m.encode(mode.name, "-i", clip, "-vf", mode.filters+",scale=160:90,setsar=1", "-an", "-pix_fmt", "yuv420p", "-f", "rawvideo", "pipe:1")
		if err != nil {
			return err
		}
		if len(raw) != mode.frames*160*90*3/2 {
			return fail("%s: неверное число кадров.", mode.name)
		}
	}
	for _, transition := range []string{"fade", "fadeblack", "fadewhite", "dissolve", "wipeleft", "wiperight", "cut"} {
		join, count := fmt.Sprintf("xfade=transition=%s:duration=0.1:offset=0.3", transition), 21
		if transition == "cut" {
			join, count = "concat=n=2:v=1:a=0,settb=1/30", 24
		}
		out := filepath.Join(m.root, transition+".mp4")
		arguments := []string{"-loop", "1", "-framerate", "30", "-t", "0.4", "-i", first,
			"-loop", "1", "-framerate", "30", "-t", "0.4", "-i", last, "-filter_complex_threads", "1",
			"-filter_complex", "[0:v]setsar=1,format=yuv420p,settb=1/30[a];" +
				"[1:v]setsar=1,format=yuv420p,settb=1/30[b];[a][b]" + join + ",setpts=PTS-STARTPTS[v]",
			"-map", "[v]"}
		arguments = append(append(arguments, commonVideo...), "-frames:v", strconv.Itoa(count), out)
		if _, err := m.encode("Переход "+transition, arguments...); err != nil {
			return err
		}
		info, err := m.probe(out)
		if err != nil {
			return err
		}
		list, err := streams(info)
		if err != nil {
			return err
		}
		if len(list) == 0 {
			return fail("Неверная длина перехода %s", transition)
		}
		if frames, err := memberInt(list[0], "nb_frames"); err != nil {
			return err
		} else if frames != count {
			return fail("Неверная длина перехода %s", transition)
		}
		pixels, err := m.encode("Проверка крайних кадров перехода", "-i", out, "-vf",
			fmt.Sprintf(`select=eq(n\,0)+eq(n\,%d),scale=1:1`, count-1), "-fps_mode", "vfr", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1")
		if err != nil {
			return err
		}
		if len(pixels) != 6 || pixels[0] <= 200 || pixels[5] <= 200 {
			return fail("Неверные крайние цвета перехода %s", transition)
		}
	}
	fmt.Println("Проверены монтаж, производные режимы, concat filter и шесть переходов xfade.")
	return nil
}

// checkAssembly проверяет полную сборку concat с песней и главами, превью и извлечение кадров.
// Кавычки concat/FFmetadata проверяются на путях с кириллицей и пробелами.
func (m mediaCheck) checkAssembly(clip, mp3 string) error {
	listing := filepath.Join(m.root, "Список клипов.txt")
	quoted := strings.ReplaceAll(clip, "'", `'\''`)
	if err := os.WriteFile(listing, []byte(fmt.Sprintf("file '%s'\nfile '%s'\n", quoted, quoted)), 0o666); err != nil {
		return err
	}
	metadata := filepath.Join(m.root, "Главы.ffmeta")
	chapters := ";FFMETADATA1\ntitle=Проверка медиа\n[CHAPTER]\nTIMEBASE=1/30\nSTART=0\nEND=12\ntitle=M01\n" +
		"[CHAPTER]\nTIMEBASE=1/30\nSTART=12\nEND=24\ntitle=M02\n"
	if err := os.WriteFile(metadata, []byte(chapters), 0o666); err != nil {
		return err
	}
	assembled := filepath.Join(m.root, "Полная сборка.mp4")
	if _, err := m.encode("Сборка concat с песней и главами", "-f", "concat", "-safe", "0", "-i", listing, "-i", mp3,
		"-i", metadata, "-map", "0:v:0", "-map", "1:a:0", "-map_metadata", "2", "-map_chapters", "2",
		"-c:v", "copy", "-c:a", "aac", "-ac", "2", "-ar", "44100", "-b:a", "192k", "-threads", "1",
		"-af", "aresample=44100,atrim=start_sample=0:end_sample=35280,asetpts=PTS-STARTPTS,apad=whole_len=35280,atrim=end_sample=35280",
		"-movflags", "+faststart", assembled); err != nil {
		return err
	}
	info, err := m.probe(assembled)
	if err != nil {
		return err
	}
	video, err := streamOf(info, "video")
	if err != nil {
		return err
	}
	audio, err := streamOf(info, "audio")
	if err != nil {
		return err
	}
	frames, err := memberInt(video, "nb_frames")
	if err != nil {
		return err
	}
	chapterList, err := member(info, "chapters")
	if err != nil {
		return err
	}
	if frames != 24 || len(asList(chapterList)) != 2 {
		return fail("Потеряны кадры или главы сборки.")
	}
	format, err := member(info, "format")
	if err != nil {
		return err
	}
	tags, err := member(format, "tags")
	if err != nil {
		return err
	}
	if title, err := memberText(tags, "title"); err != nil {
		return err
	} else if title != "Проверка медиа" {
		return fail("Потеряно название сборки.")
	}
	duration, err := memberFloat(audio, "duration")
	if err != nil {
		return err
	}
	channels, _ := audio["channels"].(float64)
	if audio["codec_name"] != "aac" || channels != 2 || audio["sample_rate"] != "44100" || !(math.Abs(duration-.8) < .003) {
		return fail("Неверный формат или длительность AAC.")
	}
	data, err := os.ReadFile(assembled)
	if err != nil {
		return err
	}
	if !(bytes.Index(data, []byte("moov")) < bytes.Index(data, []byte("mdat"))) {
		return fail("Не применён MP4 faststart.")
	}
	if _, err := m.encode("Полное декодирование результата в null", "-i", assembled, "-f", "null", "-"); err != nil {
		return err
	}
	preview := filepath.Join(m.root, "Превью.mp4")
	if _, err := m.encode("Превью с копированием видео и музыкой", "-i", clip, "-ss", "0.1", "-i", mp3,
		"-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-t", "0.4", preview); err != nil {
		return err
	}
	info, err = m.probe(preview)
	if err != nil {
		return err
	}
	if list, err := streams(info); err != nil {
		return err
	} else if len(list) != 2 {
		return fail("Превью потеряло поток.")
	}
	if _, err := m.encode("Превью 2×", "-i", clip, "-vf", "setpts=PTS/2,scale=960:-2", "-an", "-c:v", "libx264",
		"-preset", "veryfast", "-crf", "28", "-pix_fmt", "yuv420p", filepath.Join(m.root, "Превью 2x.mp4")); err != nil {
		return err
	}
	// Декодирование реальных PTS проверяется отдельно от метаданных контейнера, как у video_review.
	ptsInfo, err := m.probeArgs("Чтение видеометок", "-select_streams", "v:0", "-read_intervals", "%+1", "-show_frames",
		"-show_entries", "frame=best_effort_timestamp_time", "-of", "json", assembled)
	if err != nil {
		return err
	}
	pts, err := frameTimes(ptsInfo)
	if err != nil {
		return err
	}
	increasing := len(pts) == 24
	for i := 1; i < len(pts); i++ {
		increasing = increasing && pts[i-1] < pts[i]
	}
	if !increasing {
		return fail("Неверные видеометки сборки.")
	}
	if _, err := m.encode("Выбор PNG-кадров", "-protocol_whitelist", "file", "-i", assembled, "-map", "0:v:0", "-an",
		"-vf", `select=eq(n\,0)+eq(n\,23),scale=w='min(960,iw)':h='min(960,ih)':force_original_aspect_ratio=decrease`,
		"-fps_mode", "vfr", "-frames:v", "2", "-start_number", "1", "-f", "image2", filepath.Join(m.root, "Кадр %03d.png")); err != nil {
		return err
	}
	items, err := os.ReadDir(m.root)
	if err != nil {
		return err
	}
	count := 0
	for _, item := range items {
		if matched, _ := filepath.Match("Кадр *.png", item.Name()); matched {
			count++
		}
	}
	if count != 2 {
		return fail("Не извлечены выбранные PNG-кадры.")
	}
	fmt.Println("Проверены concat demuxer, FFmetadata, MP4 faststart, AAC, главы, PTS, PNG, rawvideo и null.")
	return nil
}

// all покрывает реальные группы рецептов; ASR, сеть и пользовательские проекты не запускаются.
func (m mediaCheck) all() error {
	if err := m.checkLists(); err != nil {
		return err
	}
	fmt.Println("Проверены списки кодеков, контейнеров, фильтров и протоколов.")
	if err := m.checkReadingFixtures(); err != nil {
		return err
	}
	if err := m.createSources(); err != nil {
		return err
	}
	wav, mp3 := filepath.Join(m.root, "Тон с пробелом.wav"), filepath.Join(m.root, "Тон с пробелом.mp3")
	first, last := filepath.Join(m.root, "Первая опора.png"), filepath.Join(m.root, "Последняя опора.png")
	clip := filepath.Join(m.root, "Монтажный клип.mp4")
	if err := m.checkAudio(wav, mp3); err != nil {
		return err
	}
	if err := m.checkMontage(first, last, clip); err != nil {
		return err
	}
	if err := m.checkAssembly(clip, mp3); err != nil {
		return err
	}
	fmt.Println("Готово: функциональные рецепты и чтение FLAC/VP8/VP9/Vorbis/Opus/WebM пройдены.")
	fmt.Println("Whisper, модели, сеть, пользовательские клипы и установка медиакомплекта не использовались.")
	return nil
}

// mediaCheckCommand — `media-check BIN_DIR WORK MANIFEST`: BIN_DIR содержит ffmpeg и ffprobe,
// WORK — новый пустой временный каталог, MANIFEST — internal/components/manifest.json.
func mediaCheckCommand(arguments []string) int {
	if len(arguments) != 3 {
		fmt.Fprintln(os.Stderr, "Использование: packtool media-check КАТАЛОГ_С_FFMPEG_И_FFPROBE РАБОЧИЙ_КАТАЛОГ MANIFEST")
		return 2
	}
	check := mediaCheck{
		ffmpeg: filepath.Join(arguments[0], "ffmpeg"), ffprobe: filepath.Join(arguments[0], "ffprobe"),
		root: arguments[1], manifest: arguments[2],
	}
	if err := check.all(); err != nil {
		fmt.Fprintln(os.Stderr, "Проверка медиакомплекта завершилась ошибкой: "+err.Error())
		return 1
	}
	return 0
}

// mediaSourcesCommand — `media-sources DIR`: исходники синтетических фикстур чтения
// testdata/components — 0,2 секунды mono 16 кГц и красная картинка 64×36.
func mediaSourcesCommand(arguments []string) error {
	if len(arguments) != 1 {
		return errors.New("использование: packtool media-sources КАТАЛОГ")
	}
	if err := os.WriteFile(filepath.Join(arguments[0], "Тон.wav"), toneWAV(1, 16000, 3200), 0o666); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(arguments[0], "Опора.png"), solidPNG(64, 36, [3]byte{255, 0, 0}), 0o666)
}

// mediaHashesCommand — `media-hashes DIR`: переписывает DIR/hashes.json по трём фикстурам
// чтения после их намеренной замены.
func mediaHashesCommand(arguments []string) error {
	if len(arguments) != 1 {
		return errors.New("использование: packtool media-hashes КАТАЛОГ")
	}
	records := object{}
	for _, name := range []string{"tiny.flac", "vp8-vorbis.webm", "vp9-opus.webm"} {
		data, err := os.ReadFile(filepath.Join(arguments[0], name))
		if err != nil {
			return err
		}
		sum := sha256.Sum256(data)
		records = append(records, field{name, object{{"sha256", hex.EncodeToString(sum[:])}, {"bytes", len(data)}}})
	}
	output := append(encodeJSON(records, jsonOptions{indent: 2}), '\n')
	return os.WriteFile(filepath.Join(arguments[0], "hashes.json"), output, 0o666)
}

// hasNonZero — в данных есть хотя бы один ненулевой байт (аудио не сплошная тишина).
func hasNonZero(data []byte) bool {
	for _, value := range data {
		if value != 0 {
			return true
		}
	}
	return false
}
