package shoteffects

import (
	"bytes"
	"context"
	"encoding/base64"
	"fmt"
	"image"
	"image/jpeg"
	"os"
	"path/filepath"

	"songframe/internal/dynvalue"
	"songframe/internal/effects"
)

// Shot — план сценария с принятым комплектом для страницы эффектов: его эффект (State), строка
// песни (поле original сценария — подпись плана в списке) и время в песне, есть ли у плана направление камеры (без него ветер дождя не применить) и
// почему эффект недоступен (Problem: повреждённый комплект; тогда State содержит только Shot).
// Heading — направление камеры первого кадра (градусы против часовой от востока, как ветер),
// осмысленно при Camera: по нему страница рисует ветер относительно взгляда камеры.
type Shot struct {
	State
	Title   string  `json:"title"`
	Start   float64 `json:"start"`
	End     float64 `json:"end"`
	Camera  bool    `json:"camera"`
	Heading float64 `json:"heading"`
	Problem string  `json:"problem"`
}

// List — принятые планы в порядке сценария с их эффектами. Только чтение.
func List(root string) ([]Shot, error) {
	registry, found := dynvalue.ReadJSONFile(filepath.Join(root, "plan", "scenes.json"))
	if !found {
		return nil, fmt.Errorf("не прочитать plan/scenes.json")
	}
	fps := 0.0
	if value, ok := dynvalue.Get(registry, "fps").(float64); ok && value > 0 {
		fps = value
	}
	scenes, _ := dynvalue.AsArray(dynvalue.Get(registry, "scenes"))
	result := []Shot{}
	for _, scene := range scenes {
		id, ok := dynvalue.Get(scene, "id").(string)
		if !ok || checkShot(id) != nil {
			continue
		}
		if _, err := os.Stat(filepath.Join(root, "assets", "shots", id, "manifest.json")); err != nil {
			continue
		}
		// Подпись — строка песни; у сцены без неё подписи нет, а не текст "undefined".
		title, _ := dynvalue.Get(scene, "original").(string)
		shot := Shot{Title: title}
		if fps > 0 {
			start, _ := dynvalue.Get(scene, "start_frame").(float64)
			end, _ := dynvalue.Get(scene, "end_frame_exclusive").(float64)
			shot.Start, shot.End = start/fps, end/fps
		}
		state, err := Read(root, id)
		if err != nil {
			shot.State = State{Shot: id, Steps: []AppliedStep{}}
			shot.Problem = err.Error()
		} else {
			shot.State = state
		}
		shot.Heading, _, shot.Camera, _ = cameraAngles(root, id)
		result = append(result, shot)
	}
	return result, nil
}

// still — источник из одного кадра: превью эффекта на кадре t ролика.
type still struct {
	frame *effects.Frame
	size  effects.Size
}

func (s still) Size() effects.Size       { return s.size }
func (s still) Frame(int) *effects.Frame { return s.frame.Clone() }

var _ effects.Source = still{}

// Preview — кадр t принятого видео плана с цепочкой steps в JPEG шириной width (data: URL для
// страницы): параметры подбираются на глаз без рендера ролика. Пустая цепочка — тот же кадр без
// эффекта. Эффект считается в полном кадре
// 1920×1080 — размеры капель и света те же, что в ролике, — и уменьшается только для показа.
func Preview(ctx context.Context, root, shot string, steps []Step, t, width int) (string, error) {
	current, err := readKit(root, shot)
	if err != nil {
		return "", err
	}
	if t < 0 || t >= current.frames {
		return "", fmt.Errorf("кадр %d вне плана (кадров %d)", t, current.frames)
	}
	// Пустая цепочка — кадр «до»: принятое видео без эффекта для сравнения.
	applied := []AppliedStep{}
	if len(steps) > 0 {
		if applied, err = Apply(root, shot, steps); err != nil {
			return "", err
		}
	}
	chainSteps := make([]effects.Step, 0, len(applied))
	for _, step := range applied {
		chainSteps = append(chainSteps, effects.Step{ID: step.Effect, Params: step.Params})
	}
	size := effects.Size{Width: Width, Height: Height, Frames: current.frames}
	chain, err := effects.Build(chainSteps, size)
	if err != nil {
		return "", err
	}
	frame, err := effects.DecodeFrame(ctx, filepath.Join(root, filepath.FromSlash(current.video.Path)), size, t)
	if err != nil {
		return "", err
	}
	result := effects.RenderFrame(still{frame: frame, size: size}, chain, current.fps, t)
	return jpegURL(result, width)
}

// jpegURL — кадр в JPEG шириной width (не больше исходной) как data: URL. Полный размер — для
// просмотра на весь экран: он сжимается бережнее, иначе JPEG сглаживает зерно.
func jpegURL(frame *effects.Frame, width int) (string, error) {
	buffer := make([]byte, frame.Width*frame.Height*3)
	frame.RGB24(buffer)
	if width <= 0 || width > frame.Width {
		width = frame.Width
	}
	height := frame.Height * width / frame.Width
	picture := image.NewRGBA(image.Rect(0, 0, width, height))
	// Уменьшение усреднением блока исходных пикселей: тонкие капли не пропадают, как при выборке.
	for y := 0; y < height; y++ {
		y0, y1 := y*frame.Height/height, max((y+1)*frame.Height/height, y*frame.Height/height+1)
		for x := 0; x < width; x++ {
			x0, x1 := x*frame.Width/width, max((x+1)*frame.Width/width, x*frame.Width/width+1)
			var sum [3]int
			for sy := y0; sy < y1; sy++ {
				row := buffer[(sy*frame.Width)*3:]
				for sx := x0; sx < x1; sx++ {
					sum[0] += int(row[sx*3])
					sum[1] += int(row[sx*3+1])
					sum[2] += int(row[sx*3+2])
				}
			}
			count := (y1 - y0) * (x1 - x0)
			offset := picture.PixOffset(x, y)
			picture.Pix[offset] = uint8(sum[0] / count)
			picture.Pix[offset+1] = uint8(sum[1] / count)
			picture.Pix[offset+2] = uint8(sum[2] / count)
			picture.Pix[offset+3] = 255
		}
	}
	quality := 88
	if width == frame.Width {
		quality = 96
	}
	var data bytes.Buffer
	if err := jpeg.Encode(&data, picture, &jpeg.Options{Quality: quality}); err != nil {
		return "", err
	}
	return "data:image/jpeg;base64," + base64.StdEncoding.EncodeToString(data.Bytes()), nil
}
