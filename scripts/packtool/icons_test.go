package main

import (
	"fmt"
	"image"
	"image/png"
	"os"
	"path/filepath"
	"testing"
)

// TestWriteIcons — значок приложения раскладывается по объявленным размерам hicolor, а
// неподходящий исходник отклоняется без записи.
func TestWriteIcons(t *testing.T) {
	share := t.TempDir()
	if err := writeIcons(filepath.Join("..", "..", "resources", "icon.png"), "songframe", share); err != nil {
		t.Fatal(err)
	}
	for _, size := range iconSizes {
		path := filepath.Join(share, "icons", "hicolor", fmt.Sprintf("%dx%d", size, size), "apps", "songframe.png")
		file, err := os.Open(path)
		if err != nil {
			t.Fatal(err)
		}
		config, err := png.DecodeConfig(file)
		file.Close()
		if err != nil || config.Width != size || config.Height != size {
			t.Fatalf("%s: %v %dx%d", path, err, config.Width, config.Height)
		}
	}

	small := filepath.Join(t.TempDir(), "small.png")
	if err := writePNG(small, image.NewNRGBA(image.Rect(0, 0, 64, 64))); err != nil {
		t.Fatal(err)
	}
	target := t.TempDir()
	if err := writeIcons(small, "songframe", target); err == nil {
		t.Fatal("маленький исходник принят")
	}
	if entries, _ := os.ReadDir(target); len(entries) != 0 {
		t.Fatalf("отказ записал файлы: %v", entries)
	}
}
