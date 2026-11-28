package app

import (
	"context"
	"errors"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"songframe/internal/dynvalue"
	"songframe/internal/mediaadapters"
	"songframe/internal/mediaapi"
	"songframe/internal/productionworkflow"
	"songframe/internal/projectfile"
	"songframe/internal/savedlooks"
	"songframe/internal/sources"
	"songframe/internal/wire"
)

// savedLooksTimeout — предел одного действия библиотеки образов: бесплатные вызовы, но создание
// загружает до четырёх снимков.
const savedLooksTimeout = 90 * time.Second

// SavedLooksView — состояние сохранённых образов проекта для «Исходников» и кастинга.
type SavedLooksView struct {
	// Supported — провайдер видео проекта хранит образы; false — блок образов не показывается, а
	// остальные поля пусты.
	Supported bool `json:"supported"`
	// Provider — id провайдера видео проекта; "" — не выбран.
	Provider string `json:"provider"`
	// Rules — ограничения образа у провайдера (окно создания).
	Rules *mediaapi.SavedLookRules `json:"rules"`
	// Report — статусы референсов и образы аккаунта; nil — список не получен (см. Error).
	Report *savedlooks.Report `json:"report"`
	// Error — почему статусы неизвестны: нет входа, сервис не ответил, повреждён файл привязок.
	Error string `json:"error"`
}

// SavedLookInput — новый образ из сохранённых снимков референса: пути — как в описи (внутри source).
type SavedLookInput struct {
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Kind        string   `json:"kind"`
	Cover       string   `json:"cover"`
	Extra       []string `json:"extra"`
}

// ShotLook — герой «В кадре» плана и его образ: по ним окно своего видеопромпта предлагает
// метки героев с образами.
type ShotLook struct {
	Code string `json:"code"`
	Name string `json:"name"`
	// Kind — вид сущности кастинга: проверка перед описанием спрашивает только о видах из Kinds.
	Kind string `json:"kind"`
	// Status — savedlooks.Status*; Look и LookName — привязанный образ.
	Status   string `json:"status"`
	Look     string `json:"look,omitempty"`
	LookName string `json:"lookName,omitempty"`
}

// ShotLooksView — образы героев «В кадре» плана.
type ShotLooksView struct {
	// Supported — провайдер видео проекта хранит образы.
	Supported bool `json:"supported"`
	// Model и Limit — модель, которую сборка запроса плана пробует первой, и сколько образов она
	// примет (0 — не принимает): по ним проверка перед описанием спрашивает о героях без образа.
	Model string `json:"model"`
	Limit int    `json:"limit"`
	// Kinds — виды сущностей, чей образ принимает модель Model.
	Kinds []string `json:"kinds"`
	// References — проверка для попытки по референсам: модель — модель режима по референсам, облик
	// героев без образа держит их картинка, а не опоры.
	References bool       `json:"references"`
	Heroes     []ShotLook `json:"heroes"`
	// Error — почему статусы неизвестны; статусы героев тогда none.
	Error string `json:"error"`
}

// SavedLooksService реализует группу window.api.savedLooks: статусы, создание, привязку, отвязку
// и удаление сохранённых образов у референсов «Исходников». Образ создаёт и удаляет только
// пользователь кнопками окна образа; удаление в аккаунте renderer вызывает после отдельного
// подтверждения. Привязки ведёт internal/savedlooks в каталоге состояния, проект не меняется.
type SavedLooksService struct {
	// stateDir — каталог состояния приложения; nil — mediaadapters.StateDir.
	stateDir func() (string, error)
	// models — ожидаемая модель видео плана (проход производства); nil — модель неизвестна, Limit 0.
	models LookModels
}

// LookModels — источник ожидаемой модели видео плана и её предела образов.
type LookModels interface {
	ExpectedLookModel(ctx context.Context, project string, references bool) (productionworkflow.LookModel, error)
}

// NewSavedLooksService — группа на каталоге состояния и таблице адаптеров приложения; models —
// проход производства, знающий выбор модели видео.
func NewSavedLooksService(models LookModels) *SavedLooksService {
	return &SavedLooksService{models: models}
}

// Тексты группы.
var (
	errLooksUnsupported = errors.New("Провайдер видео проекта не хранит образы.")
	errLookReference    = errors.New("Референса нет в сохранённых исходниках: сохраните исходники и повторите.")
	errLookFile         = errors.New("Снимок не принадлежит референсу или ещё не сохранён.")
	errLookNotInAccount = errors.New("Образа нет в аккаунте: откройте «Исходники» заново.")
)

// store — привязки в каталоге состояния.
func (s *SavedLooksService) store() (savedlooks.Store, error) {
	dir := mediaadapters.StateDir
	if s.stateDir != nil {
		dir = s.stateDir
	}
	path, err := dir()
	return savedlooks.Store{Dir: path}, err
}

// videoProvider — подтверждённый generation.video.provider проекта (как у «Производства»); "" —
// не выбран.
func videoProvider(project string) (string, error) {
	settings, err := projectfile.ReadSettings(project)
	if err != nil {
		return "", err
	}
	generation, _ := dynvalue.Parse(settings.Generation)
	video := dynvalue.Get(generation, "video")
	provider, ok := dynvalue.Get(video, "provider").(string)
	if !dynvalue.StrictEqual(dynvalue.Get(video, "provider_selected"), true) || !ok {
		return "", nil
	}
	return strings.ToLower(dynvalue.Trim(provider)), nil
}

// library — провайдер видео проекта и его библиотека образов; nil — провайдер их не хранит.
func (s *SavedLooksService) library(project string) (string, mediaapi.SavedLooks, error) {
	provider, err := videoProvider(project)
	if err != nil || provider == "" {
		return "", nil, err
	}
	adapter, ok := mediaadapters.Get(provider)
	if !ok {
		return provider, nil, nil
	}
	looks, _ := adapter.(mediaapi.SavedLooks)
	return provider, looks, nil
}

// View — savedLooks.view: статусы образов референсов проекта одним бесплатным списком
// библиотеки. Сбой списка не отклоняет вызов: он приходит в Error, и страница остаётся рабочей.
func (s *SavedLooksService) View(ctx context.Context, project string) (SavedLooksView, error) {
	provider, looks, err := s.library(project)
	if err != nil || looks == nil {
		return wire.Done(SavedLooksView{Provider: provider}, err)
	}
	rules := looks.SavedLookRules()
	view := SavedLooksView{Supported: true, Provider: provider, Rules: &rules}
	store, err := s.store()
	if err != nil {
		return wire.Done(view, err)
	}
	ctx, cancel := context.WithTimeout(ctx, savedLooksTimeout)
	defer cancel()
	report, err := store.Check(ctx, looks, provider, project, savedLooksTimeout)
	if err != nil {
		view.Error = err.Error()
	} else {
		view.Report = &report
	}
	return wire.Done(view, nil)
}

// prepare — провайдер, библиотека, привязки, референс описи и текущий аккаунт для изменяющего
// действия.
func (s *SavedLooksService) prepare(ctx context.Context, project, reference string) (string, mediaapi.SavedLooks, savedlooks.Store, *savedlooks.Reference, mediaapi.SavedLookLibrary, error) {
	provider, looks, err := s.library(project)
	if err == nil && looks == nil {
		err = errLooksUnsupported
	}
	if err != nil {
		return "", nil, savedlooks.Store{}, nil, mediaapi.SavedLookLibrary{}, err
	}
	store, err := s.store()
	if err != nil {
		return "", nil, savedlooks.Store{}, nil, mediaapi.SavedLookLibrary{}, err
	}
	var found *savedlooks.Reference
	if reference != "" {
		references, err := savedlooks.References(project)
		if err != nil {
			return "", nil, savedlooks.Store{}, nil, mediaapi.SavedLookLibrary{}, err
		}
		index := slices.IndexFunc(references, func(item savedlooks.Reference) bool { return item.ID == reference })
		if index < 0 {
			return "", nil, savedlooks.Store{}, nil, mediaapi.SavedLookLibrary{}, errLookReference
		}
		found = &references[index]
	}
	library, err := looks.ListSavedLooks(ctx, savedLooksTimeout)
	return provider, looks, store, found, library, err
}

// fileSHA — SHA-256 сохранённого снимка референса по пути описи.
func fileSHA(project, reference, path string) (string, error) {
	manifest := sources.ReadManifest(project)
	items, _ := dynvalue.AsArray(dynvalue.Get(manifest, "references"))
	for _, item := range items {
		if dynvalue.Get(item, "id") != reference {
			continue
		}
		files, _ := dynvalue.AsArray(dynvalue.Get(item, "files"))
		for _, entry := range files {
			sha, _ := dynvalue.Get(entry, "sha256").(string)
			if dynvalue.Get(entry, "path") == path && sha != "" {
				return sha, nil
			}
		}
	}
	return "", errLookFile
}

// Create — savedLooks.create: новый образ из сохранённых снимков референса и его привязка.
// Снимки берутся только из описи референса: так SHA в привязке совпадают с теми, по которым
// потом считается «устарел».
func (s *SavedLooksService) Create(ctx context.Context, project, reference string, input SavedLookInput) (SavedLooksView, error) {
	ctx, cancel := context.WithTimeout(ctx, savedLooksTimeout)
	defer cancel()
	provider, looks, store, found, library, err := s.prepare(ctx, project, reference)
	if err != nil {
		return wire.Done(SavedLooksView{}, err)
	}
	paths := append([]string{input.Cover}, input.Extra...)
	images := make([]string, 0, len(paths))
	absolute := make([]string, 0, len(paths))
	for _, path := range paths {
		if path == "" {
			continue
		}
		sha, err := fileSHA(project, found.ID, path)
		if err != nil {
			return wire.Done(SavedLooksView{}, err)
		}
		images = append(images, sha)
		absolute = append(absolute, filepath.Join(project, "source", filepath.FromSlash(path)))
	}
	draft := mediaapi.SavedLookDraft{Name: input.Name, Description: input.Description, Kind: input.Kind}
	if input.Cover != "" {
		draft.Cover, draft.Extra = absolute[0], absolute[1:]
	}
	look, err := looks.CreateSavedLook(ctx, draft, savedLooksTimeout)
	if err != nil {
		return wire.Done(SavedLooksView{}, err)
	}
	binding := savedlooks.Binding{Account: library.Account, Project: project, Reference: found.ID, Look: look.ID, Name: look.Name, Images: images, Created: true}
	if err := store.Bind(provider, binding); err != nil {
		return wire.Done(SavedLooksView{}, err)
	}
	return s.View(ctx, project)
}

// Bind — savedLooks.bind: привязка готового образа аккаунта (например, сделанного на сайте
// провайдера) к референсу. SHA — все снимки референса сейчас: их смена сделает образ устаревшим.
func (s *SavedLooksService) Bind(ctx context.Context, project, reference, look string) (SavedLooksView, error) {
	ctx, cancel := context.WithTimeout(ctx, savedLooksTimeout)
	defer cancel()
	provider, _, store, found, library, err := s.prepare(ctx, project, reference)
	if err != nil {
		return wire.Done(SavedLooksView{}, err)
	}
	index := slices.IndexFunc(library.Looks, func(item mediaapi.SavedLook) bool { return item.ID == look })
	if index < 0 {
		return wire.Done(SavedLooksView{}, errLookNotInAccount)
	}
	binding := savedlooks.Binding{Account: library.Account, Project: project, Reference: found.ID, Look: look, Name: library.Looks[index].Name, Images: found.Images}
	if err := store.Bind(provider, binding); err != nil {
		return wire.Done(SavedLooksView{}, err)
	}
	return s.View(ctx, project)
}

// Unbind — savedLooks.unbind: убирает привязку референса; образ остаётся в аккаунте.
func (s *SavedLooksService) Unbind(ctx context.Context, project, reference string) (SavedLooksView, error) {
	ctx, cancel := context.WithTimeout(ctx, savedLooksTimeout)
	defer cancel()
	provider, _, store, _, library, err := s.prepare(ctx, project, "")
	if err != nil {
		return wire.Done(SavedLooksView{}, err)
	}
	if err := store.Unbind(provider, library.Account, project, reference); err != nil {
		return wire.Done(SavedLooksView{}, err)
	}
	return s.View(ctx, project)
}

// Remove — savedLooks.remove: удаляет образ из аккаунта провайдера и все привязки к нему.
// Необратимо: renderer вызывает только после отдельного подтверждения с именем образа.
func (s *SavedLooksService) Remove(ctx context.Context, project, look string) (SavedLooksView, error) {
	ctx, cancel := context.WithTimeout(ctx, savedLooksTimeout)
	defer cancel()
	provider, looks, store, _, library, err := s.prepare(ctx, project, "")
	if err != nil {
		return wire.Done(SavedLooksView{}, err)
	}
	if err := looks.DeleteSavedLook(ctx, look, savedLooksTimeout); err != nil {
		return wire.Done(SavedLooksView{}, err)
	}
	if err := store.ForgetLook(provider, library.Account, look); err != nil {
		return wire.Done(SavedLooksView{}, err)
	}
	return s.View(ctx, project)
}

// Shot — savedLooks.shot: герои «В кадре» плана shot со статусами образов одним бесплатным
// списком библиотеки. references — новая попытка по референсам: модель ожидается из режима по
// референсам. Сбой списка приходит в Error, как у View.
func (s *SavedLooksService) Shot(ctx context.Context, project, shot string, references bool) (ShotLooksView, error) {
	provider, looks, err := s.library(project)
	if err != nil || looks == nil {
		return wire.Done(ShotLooksView{}, err)
	}
	entities, err := productionworkflow.ShotEntities(project, shot)
	if err != nil {
		return wire.Done(ShotLooksView{}, err)
	}
	view := ShotLooksView{Supported: true, References: references, Heroes: make([]ShotLook, len(entities))}
	for index, entity := range entities {
		view.Heroes[index] = ShotLook{Code: entity.Code, Name: entity.Name, Kind: entity.Kind, Status: savedlooks.StatusNone}
	}
	if s.models != nil {
		model, err := s.models.ExpectedLookModel(ctx, project, references)
		if err != nil {
			return wire.Done(view, err)
		}
		view.Model, view.Limit, view.Kinds = model.Model, model.Limit, model.Kinds
	}
	store, err := s.store()
	if err != nil {
		return wire.Done(view, err)
	}
	ctx, cancel := context.WithTimeout(ctx, savedLooksTimeout)
	defer cancel()
	report, err := store.Check(ctx, looks, provider, project, savedLooksTimeout)
	if err != nil {
		view.Error = err.Error()
		return wire.Done(view, nil)
	}
	for index, hero := range view.Heroes {
		for _, state := range report.States {
			if state.Reference == hero.Code {
				view.Heroes[index].Status, view.Heroes[index].Look, view.Heroes[index].LookName = state.Status, state.Look, state.Name
			}
		}
	}
	return wire.Done(view, nil)
}
