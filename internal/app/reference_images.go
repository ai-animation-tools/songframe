package app

import (
	"context"
	"errors"
	"sync"

	"songframe-go/internal/agents"
	"songframe-go/internal/covergen"
	"songframe-go/internal/mediaapi"
	"songframe-go/internal/referenceimage"
	"songframe-go/internal/wire"
)

// textTargetChanged — referenceImageTexts.targetChanged.
const textTargetChanged = "Это изображение уже принято для другой сущности."

// ReferenceImagesService реализует window.api.referenceImages: генерацию изображения референса
// с архивом попыток в проекте, приёмку полного оригинала и его привязку к сущности кастинга.
type ReferenceImagesService struct {
	routes *coverRoutes

	mu sync.Mutex
	// attached — сущность, к которой уже привязан результат сессии: повтор attach для неё же
	// допустим (renderer мог упасть после ответа), для другой — отказ.
	attached map[string]string
}

// NewReferenceImagesService создаёт группу referenceImages на генераторе референсов.
func NewReferenceImagesService(generator *covergen.Generator, access *agents.AccessChecker) *ReferenceImagesService {
	return &ReferenceImagesService{routes: newCoverRoutes(generator, access), attached: map[string]string{}}
}

// Inspect читает выбранные опоры без создания сессии и объединения одинаковых байтов.
func (s *ReferenceImagesService) Inspect(input referenceimage.GenerationInput) ([]mediaapi.ReferenceImage, error) {
	return wire.Done(referenceimage.Inspect(input))
}

// Context — сведения клипа для конструктора промпта; только чтение.
func (s *ReferenceImagesService) Context(project string, drafts *referenceimage.ContextDrafts) (referenceimage.Context, error) {
	return referenceimage.ReadContext(project, drafts)
}

// Create создаёт сессию референса окна после проверки доступа к провайдеру изображений.
func (s *ReferenceImagesService) Create(ctx context.Context, project, prompt string, input *referenceimage.GenerationInput) (covergen.Session, error) {
	return wire.Done(s.routes.create(ctx, project, prompt, input))
}

// Prepare готовит следующую попытку и цену; запрос генерации не отправляется.
func (s *ReferenceImagesService) Prepare(ctx context.Context, id string) (covergen.Session, error) {
	return wire.Done(s.routes.prepare(ctx, id))
}

// Generate запускает подготовленную попытку по согласию на показанный SHA и промпт.
func (s *ReferenceImagesService) Generate(ctx context.Context, id, requestSha string, approval *covergen.Approval) (covergen.Session, error) {
	return wire.Done(s.routes.generate(ctx, id, requestSha, approval))
}

// View — текущее состояние сессии.
func (s *ReferenceImagesService) View(id string) (covergen.Session, error) {
	return wire.Done(s.routes.generator.View(id))
}

// Accept принимает полный оригинал; он остаётся в архиве попытки проекта.
func (s *ReferenceImagesService) Accept(id string) (referenceimage.Result, error) {
	return s.routes.generator.AcceptReference(id)
}

// Attach принимает оригинал и добавляет его в исходники и к сохранённой сущности кастинга, не
// заменяя прежние изображения. Повтор для той же сущности ничего не меняет.
func (s *ReferenceImagesService) Attach(id, entityID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if previous, ok := s.attached[id]; ok && previous != entityID {
		return errors.New(textTargetChanged)
	}
	result, err := s.routes.generator.AcceptReference(id)
	if err != nil {
		return err
	}
	project, err := s.routes.generator.Project(id)
	if err != nil {
		return err
	}
	if err := referenceimage.Attach(project, entityID, result); err != nil {
		return err
	}
	s.attached[id] = entityID
	return nil
}

// Close закрывает сессию; попытки и квитанция остаются в архиве проекта.
func (s *ReferenceImagesService) Close(ctx context.Context, id string) error {
	return s.routes.close(ctx, id)
}

// ServiceShutdown закрывает все сессии при завершении приложения, сохраняя квитанции.
func (s *ReferenceImagesService) ServiceShutdown() error {
	return s.routes.generator.Shutdown()
}
