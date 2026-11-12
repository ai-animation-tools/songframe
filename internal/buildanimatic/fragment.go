package buildanimatic

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"songframe/internal/mediacmd"
	"songframe/internal/toolcli"
	"songframe/internal/toolrt"
)

// FragmentFile — путь фрагмента от корня проекта. Фрагмент — рабочий просмотр, а не версия
// аниматика: он лежит в игнорируемом Git кэше, каждая сборка заменяет прежний файл, latest,
// принятие аниматика и комплекты планов не меняются.
const FragmentFile = "plan/animatic/.cache/fragment/fragment.mp4"

// Тексты отказов сборки фрагмента.
const (
	textFragmentRange   = "Укажите первый и последний план фрагмента вместе (--from и --to)."
	textFragmentOnly    = "Фрагмент собирается без --plan-only."
	textFragmentOrder   = "Первый план фрагмента идёт позже последнего."
	textFragmentInvalid = "Фрагмент имеет неверный формат или длину."
)

// textFragmentUnknown — план фрагмента не найден в реестре.
func textFragmentUnknown(id string) string {
	return "План " + id + " не найден в реестре сцен."
}

// fragmentRange — индексы первого и последнего плана фрагмента [from, to] в порядке реестра.
func fragmentRange(shots []*toolrt.Dict, from, to string) (int, int, error) {
	first, last := -1, -1
	for index, shot := range shots {
		id := toolrt.Str(shot.Value("id"))
		if id == from {
			first = index
		}
		if id == to {
			last = index
		}
	}
	if first < 0 {
		return 0, 0, toolrt.New(toolrt.ValueError, textFragmentUnknown(from))
	}
	if last < 0 {
		return 0, 0, toolrt.New(toolrt.ValueError, textFragmentUnknown(to))
	}
	if first > last {
		return 0, 0, toolrt.New(toolrt.ValueError, textFragmentOrder)
	}
	return first, last, nil
}

// frameField — целое поле кадровой сетки плана (start_frame, end_frame_exclusive).
func frameField(shot *toolrt.Dict, key string) (int64, error) {
	value, err := toInt(shot.Value(key))
	if err != nil {
		return 0, err
	}
	frames, fits := value.Int64()
	if !fits {
		return 0, toolrt.Raise(toolrt.TypeError, "%s плана %s вне диапазона", key, toolrt.Repr(shot.Value("id")))
	}
	return frames, nil
}

// BuildFragment собирает просмотр подряд идущих планов from…to под соответствующий участок
// песни: те же входы, что у полной сборки (принятый монтаж или карточка утверждённых опор, с
// проверками preparePlan), те же фрагменты и кэш, звук — вырезка песни от начала первого плана
// до конца последнего. Результат заменяет FragmentFile; генерации, приёмка и latest не
// затрагиваются. out получает строки готовности фрагментов, как у Build. Отчёт — путь, планы,
// окно в секундах и SHA-256 видео (адрес просмотра меняется вместе с содержимым).
func BuildFragment(ctx context.Context, root, from, to string, out func(line string) error) (*toolrt.Dict, error) {
	root = toolrt.ResolvePath(root)
	prepared, err := preparePlan(ctx, root)
	if err != nil {
		return nil, err
	}
	first, last, err := fragmentRange(prepared.shots, from, to)
	if err != nil {
		return nil, err
	}
	shots := prepared.shots[first : last+1]
	startFrame, err := frameField(shots[0], "start_frame")
	if err != nil {
		return nil, err
	}
	endFrame, err := frameField(shots[len(shots)-1], "end_frame_exclusive")
	if err != nil {
		return nil, err
	}
	cache := &artifactCache{directory: toolrt.JoinPath(root, "plan/animatic/.cache")}
	versionOutput, err := run(ctx, mediacmd.FFmpeg(), "-version")
	if err != nil {
		return nil, err
	}
	toolchain, err := toolrt.DecodeUTF8(versionOutput)
	if err != nil {
		return nil, err
	}
	for _, shot := range shots {
		if _, err := segment(ctx, cache, root, shot, toolchain, prepared.fps); err != nil {
			return nil, err
		}
		status := "подготовлена"
		if cache.events[len(cache.events)-1].hit {
			status = "из кэша"
		}
		if err := out(toolrt.Str(shot.Value("id")) + " " + status); err != nil {
			return nil, err
		}
	}
	work, err := os.MkdirTemp(cache.directory, "fragment-")
	if err != nil {
		return nil, toolrt.OSErrorFrom(err, cache.directory)
	}
	defer os.RemoveAll(work)
	listing := toolrt.JoinPath(work, "concat.txt")
	var concat strings.Builder
	for _, part := range parts(cache) {
		concat.WriteString("file '" + strings.ReplaceAll(part, "'", `'\''`) + "'\n")
	}
	if err := writeText(listing, concat.String()); err != nil {
		return nil, err
	}
	// Главы по планам от начала фрагмента: плеер и монтажные программы показывают границы.
	chapters := []string{";FFMETADATA1"}
	for _, shot := range shots {
		start, err := frameField(shot, "start_frame")
		if err != nil {
			return nil, err
		}
		end, err := frameField(shot, "end_frame_exclusive")
		if err != nil {
			return nil, err
		}
		chapters = append(chapters, "[CHAPTER]", "TIMEBASE=1/"+strconv.FormatInt(prepared.fps, 10), "START="+strconv.FormatInt(start-startFrame, 10),
			"END="+strconv.FormatInt(end-startFrame, 10), "title="+toolrt.Str(shot.Value("id")))
	}
	metadata := toolrt.JoinPath(work, "chapters.ffmeta")
	if err := writeText(metadata, strings.Join(chapters, "\n")+"\n"); err != nil {
		return nil, err
	}
	video := toolrt.JoinPath(work, "fragment.mp4")
	total := endFrame - startFrame
	if _, err := run(ctx, mediacmd.FFmpeg(),
		"-v", "error", "-nostdin", "-n", "-f", "concat", "-safe", "0", "-i", listing,
		// Поиск по входу при перекодировании точен до отсчёта: участок песни совпадает с окнами планов.
		"-ss", seconds(startFrame, prepared.fps), "-t", seconds(total, prepared.fps), "-i", toolrt.JoinPath(root, prepared.track), "-i", metadata,
		"-map", "0:v:0", "-map", "1:a:0", "-map_metadata", "2", "-map_chapters", "2",
		"-c:v", "copy", "-c:a", "aac", "-ac", "2", "-ar", "44100", "-threads", "1", "-b:a", "192k",
		"-af", "asetpts=PTS-STARTPTS", "-movflags", "+faststart", video); err != nil {
		return nil, err
	}
	if err := checkFragment(ctx, video, shots, total, prepared.fps); err != nil {
		return nil, err
	}
	target := toolrt.JoinPath(root, FragmentFile)
	if err := os.MkdirAll(filepath.Dir(target), 0o777); err != nil {
		return nil, toolrt.OSErrorFrom(err, target)
	}
	if err := os.Rename(video, target); err != nil {
		return nil, toolrt.OSErrorFrom(err, target)
	}
	digest, err := sha(target)
	if err != nil {
		return nil, err
	}
	return toolcli.Record(
		"status", "passed", "video", FragmentFile, "video_sha256", digest, "from", from, "to", to,
		"shots", toolrt.NewInt(int64(len(shots))), "start", seconds(startFrame, prepared.fps), "end", seconds(endFrame, prepared.fps),
	), nil
}

// checkFragment — проверки готового фрагмента: формат и число кадров окна, глава на план, стерео
// 44,1 кГц и звук на всю длину окна (расхождение не больше одного кадра: вырезка MP3 по
// отсчётам), затем полное декодирование.
func checkFragment(ctx context.Context, video string, shots []*toolrt.Dict, total, fps int64) error {
	info, err := probe(ctx, video)
	if err != nil {
		return err
	}
	v, err := streamOf(info, "video")
	if err != nil {
		return err
	}
	a, err := streamOf(info, "audio")
	if err != nil {
		return err
	}
	ok, err := videoMatches(v, toolrt.NewInt(total), fps)
	if err != nil {
		return err
	}
	if ok {
		chapters, err := item(info, "chapters")
		if err != nil {
			return err
		}
		list, err := toolrt.Iter(chapters)
		if err != nil {
			return err
		}
		ok = len(list) == len(shots)
	}
	if ok {
		channels, err := item(a, "channels")
		if err != nil {
			return err
		}
		rate, err := item(a, "sample_rate")
		if err != nil {
			return err
		}
		duration, err := floatItem(a, "duration")
		if err != nil {
			return err
		}
		step := 1.0 / float64(fps)
		difference := duration - float64(total)*step
		ok = toolrt.Equal(channels, toolrt.NewInt(2)) && toolrt.Equal(rate, "44100") && difference <= step && difference >= -step
	}
	if !ok {
		return toolrt.New(toolrt.ValueError, textFragmentInvalid)
	}
	_, err = run(ctx, mediacmd.FFmpeg(), "-v", "error", "-threads", "2", "-i", video, "-f", "null", "-")
	return err
}
