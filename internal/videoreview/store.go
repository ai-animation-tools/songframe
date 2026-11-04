package videoreview

import (
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"songframe-go/internal/jscompat"
	"songframe-go/internal/projectfs"
)

// Состояния проверки (VideoReviewView.status).
const (
	StatusIdle      = "idle"
	StatusPreparing = "preparing"
	StatusRunning   = "running"
	StatusCompleted = "completed"
	StatusFailed    = "failed"
	StatusCancelled = "cancelled"
)

// reviewDir — папка проверок внутри пакета: latest.json и подпапки выборок <id>/.
const reviewDir = "video-review"

var (
	storedID    = regexp.MustCompile(`^[\w-]+$`)
	sha256Hex   = regexp.MustCompile(`^[a-f0-9]{64}$`)
	frameID     = regexp.MustCompile(`^F\d{3}$`)
	statusNames = map[string]bool{StatusIdle: true, StatusPreparing: true, StatusRunning: true, StatusCompleted: true, StatusFailed: true, StatusCancelled: true}
)

// stored — снимок проверки в <пакет>/video-review/latest.json (формат оригинала, schemaVersion 1):
// schemaVersion, id, shot, sourceHash, status, durationSeconds, frames, imageHashes, jobId, report,
// error. Документ хранится деревом jscompat: запись меняет только нужные поля и сохраняет
// остальное (порядок ключей, посторонние поля) так же, как JSON.stringify объекта оригинала.
// Все пути внутри относительны папке пакета, поэтому перенос папки не требует исправления отчёта.
type stored struct{ doc *jscompat.Object }

// newStored — запись новой проверки в состоянии preparing с ключами в порядке оригинала.
func newStored(id, shot, sourceHash string) stored {
	doc := jscompat.NewObject()
	doc.Set("schemaVersion", 1.0)
	doc.Set("id", id)
	doc.Set("shot", shot)
	doc.Set("sourceHash", sourceHash)
	doc.Set("status", StatusPreparing)
	doc.Set("durationSeconds", nil)
	doc.Set("frames", &jscompat.Array{})
	doc.Set("imageHashes", jscompat.NewObject())
	doc.Set("jobId", nil)
	doc.Set("report", nil)
	doc.Set("error", nil)
	return stored{doc: doc}
}

func (s stored) id() string         { text, _ := s.doc.Value("id").(string); return text }
func (s stored) status() string     { text, _ := s.doc.Value("status").(string); return text }
func (s stored) sourceHash() string { text, _ := s.doc.Value("sourceHash").(string); return text }
func (s stored) jobID() string      { text, _ := s.doc.Value("jobId").(string); return text }

// errorText — сохранённая ошибка или nil.
func (s stored) errorText() *string {
	if text, ok := s.doc.Value("error").(string); ok {
		return &text
	}
	return nil
}

// duration — durationSeconds или nil до извлечения кадров.
func (s stored) duration() *float64 {
	if value, ok := s.doc.Value("durationSeconds").(float64); ok {
		return &value
	}
	return nil
}

// frames — кадры выборки с путями относительно пакета (уже проверены read).
func (s stored) frames() []Frame {
	items, _ := jscompat.AsArray(s.doc.Value("frames"))
	result := make([]Frame, 0, len(items))
	for _, item := range items {
		frame := Frame{}
		frame.ID, _ = jscompat.Get(item, "id").(string)
		frame.TimeSeconds, _ = jscompat.Get(item, "timeSeconds").(float64)
		frame.Path, _ = jscompat.Get(item, "path").(string)
		result = append(result, frame)
	}
	return result
}

// imageHashes — SHA-256 подготовленных копий по пути относительно пакета, в порядке записи.
func (s stored) imageHashes() []jscompat.Entry {
	entries, _ := jscompat.Entries(s.doc.Value("imageHashes"))
	return entries
}

// finish переводит запись в итоговое состояние с текстом ошибки (nil — без ошибки).
func (s stored) finish(status string, message any) {
	s.doc.Set("status", status)
	s.doc.Set("error", message)
}

// latestPath — <пакет>/video-review/latest.json с проверкой, что путь не уходит из пакета.
func latestPath(directory string) (string, error) {
	return productionPath(directory, filepath.Join(reviewDir, "latest.json"))
}

// save атомарно записывает latest.json в формате JSON.stringify(value, null, 2) + "\n".
// Запись идёт через шлюз проекта: при незавершённой многофайловой операции проект не меняется.
func save(project, directory string, record stored) error {
	path, err := latestPath(directory)
	if err != nil {
		return err
	}
	if err := projectfs.CheckWrite(project); err != nil {
		return err
	}
	return projectfs.WriteFile(path, []byte(jscompat.StringifyIndent(record.doc, "  ")+"\n"), 0)
}

// inside — путь сохранённой копии принадлежит выборке id (`video-review/<id>/…`).
func inside(path, id string) bool {
	return strings.HasPrefix(slash(path), reviewDir+"/"+id+"/")
}

// read — read оригинала: отсутствующий файл — (nil, nil); повреждённый или несогласованный снимок
// (неверные ID/время кадров, пути вне выборки, нет хеша кадра, готовый статус без кадров или
// отчёта, отчёт с непоказанными кадрами) — errInvalidReport. Ничего не записывает.
func read(directory string) (*stored, error) {
	path, err := latestPath(directory)
	if err != nil {
		return nil, err
	}
	if !jscompat.Exists(path) {
		return nil, nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, errInvalidReport
	}
	value, err := jscompat.Parse([]byte(jscompat.DecodeUTF8(data)))
	if err != nil {
		return nil, errInvalidReport
	}
	doc, ok := value.(*jscompat.Object)
	if !ok {
		return nil, errInvalidReport
	}
	id, _ := doc.Value("id").(string)
	hash, hashOK := doc.Value("sourceHash").(string)
	duration := doc.Value("durationSeconds")
	durationValue, durationOK := number(duration)
	frames, framesOK := jscompat.AsArray(doc.Value("frames"))
	hashes, hashesOK := doc.Value("imageHashes").(*jscompat.Object)
	if !jscompat.StrictEqual(doc.Value("schemaVersion"), 1.0) || !nonempty(doc.Value("id"), 80) || !storedID.MatchString(id) ||
		!nonempty(doc.Value("shot"), 20) || !hashOK || !sha256Hex.MatchString(hash) ||
		!statusNames[jscompat.ToString(doc.Value("status"))] ||
		!(duration == nil || (durationOK && durationValue > 0)) ||
		!(doc.Value("jobId") == nil || nonempty(doc.Value("jobId"), 128)) ||
		!(doc.Value("error") == nil || nonempty(doc.Value("error"), 16000)) ||
		!framesOK || len(frames) > 32 || !hashesOK {
		return nil, errInvalidReport
	}
	ids := map[string]bool{}
	previous := -1.0
	list := make([]Frame, 0, len(frames))
	for _, raw := range frames {
		frame, ok := raw.(*jscompat.Object)
		if !ok {
			return nil, errInvalidReport
		}
		fid, isString := frame.Value("id").(string)
		time, finite := number(frame.Value("timeSeconds"))
		framePath := frame.Value("path")
		pathText, _ := framePath.(string)
		if !isString || !frameID.MatchString(fid) || ids[fid] || !finite || time < 0 || time <= previous ||
			duration == nil || time >= durationValue || !nonempty(framePath, 4000) || jscompat.IsAbs(pathText) {
			return nil, errInvalidReport
		}
		if _, err := productionPath(directory, pathText); err != nil {
			return nil, err
		}
		if !inside(pathText, id) {
			return nil, errInvalidReport
		}
		if _, ok := hashes.Value(pathText).(string); !ok {
			return nil, errInvalidReport
		}
		previous = time
		ids[fid] = true
		list = append(list, Frame{ID: fid, TimeSeconds: time, Path: pathText})
	}
	status := jscompat.ToString(doc.Value("status"))
	if (status == StatusRunning || status == StatusCompleted) &&
		(len(frames) == 0 || !jscompat.Truthy(doc.Value("jobId")) || !jscompat.Truthy(duration)) {
		return nil, errInvalidReport
	}
	if status == StatusCompleted && doc.Value("report") == nil {
		return nil, errInvalidReport
	}
	for _, key := range hashes.Keys() {
		value, isString := hashes.Value(key).(string)
		if jscompat.IsAbs(key) || !inside(key, id) || !isString || !sha256Hex.MatchString(value) {
			return nil, errInvalidReport
		}
		if _, err := productionPath(directory, key); err != nil {
			return nil, err
		}
	}
	if report := doc.Value("report"); report != nil {
		// Number(durationSeconds): null даёт 0, и тогда любое наблюдение выходит за длительность.
		if _, err := ParseReport(report, list, durationValue); err != nil {
			return nil, err
		}
	}
	return &stored{doc: doc}, nil
}

// mathFinite — число конечно (Number.isFinite).
func mathFinite(value float64) bool { return !math.IsInf(value, 0) && !math.IsNaN(value) }
