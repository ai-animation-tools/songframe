// Package covergen генерирует обложку проекта и изображения референсов. Обе формы — одна машина
// состояний Generator:
//
//   - обложка живёт во временной папке ОС; только принятый квадратный PNG (accepted.png)
//     переносит форма «Исходники», а закрытие сессии удаляет папку целиком;
//   - референс (Options.Reference) хранит каждую попытку в архиве проекта
//     plan/reference-images/<ID сессии>/ вместе с квитанцией session.json: оплаченные оригиналы и
//     запросы не теряются при закрытии окна, а принятый полный оригинал отдельно публикует
//     referenceimage.Attach.
//
// Платная отправка разрешается только явным согласием на показанный промпт: каждая подготовка
// выдаёт новый approvalToken, согласие расходуется одной попыткой («Ещё» и повтор требуют новой
// подготовки), неизвестная цена допускает одну отправку только с allowUnknownCost, известная
// нехватка средств отправку запрещает. Подготовку запроса выполняет провайдер изображений
// проекта (PrepareProject): программа-агент по реестру или платный провайдер (PreparePaid).
//
// Сессии живут в памяти процесса; фоновые подготовка и генерация — горутины с отменой через
// context, а не задания internal/jobs: они не показываются в списке заданий, и окно ждёт их само
// (view). Закрытие сессии отменяет работу и дожидается её завершения до
// удаления временной папки.
package covergen

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"

	"songframe/internal/dynvalue"
	"songframe/internal/mediaapi"
	"songframe/internal/mediafile"
	"songframe/internal/mediaproviders"
	"songframe/internal/projectfile"
	"songframe/internal/projectfs"
	"songframe/internal/providers/agentexec"
	"songframe/internal/referenceimage"
)

// Статусы сессии (CoverGenerationSession.status контракта).
const (
	StatusIdle       = "idle"
	StatusGenerating = "generating"
	StatusReady      = "ready"
	StatusFailed     = "failed"
	StatusAccepted   = "accepted"
)

// Вердикты проверки цены cost_check.
const (
	VerdictOK                   = "ok"
	VerdictInsufficientBalance  = "insufficient_balance"
	VerdictCostOrBalanceUnknown = "cost_or_balance_unknown"
)

// promptLimit — предел описания в байтах UTF-8 (32 КБ).
const promptLimit = 32 * 1024

// Image — изображение сессии: абсолютный путь кандидата (или принятой обложки) и размеры.
type Image struct {
	Path   string `json:"path"`
	Width  int    `json:"width"`
	Height int    `json:"height"`
}

// Quote — цена подготовленного платного запроса: стоимость и остаток кредитов (nil — неизвестно)
// и вердикт cost_check. Message — причины проверки или текст сбоя проверки; "" — поля нет.
type Quote struct {
	Credits *float64 `json:"credits"`
	Balance *float64 `json:"balance"`
	Verdict string   `json:"verdict"`
	Message string   `json:"message,omitempty"`
}

// Session — CoverGenerationSession контракта. Порядок полей зафиксирован: он виден в квитанции
// session.json архива референса.
type Session struct {
	ID     string `json:"id"`
	Prompt string `json:"prompt"`
	// ReferenceImages — закреплённые копии выбранных опор в папке сессии (references/R001.ext …).
	ReferenceImages []mediaapi.ReferenceImage `json:"referenceImages"`
	Status          string                    `json:"status"`
	Image           *Image                    `json:"image"`
	Error           *string                   `json:"error"`
	Provider        string                    `json:"provider"`
	Model           *string                   `json:"model"`
	Preparing       bool                      `json:"preparing"`
	// RequestSha и ApprovalToken — подготовленный запрос и одноразовый токен согласия на него;
	// nil — согласовывать нечего.
	RequestSha    *string `json:"requestSha"`
	ApprovalToken *string `json:"approvalToken"`
	Quote         *Quote  `json:"quote"`
}

// clone — глубокая копия сессии: ответ renderer не делит срезы и указатели с состоянием.
func (s Session) clone() Session {
	result := s
	result.ReferenceImages = append([]mediaapi.ReferenceImage{}, s.ReferenceImages...)
	if s.Image != nil {
		image := *s.Image
		result.Image = &image
	}
	if s.Quote != nil {
		quote := *s.Quote
		result.Quote = &quote
	}
	return result
}

// Approval — CoverGenerationApproval контракта: подтверждение показанного промпта для токена
// текущей подготовки и, для неизвестной цены, отдельное согласие на одну отправку.
type Approval struct {
	ApprovalToken    string `json:"approvalToken"`
	PromptConfirmed  bool   `json:"promptConfirmed"`
	AllowUnknownCost bool   `json:"allowUnknownCost,omitempty"`
}

// Crop — CoverCrop контракта: квадрат обложки в пикселях исходного изображения. Значения —
// числа JSON: целостность (безопасное целое) проверяет Accept.
type Crop struct {
	X    float64 `json:"x"`
	Y    float64 `json:"y"`
	Size float64 `json:"size"`
}

// Accepted — принятая обложка: id сессии и путь квадратного PNG во временной папке.
type Accepted struct {
	ID   string `json:"id"`
	Path string `json:"path"`
}

// CandidateInput — вход подготовки запроса; отмену передаёт context.
type CandidateInput = agentexec.CoverInput

// Candidate — подготовленный запрос провайдера (PreparedCoverCandidate). Generate выполняет
// единственную попытку и возвращает путь результата (абсолютный или относительно WorkDir);
// allowUnknownCost — согласие пользователя на неизвестную цену для этой попытки.
type Candidate struct {
	Provider   string
	Model      *string
	RequestSha string
	Quote      *Quote
	Generate   func(ctx context.Context, allowUnknownCost bool) (string, error)
}

// Options — зависимости генератора.
type Options struct {
	// Reference — режим референса: попытки и квитанции хранятся в архиве проекта.
	Reference bool
	// AssertSelection проверяет явный выбор провайдера изображений без диагностики.
	AssertSelection func(project string) error
	// ReadImage — размеры изображения, которое декодируется целиком; false — не изображение.
	ReadImage func(path string) (width, height int, ok bool)
	// CropImage вырезает квадрат crop из input и пишет PNG в output.
	CropImage func(input, output string, crop Crop) error
	// Prepare — подготовка запроса провайдером изображений проекта (PrepareProject).
	Prepare func(ctx context.Context, input CandidateInput) (*Candidate, error)
	// TempDir — каталог временных папок обложки; nil — os.TempDir.
	TempDir func() string
	// AllowMedia разрешает медиасерверу окна папку сессии: копии опор и результаты обложки лежат
	// во временной папке ОС вне проекта, и без разрешения окно не может показать их превью.
	// Ошибка не мешает генерации; nil — не нужно (тесты).
	AllowMedia func(directory string) error
	// NewID — генератор ID сессий, попыток и токенов; nil — crypto.randomUUID. Тесты и эталоны
	// подменяют его ради стабильных путей.
	NewID func() string
}

// prepared — подготовленная попытка: кандидат, его папка и копии опор этой попытки.
type prepared struct {
	candidate  *Candidate
	workDir    string
	references []mediaapi.ReferenceImage
}

// record — сессия и её служебное состояние. Все поля защищены Generator.mu; done закрывается по
// завершении текущей фоновой работы (подготовки или генерации).
type record struct {
	session  Session
	project  string
	root     string
	closed   bool
	cancel   context.CancelFunc
	done     chan struct{}
	prepared *prepared
}

// Generator — сессии одной формы (обложки или референса).
// Безопасен для одновременных вызовов из Wails: состояние сессий защищено мьютексом, долгие
// вызовы провайдера выполняются без него.
type Generator struct {
	options  Options
	texts    texts
	mu       sync.Mutex
	sessions map[string]*record
	stopping bool
}

// New создаёт генератор с зависимостями options.
func New(options Options) *Generator {
	if options.TempDir == nil {
		options.TempDir = os.TempDir
	}
	if options.NewID == nil {
		options.NewID = randomUUID
	}
	return &Generator{options: options, texts: textsFor(options.Reference), sessions: map[string]*record{}}
}

// randomUUID — crypto.randomUUID (версия 4).
func randomUUID() string {
	var data [16]byte
	_, _ = rand.Read(data[:])
	data[6] = data[6]&0x0f | 0x40
	data[8] = data[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", data[0:4], data[4:6], data[6:8], data[8:10], data[10:16])
}

// imageSettings — generation.image настроек проекта как значение dynvalue: nil — блока нет или он не
// объект, Undefined — нет блока generation. Ошибка чтения plan/project.json — projectReadFailed.
func imageSettings(project string) (any, error) {
	settings, err := projectfile.ReadSettings(project)
	if err != nil {
		return nil, err
	}
	generation, err := dynvalue.Parse(settings.Generation)
	if err != nil {
		return nil, err
	}
	return dynvalue.Get(generation, "image"), nil
}

// trimmedModel — model настроек изображения без пробелов по краям: null и отсутствие — "", не
// строка — TypeError.
func trimmedModel(settings any) (string, error) {
	value := dynvalue.Get(settings, "model")
	if dynvalue.IsNullish(value) {
		return "", nil
	}
	text, ok := value.(string)
	if !ok {
		return "", &dynvalue.TypeError{Message: "imageSettings.model?.trim is not a function"}
	}
	return dynvalue.Trim(text), nil
}

// copyReferences фиксирует опоры: проверенные копии R001<расширение>, R002… в directory. Пустой
// список папку не создаёт.
func copyReferences(images []mediaapi.ReferenceImage, directory string) ([]mediaapi.ReferenceImage, error) {
	if len(images) == 0 {
		return []mediaapi.ReferenceImage{}, nil
	}
	if err := os.MkdirAll(directory, 0o777); err != nil {
		return nil, dynvalue.FsError("mkdir", directory, err)
	}
	checked, err := mediafile.CheckedReferences(images)
	if err != nil {
		return nil, err
	}
	copies := make([]mediaapi.ReferenceImage, len(checked))
	for index, image := range checked {
		path := filepath.Join(directory, fmt.Sprintf("R%03d%s", index+1, strings.ToLower(filepath.Ext(image.Path))))
		if err := copyFile(image.Path, path); err != nil {
			return nil, err
		}
		image.Path = path
		copies[index] = image
	}
	return mediafile.CheckedReferences(copies)
}

// copyFile — байты и права источника в новом (или заменённом) файле.
func copyFile(from, to string) error {
	data, err := os.ReadFile(from)
	if err != nil {
		return dynvalue.FsError("copyfile", from, err)
	}
	info, err := os.Stat(from)
	if err != nil {
		return dynvalue.FsError("copyfile", from, err)
	}
	if err := os.WriteFile(to, data, info.Mode().Perm()); err != nil {
		return dynvalue.FsError("copyfile", to, err)
	}
	return nil
}

// Create — cover.create / referenceImages.create: проверяет проект, явный выбор провайдера
// изображений, описание и опоры и создаёт сессию без генерации. Опоры копируются в папку сессии
// (references/): дальнейшие правки исходников на попытку не влияют. Референс создаёт папку
// архива plan/reference-images/<ID>; при отказе фиксации опор папка сессии удаляется.
func (g *Generator) Create(project, prompt string, input *referenceimage.GenerationInput) (Session, error) {
	g.mu.Lock()
	stopping := g.stopping
	g.mu.Unlock()
	t := g.texts
	if stopping {
		return Session{}, errors.New(t.applicationStopping)
	}
	if !dynvalue.IsAbs(project) || strings.ContainsRune(project, 0) {
		return Session{}, errors.New(t.projectRequired)
	}
	canonical, err := dynvalue.Realpath(project)
	if err != nil {
		return Session{}, errors.New(t.projectMissing)
	}
	if !dynvalue.Exists(filepath.Join(canonical, "plan", "project.json")) {
		return Session{}, errors.New(t.projectPlanMissing)
	}
	settings, err := imageSettings(canonical)
	if err != nil {
		return Session{}, err
	}
	provider := dynvalue.Get(settings, "provider")
	if !mediaproviders.Supports(provider, mediaproviders.Image) {
		return Session{}, errors.New(imageProviderRequired())
	}
	if err := g.options.AssertSelection(canonical); err != nil {
		return Session{}, err
	}
	if dynvalue.Trim(prompt) == "" || strings.ContainsRune(prompt, 0) || len(prompt) > promptLimit {
		return Session{}, errors.New(t.promptInvalid)
	}
	inputs, err := referenceimage.Inputs(input)
	if err != nil {
		return Session{}, err
	}
	model, err := trimmedModel(settings)
	if err != nil {
		return Session{}, err
	}
	id := g.options.NewID()
	var root string
	if g.options.Reference {
		archive := filepath.Join(canonical, "plan", "reference-images", id)
		if err := os.MkdirAll(archive, 0o777); err != nil {
			return Session{}, dynvalue.FsError("mkdir", archive, err)
		}
		if root, err = dynvalue.Realpath(archive); err != nil {
			return Session{}, err
		}
	} else {
		temporary, err := os.MkdirTemp(g.options.TempDir(), "songframe-cover-")
		if err != nil {
			return Session{}, dynvalue.FsError("mkdtemp", filepath.Join(g.options.TempDir(), "songframe-cover-XXXXXX"), err)
		}
		if root, err = dynvalue.Realpath(temporary); err != nil {
			return Session{}, err
		}
	}
	if g.options.AllowMedia != nil {
		_ = g.options.AllowMedia(root)
	}
	session := Session{ID: id, Prompt: prompt, ReferenceImages: []mediaapi.ReferenceImage{}, Status: StatusIdle, Provider: provider.(string)}
	if model != "" {
		session.Model = &model
	}
	copies, err := copyReferences(inputs, filepath.Join(root, "references"))
	if err == nil {
		session.ReferenceImages, err = mediafile.CheckedReferences(copies)
	}
	if err != nil {
		_ = os.RemoveAll(root)
		return Session{}, err
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	g.sessions[id] = &record{session: session, project: canonical, root: root}
	return session.clone(), nil
}

// record — открытая сессия или «сессия закрыта». Вызывается под g.mu.
func (g *Generator) record(id string) (*record, error) {
	item, ok := g.sessions[id]
	if !ok || item.closed {
		return nil, errors.New(g.texts.sessionClosed)
	}
	return item, nil
}

// Prepare — cover.prepare: новая подготовка запроса. Прежняя неотправленная подготовка удаляется,
// согласие и цена сбрасываются; провайдер готовит запрос в новой папке image-jobs/<ID> с
// собственными копиями опор. Успех выдаёт SHA запроса, цену и новый одноразовый approvalToken;
// ошибка остаётся в сессии (status failed, а при уже полученном изображении — ready). Метод
// ждёт окончания подготовки и возвращает состояние сессии.
func (g *Generator) Prepare(id string) (Session, error) {
	g.mu.Lock()
	item, err := g.record(id)
	if err != nil {
		g.mu.Unlock()
		return Session{}, err
	}
	project := item.project
	g.mu.Unlock()
	if err := g.options.AssertSelection(project); err != nil {
		return Session{}, err
	}
	g.mu.Lock()
	if item.closed {
		g.mu.Unlock()
		return Session{}, errors.New(g.texts.sessionClosed)
	}
	if item.session.Preparing || item.session.Status == StatusGenerating {
		g.mu.Unlock()
		return Session{}, errors.New(g.texts.busy)
	}
	if item.session.Status == StatusAccepted {
		g.mu.Unlock()
		return Session{}, errors.New(g.texts.alreadyAccepted)
	}
	if item.prepared != nil {
		_ = os.RemoveAll(item.prepared.workDir)
	}
	item.prepared = nil
	item.session.Preparing = true
	item.session.RequestSha, item.session.ApprovalToken, item.session.Quote, item.session.Error = nil, nil, nil, nil
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	item.cancel, item.done = cancel, done
	workDir := filepath.Join(item.root, "image-jobs", g.options.NewID())
	sessionReferences := item.session.ReferenceImages
	prompt := item.session.Prompt
	g.mu.Unlock()

	g.runPrepare(ctx, item, workDir, prompt, sessionReferences)
	cancel()
	close(done)
	g.mu.Lock()
	defer g.mu.Unlock()
	if _, err := g.record(id); err != nil {
		return Session{}, err
	}
	return item.session.clone(), nil
}

// runPrepare — тело подготовки: копии опор, запрос провайдера и запись результата в сессию.
// Закрытая во время подготовки сессия ничего не записывает.
func (g *Generator) runPrepare(ctx context.Context, item *record, workDir, prompt string, references []mediaapi.ReferenceImage) {
	candidate, copies, err := func() (*Candidate, []mediaapi.ReferenceImage, error) {
		if err := os.MkdirAll(workDir, 0o777); err != nil {
			return nil, nil, dynvalue.FsError("mkdir", workDir, err)
		}
		copies, err := copyReferences(references, filepath.Join(workDir, "references"))
		if err != nil {
			return nil, nil, err
		}
		input := CandidateInput{WorkDir: workDir, Project: item.project, Prompt: prompt, References: copies}
		if g.options.Reference {
			input.Purpose = agentexec.PurposeReference
		}
		candidate, err := g.options.Prepare(ctx, input)
		return candidate, copies, err
	}()
	g.mu.Lock()
	defer g.mu.Unlock()
	defer func() { item.session.Preparing = false }()
	if item.closed {
		return
	}
	if err == nil && (candidate == nil || candidate.RequestSha == "" || !mediaproviders.Supports(candidate.Provider, mediaproviders.Image)) {
		err = errors.New(g.texts.requestPrepareFailed)
	}
	if err != nil {
		_ = os.RemoveAll(workDir)
		item.session.Status = StatusFailed
		if item.session.Image != nil {
			item.session.Status = StatusReady
		}
		message := err.Error()
		item.session.Error = &message
		return
	}
	item.prepared = &prepared{candidate: candidate, workDir: workDir, references: copies}
	token := g.options.NewID()
	sha := candidate.RequestSha
	item.session.Provider = candidate.Provider
	item.session.Model = candidate.Model
	item.session.RequestSha = &sha
	item.session.ApprovalToken = &token
	item.session.Quote = candidate.Quote
}

// priceAllowsGeneration — правило frontend/src/shared/generation-consent.ts: цена подтверждена
// либо пользователь согласился на неизвестную цену, которую можно согласовать
// (canAgreeToUnknownCost).
func priceAllowsGeneration(quote *Quote, agreed bool) bool {
	return quote != nil && (quote.Verdict == VerdictOK || (agreed && canAgreeToUnknownCost(quote)))
}

// canAgreeToUnknownCost — неизвестна именно стоимость (credits nil), а не только остаток.
func canAgreeToUnknownCost(quote *Quote) bool {
	return quote != nil && quote.Verdict == VerdictCostOrBalanceUnknown && quote.Credits == nil
}

// currentProvider — generation.image.provider проекта (строгое сравнение: не строка не совпадает
// ни с одним id).
func currentProvider(project string) (any, error) {
	settings, err := imageSettings(project)
	if err != nil {
		return nil, err
	}
	return dynvalue.Get(settings, "provider"), nil
}

// Generate — cover.generate: запуск подготовленной попытки по явному согласию. Запрос должен
// совпасть с показанным SHA, промпт — подтверждён для токена текущей подготовки (даже при
// совпадающем SHA следующей), провайдер проекта — не измениться, цена платного провайдера —
// быть подтверждённой или согласованной как неизвестная; закреплённые опоры не должны
// измениться. Подготовка расходуется до запуска: повтор, «Ещё» и попытка после ошибки требуют
// новой подготовки. Обложка удаляет прежние кандидаты, референс сохраняет их в архиве и
// записывает квитанцию. Генерация идёт в фоне; метод возвращает состояние generating.
func (g *Generator) Generate(id, requestSha string, approval *Approval) (Session, error) {
	g.mu.Lock()
	item, err := g.record(id)
	if err != nil {
		g.mu.Unlock()
		return Session{}, err
	}
	project := item.project
	g.mu.Unlock()
	if err := g.options.AssertSelection(project); err != nil {
		return Session{}, err
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if item.closed {
		return Session{}, errors.New(g.texts.sessionClosed)
	}
	t := g.texts
	if item.session.Preparing || item.session.Status == StatusGenerating {
		return Session{}, errors.New(t.busy)
	}
	if item.session.Status == StatusAccepted {
		return Session{}, errors.New(t.acceptedNeedsNewSession)
	}
	attempt := item.prepared
	if attempt == nil || requestSha == "" || attempt.candidate.RequestSha != requestSha {
		return Session{}, errors.New(t.requestRequired)
	}
	// Согласие относится к показанному промпту и этой подготовке, даже когда SHA следующей попытки совпадает.
	if approval == nil || !approval.PromptConfirmed || item.session.ApprovalToken == nil || approval.ApprovalToken != *item.session.ApprovalToken {
		return Session{}, errors.New(t.promptConfirmationRequired)
	}
	provider, err := currentProvider(project)
	if err != nil {
		return Session{}, err
	}
	if provider != attempt.candidate.Provider {
		return Session{}, errors.New(t.providerChanged)
	}
	info, _ := mediaproviders.Lookup(attempt.candidate.Provider)
	if info.Paid && !priceAllowsGeneration(attempt.candidate.Quote, approval.AllowUnknownCost) {
		return Session{}, errors.New(t.costBlocked(info.Title))
	}
	if _, err := mediafile.CheckedReferences(item.session.ReferenceImages); err != nil {
		return Session{}, err
	}
	if _, err := mediafile.CheckedReferences(attempt.references); err != nil {
		return Session{}, err
	}
	item.prepared = nil
	item.session.ApprovalToken = nil
	// Согласованный запрос расходуется один раз; старый кандидат удаляется только после явного запуска.
	if !g.options.Reference {
		g.clear(item, "image-jobs", "references")
		jobs := filepath.Join(item.root, "image-jobs")
		entries, _ := os.ReadDir(jobs)
		for _, entry := range entries {
			if path := filepath.Join(jobs, entry.Name()); path != attempt.workDir {
				_ = os.RemoveAll(path)
			}
		}
	}
	item.session.Status = StatusGenerating
	item.session.Image, item.session.Error, item.session.RequestSha = nil, nil, nil
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	item.cancel, item.done = cancel, done
	if err := g.archive(item); err != nil {
		item.session.Status = StatusFailed
		message := textArchiveFailed
		item.session.Error = &message
		cancel()
		close(done)
		return Session{}, err
	}
	allowUnknownCost := approval.AllowUnknownCost
	// Отложенный запуск позволяет немедленно закрыть диалог, не создавая процесс после отмены.
	go func() {
		defer close(done)
		defer cancel()
		g.run(ctx, item, attempt, allowUnknownCost)
	}()
	return item.session.clone(), nil
}

// run — фоновая генерация подготовленной попытки. Настройки могли измениться между согласием и
// запуском, поэтому выбор, провайдер и опоры проверяются ещё раз. Результат должен быть
// настоящим изображением внутри папки попытки без символических ссылок. Ошибка становится
// состоянием сессии; квитанция референса пишется в любом исходе.
func (g *Generator) run(ctx context.Context, item *record, attempt *prepared, allowUnknownCost bool) {
	g.mu.Lock()
	if item.closed {
		g.mu.Unlock()
		return
	}
	project := item.project
	sessionReferences := item.session.ReferenceImages
	g.mu.Unlock()
	t := g.texts
	image, err := func() (*Image, error) {
		if err := g.options.AssertSelection(project); err != nil {
			return nil, err
		}
		provider, err := currentProvider(project)
		if err != nil {
			return nil, err
		}
		if provider != attempt.candidate.Provider {
			return nil, errors.New(t.providerChanged)
		}
		if _, err := mediafile.CheckedReferences(sessionReferences); err != nil {
			return nil, err
		}
		if _, err := mediafile.CheckedReferences(attempt.references); err != nil {
			return nil, err
		}
		output, err := attempt.candidate.Generate(ctx, allowUnknownCost)
		if err != nil {
			return nil, err
		}
		g.mu.Lock()
		closed := item.closed
		g.mu.Unlock()
		if closed {
			return nil, nil
		}
		return g.checkedResult(attempt.workDir, output)
	}()
	g.mu.Lock()
	defer g.mu.Unlock()
	// Ошибка архива должна стать состоянием сессии, а не потерянным отказом фоновой работы.
	defer func() {
		if archiveErr := g.archive(item); archiveErr != nil {
			// Готовый оригинал уже получен: сбой квитанции не должен требовать новой платной генерации.
			// Приёмка повторит сохранение архива после устранения файловой ошибки.
			if item.session.Image == nil {
				item.session.Status = StatusFailed
			}
			message := textArchiveFailed
			item.session.Error = &message
		}
	}()
	if item.closed {
		return
	}
	if err != nil {
		if !g.options.Reference {
			g.clear(item, "references")
		}
		item.session.Image = nil
		item.session.Status = StatusFailed
		message := t.fileReadFailed
		if !hasCode(err) {
			message = err.Error()
		}
		item.session.Error = &message
		return
	}
	item.session.Image = image
	item.session.Status = StatusReady
}

// checkedResult — путь результата исполнителя внутри папки попытки: обычный файл без ссылок,
// реальный формат PNG/JPEG/WebP с расширением этого формата и читаемыми размерами.
func (g *Generator) checkedResult(workDir, output string) (*Image, error) {
	t := g.texts
	path := dynvalue.Resolve(workDir, output)
	local := dynvalue.Relative(workDir, path)
	if local == "" || dynvalue.IsAbs(local) || local == ".." || strings.HasPrefix(local, "../") || strings.HasPrefix(local, `..\`) {
		return nil, errors.New(t.fileInvalid)
	}
	real, err := dynvalue.Realpath(path)
	if err != nil {
		return nil, err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return nil, dynvalue.FsError("lstat", path, err)
	}
	if real != path || info.Mode()&os.ModeSymlink != 0 || !mediafile.IsImage(path) || !mediafile.ExtensionMatches(path) {
		return nil, errors.New(t.fileInvalid)
	}
	width, height, ok := g.options.ReadImage(path)
	if !ok || width <= 0 || height <= 0 {
		return nil, errors.New(t.imageReadFailed)
	}
	return &Image{Path: path, Width: width, Height: height}, nil
}

// hasCode — файловая ошибка (dynvalue.FileError) или ошибка системного вызова: пользователю
// вместо её текста показывается общее «не удалось прочитать файл».
func hasCode(err error) bool {
	var node *dynvalue.FileError
	var path *fs.PathError
	var link *os.LinkError
	var errno syscall.Errno
	return errors.As(err, &node) || errors.As(err, &path) || errors.As(err, &link) || errors.As(err, &errno)
}

// View — cover.view: текущее состояние сессии.
func (g *Generator) View(id string) (Session, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	item, err := g.record(id)
	if err != nil {
		return Session{}, err
	}
	return item.session.clone(), nil
}

// isSafeInteger — целое по модулю не больше 2^53−1 (точно представимое в JSON-числе).
func isSafeInteger(value float64) bool {
	return dynvalue.IsSafeInteger(value)
}

// Accept — cover.accept: вырезает выбранный квадрат готовой обложки в собственный новый
// accepted.png сессии и удаляет остальные файлы папки. Квадрат — целые координаты внутри
// изображения; результат проверяется как настоящий PNG ровно этого размера.
func (g *Generator) Accept(id string, crop *Crop) (Accepted, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	item, err := g.record(id)
	if err != nil {
		return Accepted{}, err
	}
	t := g.texts
	image := item.session.Image
	if item.session.Preparing || item.session.Status != StatusReady || image == nil {
		return Accepted{}, errors.New(t.notReady)
	}
	if crop == nil || !isSafeInteger(crop.X) || !isSafeInteger(crop.Y) || !isSafeInteger(crop.Size) || crop.X < 0 || crop.Y < 0 || crop.Size <= 0 ||
		crop.X+crop.Size > float64(image.Width) || crop.Y+crop.Size > float64(image.Height) {
		return Accepted{}, errors.New(t.cropInvalid)
	}
	path := filepath.Join(item.root, "accepted.png")
	err = func() error {
		// Агент мог оставить одноимённый артефакт; обрезка должна создать собственный новый файл.
		if err := os.RemoveAll(path); err != nil {
			return err
		}
		if err := g.options.CropImage(image.Path, path, *crop); err != nil {
			return err
		}
		width, height, ok := g.options.ReadImage(path)
		real, err := dynvalue.Realpath(path)
		if err != nil {
			return err
		}
		info, err := os.Lstat(path)
		if err != nil {
			return dynvalue.FsError("lstat", path, err)
		}
		if real != path || info.Mode()&os.ModeSymlink != 0 || !mediafile.IsImage(path) || !mediafile.ExtensionMatches(path) ||
			!ok || float64(width) != crop.Size || float64(height) != crop.Size {
			return errors.New(t.cropSaveFailed)
		}
		return nil
	}()
	if err != nil {
		_ = os.RemoveAll(path)
		return Accepted{}, err
	}
	g.clear(item, "accepted.png")
	size := int(crop.Size)
	item.session.Image = &Image{Path: path, Width: size, Height: size}
	item.session.Status = StatusAccepted
	item.prepared = nil
	item.session.RequestSha, item.session.ApprovalToken = nil, nil
	return Accepted{ID: id, Path: path}, nil
}

// AcceptReference — приёмка референса (referenceImages.accept и первая часть attach): полный
// оригинал остаётся в архиве, сессия становится accepted, квитанция обновляется. Повторная
// приёмка того же оригинала допустима: attach после сбоя renderer повторяет её.
func (g *Generator) AcceptReference(id string) (referenceimage.Result, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	item, err := g.record(id)
	if err != nil {
		return referenceimage.Result{}, err
	}
	status := item.session.Status
	if !g.options.Reference || item.session.Preparing || (status != StatusReady && status != StatusAccepted) || item.session.Image == nil {
		return referenceimage.Result{}, errors.New(textReferenceNotReady)
	}
	item.session.Status = StatusAccepted
	item.session.RequestSha, item.session.ApprovalToken = nil, nil
	if err := g.archive(item); err != nil {
		return referenceimage.Result{}, err
	}
	return referenceimage.Result{ID: id, Path: item.session.Image.Path, Prompt: item.session.Prompt}, nil
}

// Project — канонический путь проекта сессии.
func (g *Generator) Project(id string) (string, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	item, err := g.record(id)
	if err != nil {
		return "", err
	}
	return item.project, nil
}

// archivePath — путь внутри архива в квитанции: относительный, через «/», чтобы архив
// переносился вместе с проектом.
func archivePath(root, path string) string {
	return strings.ReplaceAll(dynvalue.Relative(root, path), `\`, "/")
}

// archive пишет квитанцию session.json референса (у обложки — ничего). Вызывается под g.mu.
func (g *Generator) archive(item *record) error {
	if !g.options.Reference {
		return nil
	}
	receipt := item.session.clone()
	for index := range receipt.ReferenceImages {
		receipt.ReferenceImages[index].Path = archivePath(item.root, receipt.ReferenceImages[index].Path)
	}
	if receipt.Image != nil {
		receipt.Image.Path = archivePath(item.root, receipt.Image.Path)
	}
	return projectfs.WriteJSON(filepath.Join(item.root, "session.json"), receipt)
}

// Close — cover.close: отменяет подготовку или генерацию, дожидается её завершения, затем
// удаляет временную папку обложки или сохраняет квитанцию референса. Неизвестная сессия —
// без ошибки.
func (g *Generator) Close(id string) error {
	g.mu.Lock()
	item, ok := g.sessions[id]
	if !ok {
		g.mu.Unlock()
		return nil
	}
	item.closed = true
	if item.cancel != nil {
		item.cancel()
	}
	done := item.done
	g.mu.Unlock()
	if done != nil {
		<-done
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if !g.options.Reference {
		_ = os.RemoveAll(item.root)
	} else if err := g.archive(item); err != nil {
		return err
	}
	delete(g.sessions, id)
	return nil
}

// Shutdown закрывает все сессии при выходе из приложения; новые сессии больше не создаются.
// Возвращает первую ошибку закрытия, остальные сессии закрываются всё равно.
func (g *Generator) Shutdown() error {
	g.mu.Lock()
	g.stopping = true
	ids := make([]string, 0, len(g.sessions))
	for id := range g.sessions {
		ids = append(ids, id)
	}
	g.mu.Unlock()
	errs := make([]error, len(ids))
	var wait sync.WaitGroup
	for index, id := range ids {
		wait.Add(1)
		go func() {
			defer wait.Done()
			errs[index] = g.Close(id)
		}()
	}
	wait.Wait()
	for _, err := range errs {
		if err != nil {
			return err
		}
	}
	return nil
}

// clear удаляет содержимое папки сессии, кроме имён keep. Вызывается под g.mu.
func (g *Generator) clear(item *record, keep ...string) {
	entries, _ := os.ReadDir(item.root)
	for _, entry := range entries {
		if !contains(keep, entry.Name()) {
			_ = os.RemoveAll(filepath.Join(item.root, entry.Name()))
		}
	}
}

// contains — строка в списке.
func contains(list []string, value string) bool {
	for _, item := range list {
		if item == value {
			return true
		}
	}
	return false
}
