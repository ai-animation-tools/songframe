// Package agentexec — контракт исполнителя опор провайдера-агента (AgentImageExecutor и
// KeyframeImages из src/main/providers/types.ts оригинала): провайдер, генерацию которого
// исполняет программа-агент из реестра (MediaProviderInfo.executor). Пакет-лист: его реализуют
// адаптеры (internal/providers/codex), используют слой провайдеров (internal/providers) и
// производство, которое владеет регистрацией кандидатов (Images).
package agentexec

import (
	"context"

	"songframe-go/internal/agents"
	"songframe-go/internal/mediaapi"
)

// ImagesRequest — KeyframeImagesRequest оригинала: согласованный запуск опор — провайдер, SHA
// запроса и программа-агент с моделью.
type ImagesRequest struct {
	Provider   string
	RequestSha string
	Agent      agents.Settings
}

// Images — KeyframeImages оригинала (владелец — производство): запуск задания опор менеджером
// агентов (StartImages в рабочей папке кандидатов), сбор кандидатов по SHA запроса и SHA
// сохранённого задания после перезапуска приложения.
type Images interface {
	Start(input mediaapi.ImagesInput, request ImagesRequest) (agents.Job, error)
	Collect(job agents.Job, requestSha string) ([]mediaapi.FrameCandidate, error)
	RequestSha(job agents.Job) (string, error)
}

// Prepared — подготовленный запрос опор: SHA согласуется до отправки. Data — замороженный запрос
// адаптера; отправка принимает именно этот объект, повторная отправка того же объекта запрещена.
type Prepared struct {
	Provider   string
	Kind       string
	RequestSha string
	Input      mediaapi.ImagesInput
	References []Reference
}

// Reference — референс запроса: путь внутри проекта и SHA-256 его байтов.
type Reference struct {
	Path   string
	SHA256 string
}

// Permit — подтверждение пользователя для SHA; расходуется одной отправкой (по указателю).
type Permit struct{ RequestSha string }

// Executor — исполнитель опор провайдера-агента: возможности, подготовка, одноразовая отправка и
// сбор результата задания (в том числе после перезапуска).
type Executor interface {
	Provider() string
	Capabilities(ctx context.Context, project string) mediaapi.Capabilities
	Prepare(input mediaapi.ImagesInput) (*Prepared, error)
	Submit(prepared *Prepared, permit *Permit) (mediaapi.AgentExecutionRef, error)
	CollectJob(job agents.Job) ([]mediaapi.Artifact, error)
}

// Deps — общие зависимости исполнителя опор (AgentImageDeps оригинала).
type Deps struct {
	// Images — запуск и сбор заданий опор (производство).
	Images Images
	// Agent — программа-агент провайдера по реестру с моделью из настроек проекта.
	Agent func(model string) (agents.Settings, error)
}

// PurposeReference — назначение «референс проекта»: изображение сохраняется целиком, без
// требований к квадратной обложке.
const PurposeReference = "reference"

// CoverInput — CoverCandidateInput оригинала (владелец — генерация обложек и референсов).
type CoverInput struct {
	// WorkDir — папка попытки <каталог>/image-jobs/<попытка>; временный проект агента — на два
	// уровня выше, его история и настройки остаются рядом с кандидатом.
	WorkDir string
	Project string
	// Prompt — финальный промпт пользователя: передаётся агенту дословно в контексте.
	Prompt string
	// Purpose — "" (обложка) или PurposeReference.
	Purpose string
	// References — закреплённые копии опор; исполнитель передаёт агенту их приватные копии.
	References []mediaapi.ReferenceImage
}

// CoverRunner — CoverCandidateRunner оригинала: исполнитель обложки и референса проекта.
type CoverRunner interface {
	// Run создаёт одно изображение и возвращает путь результата относительно WorkDir. Отмена ctx
	// останавливает генерацию.
	Run(ctx context.Context, input CoverInput) (string, error)
	// ValidateInput проверяет собственный транспорт до выдачи SHA и токена согласования.
	ValidateInput(input CoverInput) error
}
