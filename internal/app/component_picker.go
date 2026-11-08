package app

import (
	"fmt"
	"runtime"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// componentFileOptions выбирает файлы одного компонента, включая поддержанный архив.
// Wails на Linux и Windows не поддерживает одновременный выбор файлов и папок:
// mixed flags фактически открывают folder-only. Поэтому пользователь выбирает файл,
// а Connect сам определяет, как использовать программу, библиотеку, модель или архив.
func componentFileOptions(component, platform string) (*application.OpenFileDialogOptions, error) {
	var title, pattern, label string
	switch component {
	case "ffmpeg":
		title, label = "Выберите FFmpeg или архив с ним", "FFmpeg"
		switch platform {
		case "windows":
			pattern = "ffmpeg.exe;ffprobe.exe;*.zip"
		default:
			pattern = "ffmpeg;ffprobe;*.tar.xz;*.zip"
		}
	case "ort-cpu":
		title, label = "Выберите ONNX Runtime или архив с ним", "ONNX Runtime"
		switch platform {
		case "windows":
			pattern = "onnxruntime.dll;*.zip"
		case "darwin":
			pattern = "libonnxruntime*.dylib;*.tgz;*.tar.gz"
		default:
			pattern = "libonnxruntime.so*;*.tgz;*.tar.gz"
		}
	case "voc-ft":
		title, label, pattern = "Выберите модель выделения вокала", "Модель выделения вокала", "*.onnx"
	case "ctc-ru":
		title, label, pattern = "Выберите русскую модель CTC", "Русская модель CTC", "*.onnx"
	case "ctc-vocab":
		title, label, pattern = "Выберите словарь CTC", "Словарь CTC", "*.json"
	default:
		return nil, fmt.Errorf("неизвестный компонент: %s", component)
	}
	return &application.OpenFileDialogOptions{
		Title: title, CanChooseFiles: true, CanChooseDirectories: false,
		Filters: []application.FileFilter{{DisplayName: label, Pattern: pattern}, {DisplayName: "Все файлы", Pattern: "*"}},
	}, nil
}

// PickComponentFile — один пользовательский вход для готового компонента и его архива.
// Отмена возвращает null и не меняет подключение; сам диалог не запускает проверку или установку.
func (s *NativeService) PickComponentFile(component string) (*string, error) {
	if s.desktop == nil {
		return nil, fmt.Errorf("нативное приложение ещё не запущено")
	}
	options, err := componentFileOptions(component, runtime.GOOS)
	if err != nil {
		return nil, err
	}
	options.Window = s.mainWindow
	path, err := s.desktop.Dialog.OpenFileWithOptions(options).PromptForSingleSelection()
	if err != nil || path == "" {
		return nil, err
	}
	return &path, nil
}
