package tools_test

import (
	"os"
	"path/filepath"
	"testing"

	"songframe/internal/golden"
	"songframe/internal/tools"
)

// TestCheckAssetsLFSPointer — клип склонирован без git lfs pull: вместо видео комплекта лежит
// указатель Git LFS. «Комплекты планов» называют файл и команду загрузки, а не «изменился файл
// комплекта». Вход — образец эталона check-assets/file-changed с подменой того же файла.
func TestCheckAssetsLFSPointer(t *testing.T) {
	var root string
	for _, c := range golden.Load(t, "check-assets") {
		if c.Name == "file-changed" {
			root = c.BuildProject(t)
		}
	}
	if root == "" {
		t.Fatal("нет случая check-assets/file-changed")
	}
	pointer := "version https://git-lfs.github.com/spec/v1\noid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393\nsize 12345\n"
	if err := os.WriteFile(filepath.Join(root, "assets", "shots", "M02", "video.mp4"), []byte(pointer), 0o644); err != nil {
		t.Fatal(err)
	}
	result, err := tools.Run(root, "check_assets", nil)
	if err != nil {
		t.Fatal(err)
	}
	want := "Ошибка: Файл assets/shots/M02/video.mp4 — указатель Git LFS, а не само содержимое. Выполните в папке проекта git lfs pull.\n"
	if result.Code == nil || *result.Code != 1 || result.Stderr != want {
		t.Fatalf("код %v, stderr %q", result.Code, result.Stderr)
	}
}
