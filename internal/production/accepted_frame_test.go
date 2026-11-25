package production

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"image/png"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"songframe/internal/filedigest"
	"songframe/internal/mediacmd"
)

// TestTakeAcceptedFrame — кадр по номеру из video.mp4 комплекта в PNG полного размера в папку
// клипа; кадр совпадает с кадром видео, проект не меняется, номер вне видео — ошибка.
func TestTakeAcceptedFrame(t *testing.T) {
	if _, err := exec.LookPath(mediacmd.FFmpeg()); err != nil {
		t.Skip("нет FFmpeg")
	}
	ctx := context.Background()
	project := filepath.Join(t.TempDir(), "Клип у ворот")
	kit := filepath.Join(project, "assets", "shots", "M01")
	if err := os.MkdirAll(kit, 0o755); err != nil {
		t.Fatal(err)
	}
	video := filepath.Join(kit, "video.mp4")
	if result, err := mediacmd.Run(ctx, mediacmd.FFmpeg(), "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
		"testsrc2=size=320x180:rate=30", "-frames:v", "8", "-pix_fmt", "yuv420p", video); err != nil || result.Code != 0 {
		t.Fatalf("видео: %v %s", err, result.Stderr)
	}
	digest, _ := filedigest.File(video)
	manifest, _ := json.Marshal(map[string]any{
		"shot": "M01",
		"accepted_edit": map[string]any{
			"video": map[string]any{"path": "video.mp4", "sha256": digest}, "fps": 30, "frames": 8,
		},
	})
	if err := os.WriteFile(filepath.Join(kit, "manifest.json"), manifest, 0o644); err != nil {
		t.Fatal(err)
	}
	before := treeDigests(t, project)
	folder := filepath.Join(t.TempDir(), "Загрузки")

	frame := func(n int) []byte {
		result, err := mediacmd.Run(ctx, mediacmd.FFmpeg(), "-hide_banner", "-loglevel", "error", "-i", video,
			"-vf", fmt.Sprintf(`select=eq(n\,%d)`, n), "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-")
		if err != nil || result.Code != 0 {
			t.Fatalf("кадр %d: %v %s", n, err, result.Stderr)
		}
		return result.Stdout
	}
	taken, err := TakeAcceptedFrame(ctx, project, "M01", 5, folder)
	if err != nil {
		t.Fatal(err)
	}
	if taken.Folder != filepath.Join(folder, "Клип у ворот") || taken.Path != filepath.Join(taken.Folder, "M01-кадр-0005.png") || taken.Frame != 5 {
		t.Fatalf("кадр: %+v", taken)
	}
	data, err := os.ReadFile(taken.Path)
	if err != nil {
		t.Fatal(err)
	}
	picture, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	if bounds := picture.Bounds(); bounds.Dx() != 320 || bounds.Dy() != 180 {
		t.Fatalf("размер кадра: %v", bounds)
	}
	rgb := make([]byte, 0, 320*180*3)
	for y := 0; y < 180; y++ {
		for x := 0; x < 320; x++ {
			r, g, b, _ := picture.At(x, y).RGBA()
			rgb = append(rgb, byte(r>>8), byte(g>>8), byte(b>>8))
		}
	}
	if !bytes.Equal(rgb, frame(5)) {
		t.Fatal("кадр не совпадает с кадром 5 видео")
	}
	if bytes.Equal(rgb, frame(4)) {
		t.Fatal("соседние кадры видео одинаковы: проверка номера ничего не доказывает")
	}
	entries, _ := os.ReadDir(taken.Folder)
	if len(entries) != 1 {
		t.Fatalf("в папке лишние файлы: %v", entries)
	}
	if after := treeDigests(t, project); fmt.Sprint(after) != fmt.Sprint(before) {
		t.Fatal("проект изменился")
	}
	if _, err := TakeAcceptedFrame(ctx, project, "M01", 8, folder); err == nil {
		t.Fatal("кадр за концом видео взят")
	}
	if _, err := TakeAcceptedFrame(ctx, project, "../M01", 0, folder); err == nil {
		t.Fatal("неверный код плана принят")
	}
}

// treeDigests — SHA-256 файлов папки по относительным путям.
func treeDigests(t *testing.T, root string) map[string]string {
	t.Helper()
	result := map[string]string{}
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return err
		}
		relative, _ := filepath.Rel(root, path)
		result[relative], _ = filedigest.File(path)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return result
}
