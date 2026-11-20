// Package drafts хранит черновики несохранённых правок страниц в каталоге состояния приложения, а не в
// папке проекта: правки сложной работы (схемы локаций, расстановка точки съёмки в сценарии) переживают
// падение или закрытие программы и не попадают в Git клипа. Черновик проекта лежит в
// drafts/<sha256 абсолютного пути проекта>/<kind>.json; содержимое — JSON, который составляет страница
// (что записано и с какой версии файла начаты правки), здесь проверяется только, что это JSON.
//
// Запись атомарна (projectfs.WriteFile): сбой посреди записи оставляет прежний черновик целым.
// Страница пишет черновик после каждой правки с короткой задержкой и удаляет его после сохранения
// или отказа от правок.
package drafts

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"slices"

	"songframe/internal/projectfs"
)

// Kinds — виды черновиков: schemes — plan/schemes.json страницы «Схемы», scenes — plan/scenes.json
// страницы «Сценарий».
var Kinds = []string{"schemes", "scenes"}

// Store — черновики в каталоге состояния localDir. Значение без состояния: каждый вызов работает с файлами.
type Store struct {
	localDir string
}

// NewStore — хранилище черновиков в каталоге состояния localDir.
func NewStore(localDir string) Store { return Store{localDir: localDir} }

// file — путь черновика kind проекта project; проверяет вид и непустой путь проекта.
func (s Store) file(project, kind string) (string, error) {
	if !slices.Contains(Kinds, kind) {
		return "", fmt.Errorf("неизвестный вид черновика «%s»", kind)
	}
	if project == "" {
		return "", fmt.Errorf("не задана папка проекта")
	}
	absolute, err := filepath.Abs(project)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256([]byte(absolute))
	return filepath.Join(s.localDir, "drafts", hex.EncodeToString(sum[:]), kind+".json"), nil
}

// Read — содержимое черновика; нет черновика — пустая строка без ошибки.
func (s Store) Read(project, kind string) (string, error) {
	path, err := s.file(project, kind)
	if err != nil {
		return "", err
	}
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// Write атомарно заменяет черновик; content должен быть JSON.
func (s Store) Write(project, kind, content string) error {
	path, err := s.file(project, kind)
	if err != nil {
		return err
	}
	if !json.Valid([]byte(content)) {
		return fmt.Errorf("черновик «%s» — не JSON", kind)
	}
	return projectfs.WriteFile(path, []byte(content), 0o600)
}

// Remove удаляет черновик и опустевший каталог проекта; отсутствующий черновик — не ошибка.
func (s Store) Remove(project, kind string) error {
	path, err := s.file(project, kind)
	if err != nil {
		return err
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	// Каталог проекта удаляется, только если в нём ничего не осталось; иначе Remove вернёт ошибку, она не важна.
	_ = os.Remove(filepath.Dir(path))
	return nil
}
