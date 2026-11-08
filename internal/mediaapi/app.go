package mediaapi

import (
	"context"
	"encoding/json"
	"regexp"
	"time"
)

// Здесь — часть контракта адаптера, которую использует слой провайдеров приложения
// (internal/providers): правила нормализации зафиксированного запроса, строки страницы «Среда»
// и DTO возможностей. Конкретный провайдер объявляет их методами своей строки таблицы
// internal/mediaadapters (RulesProvider, EnvironmentProvider), поэтому добавление провайдера —
// одна строка таблицы и папка его пакета, без второй таблицы адаптеров.

// Alias — синонимы одного параметра у провайдера: каноническое имя и все его написания.
// Порядок групп важен: первая группа, содержащая имя, задаёт синонимы.
type Alias struct {
	Name  string
	Names []string
}

// InputFlag — короткий флаг входа (image, tailImage, …) и шаблон объявленных слотов, в которые он
// раскрывается до фиксации SHA. Порядок флагов виден в тексте ошибки «Не смешивайте именованные
// входы с короткими флагами image/tailImage/…».
type InputFlag struct {
	Flag    string
	Pattern *regexp.Regexp
}

// Enforced — значение, которое приложение задаёт всегда, если модель объявляет параметр; явное
// значение из Rejected — ошибка с текстом Message (например, запрет логотипа).
type Enforced struct {
	Name     string
	Value    any
	Rejected []any
	Message  string
}

// ImageSeries — параметр серии изображений: для одной опоры и обложки серия выключается Off.
type ImageSeries struct {
	Names []string
	Off   any
}

// ImageRules — запрос одного изображения (опора или обложка).
type ImageRules struct {
	// Command — команда по числу переданных референсов.
	Command func(references int) string
	// ReferenceSlot — именованный слот N-го переданного референса (с нуля).
	ReferenceSlot func(index int) string
	// Series — nil, если у провайдера нет серии изображений.
	Series *ImageSeries
}

// FrameDefined — параметры, которые при переданном начальном кадре (слот по шаблону Slots)
// задаёт сам кадр: их можно не передавать, а настройка проекта сверяется по размерам изображения.
type FrameDefined struct {
	Slots      *regexp.Regexp
	Parameters []string
}

// RequestRules — правила нормализации зафиксированного запроса, которые общий платный адаптер
// (internal/providers) получает из конфигурации провайдера. Значения параметров — значения JS
// (internal/jscompat): от их сравнения и печати зависят тексты ошибок, проверяемые эталонами.
type RequestRules struct {
	// Aliases — синонимы параметров по виду медиа.
	Aliases map[string][]Alias
	// OutputCount — имена параметра числа результатов; модель без него даёт ровно один результат.
	OutputCount []string
	InputFlags  []InputFlag
	Enforced    []Enforced
	Image       ImageRules
	// DraftVideoCommands — команды видео, которые агент видит до этапа запроса у плана без
	// липсинка; nil — все команды вида.
	DraftVideoCommands []string
	// FrameDefined — nil, если кадр ничего не задаёт.
	FrameDefined *FrameDefined
}

// RulesProvider — платный провайдер с правилами запроса для общего платного адаптера
// приложения. Только такие строки таблицы internal/mediaadapters слой провайдеров считает
// платными адаптерами.
type RulesProvider interface {
	RequestRules() RequestRules
}

// EnvironmentCheck — EnvironmentCheck контракта (frontend/src/shared/types.ts): строка страницы
// «Среда». Необязательные поля опускаются из JSON.
type EnvironmentCheck struct {
	ID             string `json:"id"`
	Label          string `json:"label"`
	OK             bool   `json:"ok"`
	Detail         string `json:"detail"`
	Hint           string `json:"hint"`
	ProductionOnly bool   `json:"productionOnly"`
	// ElapsedMs — время фактической проверки; nil — не измерялось.
	ElapsedMs *int `json:"elapsedMs,omitempty"`
	// Status — pending, running или done; "" — поле отсутствует.
	Status        string `json:"status,omitempty"`
	Bundled       *bool  `json:"bundled,omitempty"`
	External      *bool  `json:"external,omitempty"`
	LoginProvider string `json:"loginProvider,omitempty"`
}

// EnvironmentUpdate — изменение строки проверки среды по её id (Partial<EnvironmentCheck>):
// заполненные поля заменяют прежние.
type EnvironmentUpdate struct {
	Status    string
	OK        *bool
	Detail    *string
	ElapsedMs *int
}

// Environment — начальные строки страницы «Среда» в порядке
// показа и проверка, которая сообщает результаты через update.
type Environment struct {
	Checks []EnvironmentCheck
	Run    func(ctx context.Context, update func(id string, patch EnvironmentUpdate))
}

// EnvironmentProvider — платный провайдер со строками страницы «Среда».
type EnvironmentProvider interface {
	Environment() Environment
}

// LoginOptions — параметры входа к провайдеру.
type LoginOptions struct {
	// OpenBrowser — открыть адрес авторизации самому; false — как --no-browser: адрес
	// открывает вызывающий по строке AUTHORIZE_URL.
	OpenBrowser bool
	// Timeout — ожидание подтверждения в браузере; 0 — предел адаптера.
	Timeout time.Duration
	// Report получает строки «AUTHORIZE_URL <адрес>» и «BROWSER_NOT_OPENED», которые CLI входа
	// печатает в stderr. nil — не сообщать.
	Report func(line string)
}

// Model — MediaModel контракта: модель одной команды. Arguments и Slots — объекты объявлений
// MediaArgument (required, default, allowed, max_items и прочие поля сервиса), Limits — лимиты
// модели; все три хранятся JSON как есть, в порядке ключей ответа сервиса.
type Model struct {
	ID        string          `json:"id"`
	Command   string          `json:"command"`
	Arguments json.RawMessage `json:"arguments"`
	Slots     json.RawMessage `json:"slots"`
	Limits    json.RawMessage `json:"limits"`
}

// Capabilities — MediaCapabilities контракта: объявления моделей провайдера вида медиа.
// GenerationVerified всегда false: наличие объявлений не доказывает работу генератора аккаунта.
type Capabilities struct {
	Provider           string   `json:"provider"`
	Kind               string   `json:"kind"`
	Available          bool     `json:"available"`
	CheckedAt          string   `json:"checkedAt"`
	Models             []Model  `json:"models"`
	Problems           []string `json:"problems"`
	GenerationVerified bool     `json:"generationVerified"`
}

// Общие тексты строк провайдеров на странице «Среда»: их подставляют адаптеры разных
// провайдеров.
const (
	TextEnvironmentWaiting = "Ожидание проверки"
	TextBundledClient      = "Клиент SongFrame входит в поставку"
)

// FramePrompt — ProductionFramePrompt контракта: описание одной опоры плана.
type FramePrompt struct {
	ID string `json:"id"`
	// Role — first, middle или last.
	Role           string   `json:"role"`
	TimeSeconds    float64  `json:"timeSeconds"`
	Prompt         string   `json:"prompt"`
	ReferencePaths []string `json:"referencePaths"`
}

// ApprovedFrame — утверждённая опора пакета: референс согласованности следующих кадров.
type ApprovedFrame struct {
	ID   string `json:"id"`
	Role string `json:"role"`
	Path string `json:"path"`
}

// ImagesInput — ProductionImagesInput контракта: запрос опор провайдеру-агенту. Notes и
// ApprovedFrames — nil, если поля нет (undefined); пустой список и отсутствие различаются, потому
// что входят в SHA запроса.
type ImagesInput struct {
	Project        string           `json:"project"`
	Shot           string           `json:"shot"`
	PackageDir     string           `json:"packageDir"`
	Frames         []FramePrompt    `json:"frames"`
	Notes          *[]string        `json:"notes,omitempty"`
	ApprovedFrames *[]ApprovedFrame `json:"approvedFrames,omitempty"`
}

// FrameCandidate — ProductionFrameCandidate контракта: кандидат опоры id в файле path.
type FrameCandidate struct {
	ID   string `json:"id"`
	Path string `json:"path"`
}

// Artifact — результат генерации (оригинал платного провайдера или
// кандидат опоры провайдера-агента) с номером, SHA-256 и размерами изображения.
type Artifact struct {
	Path    string `json:"path"`
	Index   int    `json:"index"`
	Kind    string `json:"kind"`
	SHA256  string `json:"sha256"`
	FrameID string `json:"frameId,omitempty"`
	Width   int    `json:"width,omitempty"`
	Height  int    `json:"height,omitempty"`
}

// AgentExecutionRef — AgentMediaExecutionRef контракта: задание опор провайдера-агента.
type AgentExecutionRef struct {
	Provider   string `json:"provider"`
	Kind       string `json:"kind"`
	RequestSha string `json:"requestSha"`
	AgentJobID string `json:"agentJobId"`
}

// PaidExecutionRef — PaidMediaExecutionRef контракта: зафиксированная попытка платного провайдера.
type PaidExecutionRef struct {
	Provider   string `json:"provider"`
	Kind       string `json:"kind"`
	RequestSha string `json:"requestSha"`
	RequestDir string `json:"requestDir"`
}

// ReferenceImage — GenerationReferenceImage контракта: закреплённая копия опоры запроса
// изображения (обложка, референс) с подписью, SHA-256 и размером в байтах.
type ReferenceImage struct {
	Path   string `json:"path"`
	Label  string `json:"label"`
	SHA256 string `json:"sha256"`
	Bytes  int64  `json:"bytes"`
}
