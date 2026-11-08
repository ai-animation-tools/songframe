// Package projectviews строит производные Markdown/JSON-представления реестра сцен и
// технических комплектов — монтажный список, раскадровка, индекс комплектов assets, ROADMAP с
// готовностью, справочник визуальных правил с речевыми планами, README комплектов и таблица
// разметки трека.
//
// Документы строятся только из файлов рабочего дерева проекта (Sources): реестр plan/scenes.json,
// plan/project.json, plan/production-status.json, разметка, манифесты комплектов и пакеты
// производства. Байты текстов зафиксированы эталонами scene-views (десятичное округление
// половины вверх, проценты с запятой, диаграмма Mermaid, время «ММ:СС.d», обрезка пробелов в
// конце строк). Ошибки данных — исключения toolrt с типом и текстом, зафиксированными теми же
// эталонами: вызывающий инструмент (internal/sceneviews) печатает их последней строкой
// трассировки. Пакет только читает проект; записью владеет вызывающий.
//
// Снимки Git (--staged/--ref, LFS-указатели) не читаются: проверка снимка — инструмент
// разработчика, приложению она не нужна.
package projectviews

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
	"os"
	"path/filepath"
	"sort"

	"songframe/internal/toolrt"
)

// skipped — каталоги, которые обход рабочего дерева не посещает на любой глубине.
var skipped = map[string]bool{".git": true, ".local": true, "__pycache__": true, "node_modules": true}

// Sources — источник данных рабочего дерева: множество файлов проекта (пути от корня через
// «/»), собранное один раз при создании, и чтение их текста, JSON и SHA-256 с диска. Обход и все
// чтения относятся к корню Root; снимок множества файлов не обновляется при последующей записи.
type Sources struct {
	Root  string
	files map[string]bool
}

// NewSources обходит рабочее дерево root, пропуская каталоги из skipped. Ссылка на каталог
// считается каталогом, но не обходится; битая ссылка и ссылка на файл — файлы; нечитаемые
// каталоги пропускаются молча.
func NewSources(root string) *Sources {
	sources := &Sources{Root: root, files: map[string]bool{}}
	var walk func(directory, prefix string)
	walk = func(directory, prefix string) {
		entries, err := os.ReadDir(directory)
		if err != nil {
			return
		}
		for _, entry := range entries {
			name := entry.Name()
			path := filepath.Join(directory, name)
			isDir := entry.IsDir()
			link := entry.Type()&os.ModeSymlink != 0
			if link {
				info, err := os.Stat(path)
				isDir = err == nil && info.IsDir()
			}
			if !isDir {
				sources.files[prefix+name] = true
				continue
			}
			if !link && !skipped[name] {
				walk(path, prefix+name+"/")
			}
		}
	}
	walk(root, "")
	return sources
}

// Has — входит ли строковый путь в множество файлов.
func (s *Sources) Has(path string) bool { return s.files[path] }

// Contains — входит ли значение из JSON в множество файлов: нестроковое хешируемое значение не
// входит, список и словарь — исключение toolrt TypeError unhashable type (toolrt.HashKey).
func (s *Sources) Contains(value any) (bool, error) {
	if _, err := toolrt.HashKey(value); err != nil {
		return false, err
	}
	text, ok := value.(string)
	return ok && s.files[text], nil
}

// Files — пути множества в порядке сортировки: порядок детерминирован и влияет только на то,
// какое из нескольких исключений чтения возникнет первым.
func (s *Sources) Files() []string {
	result := make([]string, 0, len(s.files))
	for path := range s.files {
		result = append(result, path)
	}
	sort.Strings(result)
	return result
}

// path — путь файла от корня Root (toolrt.JoinPath) в той записи, что попадает в текст OSError.
func (s *Sources) path(path string) string { return toolrt.JoinPath(s.Root, path) }

// Text — текст файла из множества (UTF-8, универсальные переводы строк); путь вне множества —
// ValueError «Нет обязательного файла: …» без точки в конце.
func (s *Sources) Text(path string) (string, error) {
	if !s.files[path] {
		return "", toolrt.Raise(toolrt.ValueError, "Нет обязательного файла: %s", path)
	}
	return toolrt.ReadText(s.path(path))
}

// JSON — разобранный JSON текста файла из множества (toolrt.LoadsJSON).
func (s *Sources) JSON(path string) (any, error) {
	text, err := s.Text(path)
	if err != nil {
		return nil, err
	}
	return toolrt.LoadsJSON(text)
}

// TextSHA — SHA-256 (hex) текста файла, снова закодированного в UTF-8: отпечаток после
// декодирования и перевода строк (не байтов файла), как его записывают квитанции.
func (s *Sources) TextSHA(path string) (string, error) {
	text, err := s.Text(path)
	if err != nil {
		return "", err
	}
	data, err := toolrt.EncodeUTF8(text)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:]), nil
}

// Require — ValueError «Нет материала: …», если файла нет в множестве.
func (s *Sources) Require(path string) error {
	if !s.files[path] {
		return toolrt.Raise(toolrt.ValueError, "Нет материала: %s", path)
	}
	return nil
}

// Digest — SHA-256 байтов файла Root/path (множество не проверяется); ошибка чтения — исключение
// toolrt OSError.
func (s *Sources) Digest(path string) (string, error) {
	return FileSHA(s.path(path))
}

// FileSHA — SHA-256 файла потоком; ошибка — исключение toolrt OSError.
func FileSHA(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", toolrt.OSErrorFrom(err, path)
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", toolrt.OSErrorFrom(err, path)
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}
