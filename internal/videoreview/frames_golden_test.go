package videoreview

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"songframe-go/internal/golden"
)

// Эталон video-review-frames построен на синтетических клипах FFmpeg: тот же FFmpeg воспроизводит
// входы побайтно, поэтому сравниваются номера, ID, PTS, длительность, manifest.json, размеры и
// формат каждого изображения. Байты кадров, которые пишет FFmpeg и Extract не переупаковывает,
// совпадают при той же версии FFmpeg. Копии опор и JPEG
// кодируют разные библиотеки: для них сверяются размеры и средние цвета сетки 4×4.

type framesGolden struct {
	FFmpegVersion string       `json:"ffmpegVersion"`
	Cases         []framesCase `json:"cases"`
}

type framesInput struct {
	Name            string   `json:"name"`
	FFmpeg          []string `json:"ffmpeg"`
	Bytes           *string  `json:"bytes"`
	ExifOrientation int      `json:"exifOrientation"`
}

type framesImage struct {
	Name   string       `json:"name"`
	Width  int          `json:"width"`
	Height int          `json:"height"`
	Bytes  int64        `json:"bytes"`
	SHA256 string       `json:"sha256"`
	Grid   [][3]float64 `json:"grid"`
}

type framesCase struct {
	Name          string            `json:"name"`
	Description   string            `json:"description"`
	Inputs        []framesInput     `json:"inputs"`
	References    []string          `json:"references"`
	Budget        *int              `json:"budget"`
	OutExists     bool              `json:"outExists"`
	OutFile       string            `json:"outFile"`
	RelativeVideo bool              `json:"relativeVideo"`
	VideoName     string            `json:"videoName"`
	StderrPrefix  string            `json:"stderrPrefix"`
	InputSHA256   map[string]string `json:"inputSha256"`
	Expected      struct {
		Code            int             `json:"code"`
		Stderr          *string         `json:"stderr"`
		Manifest        json.RawMessage `json:"manifest"`
		ManifestFile    string          `json:"manifestFile"`
		Images          []framesImage   `json:"images"`
		OutEntries      []string        `json:"outEntries"`
		Siblings        []string        `json:"siblings"`
		InputsUnchanged bool            `json:"inputsUnchanged"`
	} `json:"expected"`
}

// mediaTools — FFmpeg/ffprobe из PATH; без них медиатесты пропускаются.
func mediaTools(t *testing.T) Tools {
	t.Helper()
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("FFmpeg не найден в PATH")
	}
	ffprobe, err := exec.LookPath("ffprobe")
	if err != nil {
		t.Skip("ffprobe не найден в PATH")
	}
	return Tools{FFmpeg: ffmpeg, FFprobe: ffprobe}
}

// ffmpegVersion — первая строка `ffmpeg -version`.
func ffmpegVersion(t *testing.T, tools Tools) string {
	output, err := exec.Command(tools.FFmpeg, "-version").Output()
	if err != nil {
		t.Fatal(err)
	}
	return strings.SplitN(string(output), "\n", 2)[0]
}

// injectExif вставляет APP1 с одним тегом Orientation сразу после SOI, как во входах эталона.
func injectExif(t *testing.T, path string, orientation int) {
	data, err := os.ReadFile(path)
	if err != nil || !bytes.HasPrefix(data, []byte{0xff, 0xd8}) {
		t.Fatalf("JPEG для EXIF: %v", err)
	}
	tiff := []byte("MM\x00\x2a\x00\x00\x00\x08")
	tiff = binary.BigEndian.AppendUint16(tiff, 1)
	tiff = binary.BigEndian.AppendUint16(tiff, 0x0112)
	tiff = binary.BigEndian.AppendUint16(tiff, 3)
	tiff = binary.BigEndian.AppendUint32(tiff, 1)
	tiff = binary.BigEndian.AppendUint16(tiff, uint16(orientation))
	tiff = append(tiff, 0, 0, 0, 0, 0, 0)
	payload := append([]byte("Exif\x00\x00"), tiff...)
	segment := binary.BigEndian.AppendUint16([]byte{0xff, 0xe1}, uint16(len(payload)+2))
	segment = append(segment, payload...)
	if err := os.WriteFile(path, append(append(append([]byte{}, data[:2]...), segment...), data[2:]...), 0o644); err != nil {
		t.Fatal(err)
	}
}

func fileSHA(t *testing.T, path string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// imageGrid — размеры и средний RGB 16 ячеек, как поле grid эталона (Pillow convert("RGB")).
func imageGrid(t *testing.T, path string) (int, int, [][3]float64) {
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	decoded, _, err := image.Decode(file)
	if err != nil {
		t.Fatalf("%s: %v", path, err)
	}
	bounds := decoded.Bounds()
	w, h := bounds.Dx(), bounds.Dy()
	cells := [][3]float64{}
	for gy := 0; gy < 4; gy++ {
		for gx := 0; gx < 4; gx++ {
			x0, y0 := gx*w/4, gy*h/4
			x1, y1 := max(x0+1, (gx+1)*w/4), max(y0+1, (gy+1)*h/4)
			var sum [3]float64
			for y := y0; y < y1; y++ {
				for x := x0; x < x1; x++ {
					r, g, b, _ := decoded.At(bounds.Min.X+x, bounds.Min.Y+y).RGBA()
					sum[0] += float64(r >> 8)
					sum[1] += float64(g >> 8)
					sum[2] += float64(b >> 8)
				}
			}
			count := float64((x1 - x0) * (y1 - y0))
			cells = append(cells, [3]float64{sum[0] / count, sum[1] / count, sum[2] / count})
		}
	}
	return w, h, cells
}

func TestExtractGolden(t *testing.T) {
	tools := mediaTools(t)
	var document framesGolden
	if err := json.Unmarshal(golden.ReadFile(t, "video-review-frames", "cases.json"), &document); err != nil {
		t.Fatal(err)
	}
	sameFFmpeg := ffmpegVersion(t, tools) == document.FFmpegVersion
	for _, item := range document.Cases {
		t.Run(item.Name, func(t *testing.T) {
			work := t.TempDir()
			inputs := filepath.Join(work, "inputs")
			if err := os.MkdirAll(inputs, 0o755); err != nil {
				t.Fatal(err)
			}
			for _, spec := range item.Inputs {
				path := filepath.Join(inputs, spec.Name)
				if spec.Bytes != nil {
					if err := os.WriteFile(path, []byte(*spec.Bytes), 0o644); err != nil {
						t.Fatal(err)
					}
				} else {
					command := exec.Command(tools.FFmpeg, append(append([]string{"-v", "error", "-nostdin", "-y"}, spec.FFmpeg...), "-fflags", "+bitexact", path)...)
					if output, err := command.CombinedOutput(); err != nil {
						t.Fatalf("вход %s: %v %s", spec.Name, err, output)
					}
				}
				if spec.ExifOrientation != 0 {
					injectExif(t, path, spec.ExifOrientation)
				}
				if sameFFmpeg && fileSHA(t, path) != item.InputSHA256[spec.Name] {
					t.Fatalf("вход %s не совпал побайтно со съёмкой", spec.Name)
				}
			}
			out := filepath.Join(work, "out", "review")
			if err := os.MkdirAll(filepath.Dir(out), 0o755); err != nil {
				t.Fatal(err)
			}
			if item.OutExists || item.OutFile != "" {
				if err := os.Mkdir(out, 0o755); err != nil {
					t.Fatal(err)
				}
			}
			if item.OutFile != "" {
				if err := os.WriteFile(filepath.Join(out, item.OutFile), []byte("сохранить"), 0o644); err != nil {
					t.Fatal(err)
				}
			}
			videoName := item.VideoName
			if videoName == "" {
				videoName = "video.mkv"
			}
			video := filepath.Join(inputs, videoName)
			if item.RelativeVideo {
				video = "relative.mkv"
			}
			references := []string{}
			for _, name := range item.References {
				references = append(references, filepath.Join(inputs, name))
			}
			budget := DefaultImageBudget
			if item.Budget != nil {
				budget = *item.Budget
			}
			manifest, err := Extract(context.Background(), ExtractInput{Tools: tools, Video: video, Out: out, References: references, BudgetBytes: budget})
			replace := strings.NewReplacer(out, "<out>", inputs, "<inputs>")
			expected := item.Expected
			if expected.Code != 0 {
				if err == nil {
					t.Fatalf("ожидалась ошибка %q", *expected.Stderr)
				}
				want := strings.TrimSpace(*expected.Stderr)
				got := replace.Replace(err.Error())
				if item.StderrPrefix != "" {
					if !strings.HasPrefix(got, item.StderrPrefix) {
						t.Fatalf("ошибка %q, ожидался префикс %q", got, item.StderrPrefix)
					}
				} else if got != want {
					t.Fatalf("ошибка\n got %q\nwant %q", got, want)
				}
			} else {
				if err != nil {
					t.Fatal(err)
				}
				manifestBytes, err := manifestJSON(manifest)
				if err != nil {
					t.Fatal(err)
				}
				if got := replace.Replace(string(manifestBytes)); got != expected.ManifestFile {
					t.Fatalf("отчёт\n got %s\nwant %s", got, expected.ManifestFile)
				}
				file, err := os.ReadFile(filepath.Join(out, "manifest.json"))
				if err != nil || string(file) != string(manifestBytes) {
					t.Fatalf("manifest.json не совпал с отчётом: %v", err)
				}
				for _, want := range expected.Images {
					path := filepath.Join(out, want.Name)
					w, h, grid := imageGrid(t, path)
					if w != want.Width || h != want.Height {
						t.Errorf("%s: размер %d×%d, ожидался %d×%d", want.Name, w, h, want.Width, want.Height)
					}
					exact := sameFFmpeg && strings.HasPrefix(want.Name, "F") && strings.HasSuffix(want.Name, ".png")
					if exact && fileSHA(t, path) != want.SHA256 {
						t.Errorf("%s: байты кадра FFmpeg не совпали", want.Name)
					}
					tolerance := 0.0
					if !exact {
						tolerance = 12
					}
					for index := range grid {
						for channel := 0; channel < 3; channel++ {
							if diff := math.Abs(grid[index][channel] - want.Grid[index][channel]); diff > tolerance+0.001 {
								t.Errorf("%s: ячейка %d канал %d: %.3f, ожидалось %.3f", want.Name, index, channel, grid[index][channel], want.Grid[index][channel])
								break
							}
						}
					}
				}
			}
			var entries []string
			if listed, err := os.ReadDir(out); err == nil {
				for _, entry := range listed {
					entries = append(entries, entry.Name())
				}
				sort.Strings(entries)
			}
			if strings.Join(entries, ",") != strings.Join(expected.OutEntries, ",") {
				t.Errorf("содержимое результата %v, ожидалось %v", entries, expected.OutEntries)
			}
			listed, _ := os.ReadDir(filepath.Dir(out))
			siblings := []string{}
			for _, entry := range listed {
				siblings = append(siblings, entry.Name())
			}
			if strings.Join(siblings, ",") != strings.Join(expected.Siblings, ",") {
				t.Errorf("временная папка осталась: %v", siblings)
			}
			for name, digest := range item.InputSHA256 {
				if sameFFmpeg && fileSHA(t, filepath.Join(inputs, name)) != digest {
					t.Errorf("вход %s изменён", name)
				}
			}
		})
	}
}
