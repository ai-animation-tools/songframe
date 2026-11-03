package desktop

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestOpenPathLinuxFolderFallsBackToXdgOpen(t *testing.T) {
	directory := t.TempDir()
	var calls []string
	d := Desktop{Platform: "linux", Run: func(command string, args ...string) error {
		calls = append(calls, command)
		if command == "gdbus" {
			if !strings.HasPrefix(args[len(args)-2], `["file:///`) {
				t.Errorf("URI папки: %q", args[len(args)-2])
			}
			return errors.New("нет FileManager1")
		}
		return nil
	}, Open: func(string) error { t.Fatal("папка Linux не открывается нативно"); return nil }}
	if err := d.OpenPath(directory); err != nil {
		t.Fatal(err)
	}
	if strings.Join(calls, ",") != "gdbus,xdg-open" {
		t.Fatalf("порядок команд: %v", calls)
	}
}

func TestOpenPathErrorsAndFiles(t *testing.T) {
	file := filepath.Join(t.TempDir(), "текст.txt")
	if err := os.WriteFile(file, []byte("строка"), 0o600); err != nil {
		t.Fatal(err)
	}
	opened := ""
	d := Desktop{Platform: "linux", Run: func(string, ...string) error { t.Fatal("файл не идёт через gdbus"); return nil },
		Open: func(path string) error { opened = path; return nil }}
	if err := d.OpenPath(file); err != nil || opened != file {
		t.Fatalf("файл: %v %q", err, opened)
	}
	if err := d.OpenPath(file + "-нет"); err == nil || !strings.Contains(err.Error(), "не найдены") {
		t.Fatalf("отсутствующий путь: %v", err)
	}
	d.Open = func(string) error { return errors.New("нет приложения") }
	if err := d.OpenPath(file); err == nil || err.Error() != "Не удалось открыть «"+file+"»: нет приложения" {
		t.Fatalf("ошибка открытия: %v", err)
	}
	if text, err := ReadText(file); err != nil || text != "строка" {
		t.Fatalf("ReadText: %q %v", text, err)
	}
	big := filepath.Join(t.TempDir(), "big.txt")
	if err := os.WriteFile(big, make([]byte, TextLimit+1), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadText(big); err == nil || !strings.Contains(err.Error(), "2 МБ") {
		t.Fatalf("большой файл: %v", err)
	}
}

func TestRunCommandMessages(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("сценарии используют POSIX sh")
	}
	if err := RunCommand("songframe-нет-такой-команды"); err == nil || err.Error() != "Не найдена системная команда songframe-нет-такой-команды." {
		t.Fatalf("отсутствующая команда: %v", err)
	}
	if err := RunCommand("sh", "-c", "echo причина >&2; exit 3"); err == nil || err.Error() != "причина" {
		t.Fatalf("stderr: %v", err)
	}
	if err := RunCommand("sh", "-c", "exit 0"); err != nil {
		t.Fatal(err)
	}
}
