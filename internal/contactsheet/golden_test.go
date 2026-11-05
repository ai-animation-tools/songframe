package contactsheet

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"image"
	_ "image/png"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"

	"songframe-go/internal/golden"
	"songframe-go/internal/mediacmd"
)

// Эталон contact-sheet снят с CLI tools/contact_sheet оригинала (Python + Pillow 10.2) на
// синтетических проектах: входы воспроизводятся тем же FFmpeg из описания случая. Сверяются код,
// stdout (отчёт и таблица побайтно), stderr (у трассировки — заголовок и последняя строка), состав
// файлов проекта, размеры и средние цвета сетки 4×4 каждого PNG, поля ffprobe превью, неизменность
// входов и пустой TMPDIR. Граничные кадры совпадают по пикселям точно (их декодирует FFmpeg); лист и
// сравнения — с допуском: буквы подписей сглаживает другой растеризатор, JPEG опоры — другой декодер.

type sheetInput struct {
	Path   string   `json:"path"`
	FFmpeg []string `json:"ffmpeg"`
	Text   *string  `json:"text"`
	Hex    string   `json:"hex"`
	Dir    bool     `json:"dir"`
}

type sheetProduced struct {
	Width     int          `json:"width"`
	Height    int          `json:"height"`
	Grid      [][3]float64 `json:"grid"`
	Codec     string       `json:"codec"`
	NBFrames  *string      `json:"nb_frames"`
	FrameRate string       `json:"r_frame_rate"`
	Audio     int          `json:"audio"`
}

type sheetCase struct {
	Name        string            `json:"name"`
	Description string            `json:"description"`
	Inputs      []sheetInput      `json:"inputs"`
	FakeProbe   *string           `json:"fakeProbe"`
	Args        []string          `json:"args"`
	InputSHA256 map[string]string `json:"inputSha256"`
	Expected    struct {
		Code            int                      `json:"code"`
		Stdout          string                   `json:"stdout"`
		Stderr          string                   `json:"stderr"`
		Files           []string                 `json:"files"`
		Produced        map[string]sheetProduced `json:"produced"`
		InputsUnchanged bool                     `json:"inputsUnchanged"`
		TempLeft        []string                 `json:"tempLeft"`
	} `json:"expected"`
}

type sheetGolden struct {
	FFmpegVersion string      `json:"ffmpegVersion"`
	Cases         []sheetCase `json:"cases"`
}

// mediaPrograms — FFmpeg и ffprobe из PATH; без них медиатест пропускается.
func mediaPrograms(t *testing.T) string {
	t.Helper()
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("FFmpeg не найден в PATH")
	}
	if _, err := exec.LookPath("ffprobe"); err != nil {
		t.Skip("ffprobe не найден в PATH")
	}
	return ffmpeg
}

func digest(t *testing.T, path string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// projectFiles — файлы проекта относительно корня через «/», по алфавиту (как rglob съёмки).
func projectFiles(t *testing.T, root string) []string {
	files := []string{}
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !entry.IsDir() {
			relative, _ := filepath.Rel(root, path)
			files = append(files, filepath.ToSlash(relative))
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	sort.Strings(files)
	return files
}

// pictureGrid — размеры и средний RGB 16 ячеек, как grid съёмки (Pillow convert("RGB")).
func pictureGrid(t *testing.T, path string) (int, int, [][3]float64) {
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

// videoFields — поля ffprobe превью, как video_fields съёмки.
func videoFields(t *testing.T, path string) sheetProduced {
	output, err := exec.Command("ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", path).Output()
	if err != nil {
		t.Fatal(err)
	}
	var info struct {
		Streams []struct {
			CodecType string  `json:"codec_type"`
			CodecName string  `json:"codec_name"`
			Width     int     `json:"width"`
			Height    int     `json:"height"`
			NBFrames  *string `json:"nb_frames"`
			FrameRate string  `json:"r_frame_rate"`
		} `json:"streams"`
	}
	if err := json.Unmarshal(output, &info); err != nil {
		t.Fatal(err)
	}
	result := sheetProduced{}
	found := false
	for _, stream := range info.Streams {
		if stream.CodecType == "audio" {
			result.Audio++
		}
		if stream.CodecType == "video" && !found {
			found = true
			result.Width, result.Height, result.Codec, result.NBFrames, result.FrameRate =
				stream.Width, stream.Height, stream.CodecName, stream.NBFrames, stream.FrameRate
		}
	}
	return result
}

var (
	address   = regexp.MustCompile(`@ 0x[0-9a-f]+`)
	byteCount = regexp.MustCompile(`"bytes": \d+|\| Размер \| [^|]* \|`)
)

func TestRunGolden(t *testing.T) {
	ffmpeg := mediaPrograms(t)
	var document sheetGolden
	if err := json.Unmarshal(golden.ReadFile(t, "contact-sheet", "cases.json"), &document); err != nil {
		t.Fatal(err)
	}
	version, err := exec.Command(ffmpeg, "-version").Output()
	if err != nil {
		t.Fatal(err)
	}
	sameFFmpeg := strings.SplitN(string(version), "\n", 2)[0] == document.FFmpegVersion
	for _, item := range document.Cases {
		t.Run(item.Name, func(t *testing.T) {
			work, err := filepath.EvalSymlinks(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			root := filepath.Join(work, "project")
			temporary := filepath.Join(work, "tmp")
			for _, dir := range []string{root, temporary} {
				if err := os.MkdirAll(dir, 0o755); err != nil {
					t.Fatal(err)
				}
			}
			for _, spec := range item.Inputs {
				path := filepath.Join(root, filepath.FromSlash(spec.Path))
				if spec.Dir {
					if err := os.MkdirAll(path, 0o755); err != nil {
						t.Fatal(err)
					}
					continue
				}
				if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
					t.Fatal(err)
				}
				switch {
				case spec.FFmpeg != nil:
					command := exec.Command(ffmpeg, append(append([]string{"-v", "error", "-nostdin", "-y"}, spec.FFmpeg...), "-fflags", "+bitexact", path)...)
					if output, err := command.CombinedOutput(); err != nil {
						t.Fatalf("вход %s: %v %s", spec.Path, err, output)
					}
				case spec.Text != nil:
					if err := os.WriteFile(path, []byte(*spec.Text), 0o644); err != nil {
						t.Fatal(err)
					}
				default:
					data, _ := hex.DecodeString(spec.Hex)
					if err := os.WriteFile(path, data, 0o644); err != nil {
						t.Fatal(err)
					}
				}
			}
			for name, want := range item.InputSHA256 {
				if spec := filepath.Join(root, filepath.FromSlash(name)); sameFFmpeg && digest(t, spec) != want {
					t.Fatalf("вход %s не совпал побайтно со съёмкой", name)
				}
			}
			if item.FakeProbe != nil {
				fake := filepath.Join(work, "fake")
				if err := os.Mkdir(fake, 0o755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(fake, "probe.json"), []byte(*item.FakeProbe), 0o644); err != nil {
					t.Fatal(err)
				}
				script := filepath.Join(fake, "ffprobe")
				if err := os.WriteFile(script, []byte("#!/bin/sh\ncat \"$(dirname \"$0\")/probe.json\"\n"), 0o755); err != nil {
					t.Fatal(err)
				}
				previous := mediacmd.Programs
				mediacmd.Programs = func() (string, string) { return "", script }
				t.Cleanup(func() { mediacmd.Programs = previous })
			}
			t.Setenv("TMPDIR", temporary)
			t.Chdir(root)
			args := make([]string, len(item.Args))
			for index, arg := range item.Args {
				args[index] = strings.ReplaceAll(arg, "<root>", root)
			}
			output := Run(context.Background(), root, args)
			normal := func(text string) string {
				return address.ReplaceAllString(strings.ReplaceAll(text, root, "<root>"), "@ <addr>")
			}
			expected := item.Expected
			if output.Code != expected.Code {
				t.Errorf("код %d, ожидался %d; stderr %q", output.Code, expected.Code, output.Stderr)
			}
			stdout, wantStdout := normal(output.Stdout), expected.Stdout
			if !sameFFmpeg {
				stdout, wantStdout = byteCount.ReplaceAllString(stdout, "<bytes>"), byteCount.ReplaceAllString(wantStdout, "<bytes>")
			}
			if stdout != wantStdout {
				t.Errorf("stdout\n got %s\nwant %s", stdout, wantStdout)
			}
			stderr, wantStderr := normal(output.Stderr), expected.Stderr
			if strings.HasPrefix(wantStderr, "Traceback (most recent call last):\n") {
				lines := strings.Split(strings.TrimSuffix(wantStderr, "\n"), "\n")
				wantStderr = lines[0] + "\n" + lines[len(lines)-1] + "\n"
			}
			if !sameFFmpeg && strings.HasPrefix(wantStderr, textMediaFailed) {
				stderr, wantStderr = stderr[:min(len(stderr), len(textMediaFailed))], textMediaFailed
			}
			if stderr != wantStderr {
				t.Errorf("stderr\n got %q\nwant %q", stderr, wantStderr)
			}
			if got := projectFiles(t, root); strings.Join(got, "\n") != strings.Join(expected.Files, "\n") {
				t.Errorf("файлы проекта\n got %v\nwant %v", got, expected.Files)
			}
			for name, want := range expected.Produced {
				path := filepath.Join(root, filepath.FromSlash(name))
				if strings.HasSuffix(name, ".mp4") {
					got := videoFields(t, path)
					if got.Width != want.Width || (sameFFmpeg && (got.Height != want.Height || got.Codec != want.Codec ||
						got.FrameRate != want.FrameRate || got.Audio != want.Audio || (got.NBFrames == nil) != (want.NBFrames == nil) ||
						(got.NBFrames != nil && *got.NBFrames != *want.NBFrames))) {
						t.Errorf("%s: превью %+v, ожидалось %+v", name, got, want)
					}
					continue
				}
				w, h, grid := pictureGrid(t, path)
				if w != want.Width || h != want.Height {
					t.Errorf("%s: размер %d×%d, ожидался %d×%d", name, w, h, want.Width, want.Height)
					continue
				}
				// Граничные кадры — пиксели FFmpeg без перерисовки; лист и сравнения — с подписями
				// другого растеризатора и опорами JPEG другого декодера.
				tolerance := 0.5
				if strings.HasSuffix(name, "-frame.png") {
					tolerance = 0
				}
				for index := range grid {
					for channel := 0; channel < 3; channel++ {
						if diff := math.Abs(grid[index][channel] - want.Grid[index][channel]); diff > tolerance+0.001 {
							t.Errorf("%s: ячейка %d канал %d: %.3f, ожидалось %.3f", name, index, channel, grid[index][channel], want.Grid[index][channel])
						}
					}
				}
			}
			for name, want := range item.InputSHA256 {
				if sameFFmpeg && expected.InputsUnchanged && digest(t, filepath.Join(root, filepath.FromSlash(name))) != want {
					t.Errorf("вход %s изменён", name)
				}
			}
			left, _ := os.ReadDir(temporary)
			if len(left) != len(expected.TempLeft) {
				t.Errorf("во временной папке осталось %d записей, ожидалось %d", len(left), len(expected.TempLeft))
			}
		})
	}
}
