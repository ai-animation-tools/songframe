package app

import (
	"context"
	"errors"
	"log"
	"sync"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"

	"songframe/internal/agents"
	"songframe/internal/covergen"
	"songframe/internal/mediaapi"
	"songframe/internal/providers"
	"songframe/internal/referenceimage"
	"songframe/internal/wire"
)

// textCoverWindowClosed — applicationTexts.coverWindowClosed.
const textCoverWindowClosed = "Окно генерации обложки закрыто."

// CoverGenerators — генераторы обложки и референсов приложения (группы cover и
// referenceImages): общая подготовка провайдером изображений проекта, различается только назначение.
type CoverGenerators struct {
	Cover     *covergen.Generator
	Reference *covergen.Generator
}

// NewCoverGenerators связывает генераторы с явным выбором провайдера изображений (access), слоем
// провайдеров (платная подготовка через общий адаптер изображений), медиасервером окна (media:
// временная папка сессии обложки разрешается для превью) и декодированием изображений
// средствами Go. Подготовка, проверка цены и отправка выполняются с отменой сессии.
func NewCoverGenerators(access *agents.AccessChecker, layer *providers.Layer, media interface{ AllowRoot(string) error }) CoverGenerators {
	assert := func(project string) error { return access.AssertSelection(&project, agents.KindImage) }
	options := covergen.Options{
		AllowMedia:      media.AllowRoot,
		AssertSelection: assert,
		ReadImage:       covergen.ReadImage,
		CropImage:       covergen.CropImage,
		Prepare: func(ctx context.Context, input covergen.CandidateInput) (*covergen.Candidate, error) {
			return covergen.PrepareProject(ctx, input, covergen.ProjectOptions{
				AssertSelection: assert,
				Paid: func(ctx context.Context, input covergen.CandidateInput, provider string) (*covergen.Candidate, error) {
					// Даже обнаружение и локальная подготовка завершаются до удаления временной сессии при закрытии.
					media, err := layer.RequirePaidMedia(provider, "image")
					if err != nil {
						return nil, err
					}
					return covergen.PreparePaid(ctx, input, covergen.PaidOptions{Media: media})
				},
			})
		},
	}
	reference := options
	reference.Reference = true
	return CoverGenerators{Cover: covergen.New(options), Reference: covergen.New(reference)}
}

// coverRoutes — общая часть маршрутов cover:* и referenceImages:*: проверка доступа,
// проект каждой сессии и владелец-окно. Перезагрузка или закрытие окна закрывает его сессии, не
// оставляя непринятые картинки до завершения приложения.
type coverRoutes struct {
	generator *covergen.Generator
	access    *agents.AccessChecker

	mu sync.Mutex
	// owners — сессии по ID окна; watched — окна, на события которых уже подписаны.
	owners  map[uint]map[string]bool
	watched map[uint]bool
	// projects — проект, переданный при создании сессии: им проверяется
	// доступ при подготовке и запуске.
	projects map[string]string
}

// newCoverRoutes создаёт маршруты группы для генератора.
func newCoverRoutes(generator *covergen.Generator, access *agents.AccessChecker) *coverRoutes {
	return &coverRoutes{generator: generator, access: access, owners: map[uint]map[string]bool{}, watched: map[uint]bool{}, projects: map[string]string{}}
}

// window — окно, вызвавшее binding; nil — вызов не из окна (тесты).
func window(ctx context.Context) application.Window {
	if ctx == nil {
		return nil
	}
	value, _ := ctx.Value(application.WindowKey).(application.Window)
	return value
}

// closeOwned закрывает сессии окна при его закрытии и при новой загрузке страницы
// (WindowRuntimeReady после первой): у перезагруженной страницы прежних сессий нет.
func (r *coverRoutes) closeOwned(windowID uint) {
	r.mu.Lock()
	owned := r.owners[windowID]
	delete(r.owners, windowID)
	ids := make([]string, 0, len(owned))
	for id := range owned {
		ids = append(ids, id)
		delete(r.projects, id)
	}
	r.mu.Unlock()
	for _, id := range ids {
		go func() {
			if err := r.generator.Close(id); err != nil {
				log.Printf("Не удалось очистить временную обложку: %v", err)
			}
		}()
	}
}

// own запоминает сессию за окном и при первой сессии окна подписывается на его закрытие и
// перезагрузку страницы.
func (r *coverRoutes) own(owner application.Window, id string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if owner == nil {
		return
	}
	windowID := owner.ID()
	if r.owners[windowID] == nil {
		r.owners[windowID] = map[string]bool{}
	}
	r.owners[windowID][id] = true
	if r.watched[windowID] {
		return
	}
	r.watched[windowID] = true
	owner.OnWindowEvent(events.Common.WindowClosing, func(*application.WindowEvent) { r.closeOwned(windowID) })
	owner.OnWindowEvent(events.Common.WindowRuntimeReady, func(*application.WindowEvent) { r.closeOwned(windowID) })
}

// create — маршрут create: доступ к провайдеру изображений проекта, затем сессия окна.
func (r *coverRoutes) create(ctx context.Context, project, prompt string, input *referenceimage.GenerationInput) (covergen.Session, error) {
	selected := project
	if err := r.access.RequireAccess(ctx, &selected, agents.KindImage); err != nil {
		return covergen.Session{}, err
	}
	if ctx != nil && ctx.Err() != nil {
		return covergen.Session{}, errors.New(textCoverWindowClosed)
	}
	session, err := r.generator.Create(project, prompt, input)
	if err != nil {
		return covergen.Session{}, err
	}
	r.own(window(ctx), session.ID)
	r.mu.Lock()
	r.projects[session.ID] = project
	r.mu.Unlock()
	return wire.Fill(session), nil
}

// sessionProject — проект сессии для проверки доступа; nil — сессия неизвестна (тогда отказ
// даёт сама проверка выбора или генератор).
func (r *coverRoutes) sessionProject(id string) *string {
	r.mu.Lock()
	defer r.mu.Unlock()
	if project, ok := r.projects[id]; ok {
		return &project
	}
	return nil
}

// prepare — маршрут prepare: доступ, затем подготовка следующей попытки и цены без отправки.
func (r *coverRoutes) prepare(ctx context.Context, id string) (covergen.Session, error) {
	if err := r.access.RequireAccess(ctx, r.sessionProject(id), agents.KindImage); err != nil {
		return covergen.Session{}, err
	}
	return wire.Done(r.generator.Prepare(id))
}

// generate — маршрут generate: доступ, затем запуск по согласию на показанный запрос.
func (r *coverRoutes) generate(ctx context.Context, id, requestSha string, approval *covergen.Approval) (covergen.Session, error) {
	if err := r.access.RequireAccess(ctx, r.sessionProject(id), agents.KindImage); err != nil {
		return covergen.Session{}, err
	}
	return wire.Done(r.generator.Generate(id, requestSha, approval))
}

// close — маршрут close: сессия больше не принадлежит окну и закрывается с ожиданием работы.
func (r *coverRoutes) close(ctx context.Context, id string) error {
	r.mu.Lock()
	if owner := window(ctx); owner != nil {
		delete(r.owners[owner.ID()], id)
	}
	delete(r.projects, id)
	r.mu.Unlock()
	return r.generator.Close(id)
}

// CoverService реализует window.api.cover: генерацию обложки проекта во временной сессии.
type CoverService struct{ routes *coverRoutes }

// NewCoverService создаёт группу cover на генераторе обложки.
func NewCoverService(generator *covergen.Generator, access *agents.AccessChecker) *CoverService {
	return &CoverService{routes: newCoverRoutes(generator, access)}
}

// Inspect читает выбранные опоры без создания сессии (доступно до выбора провайдера).
func (s *CoverService) Inspect(input referenceimage.GenerationInput) ([]mediaapi.ReferenceImage, error) {
	return wire.Done(referenceimage.Inspect(input))
}

// Create создаёт сессию обложки окна после проверки доступа к провайдеру изображений.
func (s *CoverService) Create(ctx context.Context, project, prompt string, input *referenceimage.GenerationInput) (covergen.Session, error) {
	return wire.Done(s.routes.create(ctx, project, prompt, input))
}

// Prepare готовит следующую попытку и цену; запрос генерации не отправляется.
func (s *CoverService) Prepare(ctx context.Context, id string) (covergen.Session, error) {
	return wire.Done(s.routes.prepare(ctx, id))
}

// Generate запускает подготовленную попытку по согласию на показанный SHA и промпт.
func (s *CoverService) Generate(ctx context.Context, id, requestSha string, approval *covergen.Approval) (covergen.Session, error) {
	return wire.Done(s.routes.generate(ctx, id, requestSha, approval))
}

// View — текущее состояние сессии.
func (s *CoverService) View(id string) (covergen.Session, error) {
	return wire.Done(s.routes.generator.View(id))
}

// Accept оставляет во временной сессии только выбранный квадрат для сохранения формы.
func (s *CoverService) Accept(id string, crop *covergen.Crop) (covergen.Accepted, error) {
	return s.routes.generator.Accept(id, crop)
}

// Close закрывает сессию и удаляет её временную папку после остановки работы.
func (s *CoverService) Close(ctx context.Context, id string) error {
	return s.routes.close(ctx, id)
}

// ServiceShutdown закрывает все сессии при завершении приложения.
func (s *CoverService) ServiceShutdown() error {
	return s.routes.generator.Shutdown()
}
