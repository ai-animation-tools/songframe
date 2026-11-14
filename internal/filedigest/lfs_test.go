package filedigest

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// pointer — указатель Git LFS в том виде, в каком его оставляет клон без git lfs pull.
const pointer = "version https://git-lfs.github.com/spec/v1\noid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393\nsize 12345\n"

// TestIsLFSPointer — указателем считается только небольшой обычный файл, начинающийся строкой
// версии спецификации; медиа, похожие начала, каталоги и отсутствующие файлы — нет.
func TestIsLFSPointer(t *testing.T) {
	dir := t.TempDir()
	write := func(name, text string) string {
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
		return path
	}
	for name, want := range map[string]bool{
		write("pointer.mp4", pointer):                                      true,
		write("crlf.png", strings.ReplaceAll(pointer, "\n", "\r\n")):       true,
		write("bare.wav", "version https://git-lfs.github.com/spec/v1"):    true,
		write("v10.mp3", "version https://git-lfs.github.com/spec/v10\n"):  false,
		write("media.mp4", "\x00\x00\x00\x18ftypmp42"):                     false,
		write("empty.png", ""):                                             false,
		write("large.mp4", pointer+strings.Repeat("x", lfsPointerLimit)):   false,
		write("text.md", "# version https://git-lfs.github.com/spec/v1\n"): false,
		dir:                               false,
		filepath.Join(dir, "missing.mp4"): false,
	} {
		if got := IsLFSPointer(name); got != want {
			t.Errorf("%s: %v, ожидалось %v", filepath.Base(name), got, want)
		}
	}
}

// TestLFSPointerProblem — текст называет путь в форме вызывающего и команду загрузки содержимого.
func TestLFSPointerProblem(t *testing.T) {
	path := filepath.Join(t.TempDir(), "track.mp3")
	if err := os.WriteFile(path, []byte(pointer), 0o644); err != nil {
		t.Fatal(err)
	}
	text, ok := LFSPointerProblem(path, "source/track.mp3")
	if want := "Файл source/track.mp3 — указатель Git LFS, а не само содержимое. Выполните в папке проекта git lfs pull."; !ok || text != want {
		t.Fatalf("%v %q", ok, text)
	}
	if err := os.WriteFile(path, []byte("ID3"), 0o644); err != nil {
		t.Fatal(err)
	}
	if text, ok := LFSPointerProblem(path, "source/track.mp3"); ok || text != "" {
		t.Fatalf("не указатель: %v %q", ok, text)
	}
}
