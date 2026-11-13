// Package songtiming — локальная автоматическая разметка трека: кэш выделенного вокала вне
// проекта, задания выделения вокала и CTC-выравнивания и загрузка нужных компонентов.
//
// Арифметику ML выполняет internal/songml, сборку черновика timing.json —
// internal/timing; здесь — файлы кэша, проверки исходников и порядок публикации. Распознавания
// слов нет: границы строк даёт принятое глобальное CTC-выравнивание по выбранному вокалу.
package songtiming

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"sync"
	"time"

	"songframe/internal/filedigest"
	"songframe/internal/projectfs"
	"songframe/internal/songml"
)

// Тексты vocalTexts (frontend/src/shared/texts/vocals.ts): Go возвращает их в ошибках как есть.
const (
	textDeleteBusy       = "Вокал используется текущим заданием. Дождитесь завершения или остановите обработку."
	textDeletePending    = "Результат вокала удаляется. Дождитесь завершения действия."
	textSourceRequired   = "Сначала добавьте исходный трек на странице «Исходники»."
	textModelMissing     = "Сначала скачайте выбранную модель выделения вокала."
	textModelUnknown     = "Неизвестная модель выделения вокала."
	textResultInvalid    = "Результат вокала повреждён или устарел. Выделите вокал заново и выберите подходящий вариант."
	textSelectRequired   = "Сначала выделите вокал, прослушайте и выберите результат."
	textSelectionInvalid = "Выбранный вокал недоступен для текущего трека. Прослушайте и выберите результат заново."
	textVocalBusy        = "Для этого трека уже выполняется выделение вокала или автоматическая разметка. Дождитесь завершения или остановите задание."
	textVocalCancelled   = "Выделение вокала остановлено пользователем."
	textSourceChanged    = "Исходный трек изменился. Выберите результат для новой записи."
	textCacheInvalid     = "Не удалось прочитать сохранённый выбор вокала. Выберите подходящий результат заново."
)

func textSeparation(model string) string { return "Выделение вокала · " + model }
func textVocalDownload(model string) string {
	return "Загрузка модели вокала · " + model
}

// VocalModel — известная модель выделения вокала: ID, подпись и SHA-256 закреплённых весов.
// Сохранённые результаты любой известной модели (Voc FT, Kim Vocal 1 и 2) читаются и удаляются,
// а новое выделение выполняется только Voc FT.
type VocalModel struct {
	ID     string
	Label  string
	SHA256 string
}

// knownModels — известные модели (как KNOWN_VOCAL_MODELS интерфейса); первая — единственная модель
// нового выделения (VOCAL_MODELS).
var knownModels = []VocalModel{
	{"voc-ft", "Voc FT", "534b2070fcc7df514b13ef660dc8cbb328679c2374d04354a5c42bb14ecce111"},
	{"kim-vocal-1", "Kim Vocal 1", "f313140ef8fecc3041881b60ecb993d985a0281a138b2fb634aa8901aebc38cb"},
	{"kim-vocal-2", "Kim Vocal 2", "ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b"},
}

func knownModel(id string) (VocalModel, bool) {
	for _, model := range knownModels {
		if model.ID == id {
			return model, true
		}
	}
	return VocalModel{}, false
}

// VocalModelStatus — VocalModelStatus frontend: модель и готовность её комплекта к выделению.
type VocalModelStatus struct {
	ID         string `json:"id"`
	Label      string `json:"label"`
	Installed  bool   `json:"installed"`
	TotalBytes int64  `json:"totalBytes"`
}

// VocalResult — проверенный готовый вокал (VocalResult frontend). Path — абсолютный путь WAV
// для прослушивания через медиасервер; Duration — секунды (samples / 44100).
type VocalResult struct {
	ID         string  `json:"id"`
	ModelID    string  `json:"modelId"`
	ModelLabel string  `json:"modelLabel"`
	Path       string  `json:"path"`
	SHA256     string  `json:"sha256"`
	CreatedAt  string  `json:"createdAt"`
	Duration   float64 `json:"duration"`
}

// VocalPreparationView — состояние подготовки вокала для окна разметки.
type VocalPreparationView struct {
	SourcePath   *string            `json:"sourcePath"`
	SourceSHA256 *string            `json:"sourceSha256"`
	Models       []VocalModelStatus `json:"models"`
	Results      []VocalResult      `json:"results"`
	SelectedID   *string            `json:"selectedId"`
	Problems     []string           `json:"problems"`
}

// metadata — result.json готового вокала; порядок полей входит в формат кэша вокала.
type metadata struct {
	SchemaVersion int    `json:"schemaVersion"`
	SourceSHA256  string `json:"sourceSha256"`
	ModelID       string `json:"modelId"`
	ModelSHA256   string `json:"modelSha256"`
	RecipeVersion int    `json:"recipeVersion"`
	SampleRate    int    `json:"sampleRate"`
	Channels      int    `json:"channels"`
	Samples       int64  `json:"samples"`
	AudioFile     string `json:"audioFile"`
	AudioSHA256   string `json:"audioSha256"`
	CreatedAt     string `json:"createdAt"`
}

var (
	resultID   = regexp.MustCompile(`^(?i:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$`)
	sha256Text = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

// selectionFile — selection.json каталога трека: явно выбранный пользователем вариант.
type selectionFile struct {
	SelectedID *string `json:"selectedId"`
}

// Store — кэш готового вокала в <профиль>/vocal-results/<SHA трека>/<uuid>/. Один WAV может
// принадлежать разным проектам с одинаковым MP3, поэтому кэш ключуется по SHA исходника, а не
// по проекту. Store сериализует удаление с выбором и запуском: пока каталог удаляется или WAV
// удерживается заданием, удаление и применение отклоняются. Методы безопасны для горутин.
type Store struct {
	root string

	mu       sync.Mutex
	deleting map[string]bool
	active   map[string]int
}

// NewStore создаёт кэш в каталоге профиля приложения.
func NewStore(profile string) *Store {
	return &Store{root: filepath.Join(profile, "vocal-results"), deleting: map[string]bool{}, active: map[string]int{}}
}

func (s *Store) directory(sourceSHA string) string { return filepath.Join(s.root, sourceSHA) }

// sourceTrack — source/track.mp3 проекта и его SHA. full=false берёт кэш filedigest
// (опрос окна), full=true читает файл заново перед применением.
func sourceTrack(project string, full bool) (string, string, error) {
	path := filepath.Join(project, "source", "track.mp3")
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		return "", "", errors.New(textSourceRequired)
	}
	var digest string
	if full {
		digest, err = fileSHA256(path)
	} else {
		var ok bool
		if digest, ok = filedigest.File(path); !ok {
			err = errors.New(textSourceRequired)
		}
	}
	if err != nil {
		return "", "", errors.New(textSourceRequired)
	}
	return path, digest, nil
}

// fileSHA256 читает файл целиком потоком без кэша.
func fileSHA256(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

// result проверяет готовый вокал: метаданные рецепта,
// канонический заголовок PCM WAV, размер и SHA-256. full=true пересчитывает SHA без кэша.
// Любая неисправность — textResultInvalid.
func (s *Store) result(sourceSHA, id string, full bool) (VocalResult, metadata, error) {
	invalid := errors.New(textResultInvalid)
	if !resultID.MatchString(id) {
		return VocalResult{}, metadata{}, invalid
	}
	directory := filepath.Join(s.directory(sourceSHA), id)
	var data metadata
	if found, err := projectfs.ReadJSON(filepath.Join(directory, "result.json"), &data); !found || err != nil {
		return VocalResult{}, metadata{}, invalid
	}
	model, known := knownModel(data.ModelID)
	created, err := time.Parse(time.RFC3339Nano, data.CreatedAt)
	if !known || err != nil || created.IsZero() || data.SchemaVersion != 1 || data.RecipeVersion != 1 || data.SourceSHA256 != sourceSHA ||
		data.ModelSHA256 != model.SHA256 || data.SampleRate != songml.VocalSampleRate || data.Channels != 2 ||
		data.Samples <= 0 || data.Samples > 1<<53-1 || data.AudioFile != "vocals.wav" || !sha256Text.MatchString(data.AudioSHA256) {
		return VocalResult{}, metadata{}, invalid
	}
	path := filepath.Join(directory, "vocals.wav")
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() != songml.WAVHeaderSize+data.Samples*4 || !canonicalWAV(path, data.Samples, info.Size()) {
		return VocalResult{}, metadata{}, invalid
	}
	// Опрос окна не перечитывает большой WAV, пока identity файла не изменилась.
	var digest string
	if full {
		digest, err = fileSHA256(path)
	} else if value, ok := filedigest.File(path); ok {
		digest = value
	} else {
		err = invalid
	}
	if err != nil || digest != data.AudioSHA256 {
		return VocalResult{}, metadata{}, invalid
	}
	return VocalResult{ID: id, ModelID: model.ID, ModelLabel: model.Label, Path: path, SHA256: data.AudioSHA256, CreatedAt: data.CreatedAt, Duration: float64(data.Samples) / songml.VocalSampleRate}, data, nil
}

// canonicalWAV сверяет 44-байтный заголовок PCM16 stereo 44,1 кГц без дополнительных chunks.
func canonicalWAV(path string, samples, size int64) bool {
	file, err := os.Open(path)
	if err != nil {
		return false
	}
	defer file.Close()
	header := make([]byte, songml.WAVHeaderSize)
	if _, err := io.ReadFull(file, header); err != nil {
		return false
	}
	le := binary.LittleEndian
	return string(header[0:4]) == "RIFF" && string(header[8:16]) == "WAVEfmt " && le.Uint32(header[16:]) == 16 &&
		le.Uint16(header[20:]) == 1 && le.Uint16(header[22:]) == 2 && le.Uint32(header[24:]) == songml.VocalSampleRate &&
		le.Uint32(header[28:]) == songml.VocalSampleRate*4 && le.Uint16(header[32:]) == 4 && le.Uint16(header[34:]) == 16 &&
		string(header[36:40]) == "data" && int64(le.Uint32(header[40:])) == samples*4 && int64(le.Uint32(header[4:]))+8 == size
}

// View — список проверенных вариантов (новые сверху), явный выбор и проблемы кэша.
// models — состояние комплекта выделения, его считает Service по менеджеру компонентов.
func (s *Store) View(project string, models []VocalModelStatus) VocalPreparationView {
	view := VocalPreparationView{Models: models, Results: []VocalResult{}, Problems: []string{}}
	if _, err := os.Stat(filepath.Join(project, "source", "track.mp3")); err != nil {
		return view
	}
	path, digest, err := sourceTrack(project, false)
	if err != nil {
		view.Problems = append(view.Problems, err.Error())
		return view
	}
	view.SourcePath, view.SourceSHA256 = &path, &digest
	directory := s.directory(digest)
	entries, err := os.ReadDir(directory)
	if err != nil {
		return view
	}
	problems := map[string]bool{}
	addProblem := func(text string) {
		if !problems[text] {
			problems[text] = true
			view.Problems = append(view.Problems, text)
		}
	}
	for _, entry := range entries {
		if !entry.IsDir() || !resultID.MatchString(entry.Name()) {
			continue
		}
		if _, err := os.Stat(filepath.Join(directory, entry.Name(), "result.json")); err != nil {
			continue
		}
		result, _, err := s.result(digest, entry.Name(), false)
		if err != nil {
			addProblem(textResultInvalid)
			continue
		}
		view.Results = append(view.Results, result)
	}
	// Строки ISO-времени сравниваются побайтно: так порядок совпадает с хронологическим.
	sort.SliceStable(view.Results, func(i, j int) bool { return view.Results[i].CreatedAt > view.Results[j].CreatedAt })
	var selection selectionFile
	if _, err := projectfs.ReadJSON(filepath.Join(directory, "selection.json"), &selection); err != nil {
		addProblem(textCacheInvalid)
	} else if selection.SelectedID != nil && *selection.SelectedID != "" {
		for _, result := range view.Results {
			if result.ID == *selection.SelectedID {
				id := result.ID
				view.SelectedID = &id
			}
		}
		if view.SelectedID == nil {
			addProblem(textSelectionInvalid)
		}
	}
	return view
}

// Select публикует явный выбор после полной проверки WAV и повторной сверки исходника.
func (s *Store) Select(project, id string) error {
	_, digest, err := sourceTrack(project, true)
	if err != nil {
		return err
	}
	if s.isDeleting(digest) {
		return errors.New(textDeletePending)
	}
	if _, _, err := s.result(digest, id, true); err != nil {
		return err
	}
	if _, again, err := sourceTrack(project, true); err != nil || again != digest {
		return errors.New(textSourceChanged)
	}
	return projectfs.WriteJSON(filepath.Join(s.directory(digest), "selection.json"), map[string]string{"selectedId": id})
}

// Selected — выбранный вокал трека проекта после полной проверки: путь result.json, метаданные
// и SHA трека. Без выбора — textSelectRequired.
func (s *Store) Selected(project string) (string, metadata, string, error) {
	_, digest, err := sourceTrack(project, true)
	if err != nil {
		return "", metadata{}, "", err
	}
	if s.isDeleting(digest) {
		return "", metadata{}, "", errors.New(textDeletePending)
	}
	var selection selectionFile
	if _, err := projectfs.ReadJSON(filepath.Join(s.directory(digest), "selection.json"), &selection); err != nil {
		return "", metadata{}, "", err
	}
	if selection.SelectedID == nil || *selection.SelectedID == "" {
		return "", metadata{}, "", errors.New(textSelectRequired)
	}
	_, data, err := s.result(digest, *selection.SelectedID, true)
	if err != nil {
		return "", metadata{}, "", err
	}
	return filepath.Join(s.directory(digest), *selection.SelectedID, "result.json"), data, digest, nil
}

// revalidate — повторная полная проверка вокала перед публикацией разметки: метаданные и WAV
// должны совпасть с теми, что были при запуске.
func (s *Store) revalidate(resultPath, sourceSHA string, expected metadata) bool {
	_, data, err := s.result(sourceSHA, filepath.Base(filepath.Dir(resultPath)), true)
	return err == nil && data == expected
}

// Hold удерживает WAV выбранного результата до завершения задания: удаление его отклоняется.
// Возвращённая функция снимает удержание (повторный вызов безопасен).
func (s *Store) Hold(resultPath string) func() {
	s.mu.Lock()
	s.active[resultPath]++
	s.mu.Unlock()
	var once sync.Once
	return func() {
		once.Do(func() {
			s.mu.Lock()
			if s.active[resultPath]--; s.active[resultPath] <= 0 {
				delete(s.active, resultPath)
			}
			s.mu.Unlock()
		})
	}
}

func (s *Store) isDeleting(sourceSHA string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.deleting[sourceSHA]
}

// Delete перемещает каталог результата в корзину (discard). Сначала сбрасывается выбор, чтобы
// во время файловой операции этот WAV нельзя было применить; отказ корзины восстанавливает выбор.
// busy сообщает о выполняющемся задании проекта. Исходники, модели и timing.json не участвуют.
func (s *Store) Delete(project, id string, busy bool, discard func(string) error) error {
	_, digest, err := sourceTrack(project, true)
	if err != nil {
		return err
	}
	if !resultID.MatchString(id) {
		return errors.New(textResultInvalid)
	}
	directory := filepath.Join(s.directory(digest), id)
	s.mu.Lock()
	if s.deleting[digest] {
		s.mu.Unlock()
		return errors.New(textDeletePending)
	}
	if s.active[filepath.Join(directory, "result.json")] > 0 || busy {
		s.mu.Unlock()
		return errors.New(textDeleteBusy)
	}
	s.deleting[digest] = true
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.deleting, digest)
		s.mu.Unlock()
	}()
	if info, err := os.Stat(directory); err != nil || !info.IsDir() {
		return errors.New(textResultInvalid)
	}
	path := filepath.Join(s.directory(digest), "selection.json")
	raw, readErr := os.ReadFile(path)
	var selection selectionFile
	selected := readErr == nil && json.Unmarshal(raw, &selection) == nil && selection.SelectedID != nil && *selection.SelectedID == id
	if selected {
		if err := projectfs.WriteJSON(path, map[string]any{"selectedId": nil}); err != nil {
			return err
		}
	}
	if err := discard(directory); err != nil {
		if selected {
			// Прежний выбор возвращается теми же байтами файла.
			_ = projectfs.WriteFile(path, raw, 0)
		}
		return err
	}
	return nil
}

// outputPath — уникальный каталог новой попытки выделения (создаётся шагом задания): удачный
// прежний результат переживает любую ошибку новой попытки.
func (s *Store) outputPath(sourceSHA string) (string, error) {
	random := make([]byte, 16)
	if _, err := rand.Read(random); err != nil {
		return "", err
	}
	random[6] = random[6]&0x0f | 0x40
	random[8] = random[8]&0x3f | 0x80
	id := fmt.Sprintf("%x-%x-%x-%x-%x", random[0:4], random[4:6], random[6:8], random[8:10], random[10:])
	return filepath.Join(s.directory(sourceSHA), id), nil
}
