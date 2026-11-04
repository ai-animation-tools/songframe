package agents

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"regexp"

	"songframe-go/internal/jscompat"
	"songframe-go/internal/projectfs"
)

// Состояния задания агента (AgentJob.status).
const (
	StatusRunning     = "running"
	StatusCompleted   = "completed"
	StatusFailed      = "failed"
	StatusCancelled   = "cancelled"
	StatusInterrupted = "interrupted"
)

// Права задания: предложения читают проект, изображения пишут только в рабочую папку кандидатов.
const (
	PermissionsReadOnly       = "read-only"
	PermissionsWorkspaceWrite = "workspace-write"
)

// InputHashes — SHA-256 промпта и контекста (с вложениями — их байтов и порядка) без самих текстов.
type InputHashes struct {
	Prompt  string `json:"prompt"`
	Context string `json:"context"`
}

// Job — AgentJob контракта и запись истории jobs/agent-<id>.json. Порядок полей — порядок ключей
// объекта оригинала (сначала поля создания, затем назначаемые по ходу cliVersion, sessionId,
// diagnostic, message), поэтому файлы истории совпадают с Electron байт в байт. Промпт, контекст,
// stderr и сырые события провайдера сюда не попадают; result и task очищены Redact.
//
// FinishedAt и ExitCode — nullable-поля контракта; менеджер всегда заменяет указатель новым
// значением и не меняет указываемое, поэтому поверхностная копия Job — независимый снимок.
type Job struct {
	SchemaVersion int         `json:"schemaVersion"`
	ID            string      `json:"id"`
	Sequence      int         `json:"sequence"`
	Project       string      `json:"project"`
	Provider      string      `json:"provider"`
	Task          string      `json:"task"`
	Model         string      `json:"model,omitempty"`
	RetryOf       string      `json:"retryOf,omitempty"`
	Permissions   string      `json:"permissions"`
	InputHashes   InputHashes `json:"inputHashes"`
	Status        string      `json:"status"`
	Phase         string      `json:"phase"`
	StartedAt     string      `json:"startedAt"`
	FinishedAt    *string     `json:"finishedAt"`
	ExitCode      *int        `json:"exitCode"`
	Result        string      `json:"result"`
	Log           string      `json:"log"`
	CLIVersion    string      `json:"cliVersion,omitempty"`
	SessionID     string      `json:"sessionId,omitempty"`
	Diagnostic    string      `json:"diagnostic,omitempty"`
	Message       string      `json:"message,omitempty"`
}

// historyFile — имя записи задания агента; файлы общего менеджера заданий (<kind>-<n>.json)
// в том же каталоге этим разбором не читаются.
var (
	historyFile = regexp.MustCompile(`^agent-[0-9a-f-]{36}\.json$`)
	sha256Hex   = regexp.MustCompile(`^[a-f0-9]{64}$`)
)

// historyLimit — предельный размер записи; больший файл считается повреждённым.
const historyLimit = 1024 * 1024

// History хранит задания агента в <каталог состояния>/jobs отдельно от общего менеджера заданий.
// Повреждённая запись сохраняется для разбора и не блокирует остальные задания.
type History struct{ directory string }

// NewHistory привязывает историю к каталогу состояния приложения.
func NewHistory(localDir string) *History {
	return &History{directory: filepath.Join(localDir, "jobs")}
}

// Read возвращает пригодные записи в порядке каталога.
func (h *History) Read() []Job {
	entries, err := os.ReadDir(h.directory)
	if err != nil {
		return []Job{}
	}
	jobs := []Job{}
	for _, entry := range entries {
		if !historyFile.MatchString(entry.Name()) {
			continue
		}
		path := filepath.Join(h.directory, entry.Name())
		job, ok := readJob(path, entry.Name())
		if !ok {
			log.Printf("Не удалось прочитать запись агента %s. Файл сохранён.", path)
			continue
		}
		jobs = append(jobs, job)
	}
	return jobs
}

// readJob проверяет запись по правилам оригинала (типы JS и закрытые наборы значений), затем
// декодирует её в Job.
func readJob(path, name string) (Job, bool) {
	info, err := os.Stat(path)
	if err != nil || info.Size() > historyLimit {
		return Job{}, false
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return Job{}, false
	}
	value, err := jscompat.Parse([]byte(jscompat.DecodeUTF8(data)))
	record, ok := value.(*jscompat.Object)
	if err != nil || !ok {
		return Job{}, false
	}
	isString := func(key string) bool { _, ok := record.Value(key).(string); return ok }
	status := record.Value("status")
	permissions := record.Value("permissions")
	finished := record.Value("finishedAt")
	exitCode := record.Value("exitCode")
	sequence, _ := record.Value("sequence").(float64)
	hashes := record.Value("inputHashes")
	provider, _ := record.Value("provider").(string)
	_, finishedString := finished.(string)
	valid := record.Value("schemaVersion") == float64(1) &&
		name == "agent-"+jscompat.ToString(record.Value("id"))+".json" &&
		IsProvider(provider) &&
		(status == StatusRunning || status == StatusCompleted || status == StatusFailed || status == StatusCancelled || status == StatusInterrupted) &&
		jscompat.IsSafeInteger(record.Value("sequence")) && sequence >= 0 &&
		isString("project") && isString("task") && isString("phase") && isString("result") && isString("log") && isString("startedAt") &&
		(finished == nil || finishedString) &&
		(exitCode == nil || jscompat.IsInteger(exitCode)) &&
		(permissions == PermissionsReadOnly || permissions == PermissionsWorkspaceWrite) &&
		sha256Hex.MatchString(text(jscompat.Get(hashes, "prompt"))) &&
		sha256Hex.MatchString(text(jscompat.Get(hashes, "context")))
	if !valid {
		return Job{}, false
	}
	var job Job
	if err := json.Unmarshal(data, &job); err != nil {
		return Job{}, false
	}
	return job, true
}

// Write атомарно сохраняет запись задания в формате JSON.stringify(job, null, 2) + "\n".
func (h *History) Write(job Job) error {
	return projectfs.WriteJSON(filepath.Join(h.directory, "agent-"+job.ID+".json"), job)
}
