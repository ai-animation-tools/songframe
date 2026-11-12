// Package promptlog ведёт журнал отправок проекта plan/prompt-log: что приложение отправило
// агенту или платному сервису генерации и что получило в ответ, включая ошибки, отмену и
// прерывание. Журнал переносится вместе с клипом и только читается страницей «Отправки»;
// повторной отправки из него нет.
//
// Одна отправка — один файл <id>.json, записанный атомарно: Begin создаёт запись running с
// полным промптом и контекстом, End дописывает итог и ответ. Поэтому каждая отправка видна ровно
// один раз, даже если приложение закрылось посреди неё: запись running, которой нет среди
// выполняющихся в этом процессе (live), при чтении показывается прерванной.
//
// Тексты очищаются от секретов тем же Redact, что журнал агента, и ограничены TextLimit байт на
// поле; вложения хранятся путями и SHA-256, без копий медиа.
package promptlog

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"songframe/internal/agents"
	"songframe/internal/projectfs"
)

// Dir — папка журнала от корня проекта.
const Dir = "plan/prompt-log"

// TextLimit — предел одного текстового поля записи в байтах UTF-8; длиннее — обрезается с
// пометкой Truncated.
const TextLimit = 256 * 1024

// Виды отправок.
const (
	// KindAgent — текстовое задание агента (сценарий, план, проверка видео).
	KindAgent = "agent"
	// KindAgentImages — изображения агентом-исполнителем (опоры, обложка, референсы).
	KindAgentImages = "agent_images"
	// KindImage, KindVideo — платный запрос сервису генерации.
	KindImage = "image"
	KindVideo = "video"
)

// Итоги отправки.
const (
	StatusRunning     = "running"
	StatusCompleted   = "completed"
	StatusFailed      = "failed"
	StatusCancelled   = "cancelled"
	StatusInterrupted = "interrupted"
)

// Place — место в проекте, к которому относится отправка: страница и план.
type Place struct {
	Page string `json:"page"`
	Shot string `json:"shot,omitempty"`
}

// Attachment — вложение отправки: путь (от проекта через «/», если внутри него) и SHA-256 байтов.
type Attachment struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
}

// Paid — сведения платной отправки из замороженного запроса и его состояния.
type Paid struct {
	RequestSHA256 string          `json:"request_sha256"`
	Parameters    json.RawMessage `json:"parameters,omitempty"`
	GenerationID  *string         `json:"generation_id"`
	Amount        *float64        `json:"amount"`
	Unit          *string         `json:"unit"`
}

// Record — запись журнала (файл <id>.json).
type Record struct {
	SchemaVersion int          `json:"schema_version"`
	ID            string       `json:"id"`
	Kind          string       `json:"kind"`
	Title         string       `json:"title"`
	Executor      string       `json:"executor"`
	Model         string       `json:"model,omitempty"`
	Place         *Place       `json:"place"`
	StartedAt     string       `json:"started_at"`
	FinishedAt    *string      `json:"finished_at"`
	Status        string       `json:"status"`
	Prompt        string       `json:"prompt"`
	Context       string       `json:"context"`
	Attachments   []Attachment `json:"attachments"`
	Response      string       `json:"response"`
	Error         string       `json:"error"`
	Paid          *Paid        `json:"paid"`
	Truncated     bool         `json:"truncated"`
}

// live — отправки, выполняющиеся в этом процессе; запись running вне него прервана.
var live = struct {
	sync.Mutex
	ids map[string]bool
}{ids: map[string]bool{}}

// recordID — имя записи: латиница, цифры, «-» и «_»; иное имя не выходит за папку журнала.
var recordID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,80}$`)

// path — файл записи id в проекте.
func path(project, id string) (string, error) {
	if !recordID.MatchString(id) {
		return "", errors.New("неверный номер записи журнала отправок: " + id)
	}
	return filepath.Join(project, filepath.FromSlash(Dir), id+".json"), nil
}

// Now — время записи в UTC с миллисекундами, как у истории заданий агента.
func Now() string { return time.Now().UTC().Format("2006-01-02T15:04:05.000Z") }

// clip — текст без секретов и не длиннее TextLimit байт (по границе символа).
func clip(text string, truncated *bool) string {
	text = agents.Redact(text)
	if len(text) <= TextLimit {
		return text
	}
	*truncated = true
	cut := TextLimit
	for cut > 0 && !utf8.RuneStart(text[cut]) {
		cut--
	}
	return text[:cut] + "\n…[обрезано]"
}

// write — атомарная запись record с очисткой текстов.
func write(project string, record Record) error {
	file, err := path(project, record.ID)
	if err != nil {
		return err
	}
	record.SchemaVersion = 1
	record.Title = agents.Redact(record.Title)
	record.Prompt = clip(record.Prompt, &record.Truncated)
	record.Context = clip(record.Context, &record.Truncated)
	record.Response = clip(record.Response, &record.Truncated)
	record.Error = clip(record.Error, &record.Truncated)
	if record.Attachments == nil {
		record.Attachments = []Attachment{}
	}
	return projectfs.WriteJSON(file, record)
}

// Begin записывает начатую отправку (status running) и отмечает её выполняющейся.
func Begin(project string, record Record) error {
	record.Status = StatusRunning
	record.FinishedAt = nil
	if record.StartedAt == "" {
		record.StartedAt = Now()
	}
	live.Lock()
	live.ids[record.ID] = true
	live.Unlock()
	return write(project, record)
}

// End дописывает итог отправки id: статус, ответ, ошибку и, у платной, сведения генерации.
// Отправка без записи Begin (журнал не был записан) пропускается.
func End(project, id, status, response, failure string, paid *Paid) error {
	live.Lock()
	delete(live.ids, id)
	live.Unlock()
	record, err := Read(project, id)
	if err != nil || record == nil {
		return err
	}
	finished := Now()
	record.Status, record.FinishedAt = status, &finished
	record.Response, record.Error = response, failure
	if paid != nil {
		// Параметры запроса известны с начала отправки; итог дополняет их сведениями генерации.
		if record.Paid != nil && paid.Parameters == nil {
			paid.Parameters = record.Paid.Parameters
		}
		record.Paid = paid
	}
	return write(project, *record)
}

// Read — запись id как есть; nil, если её нет.
func Read(project, id string) (*Record, error) {
	file, err := path(project, id)
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(file)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var record Record
	if err := json.Unmarshal(data, &record); err != nil || record.SchemaVersion != 1 {
		return nil, errors.New("Запись журнала отправок " + filepath.Base(file) + " повреждена.")
	}
	return &record, nil
}

// Get — запись для показа: running вне этого процесса показывается прерванной.
func Get(project, id string) (*Record, error) {
	record, err := Read(project, id)
	if err != nil || record == nil {
		return record, err
	}
	shown(record)
	return record, nil
}

// shown — состояние записи для показа: незавершённая отправка вне этого процесса прервана.
func shown(record *Record) {
	live.Lock()
	running := live.ids[record.ID]
	live.Unlock()
	if record.Status == StatusRunning && !running {
		record.Status = StatusInterrupted
	}
}

// Summary — строка списка страницы: без полных текстов, с их длиной.
type Summary struct {
	ID         string  `json:"id"`
	Kind       string  `json:"kind"`
	Title      string  `json:"title"`
	Executor   string  `json:"executor"`
	Model      string  `json:"model"`
	Place      *Place  `json:"place"`
	StartedAt  string  `json:"startedAt"`
	FinishedAt *string `json:"finishedAt"`
	Status     string  `json:"status"`
	Error      string  `json:"error"`
	Paid       bool    `json:"paid"`
}

// List — отправки проекта от новых к старым. Повреждённая запись показывается отдельной строкой
// со статусом failed и причиной, чтобы не скрывать остальные.
func List(project string) ([]Summary, error) {
	entries, err := os.ReadDir(filepath.Join(project, filepath.FromSlash(Dir)))
	if errors.Is(err, os.ErrNotExist) {
		return []Summary{}, nil
	}
	if err != nil {
		return nil, err
	}
	result := []Summary{}
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".json") {
			continue
		}
		id := strings.TrimSuffix(name, ".json")
		record, err := Get(project, id)
		if err != nil {
			result = append(result, Summary{ID: id, Kind: KindAgent, Title: name, Status: StatusFailed, Error: err.Error()})
			continue
		}
		if record == nil {
			continue
		}
		result = append(result, Summary{
			ID: record.ID, Kind: record.Kind, Title: record.Title, Executor: record.Executor, Model: record.Model, Place: record.Place,
			StartedAt: record.StartedAt, FinishedAt: record.FinishedAt, Status: record.Status, Error: record.Error, Paid: record.Paid != nil,
		})
	}
	sort.SliceStable(result, func(i, j int) bool {
		if result[i].StartedAt != result[j].StartedAt {
			return result[i].StartedAt > result[j].StartedAt
		}
		return result[i].ID > result[j].ID
	})
	return result, nil
}

// Attach — вложения по путям файлов: путь от проекта, если файл внутри него, иначе только имя
// файла (абсолютный путь машины в проект не пишется), и SHA-256 байтов; нечитаемый файл — с
// пустым SHA.
func Attach(project string, files []string) []Attachment {
	result := []Attachment{}
	for _, file := range files {
		digest := ""
		if data, err := os.ReadFile(file); err == nil {
			sum := sha256.Sum256(data)
			digest = hex.EncodeToString(sum[:])
		}
		shown := filepath.Base(file)
		if relative, err := filepath.Rel(project, file); err == nil && !strings.HasPrefix(relative, "..") && !filepath.IsAbs(relative) {
			shown = filepath.ToSlash(relative)
		}
		result = append(result, Attachment{Path: shown, SHA256: digest})
	}
	return result
}

// NewID — номер новой записи для отправки без собственного номера задания (платные запросы).
func NewID(prefix string) string {
	var data [8]byte
	_, _ = rand.Read(data[:])
	return prefix + "-" + hex.EncodeToString(data[:])
}
