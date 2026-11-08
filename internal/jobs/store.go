package jobs

import (
	"bytes"
	"encoding/json"
	"io"
	"log"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"

	"songframe-go/internal/projectfs"
)

// jobFile — имя файла сведений задания; agent-<uuid>.json принадлежит заданиям агента
// и этим менеджером не читается. \d в RE2 — только ASCII-цифры, как в JS.
var jobFile = regexp.MustCompile(`^([0-9a-z]+-\d+)\.json$`)

// record — содержимое <id>.json: сведения без журнала и признака прошлого сеанса.
// Порядок полей задаёт порядок ключей файла и закреплён эталоном internal/jobs/testdata.
type record struct {
	ID            string         `json:"id"`
	Project       *string        `json:"project"`
	Kind          Kind           `json:"kind"`
	Title         string         `json:"title"`
	Status        Status         `json:"status"`
	StartedAt     string         `json:"startedAt"`
	FinishedAt    *string        `json:"finishedAt"`
	Code          *int           `json:"code"`
	Steps         []StepInfo     `json:"steps"`
	ModelDownload *ModelDownload `json:"modelDownload,omitempty"`
	Error         *string        `json:"error,omitempty"`
}

// saveInfo атомарно записывает сведения. Сбой записи не останавливает задание:
// он попадает только в служебный журнал процесса.
func saveInfo(directory string, info Info) {
	value := record{info.ID, info.Project, info.Kind, info.Title, info.Status, info.StartedAt, info.FinishedAt, info.Code, info.Steps, info.ModelDownload, info.Error}
	if err := projectfs.WriteJSON(filepath.Join(directory, info.ID+".json"), value); err != nil {
		log.Printf("Не удалось сохранить сведения задания: %v", err)
	}
}

// loadSaved читает сведения прошлых сеансов: новые сверху, не больше limit; лишние удаляются
// вместе с журналами. Выполнявшееся задание помечается interrupted с InterruptedMessage,
// его running-шаги — failed, и это сохраняется. Повреждённый или слишком большой файл
// пропускается (и не удаляется).
func loadSaved(directory string, limit int, now string) []Info {
	entries, err := os.ReadDir(directory)
	if err != nil {
		if !os.IsNotExist(err) {
			log.Printf("Не удалось прочитать каталог заданий %s: %v", directory, err)
		}
		return nil
	}
	jobs := []Info{}
	for _, entry := range entries {
		match := jobFile.FindStringSubmatch(entry.Name())
		if match == nil {
			continue
		}
		path := filepath.Join(directory, entry.Name())
		info, ok := readSaved(path, match[1])
		if !ok {
			log.Printf("Не удалось прочитать сведения задания %s; файл пропущен.", path)
			continue
		}
		info.PreviousSession = true
		jobs = append(jobs, info)
	}
	sort.SliceStable(jobs, func(a, b int) bool { return jobs[a].StartedAt > jobs[b].StartedAt })
	if len(jobs) > limit {
		for _, old := range jobs[limit:] {
			os.Remove(filepath.Join(directory, old.ID+".json"))
			os.Remove(filepath.Join(directory, old.ID+".log"))
		}
		jobs = jobs[:limit]
	}
	for index := range jobs {
		job := &jobs[index]
		if job.Status != StatusRunning {
			continue
		}
		message := InterruptedMessage
		finished := now
		job.Status = StatusInterrupted
		job.Error = &message
		job.FinishedAt = &finished
		for step := range job.Steps {
			if job.Steps[step].Status == StepRunning {
				job.Steps[step].Status = StepFailed
			}
		}
		saveInfo(directory, *job)
	}
	return jobs
}

// readSaved проверяет запись: id совпадает с именем файла,
// kind/title/startedAt — строки, известные статусы, finishedAt и code присутствуют
// (null или строка/целое), steps — массив шагов со строковыми label/tool и известным статусом.
// Необязательные поля неверного типа (project, error, modelDownload, code шага) не делают
// запись повреждённой, а отбрасываются.
func readSaved(path, id string) (Info, bool) {
	info := Info{}
	stat, err := os.Stat(path)
	if err != nil || !stat.Mode().IsRegular() || stat.Size() > savedFileLimit {
		return info, false
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return info, false
	}
	var raw struct {
		ID            *string           `json:"id"`
		Project       json.RawMessage   `json:"project"`
		Kind          *string           `json:"kind"`
		Title         *string           `json:"title"`
		Status        *string           `json:"status"`
		StartedAt     *string           `json:"startedAt"`
		FinishedAt    json.RawMessage   `json:"finishedAt"`
		Code          json.RawMessage   `json:"code"`
		Steps         []json.RawMessage `json:"steps"`
		ModelDownload json.RawMessage   `json:"modelDownload"`
		Error         json.RawMessage   `json:"error"`
	}
	if json.Unmarshal(data, &raw) != nil || raw.ID == nil || *raw.ID != id || raw.Kind == nil || raw.Title == nil || raw.Status == nil || raw.StartedAt == nil || raw.Steps == nil {
		return info, false
	}
	status := Status(*raw.Status)
	if status != StatusRunning && status != StatusDone && status != StatusFailed && status != StatusInterrupted {
		return info, false
	}
	finishedAt, ok := nullableString(raw.FinishedAt)
	if !ok {
		return info, false
	}
	code, ok := nullableInt(raw.Code)
	if !ok {
		return info, false
	}
	info = Info{ID: id, Kind: Kind(*raw.Kind), Title: *raw.Title, Status: status, StartedAt: *raw.StartedAt, FinishedAt: finishedAt, Code: code, Steps: make([]StepInfo, 0, len(raw.Steps))}
	for _, item := range raw.Steps {
		var step struct {
			Label  *string         `json:"label"`
			Tool   *string         `json:"tool"`
			Status *string         `json:"status"`
			Code   json.RawMessage `json:"code"`
		}
		if json.Unmarshal(item, &step) != nil || step.Label == nil || step.Tool == nil || step.Status == nil {
			return info, false
		}
		stepStatus := StepStatus(*step.Status)
		if stepStatus != StepPending && stepStatus != StepRunning && stepStatus != StepDone && stepStatus != StepFailed {
			return info, false
		}
		stepCode, _ := nullableInt(step.Code)
		info.Steps = append(info.Steps, StepInfo{Label: *step.Label, Tool: *step.Tool, Status: stepStatus, Code: stepCode})
	}
	info.Project, _ = nullableString(raw.Project)
	var message string
	if len(raw.Error) > 0 && json.Unmarshal(raw.Error, &message) == nil {
		info.Error = &message
	}
	var download ModelDownload
	if len(raw.ModelDownload) > 0 && !bytes.Equal(raw.ModelDownload, []byte("null")) && json.Unmarshal(raw.ModelDownload, &download) == nil {
		info.ModelDownload = &download
	}
	return info, true
}

// nullableString принимает null или строку; отсутствие поля (пустой raw) — не принимает.
func nullableString(raw json.RawMessage) (*string, bool) {
	if len(raw) == 0 {
		return nil, false
	}
	if bytes.Equal(raw, []byte("null")) {
		return nil, true
	}
	var value string
	if json.Unmarshal(raw, &value) != nil {
		return nil, false
	}
	return &value, true
}

// nullableInt принимает null или целое число (Number.isInteger: 3.0 — тоже целое).
func nullableInt(raw json.RawMessage) (*int, bool) {
	if len(raw) == 0 {
		return nil, false
	}
	if bytes.Equal(raw, []byte("null")) {
		return nil, true
	}
	var value float64
	if json.Unmarshal(raw, &value) != nil || value != math.Trunc(value) || math.Abs(value) > 1<<53 {
		return nil, false
	}
	code := int(value)
	return &code, true
}

// readLogTail возвращает последние maxBytes журнала без чтения всего файла; отсутствующий
// файл — пустая строка. Обрезка могла попасть в середину многобайтного символа: такие байты
// (и заменители U+FFFD) в начале убираются, остальные некорректные последовательности
// заменяются U+FFFD.
func readLogTail(path string, maxBytes int64) string {
	file, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer file.Close()
	stat, err := file.Stat()
	if err != nil {
		return ""
	}
	length := min(stat.Size(), maxBytes)
	buffer := make([]byte, length)
	if _, err := file.ReadAt(buffer, stat.Size()-length); err != nil && err != io.EOF {
		return ""
	}
	return strings.ToValidUTF8(trimBrokenStart(buffer), "\uFFFD")
}

// trimBrokenStart убирает в начале байты, не образующие символ, и заменители U+FFFD.
func trimBrokenStart(data []byte) string {
	for len(data) > 0 {
		r, size := utf8.DecodeRune(data)
		if r != utf8.RuneError {
			break
		}
		data = data[size:]
	}
	return string(data)
}
