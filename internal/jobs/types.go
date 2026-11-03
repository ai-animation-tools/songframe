// Package jobs — общий менеджер длительных заданий приложения: отправка и ожидание генерации,
// приёмка, сборки, проверки, загрузка моделей.
//
// Задание — последовательность шагов. Шаг — Go-функция с context отмены и журналом; внешнюю
// программу он запускает через StepContext.Exec (internal/process). Сведения задания без текста
// журнала хранятся в <localDir>/jobs/<id>.json (атомарно), журнал — в <id>.log рядом; оба
// переживают перезапуск и сбой. Наблюдаемая семантика (JobInfo, статусы шагов, коды, error,
// «прервано» после перезапуска, текст копирования) совпадает с src/main/jobs.ts оригинала.
package jobs

// Kind — вид задания; значения совпадают с JobKind в frontend/src/shared/types.ts.
type Kind string

const (
	KindSubmit        Kind = "submit"
	KindRegenerate    Kind = "regenerate"
	KindAccept        Kind = "accept"
	KindContactSheet  Kind = "contact_sheet"
	KindTool          Kind = "tool"
	KindCheck         Kind = "check"
	KindReview        Kind = "review"
	KindAnimatic      Kind = "animatic"
	KindModelDownload Kind = "model_download"
)

// Status — состояние задания. Interrupted ставится только при запуске приложения заданиям,
// которые по сохранённым сведениям выполнялись, когда прошлый сеанс закрылся или упал.
type Status string

const (
	StatusRunning     Status = "running"
	StatusDone        Status = "done"
	StatusFailed      Status = "failed"
	StatusInterrupted Status = "interrupted"
)

// StepStatus — состояние шага; failed ставится и шагам, прерванным закрытием программы.
type StepStatus string

const (
	StepPending StepStatus = "pending"
	StepRunning StepStatus = "running"
	StepDone    StepStatus = "done"
	StepFailed  StepStatus = "failed"
)

// InterruptedMessage — причина задания, прерванного закрытием программы
// (JOB_INTERRUPTED_MESSAGE = projectDataTexts.jobInterrupted во frontend).
const InterruptedMessage = "Прервано закрытием или сбоем программы"

// StoppedMessage — причина отмены по умолчанию и строка журнала остановленной программы
// (environmentTexts.main.executionStopped оригинала).
const StoppedMessage = "Выполнение остановлено пользователем."

const (
	// LogTail — сколько последних символов журнала отдаётся в JobInfo.log
	// (для заданий прошлых сеансов — байт файла, как readLogTail оригинала).
	LogTail = 12000
	// ErrorLimit — сколько последних символов причины хранится в JobInfo.error.
	ErrorLimit = 2000
	// SavedJobsLimit — сколько заданий прошлых сеансов хранится; более старые удаляются с журналами.
	SavedJobsLimit = 200
	// savedFileLimit — сведения больше 1 МиБ считаются повреждёнными и пропускаются.
	savedFileLimit = 1024 * 1024
	// copyLogLimit — сколько байт журнала с конца входит в текст копирования (readLog оригинала).
	copyLogLimit = 1024 * 1024
)

// StepInfo — DTO шага (JobStepInfo): один вызов операции с её кодом завершения.
// Code — nil, пока шаг не завершён.
type StepInfo struct {
	Label  string     `json:"label"`
	Tool   string     `json:"tool"`
	Status StepStatus `json:"status"`
	Code   *int       `json:"code"`
}

// ModelDownload связывает задание загрузки весов с моделью и папкой: такая загрузка
// относится к приложению, а не к данным текущего клипа.
type ModelDownload struct {
	Model     string `json:"model"`
	Directory string `json:"directory"`
}

// Info — DTO задания (JobInfo frontend). Поля с nil сериализуются как null там, где TS-тип
// допускает null (project, finishedAt, code), и опускаются там, где поле необязательно
// (error, modelDownload, previousSession). Steps никогда не nil.
type Info struct {
	ID string `json:"id"`
	// Project — папка проекта задания; nil — общее задание приложения.
	Project    *string `json:"project"`
	Kind       Kind    `json:"kind"`
	Title      string  `json:"title"`
	Status     Status  `json:"status"`
	StartedAt  string  `json:"startedAt"`
	FinishedAt *string `json:"finishedAt"`
	// Log — хвост журнала. У заданий прошлых сеансов в List пуст, Get читает его из файла.
	Log  string `json:"log"`
	Code *int   `json:"code"`
	// Error — причина первого обязательного сбоя, пригодная для показа без журнала.
	Error           *string        `json:"error,omitempty"`
	Steps           []StepInfo     `json:"steps"`
	ModelDownload   *ModelDownload `json:"modelDownload,omitempty"`
	PreviousSession bool           `json:"previousSession,omitempty"`
}

// clone возвращает независимую копию: подписчики и вызывающие не видят дальнейших изменений
// и не могут испортить состояние менеджера (structuredClone оригинала).
func (info Info) clone() Info {
	result := info
	result.Steps = make([]StepInfo, len(info.Steps))
	for index, step := range info.Steps {
		result.Steps[index] = step
		if step.Code != nil {
			code := *step.Code
			result.Steps[index].Code = &code
		}
	}
	result.Project = cloneString(info.Project)
	result.FinishedAt = cloneString(info.FinishedAt)
	result.Error = cloneString(info.Error)
	if info.Code != nil {
		code := *info.Code
		result.Code = &code
	}
	if info.ModelDownload != nil {
		download := *info.ModelDownload
		result.ModelDownload = &download
	}
	return result
}

func cloneString(value *string) *string {
	if value == nil {
		return nil
	}
	copied := *value
	return &copied
}

// Change — событие изменения задания для подписчиков (события Wails). Log=true означает, что
// изменился только журнал: такие события прореживаются (не чаще logEventInterval на задание),
// а итоговое изменение состояния публикуется всегда. Полный снимок берётся через Get.
type Change struct {
	ID      string  `json:"id"`
	Project *string `json:"project"`
	Status  Status  `json:"status"`
	Log     bool    `json:"log"`
}
