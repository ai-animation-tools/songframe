package desktop

import (
	"os"
	"path/filepath"
	"testing"
)

// TestXDGDownloadDir — папка загрузок из user-dirs.dirs: подстановка $HOME, отключённый каталог и
// отсутствие строки.
func TestXDGDownloadDir(t *testing.T) {
	dir := t.TempDir()
	home := filepath.Join(dir, "home")
	write := func(text string) string {
		path := filepath.Join(dir, "user-dirs.dirs")
		if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
		return path
	}
	cases := map[string]string{
		"# комментарий\nXDG_DESKTOP_DIR=\"$HOME/Рабочий стол\"\nXDG_DOWNLOAD_DIR=\"$HOME/Загрузки\"\n": filepath.Join(home, "Загрузки"),
		"XDG_DOWNLOAD_DIR=\"/data/загрузки\"\n": "/data/загрузки",
		"XDG_DOWNLOAD_DIR=\"$HOME/\"\n":         "",
		"XDG_MUSIC_DIR=\"$HOME/Музыка\"\n":      "",
		"XDG_DOWNLOAD_DIR=\"downloads\"\n":      "",
	}
	for text, want := range cases {
		if got := xdgDownloadDir(write(text), home); got != want {
			t.Errorf("%q: %q, нужно %q", text, got, want)
		}
	}
	if got := xdgDownloadDir(filepath.Join(dir, "нет"), home); got != "" {
		t.Errorf("нет файла: %q", got)
	}
}
