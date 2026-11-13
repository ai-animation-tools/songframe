package production

import (
	"context"
	"strconv"

	"songframe/internal/mediacmd"
	"songframe/internal/toolrt"
)

// ResultMedia — параметры показанного оригинала попытки по ffprobe. Окно приёмки сверяет их с
// окном и кадром плана: «целиком» без перекодирования принимается только ролик 1920×1080 в
// частоте проекта с длиной окна, а видео, сделанное вне приложения (своё видео, ручная
// генерация), обычно другое и сразу получает участок. Нули — величину ffprobe не сообщил.
type ResultMedia struct {
	// Seconds — длительность видеопотока, с.
	Seconds float64 `json:"seconds"`
	Width   int     `json:"width"`
	Height  int     `json:"height"`
	// FrameRate — r_frame_rate видеопотока как есть («30/1», «30000/1001»).
	FrameRate string `json:"frameRate"`
}

// ResultMediaFor читает параметры первого оригинала попытки packageDir. nil без ошибки — у
// попытки нет скачанного оригинала. Ошибка ffprobe (нет компонента, повреждённый файл)
// возвращается: окно приёмки тогда остаётся при оценке по запрошенной длительности.
func ResultMediaFor(ctx context.Context, project, packageDir string) (*ResultMedia, error) {
	view, err := ReadPackage(project, packageDir)
	if err != nil || view == nil || view.Request == nil || len(view.Request.Downloads) == 0 {
		return nil, err
	}
	probed, err := mediacmd.AnimaticProbe(ctx, view.Request.Downloads[0])
	if err != nil || probed == nil {
		return nil, err
	}
	streams, _ := probed.Value("streams").([]any)
	for _, raw := range streams {
		stream, _ := raw.(*toolrt.Dict)
		if stream == nil || !toolrt.Equal(stream.Value("codec_type"), "video") {
			continue
		}
		number := func(key string) float64 {
			value, ok := stream.Get(key)
			if !ok {
				return 0
			}
			parsed, _ := strconv.ParseFloat(toolrt.Str(value), 64)
			return parsed
		}
		rate, _ := stream.Get("r_frame_rate")
		media := &ResultMedia{Seconds: number("duration"), Width: int(number("width")), Height: int(number("height"))}
		if rate != nil {
			media.FrameRate = toolrt.Str(rate)
		}
		return media, nil
	}
	return nil, nil
}
