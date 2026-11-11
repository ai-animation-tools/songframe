package main

import (
	"errors"
	"fmt"
	"image"
	"image/png"
	"os"
	"path/filepath"

	xdraw "golang.org/x/image/draw"
)

// iconSizes — размеры значка в теме hicolor. Это каталоги, которые объявляет index.theme
// hicolor в Ubuntu 24.04: каталога 1024x1024 там нет, и значок такого размера тема не находит.
var iconSizes = []int{16, 24, 32, 48, 64, 128, 256, 512}

// iconsCommand — `icons SOURCE NAME SHARE`: квадратный PNG SOURCE уменьшается до iconSizes и
// пишется в SHARE/icons/hicolor/<N>x<N>/apps/NAME.png. Так значок ставят deb (SHARE =
// /usr/share пакета) и AppImage (SHARE = $APPDIR/usr/share). Исходник меньше 512 px отклоняется:
// увеличенный значок был бы размытым.
func iconsCommand(arguments []string) error {
	if len(arguments) != 3 {
		return errors.New("нужны SOURCE NAME SHARE")
	}
	return writeIcons(arguments[0], arguments[1], arguments[2])
}

// writeIcons — сама запись значков iconsCommand (масштаб Catmull-Rom с сохранением прозрачности).
func writeIcons(source, name, share string) error {
	file, err := os.Open(source)
	if err != nil {
		return err
	}
	defer file.Close()
	picture, err := png.Decode(file)
	if err != nil {
		return fmt.Errorf("%s: %w", source, err)
	}
	bounds := picture.Bounds()
	largest := iconSizes[len(iconSizes)-1]
	if bounds.Dx() != bounds.Dy() || bounds.Dx() < largest {
		return fmt.Errorf("%s: нужен квадратный PNG не меньше %d px, получено %d×%d", source, largest, bounds.Dx(), bounds.Dy())
	}
	for _, size := range iconSizes {
		scaled := image.NewNRGBA(image.Rect(0, 0, size, size))
		xdraw.CatmullRom.Scale(scaled, scaled.Bounds(), picture, bounds, xdraw.Src, nil)
		directory := filepath.Join(share, "icons", "hicolor", fmt.Sprintf("%dx%d", size, size), "apps")
		if err := os.MkdirAll(directory, 0o755); err != nil {
			return err
		}
		if err := writePNG(filepath.Join(directory, name+".png"), scaled); err != nil {
			return err
		}
	}
	return nil
}

// writePNG записывает изображение PNG с правами 0644: файлы входят в пакет как есть.
func writePNG(path string, picture image.Image) error {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	if err := png.Encode(file, picture); err != nil {
		file.Close()
		return err
	}
	return file.Close()
}
