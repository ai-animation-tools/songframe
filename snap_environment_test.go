package main

import (
	"os"
	"testing"
)

// Сохранённые snap значения возвращаются: пустое — переменной не было, непустое — прежнее значение.
func TestSnapOriginals(t *testing.T) {
	got := snapOriginals([]string{
		"GIO_MODULE_DIR=/snap-cache/gio-modules",
		"GIO_MODULE_DIR_VSCODE_SNAP_ORIG=",
		"XDG_DATA_DIRS=/snap/share:/usr/share",
		"XDG_DATA_DIRS_VSCODE_SNAP_ORIG=/usr/local/share:/usr/share",
		"_VSCODE_SNAP_ORIG=ignored",
		"HOME=/home/example",
	})
	want := map[string]string{"GIO_MODULE_DIR": "", "XDG_DATA_DIRS": "/usr/local/share:/usr/share"}
	if len(got) != len(want) {
		t.Fatalf("snapOriginals = %v, want %v", got, want)
	}
	for name, value := range want {
		if got[name] != value {
			t.Fatalf("snapOriginals[%s] = %q, want %q", name, got[name], value)
		}
	}
}

func TestRestoreSnapEnvironment(t *testing.T) {
	t.Setenv("GIO_MODULE_DIR", "/snap-cache/gio-modules")
	t.Setenv("GIO_MODULE_DIR_VSCODE_SNAP_ORIG", "")
	t.Setenv("XDG_DATA_DIRS", "/snap/share:/usr/share")
	t.Setenv("XDG_DATA_DIRS_VSCODE_SNAP_ORIG", "/usr/local/share:/usr/share")
	restoreSnapEnvironment()
	if value, ok := os.LookupEnv("GIO_MODULE_DIR"); ok {
		t.Fatalf("GIO_MODULE_DIR остался: %q", value)
	}
	if value := os.Getenv("XDG_DATA_DIRS"); value != "/usr/local/share:/usr/share" {
		t.Fatalf("XDG_DATA_DIRS = %q", value)
	}
}
