package components

import (
	"bytes"
	"context"
	"embed"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

// FFmpegPair содержит только явно выбранные абсолютные пути. Проверка не ищет
// команды в PATH и не меняет установленный комплект или настройки приложения.
type FFmpegPair struct {
	FFmpeg  string `json:"ffmpeg"`
	FFprobe string `json:"ffprobe"`
}

// ProbeOutcome описывает готовность отдельной операции; неисправный видеокодировщик
// не должен запрещать декодирование PCM. Reason предназначен для диагностики пользователем.
type ProbeOutcome struct {
	Status string `json:"status"`
	Reason string `json:"reason"`
}

// MediaReport хранит общий token версии и результаты только ffmpeg-recipes capabilities.
// Статусы ready/incompatible/error/cancelled не являются результатом установки пакета.
type MediaReport struct {
	Version    string                  `json:"version"`
	Operations map[string]ProbeOutcome `json:"operations"`
}

// mediaInputs — короткие синтетические входы: чтение MP3/AAC/H.264 не должно
// требовать исправного кодировщика этих же форматов. Веса и клипы сюда не входят.
//
//go:embed fixtures/*.flac fixtures/*.webm fixtures/*.mp3 fixtures/*.m4a fixtures/*.mp4
var mediaInputs embed.FS

const mediaCommandTimeout = 15 * time.Second
const mediaOutputLimit = 1024 * 1024

// mediaFailure сохраняет различие несовместимой программы, ошибки I/O и отмены.
// Ненулевой код recipe означает incompatible; невозможность запуска — error.
type mediaFailure struct{ status, reason string }

func (e *mediaFailure) Error() string { return e.reason }

// mediaBuffer принимает весь поток процесса, но сохраняет только ограниченный префикс.
// Превышение лимита обнаруживается после Run и никогда не выдаётся как успешный JSON/PCM.
type mediaBuffer struct {
	data     []byte
	limit    int
	overflow bool
}

func (b *mediaBuffer) Write(p []byte) (int, error) {
	n := len(p)
	remaining := b.limit - len(b.data)
	if len(p) > remaining {
		b.overflow = true
		p = p[:remaining]
	}
	b.data = append(b.data, p...)
	return n, nil
}

// mediaRunner владеет временными файлами одного вызова и кэшем списков возможностей.
// Он не разделяется между горутинами; все дочерние процессы наследуют отмену caller.
type mediaRunner struct {
	ctx        context.Context
	pair       FFmpegPair
	dir        string
	timeout    time.Duration
	lists      map[string]map[string]bool
	listErrors map[string]error
}

// run запускает только указанный бинарник без shell, ограничивая время и оба потока.
// WaitDelay не позволяет оставленному потомком открытому pipe удерживать отменённый probe.
func (r *mediaRunner) run(program string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(r.ctx, r.timeout)
	defer cancel()
	command := exec.CommandContext(ctx, program, args...)
	command.WaitDelay = 250 * time.Millisecond
	stdout := &mediaBuffer{limit: mediaOutputLimit}
	stderr := &mediaBuffer{limit: 16 * 1024}
	command.Stdout = stdout
	command.Stderr = stderr
	err := command.Run()
	if r.ctx.Err() != nil {
		return nil, &mediaFailure{"cancelled", "Проверка отменена: " + r.ctx.Err().Error()}
	}
	if ctx.Err() != nil {
		return nil, &mediaFailure{"error", "Превышено время ожидания медиакоманды."}
	}
	if stdout.overflow || stderr.overflow {
		return nil, &mediaFailure{"error", "Медиакоманда превысила допустимый объём вывода."}
	}
	if err != nil {
		status := "error"
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			status = "incompatible"
		}
		detail := strings.TrimSpace(string(stderr.data))
		if detail == "" {
			detail = err.Error()
		}
		return nil, &mediaFailure{status, "Ошибка медиакоманды: " + detail}
	}
	return stdout.data, nil
}

// ff добавляет общий неинтерактивный режим; существующие файлы probe не перезаписываются.
func (r *mediaRunner) ff(args ...string) ([]byte, error) {
	return r.run(r.pair.FFmpeg, append([]string{"-hide_banner", "-v", "error", "-nostdin", "-n"}, args...)...)
}

// ProbeFFmpeg проверяет выбранную пару и отдельно каждую операцию manifest.
// Только поломка самой пары, общая ошибка временных файлов или отмена возвращают error;
// несовместимость отдельного recipe остаётся в Operations и не блокирует соседние операции.
func ProbeFFmpeg(ctx context.Context, manifest Manifest, pair FFmpegPair) (MediaReport, error) {
	report := MediaReport{Operations: map[string]ProbeOutcome{}}
	caps := []Capability{}
	for _, capability := range manifest.Capabilities {
		if hasMediaProbe(capability.Probes) {
			caps = append(caps, capability)
			report.Operations[capability.ID] = ProbeOutcome{"cancelled", "Проверка ещё не выполнена."}
		}
	}
	failPair := func(err error) (MediaReport, error) {
		outcome := mediaOutcome(err)
		for id := range report.Operations {
			report.Operations[id] = outcome
		}
		if ctx.Err() != nil {
			return report, ctx.Err()
		}
		return report, err
	}
	if err := ctx.Err(); err != nil {
		return failPair(&mediaFailure{"cancelled", "Проверка отменена: " + err.Error()})
	}
	for _, name := range []string{pair.FFmpeg, pair.FFprobe} {
		if !filepath.IsAbs(name) {
			return failPair(&mediaFailure{"error", "Для FFmpeg и ffprobe нужны явные абсолютные пути."})
		}
		info, err := os.Stat(name)
		if err != nil || !info.Mode().IsRegular() {
			return failPair(&mediaFailure{"error", "Файл медиапрограммы недоступен: " + name})
		}
	}
	r := mediaRunner{ctx: ctx, pair: pair, timeout: mediaCommandTimeout, lists: map[string]map[string]bool{}, listErrors: map[string]error{}}
	versions := []string{}
	for _, program := range []struct{ path, name string }{{pair.FFmpeg, "ffmpeg"}, {pair.FFprobe, "ffprobe"}} {
		output, err := r.run(program.path, "-version")
		if err != nil {
			return failPair(err)
		}
		fields := strings.Fields(string(output))
		if len(fields) < 3 || fields[0] != program.name || fields[1] != "version" {
			return failPair(&mediaFailure{"incompatible", "Не удалось прочитать версию " + program.name + "."})
		}
		versions = append(versions, fields[2])
	}
	if versions[0] != versions[1] {
		return failPair(&mediaFailure{"incompatible", "Версии FFmpeg и ffprobe не совпадают: " + strings.Join(versions, ", ")})
	}
	report.Version = versions[0]
	dir, err := os.MkdirTemp("", "SongFrame медиа ")
	if err != nil {
		return failPair(fmt.Errorf("временная папка проверки медиа: %w", err))
	}
	defer os.RemoveAll(dir)
	r.dir = dir
	if err = r.sources(); err != nil {
		return failPair(err)
	}
	for _, capability := range caps {
		if ctx.Err() != nil {
			for id, outcome := range report.Operations {
				if outcome.Status == "cancelled" {
					report.Operations[id] = ProbeOutcome{"cancelled", "Проверка отменена до выполнения операции."}
				}
			}
			return report, ctx.Err()
		}
		err = r.features(capability)
		if err == nil {
			err = r.operation(capability)
		}
		report.Operations[capability.ID] = mediaOutcome(err)
	}
	if ctx.Err() != nil {
		return report, ctx.Err()
	}
	return report, nil
}

// hasMediaProbe исключает ML capabilities, у которых совсем другой жизненный цикл.
func hasMediaProbe(probes []string) bool {
	for _, probe := range probes {
		if probe == "ffmpeg-recipes" {
			return true
		}
	}
	return false
}

// mediaOutcome переводит техническую ошибку в стабильные статусы API.
func mediaOutcome(err error) ProbeOutcome {
	if err == nil {
		return ProbeOutcome{"ready", "Короткая функциональная проверка выполнена."}
	}
	var failure *mediaFailure
	if errors.As(err, &failure) {
		return ProbeOutcome{failure.status, failure.reason}
	}
	return ProbeOutcome{"error", err.Error()}
}

// list кэширует и успех, и ошибку конкретной таблицы, не распространяя её на другие категории.
func (r *mediaRunner) list(program, option string) (map[string]bool, error) {
	key := program + "\x00" + option
	if data, ok := r.lists[key]; ok {
		return data, nil
	}
	if err, ok := r.listErrors[key]; ok {
		return nil, err
	}
	output, err := r.run(program, "-hide_banner", option)
	if err != nil {
		r.listErrors[key] = err
		return nil, err
	}
	names := map[string]bool{}
	for _, line := range strings.Split(string(output), "\n") {
		fields := strings.Fields(line)
		if len(fields) == 1 && option == "-protocols" && strings.TrimSpace(line) == fields[0] && strings.HasPrefix(line, " ") {
			names[fields[0]] = true
			continue
		}
		if len(fields) < 2 {
			continue
		}
		flags := fields[0]
		valid := true
		for _, letter := range flags {
			if (letter < 'A' || letter > 'Z') && letter != '.' {
				valid = false
			}
		}
		if !valid {
			continue
		}
		for _, name := range strings.Split(fields[1], ",") {
			names[name] = true
		}
	}
	r.lists[key] = names
	return names, nil
}

// features читает требования именно данной операции из manifest, включая алиасы MP3.
// lavfi перечислен как вход manifest, но FFmpeg публикует его в таблице устройств.
func (r *mediaRunner) features(capability Capability) error {
	categories := make([]string, 0, len(capability.Features))
	for category := range capability.Features {
		categories = append(categories, category)
	}
	sort.Strings(categories)
	for _, category := range categories {
		if category == "xfade_transitions" {
			continue
		}
		option := "-" + category
		if category == "decoder_families" {
			option = "-decoders"
		}
		switch option {
		case "-decoders", "-encoders", "-demuxers", "-muxers", "-filters", "-protocols":
		default:
			return &mediaFailure{"incompatible", "Неизвестная категория возможностей: " + category}
		}
		for _, name := range capability.Features[category] {
			selected := option
			if category == "demuxers" && name == "lavfi" {
				selected = "-devices"
			}
			programs := []string{r.pair.FFmpeg}
			if selected == "-decoders" || selected == "-demuxers" || selected == "-protocols" {
				programs = append(programs, r.pair.FFprobe)
			}
			for _, program := range programs {
				names, err := r.list(program, selected)
				if err != nil {
					return err
				}
				present := names[name]
				if category == "decoder_families" && name == "mp3" {
					present = present || names["mp3float"]
				}
				if !present {
					return &mediaFailure{"incompatible", fmt.Sprintf("В %s отсутствует %s (%s).", filepath.Base(program), name, category)}
				}
			}
		}
	}
	return nil
}

// sources создаёт только известные синтетические WAV/PNG и копии embedded входов.
// Одинаковые имена и кириллица проверяют передачу аргументов без shell и зависимостей от cwd.
func (r *mediaRunner) sources() error {
	for _, name := range []string{"tiny.flac", "vp8-vorbis.webm", "vp9-opus.webm", "tiny.mp3", "tiny.m4a", "tiny.mp4"} {
		data, err := mediaInputs.ReadFile("fixtures/" + name)
		if err != nil {
			return err
		}
		if err = os.WriteFile(r.path(name), data, 0600); err != nil {
			return err
		}
	}
	const samples = 17640
	data := make([]byte, 44+samples*4)
	copy(data, "RIFF")
	binary.LittleEndian.PutUint32(data[4:], uint32(len(data)-8))
	copy(data[8:], "WAVEfmt ")
	binary.LittleEndian.PutUint32(data[16:], 16)
	binary.LittleEndian.PutUint16(data[20:], 1)
	binary.LittleEndian.PutUint16(data[22:], 2)
	binary.LittleEndian.PutUint32(data[24:], 44100)
	binary.LittleEndian.PutUint32(data[28:], 44100*4)
	binary.LittleEndian.PutUint16(data[32:], 4)
	binary.LittleEndian.PutUint16(data[34:], 16)
	copy(data[36:], "data")
	binary.LittleEndian.PutUint32(data[40:], samples*4)
	for n := 0; n < samples; n++ {
		value := uint16(int16(math.Round(8000 * math.Sin(2*math.Pi*440*float64(n)/44100))))
		binary.LittleEndian.PutUint16(data[44+n*4:], value)
		binary.LittleEndian.PutUint16(data[46+n*4:], value)
	}
	if err := os.WriteFile(r.path("Тон с пробелом.wav"), data, 0600); err != nil {
		return err
	}
	for name, c := range map[string]color.NRGBA{"Первая опора.png": {R: 255, A: 255}, "Последняя опора.png": {B: 255, A: 255}} {
		picture := image.NewNRGBA(image.Rect(0, 0, 160, 90))
		for y := 0; y < 90; y++ {
			for x := 0; x < 160; x++ {
				picture.SetNRGBA(x, y, c)
			}
		}
		var encoded bytes.Buffer
		if err := png.Encode(&encoded, picture); err != nil {
			return err
		}
		if err := os.WriteFile(r.path(name), encoded.Bytes(), 0600); err != nil {
			return err
		}
	}
	return nil
}

// path возвращает путь только к внутреннему имени probe, не к пользовательскому медиа.
func (r *mediaRunner) path(name string) string { return filepath.Join(r.dir, name) }

// mediaInfo содержит используемый поднабор JSON ffprobe; неизвестные поля допустимы.
// Числовые параметры FFmpeg иногда представлены строками и разбираются явно.
type mediaInfo struct {
	Streams []struct {
		Type       string `json:"codec_type"`
		Codec      string `json:"codec_name"`
		Width      int    `json:"width"`
		Height     int    `json:"height"`
		Rate       string `json:"r_frame_rate"`
		Frames     string `json:"nb_frames"`
		Channels   int    `json:"channels"`
		SampleRate string `json:"sample_rate"`
		Duration   string `json:"duration"`
	} `json:"streams"`
	Chapters []json.RawMessage `json:"chapters"`
	Format   struct {
		Duration string            `json:"duration"`
		Tags     map[string]string `json:"tags"`
	} `json:"format"`
}

// info получает метаданные настоящего локального файла; сетевые протоколы не нужны.
func (r *mediaRunner) info(path string) (mediaInfo, error) {
	var info mediaInfo
	data, err := r.run(r.pair.FFprobe, "-v", "error", "-protocol_whitelist", "file", "-show_streams", "-show_format", "-show_chapters", "-of", "json", path)
	if err != nil {
		return info, err
	}
	if err = json.Unmarshal(data, &info); err != nil {
		return info, &mediaFailure{"incompatible", "ffprobe вернул некорректный JSON: " + err.Error()}
	}
	if len(info.Streams) == 0 {
		return info, &mediaFailure{"incompatible", "ffprobe не обнаружил медиапоток."}
	}
	return info, nil
}

// video проверяет кадровый контракт короткого MP4, а не только код завершения процесса.
func (r *mediaRunner) video(path string, frames int) error {
	info, err := r.info(path)
	if err != nil {
		return err
	}
	for _, stream := range info.Streams {
		if stream.Type == "video" && stream.Codec == "h264" && stream.Rate == "30/1" && stream.Frames == strconv.Itoa(frames) && stream.Width == 192 && stream.Height == 108 {
			return nil
		}
	}
	return &mediaFailure{"incompatible", "Неверный формат или число кадров короткого H.264 результата."}
}

// operation запускает независимый минимальный recipe известной capability.
// Неизвестный ID не получает ready только на основании таблицы опций.
func (r *mediaRunner) operation(capability Capability) error {
	switch capability.ID {
	case "audio-pcm":
		return r.audio()
	case "video-frames":
		return r.frames()
	case "montage-export":
		return r.montage(capability.Features["xfade_transitions"])
	case "animatic":
		return r.animatic()
	case "development-smoke":
		return r.smoke()
	default:
		return &mediaFailure{"incompatible", "Нет функциональной проверки операции " + capability.ID + "."}
	}
}

// audio декодирует разные входы в mono16k float32, не вызывая ни одного видеокодировщика.
// Отдельный PCM16 stereo44k проход покрывает точные сэмплы липсинка и pipe.
func (r *mediaRunner) audio() error {
	for _, name := range []string{"Тон с пробелом.wav", "tiny.mp3", "tiny.m4a", "tiny.flac", "vp8-vorbis.webm", "vp9-opus.webm"} {
		info, err := r.info(r.path(name))
		if err != nil {
			return err
		}
		audio := false
		for _, s := range info.Streams {
			audio = audio || s.Type == "audio"
		}
		if !audio {
			return &mediaFailure{"incompatible", "В синтетическом входе не найден звук."}
		}
		data, err := r.ff("-i", r.path(name), "-map", "0:a:0", "-ac", "1", "-ar", "16000", "-f", "f32le", "pipe:1")
		if err != nil {
			return err
		}
		if len(data) < 16000*4/10 || len(data)%4 != 0 {
			return &mediaFailure{"incompatible", "Декодирование вернуло неверный размер PCM."}
		}
		nonzero := false
		for index := 0; index < len(data); index += 4 {
			value := math.Float32frombits(binary.LittleEndian.Uint32(data[index:]))
			if math.IsNaN(float64(value)) || math.IsInf(float64(value), 0) {
				return &mediaFailure{"incompatible", "Декодированное PCM содержит некорректный float."}
			}
			nonzero = nonzero || value != 0
		}
		if !nonzero {
			return &mediaFailure{"incompatible", "Декодирование потеряло синтетический тон."}
		}
	}
	data, err := r.ff("-i", r.path("Тон с пробелом.wav"), "-ac", "2", "-ar", "44100", "-f", "s16le", "pipe:1")
	if err == nil && len(data) != 17640*4 {
		return &mediaFailure{"incompatible", "PCM16 изменил число сэмплов."}
	}
	return err
}

// frames декодирует H.264/VP8/VP9, читает реальные PTS и извлекает выбранные PNG.
// Функциональный проход не зависит от libx264: все видеовходы встроены в приложение.
func (r *mediaRunner) frames() error {
	for index, name := range []string{"tiny.mp4", "vp8-vorbis.webm", "vp9-opus.webm"} {
		data, err := r.run(r.pair.FFprobe, "-v", "error", "-protocol_whitelist", "file", "-select_streams", "v:0", "-read_intervals", "%+1", "-show_frames", "-show_entries", "frame=best_effort_timestamp_time", "-of", "json", r.path(name))
		if err != nil {
			return err
		}
		var info struct {
			Frames []struct {
				PTS string `json:"best_effort_timestamp_time"`
			} `json:"frames"`
		}
		if err = json.Unmarshal(data, &info); err != nil || len(info.Frames) < 2 {
			return &mediaFailure{"incompatible", "ffprobe не декодировал реальные кадры/PTS."}
		}
		previous := math.Inf(-1)
		for _, frame := range info.Frames {
			point, err := strconv.ParseFloat(frame.PTS, 64)
			if err != nil || math.IsNaN(point) || math.IsInf(point, 0) || point <= previous {
				return &mediaFailure{"incompatible", "Видеометки кадров некорректны."}
			}
			previous = point
		}
		output := r.path(fmt.Sprintf("Кадры %d %%03d.png", index))
		_, err = r.ff("-protocol_whitelist", "file", "-i", r.path(name), "-map", "0:v:0", "-an", "-vf", "select=eq(n\\,0)+eq(n\\,1),scale=80:-2:force_original_aspect_ratio=decrease", "-fps_mode", "vfr", "-frames:v", "2", "-start_number", "1", "-f", "image2", output)
		if err != nil {
			return err
		}
		for number := 1; number <= 2; number++ {
			file, err := os.Open(r.path(fmt.Sprintf("Кадры %d %03d.png", index, number)))
			if err != nil {
				return err
			}
			picture, decodeErr := png.Decode(file)
			file.Close()
			if decodeErr != nil || picture.Bounds().Dx() != 80 {
				return &mediaFailure{"incompatible", "Выбранные PNG-кадры не читаются или имеют неверный размер."}
			}
		}
	}
	data, err := r.ff("-i", r.path("tiny.mp4"), "-vf", "select=eq(n\\,0),setpts=PTS/2,scale=32:18", "-frames:v", "1", "-pix_fmt", "yuv420p", "-f", "rawvideo", "pipe:1")
	if err == nil && len(data) != 32*18*3/2 {
		return &mediaFailure{"incompatible", "Неверный размер выбранного rawvideo кадра."}
	}
	return err
}

// mediaEncode сохраняет рабочие H.264 параметры рецепта при маленьком размере probe.
// Проверка возможностей не является измерением скорости полного 1920×1080 производства.
var mediaEncode = []string{"-an", "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-threads", "2", "-pix_fmt", "yuv420p", "-r", "30", "-video_track_timescale", "15360", "-map_metadata", "-1"}

// segment проверяет карточку и нормализацию trim/speed/holds в отдельный MP4.
func (r *mediaRunner) segment(source, target string) error {
	graph := "fps=30,trim=end_frame=8,setpts=(PTS-STARTPTS)/2,fps=30,tpad=stop_mode=clone:stop=1,trim=end_frame=4,setpts=N/(30*TB),scale=160:90:flags=lanczos,pad=192:108:(ow-iw)/2:(oh-ih)/2:black,setsar=1,format=yuv420p,tpad=start_mode=clone:start=1:stop_mode=clone:stop=1,settb=1/30"
	args := []string{"-loop", "1", "-framerate", "30", "-i", source, "-vf", graph}
	args = append(args, mediaEncode...)
	args = append(args, "-frames:v", "6", target)
	if _, err := r.ff(args...); err != nil {
		return err
	}
	return r.video(target, 6)
}

// transition проверяет реальный xfade/concat graph без зависимости от другого outcome.
func (r *mediaRunner) transition(transition, target string) error {
	join := "concat=n=2:v=1:a=0,settb=1/30"
	count := 12
	if transition != "cut" {
		join = "xfade=transition=" + transition + ":duration=0.1:offset=0.1"
		count = 9
	}
	normalize := "scale=192:108:flags=lanczos,setsar=1,format=yuv420p,settb=1/30"
	graph := "[0:v]" + normalize + "[a];[1:v]" + normalize + "[b];[a][b]" + join + ",setpts=PTS-STARTPTS[v]"
	args := []string{"-loop", "1", "-framerate", "30", "-t", "0.2", "-i", r.path("Первая опора.png"), "-loop", "1", "-framerate", "30", "-t", "0.2", "-i", r.path("Последняя опора.png"), "-filter_complex_threads", "1", "-filter_complex", graph, "-map", "[v]"}
	args = append(args, mediaEncode...)
	args = append(args, "-frames:v", strconv.Itoa(count), target)
	if _, err := r.ff(args...); err != nil {
		return err
	}
	return r.video(target, count)
}

// montage охватывает монтаж, производные loop/fit и все переходы manifest.
// Проверка точного аудиоокна выполняется независимо от готовности общего аниматика.
func (r *mediaRunner) montage(transitions []string) error {
	segment := r.path("Монтаж.mp4")
	if err := r.segment(r.path("Первая опора.png"), segment); err != nil {
		return err
	}
	target := r.path("Производный.mp4")
	filters := "fps=30,trim=start_frame=1:end_frame=3,setpts=PTS-STARTPTS,setpts=PTS*2,fps=30:round=near,loop=loop=-1:size=4:start=0,trim=end_frame=6,setpts=N/(30*TB),scale=192:108:force_original_aspect_ratio=decrease,pad=192:108:(ow-iw)/2:(oh-ih)/2,setsar=1"
	args := []string{"-i", segment, "-vf", filters}
	args = append(args, mediaEncode...)
	args = append(args, "-frames:v", "6", target)
	if _, err := r.ff(args...); err != nil {
		return err
	}
	if err := r.video(target, 6); err != nil {
		return err
	}
	for index, transition := range append(append([]string{}, transitions...), "cut") {
		if err := r.transition(transition, r.path(fmt.Sprintf("Стык %d.mp4", index))); err != nil {
			return err
		}
	}
	preview := r.path("Проба.mp4")
	_, err := r.ff("-i", segment, "-ss", "0.05", "-i", r.path("Тон с пробелом.wav"), "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-ac", "2", "-ar", "44100", "-b:a", "192k", "-af", "aresample=44100,atrim=start_sample=0:end_sample=8820,asetpts=PTS-STARTPTS,apad=whole_len=8820,atrim=end_sample=8820", "-t", "0.2", "-movflags", "+faststart", preview)
	if err != nil {
		return err
	}
	return r.checkAudio(preview, .2)
}

// checkAudio проверяет AAC stereo44k и его длительность из реального результата.
func (r *mediaRunner) checkAudio(path string, duration float64) error {
	info, err := r.info(path)
	if err != nil {
		return err
	}
	for _, s := range info.Streams {
		if s.Type == "audio" {
			actual, parseErr := strconv.ParseFloat(s.Duration, 64)
			if parseErr == nil && s.Codec == "aac" && s.Channels == 2 && s.SampleRate == "44100" && math.Abs(actual-duration) < .003 {
				return nil
			}
		}
	}
	return &mediaFailure{"incompatible", "Неверный формат или длительность выходного AAC."}
}

// animatic проверяет оба вида карточек, concat demuxer, главы, AAC и полный decode.
// Метаданные и список содержат кириллицу/пробелы; пользовательские файлы не открываются.
func (r *mediaRunner) animatic() error {
	first, last := r.path("Карточка.mp4"), r.path("Опоры.mp4")
	if err := r.segment(r.path("Первая опора.png"), first); err != nil {
		return err
	}
	if err := r.segment(r.path("Последняя опора.png"), last); err != nil {
		return err
	}
	if err := r.transition("fade", r.path("Растворение.mp4")); err != nil {
		return err
	}
	quote := func(path string) string { return strings.ReplaceAll(filepath.ToSlash(path), "'", "'\\''") }
	listing := r.path("Список.txt")
	metadata := r.path("Главы.ffmeta")
	if err := os.WriteFile(listing, []byte("file '"+quote(first)+"'\nfile '"+quote(last)+"'\n"), 0600); err != nil {
		return err
	}
	chapters := ";FFMETADATA1\ntitle=Проверка медиа\n[CHAPTER]\nTIMEBASE=1/30\nSTART=0\nEND=6\ntitle=M01\n[CHAPTER]\nTIMEBASE=1/30\nSTART=6\nEND=12\ntitle=M02\n"
	if err := os.WriteFile(metadata, []byte(chapters), 0600); err != nil {
		return err
	}
	target := r.path("Аниматик.mp4")
	_, err := r.ff("-f", "concat", "-safe", "0", "-i", listing, "-i", r.path("Тон с пробелом.wav"), "-i", metadata, "-map", "0:v:0", "-map", "1:a:0", "-map_metadata", "2", "-map_chapters", "2", "-c:v", "copy", "-c:a", "aac", "-ac", "2", "-ar", "44100", "-b:a", "192k", "-af", "asetpts=PTS-STARTPTS", "-movflags", "+faststart", target)
	if err != nil {
		return err
	}
	if err = r.video(target, 12); err != nil {
		return err
	}
	if err = r.checkAudio(target, .4); err != nil {
		return err
	}
	info, err := r.info(target)
	if err != nil {
		return err
	}
	if len(info.Chapters) != 2 || info.Format.Tags["title"] != "Проверка медиа" {
		return &mediaFailure{"incompatible", "Потеряны главы или название MP4."}
	}
	data, err := os.ReadFile(target)
	if err != nil {
		return err
	}
	moov, mdat := bytes.Index(data, []byte("moov")), bytes.Index(data, []byte("mdat"))
	if moov < 0 || mdat < 0 || moov > mdat {
		return &mediaFailure{"incompatible", "Не применён MP4 faststart."}
	}
	_, err = r.ff("-i", target, "-f", "null", "-")
	return err
}

// smoke сохраняет отдельные зависимости штатной проверки поставки, не влияя на PCM.
func (r *mediaRunner) smoke() error {
	wav, mp3 := r.path("Тишина.wav"), r.path("Проверка.mp3")
	if _, err := r.ff("-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-t", "0.1", "-c:a", "pcm_s16le", wav); err != nil {
		return err
	}
	info, err := r.info(wav)
	if err != nil {
		return err
	}
	duration, err := strconv.ParseFloat(info.Format.Duration, 64)
	if err != nil || math.Abs(duration-.1) > .001 {
		return &mediaFailure{"incompatible", "Неверная длительность синтетического WAV."}
	}
	if _, err = r.ff("-i", wav, "-af", "apad=pad_dur=0.1", "-c:a", "libmp3lame", mp3); err != nil {
		return err
	}
	_, err = r.info(mp3)
	return err
}
