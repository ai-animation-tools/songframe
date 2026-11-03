package store

import (
	"os"
	"path/filepath"
	"testing"
)

func TestProfileUsesSeparateApplicationDirectory(t *testing.T) {
	base := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", base)
	t.Setenv("APPDATA", base)
	old := filepath.Join(base, "electron-profile")
	t.Setenv("SONGFRAME_LOCAL_DIR", old)
	path, err := NewProfile("").Path()
	if err != nil {
		t.Fatal(err)
	}
	config, err := os.UserConfigDir()
	if err != nil {
		t.Fatal(err)
	}
	expected := filepath.Join(config, ProfileName)
	if path != expected {
		t.Fatalf("профиль не изолирован: %q", path)
	}
	if _, err := os.Stat(old); !os.IsNotExist(err) {
		t.Fatalf("старый профиль затронут: %v", err)
	}
}

func TestProfileOverrideAndFailure(t *testing.T) {
	dir := t.TempDir()
	chosen := filepath.Join(dir, "Профиль с пробелами")
	got, err := NewProfile(chosen).Directory()
	if err != nil || got != chosen {
		t.Fatalf("явный путь: %q, %v", got, err)
	}
	occupied := filepath.Join(dir, "file")
	if err := os.WriteFile(occupied, []byte("сохранить"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := NewProfile(occupied).Directory(); err == nil {
		t.Fatal("файл принят за каталог")
	}
	raw, err := os.ReadFile(occupied)
	if err != nil || string(raw) != "сохранить" {
		t.Fatal("файл профиля повреждён")
	}
}
