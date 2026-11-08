package contactsheet

import (
	"bytes"
	"context"
	"image"
	"image/color"
	"image/png"
	"math"
	"os"
	"strconv"
	"strings"

	"songframe/internal/animaticcards"
	"songframe/internal/toolrt"
)

// Макет сводки: 12 кадров сеткой в 4 столбца, ячейка 480×270 и полоса подписи 26 px; сравнение
// с опорой — по высоте 540 px; цвета и кегль 16 — те же, что у карточек аниматика.
const (
	samples       = 12
	columns       = 4
	cellWidth     = 480
	cellHeight    = 270
	labelBand     = 26
	compareHeight = 540
	labelSize     = 16
	background    = "#171E24"
	labelColor    = "#EDF0F2"
	captionColor  = "#E8B975"
)

// report — результат summarize: поля отчёта и словарь files в порядке вывода, зафиксированном эталоном.
type report struct {
	video, outputDir string
	media            media
	sampled          []int64
	files            *toolrt.Dict
}

// dict — словарь отчёта для --json.
func (r report) dict() *toolrt.Dict {
	sampled := make([]any, len(r.sampled))
	for index, value := range r.sampled {
		sampled[index] = toolrt.NewInt(value)
	}
	result := toolrt.NewDict()
	result.Set("video", r.video)
	result.Set("output_dir", r.outputDir)
	result.Set("media", r.media.dict())
	result.Set("sampled_frames", sampled)
	result.Set("files", r.files)
	result.Set("note", textNote)
	return result
}

// table — Markdown-таблица параметров отчёта и строка статуса.
func (r report) table() string {
	m := r.media
	audio := "нет"
	if m.audio != 0 {
		audio = strconv.Itoa(m.audio) + " поток(а), в монтаже не используется"
	}
	size, _ := m.bytes.Float()
	names := []string{}
	for _, key := range r.files.Keys() {
		switch item := r.files.Value(key).(type) {
		case string:
			names = append(names, item)
		case []any:
			parts := make([]string, len(item))
			for index, part := range item {
				parts[index] = part.(string)
			}
			names = append(names, strings.Join(parts, ", "))
		}
	}
	lines := []string{
		"| Параметр | Значение |",
		"| --- | --- |",
		"| Файл | " + r.video + " |",
		"| Кадр | " + m.width.String() + "×" + m.height.String() + ", " + toolrt.Str(m.codec) + ", " + toolrt.Str(m.pixFmt) + " |",
		"| Частота | " + toolrt.Str(m.rFrameRate) + " (" + toolrt.FormatFixed(m.fps, 3) + " кадр/с) |",
		"| Длительность | " + toolrt.FormatFixed(m.duration, 3) + " с, " + m.frames.String() + " кадров |",
		"| Звук | " + audio + " |",
		"| Размер | " + toolrt.FormatFixed(size/1e6, 1) + " МБ |",
		"| Сводка | " + r.outputDir + ": " + strings.Join(names, ", ") + " |",
	}
	return strings.Join(lines, "\n") + "\n\n" + textStatus
}

// summarize создаёт папку out, лист, граничные кадры,
// сравнения с опорами first/last и превью. Временные кадры — во временной папке «contact-*»,
// которая удаляется и при ошибке; уже записанные файлы сводки при ошибке остаются.
func summarize(ctx context.Context, video, out string, keyframes []keyframe, withPreview bool) (report, error) {
	if err := os.MkdirAll(out, 0o777); err != nil {
		return report{}, toolrt.OSErrorFrom(err, out)
	}
	info, err := probe(ctx, video)
	if err != nil {
		return report{}, err
	}
	if info.frames.Sign() < 1 {
		return report{}, toolrt.New(toolrt.ValueError, textNoFrames)
	}
	total, ok := info.frames.Int64()
	if !ok {
		// Число кадров вне int64 ffprobe не сообщает; такое значение — OverflowError с текстом эталона.
		return report{}, toolrt.New(toolrt.OverflowError, "слишком большое число")
	}
	last := total - 1
	indices := []int64{0}
	if last != 0 {
		indices = nil
		for i := int64(0); i < samples; i++ {
			indices = append(indices, int64(math.RoundToEven(float64(i*last)/float64(samples-1))))
		}
		indices = uniqueSorted(indices)
	}
	temporary, err := os.MkdirTemp("", "contact-")
	if err != nil {
		return report{}, toolrt.OSErrorFrom(err, os.TempDir())
	}
	defer os.RemoveAll(temporary)
	small := toolrt.JoinPath(temporary, "small")
	if err := os.Mkdir(small, 0o777); err != nil {
		return report{}, toolrt.OSErrorFrom(err, small)
	}
	smallFrames, err := extract(ctx, video, indices, small, true)
	if err != nil {
		return report{}, err
	}
	cells := make([]string, len(indices))
	for position, index := range indices {
		if cells[position], err = frame(smallFrames, index); err != nil {
			return report{}, err
		}
	}
	if err := sheet(indices, cells, info.fps, toolrt.JoinPath(out, "contact-sheet.png")); err != nil {
		return report{}, err
	}
	full := toolrt.JoinPath(temporary, "full")
	if err := os.Mkdir(full, 0o777); err != nil {
		return report{}, toolrt.OSErrorFrom(err, full)
	}
	fullFrames, err := extract(ctx, video, []int64{0, last}, full, false)
	if err != nil {
		return report{}, err
	}
	for _, edge := range []struct {
		index int64
		name  string
	}{{0, "first-frame.png"}, {last, "last-frame.png"}} {
		source, err := frame(fullFrames, edge.index)
		if err != nil {
			return report{}, err
		}
		if err := resave(source, toolrt.JoinPath(out, edge.name)); err != nil {
			return report{}, err
		}
	}
	files := toolrt.NewDict()
	files.Set("contact_sheet", "contact-sheet.png")
	files.Set("first_frame", "first-frame.png")
	files.Set("last_frame", "last-frame.png")
	comparisons := []any{}
	for _, item := range keyframes {
		role := item.record.Value("role")
		if !toolrt.Equal(role, "first") && !toolrt.Equal(role, "last") || !toolrt.IsFile(item.file) {
			continue
		}
		name := "compare-" + role.(string) + ".png"
		id, _ := toolrt.DictGet(item.record, "id", role)
		actual := "last-frame.png"
		if role == "first" {
			actual = "first-frame.png"
		}
		caption := toolrt.Str(id) + " (" + role.(string) + ")"
		if err := compare(item.file, toolrt.JoinPath(out, actual), caption, toolrt.JoinPath(out, name)); err != nil {
			return report{}, err
		}
		comparisons = append(comparisons, name)
	}
	if len(comparisons) > 0 {
		files.Set("comparisons", comparisons)
	}
	if withPreview {
		if err := preview(ctx, video, toolrt.JoinPath(out, "preview-2x.mp4")); err != nil {
			return report{}, err
		}
		files.Set("preview_2x", "preview-2x.mp4")
	}
	return report{video: video, outputDir: out, media: info, sampled: indices, files: files}, nil
}

// floorDiv — целочисленное деление с округлением к минус бесконечности.
func floorDiv(a, b int) int {
	quotient := a / b
	if (a%b != 0) && ((a < 0) != (b < 0)) {
		quotient--
	}
	return quotient
}

// thumbnailSize — размер изображения, вписанного в рамку box: пропорции сохраняются, из двух
// округлений (вниз и вверх) выбирается более близкое по отношению сторон, без увеличения;
// ok=false — изображение уже в рамке.
func thumbnailSize(width, height, boxW, boxH int) (int, int, bool) {
	if boxW >= width && boxH >= height {
		return width, height, false
	}
	aspect := float64(width) / float64(height)
	roundAspect := func(value float64, key func(n float64) float64) int {
		floor, ceil := math.Floor(value), math.Ceil(value)
		chosen := floor
		if key(ceil) < key(floor) {
			chosen = ceil
		}
		return max(int(chosen), 1)
	}
	x, y := boxW, boxH
	if float64(x)/float64(y) >= aspect {
		x = roundAspect(float64(y)*aspect, func(n float64) float64 { return math.Abs(aspect - n/float64(y)) })
	} else {
		y = roundAspect(float64(x)/aspect, func(n float64) float64 {
			if n == 0 {
				return 0
			}
			return math.Abs(aspect - float64(x)/n)
		})
	}
	return x, y, x != width || y != height
}

// sheet — лист кадров: холст 4 столбца × ceil(n/4) строк, кадр в ячейке по центру
// по горизонтали и прижат к верху, под ним подпись «кадр N · T с». Кадры FFmpeg уже вписаны в
// ячейку (force_original_aspect_ratio=decrease), поэтому thumbnailSize их не меняет; ветка
// уменьшения — бикубическая без предварительного грубого уменьшения (недостижима с кадрами FFmpeg).
func sheet(indices []int64, paths []string, fps float64, target string) error {
	rows := (len(paths) + columns - 1) / columns
	canvas := animaticcards.NewPicture(columns*cellWidth, rows*(cellHeight+labelBand), background)
	for position, path := range paths {
		picture, err := animaticcards.OpenPicture(path)
		if err != nil {
			return err
		}
		width, height := picture.Size()
		if w, h, resize := thumbnailSize(width, height, cellWidth, cellHeight); resize {
			if picture, err = picture.Resize(w, h, animaticcards.Bicubic); err != nil {
				return err
			}
			width = w
		}
		column, row := position%columns, position/columns
		x := column*cellWidth + floorDiv(cellWidth-width, 2)
		y := row * (cellHeight + labelBand)
		canvas.Paste(picture, x, y)
		seconds := 0.0
		if fps != 0 {
			seconds = float64(indices[position]) / fps
		}
		label := "кадр " + strconv.FormatInt(indices[position], 10) + " · " + toolrt.FormatFixed(seconds, 2) + " с"
		if err := canvas.DrawText(column*cellWidth+6, y+cellHeight+4, label, labelSize, labelColor); err != nil {
			return err
		}
	}
	return savePicture(canvas, target)
}

// compare — картинка сравнения: опора слева, фактический кадр справа,
// обе высотой 540 (бикубическое масштабирование, ширина округляется половиной к чётному), поля 10 px
// и подписи сверху.
func compare(keyframePath, actualPath, caption, target string) error {
	left, err := animaticcards.OpenPicture(keyframePath)
	if err != nil {
		return err
	}
	right, err := animaticcards.OpenPicture(actualPath)
	if err != nil {
		return err
	}
	scaled := func(picture animaticcards.Picture) (animaticcards.Picture, error) {
		width, height := picture.Size()
		return picture.Resize(int(math.RoundToEven(float64(width*compareHeight)/float64(height))), compareHeight, animaticcards.Bicubic)
	}
	if left, err = scaled(left); err != nil {
		return err
	}
	if right, err = scaled(right); err != nil {
		return err
	}
	leftWidth, _ := left.Size()
	rightWidth, _ := right.Size()
	canvas := animaticcards.NewPicture(leftWidth+rightWidth+30, compareHeight+40, background)
	canvas.Paste(left, 10, 30)
	canvas.Paste(right, leftWidth+20, 30)
	if err := canvas.DrawText(10, 6, caption+": опора", labelSize, captionColor); err != nil {
		return err
	}
	if err := canvas.DrawText(leftWidth+20, 6, caption+": фактический кадр", labelSize, captionColor); err != nil {
		return err
	}
	return savePicture(canvas, target)
}

// savePicture — запись картинки в target в формате PNG.
func savePicture(picture animaticcards.Picture, target string) error {
	data, err := picture.PNG()
	if err != nil {
		return err
	}
	return writeFile(target, data)
}

// resave — перезапись кадра FFmpeg в target: те же пиксели без служебных фрагментов PNG FFmpeg
// (gAMA, cHRM, pHYs не переносятся, иначе просмотрщик показал бы кадр с другой гаммой, чем лист).
// 16-битный RGB(A) сохраняется как 8-битный (старший байт), остальные режимы — как есть.
func resave(source, target string) error {
	data, err := os.ReadFile(source)
	if err != nil {
		return toolrt.OSErrorFrom(err, source)
	}
	decoded, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		return toolrt.New(toolrt.OSError, err.Error())
	}
	switch decoded.(type) {
	case *image.RGBA64, *image.NRGBA64:
		bounds := decoded.Bounds()
		converted := image.NewNRGBA(bounds)
		for y := bounds.Min.Y; y < bounds.Max.Y; y++ {
			for x := bounds.Min.X; x < bounds.Max.X; x++ {
				c := color.NRGBA64Model.Convert(decoded.At(x, y)).(color.NRGBA64)
				converted.SetNRGBA(x, y, color.NRGBA{R: uint8(c.R >> 8), G: uint8(c.G >> 8), B: uint8(c.B >> 8), A: uint8(c.A >> 8)})
			}
		}
		decoded = converted
	}
	var buffer bytes.Buffer
	if err := png.Encode(&buffer, decoded); err != nil {
		return toolrt.New(toolrt.OSError, err.Error())
	}
	return writeFile(target, buffer.Bytes())
}
