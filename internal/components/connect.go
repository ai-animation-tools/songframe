package components

import (
	"context"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

// Connect распознаёт выбранный готовый файл, папку или закреплённый архив без пользовательского выбора режима.
// Готовые модели и инструменты подключаются по месту; только архив устанавливается через SHA/staging/publish.
func (m *Manager) Connect(ctx context.Context, id, selected string) (Snapshot, error) {
	artifact, ok := m.artifact(id)
	if !ok {
		return m.State(), fmt.Errorf("для этого компонента нет подтверждённого пакета на текущей платформе")
	}
	if strings.TrimSpace(selected) == "" {
		return m.State(), fmt.Errorf("выберите файл компонента")
	}
	path, err := filepath.Abs(selected)
	if err != nil {
		return m.State(), fmt.Errorf("не удалось определить выбранный путь")
	}
	info, err := os.Stat(path)
	if err != nil {
		return m.State(), fmt.Errorf("выбранный файл или папка недоступны; выберите существующий компонент")
	}
	archive := false
	if !info.IsDir() {
		if !info.Mode().IsRegular() {
			return m.State(), fmt.Errorf("выберите обычный файл компонента или его папку")
		}
		archive, err = isComponentArchive(path)
		if err != nil {
			return m.State(), fmt.Errorf("не удалось прочитать выбранный файл; проверьте доступ к нему")
		}
	}
	if archive {
		if artifact.Format == "file" {
			return m.State(), fmt.Errorf("для этого компонента нужен готовый файл модели или словаря, а не архив")
		}
		_, err = m.install(ctx, InstallRequest{Components: []string{id}, LocalFiles: map[string]string{id: path}}, true)
		return m.State(), err
	}
	if err = ctx.Err(); err != nil {
		return m.State(), err
	}
	if info.IsDir() {
		if id == "ffmpeg" {
			path, err = m.ffmpegDirectory(path)
		} else {
			path, err = componentFileInDirectory(path, artifact)
		}
		if err != nil {
			return m.State(), err
		}
	} else if id == "ffmpeg" {
		path, err = m.ffmpegDirectory(filepath.Dir(path))
		if err != nil {
			return m.State(), err
		}
	}
	if !m.work.TryLock() {
		return m.State(), fmt.Errorf("дождитесь завершения текущей проверки или установки")
	}
	defer m.work.Unlock()
	if err = ctx.Err(); err != nil {
		return m.State(), err
	}
	m.mu.Lock()
	selection := m.selection
	m.mu.Unlock()
	switch id {
	case "ffmpeg":
		selection.FFmpegDirectory = path
	case "ort-cpu":
		selection.ORTLibraryFile = path
		selection.ORTDirectory = ""
	case "voc-ft":
		selection.VocalsFile = path
	case "ctc-ru":
		selection.CTCModelFile = path
	case "ctc-vocab":
		selection.CTCVocabFile = path
	default:
		return m.State(), fmt.Errorf("неизвестный компонент")
	}
	return m.configureLocked(selection)
}

// isComponentArchive распознаёт поддержанные архивы по сигнатуре bytes, а не имени файла.
// Для модели чтение ограничено шестью байтами; большие веса здесь не хешируются и не копируются.
func isComponentArchive(path string) (bool, error) {
	f, err := os.Open(path)
	if err != nil {
		return false, err
	}
	defer f.Close()
	header := make([]byte, 6)
	n, err := io.ReadFull(f, header)
	if err != nil && err != io.EOF && err != io.ErrUnexpectedEOF {
		return false, err
	}
	header = header[:n]
	return len(header) >= 4 && (string(header[:4]) == "PK\x03\x04" || string(header[:4]) == "PK\x05\x06") || len(header) >= 2 && header[0] == 0x1f && header[1] == 0x8b || len(header) == 6 && string(header) == "\xfd7zXZ\x00", nil
}

// ffmpegDirectory принимает папку пары либо корень распакованного пакета с bin/.
// Путь одной выбранной программы не меняет контракт: для готовности всё равно нужны обе программы.
func (m *Manager) ffmpegDirectory(directory string) (string, error) {
	extension := ""
	if m.options.os == "windows" {
		extension = ".exe"
	}
	for _, candidate := range []string{directory, filepath.Join(directory, "bin")} {
		complete := true
		for _, role := range []string{"ffmpeg", "ffprobe"} {
			info, err := os.Stat(filepath.Join(candidate, role+extension))
			if err != nil || !info.Mode().IsRegular() {
				complete = false
				break
			}
		}
		if complete {
			return candidate, nil
		}
	}
	return "", fmt.Errorf("рядом с выбранным файлом или в папке не найдена пара FFmpeg и ffprobe; выберите готовый комплект или его архив")
}

// componentFileInDirectory поддерживает root/lib и исходное имя закреплённой загрузки без поиска произвольных похожих файлов.
// Для неизвестной платформы Connect уже завершился без догадок о библиотеке или ABI.
func componentFileInDirectory(directory string, a Artifact) (string, error) {
	role := "model"
	if a.Component == "ort-cpu" {
		role = "ort-library"
	}
	if a.Component == "ctc-vocab" {
		role = "vocab"
	}
	entrypoint := a.Entrypoints[role]
	candidates := []string{filepath.Join(directory, filepath.FromSlash(entrypoint)), filepath.Join(directory, filepath.Base(entrypoint))}
	if a.Component == "ort-cpu" {
		base := filepath.Base(entrypoint)
		if index := strings.Index(base, ".so."); index >= 0 {
			shared := base[:index+3]
			for _, alias := range []string{shared, shared + ".1"} {
				candidates = append(candidates, filepath.Join(directory, alias), filepath.Join(directory, "lib", alias))
			}
		}
	} else if parsed, err := url.Parse(a.URL); err == nil {
		candidates = append(candidates, filepath.Join(directory, filepath.Base(parsed.Path)))
	}
	for _, candidate := range candidates {
		info, err := os.Stat(candidate)
		if err == nil && info.Mode().IsRegular() {
			return candidate, nil
		}
	}
	if a.Component == "ort-cpu" {
		return "", fmt.Errorf("в выбранной папке не найдена библиотека ONNX Runtime; выберите файл библиотеки или архив runtime")
	}
	return "", fmt.Errorf("в выбранной папке не найден нужный файл; выберите файл модели или словаря")
}
