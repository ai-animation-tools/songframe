package production

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"

	"songframe/internal/builtoutput"
	"songframe/internal/dynvalue"
	"songframe/internal/jobs"
	"songframe/internal/mediaproviders"
	"songframe/internal/projectfile"
	"songframe/internal/projectfs"
	"songframe/internal/providers"
	"songframe/internal/shotworkflow"
	"songframe/internal/spend"
	"songframe/internal/tools"
)

// Runner — запуск инструмента комплекса по имени (tools.RunContext): инструменты выполняются в
// процессе приложения и возвращают код, stdout и stderr, как отдельная программа.
type Runner func(ctx context.Context, project, name string, args []string) (tools.Result, error)

// Options — зависимости сервиса производства.
type Options struct {
	// Jobs — общий менеджер заданий (отправка, получение, повтор, приёмка).
	Jobs *jobs.Manager
	// Layer — слой провайдеров: платный адаптер зафиксированного запроса проверяет попытку перед
	// отправкой и собирает скачанные оригиналы. nil — адаптеры не подключены (служебные проверки
	// без провайдеров): отправка идёт без проверки адаптера.
	Layer *providers.Layer
	// Run — запуск инструментов; nil — tools.RunContext.
	Run Runner
	// PricingFile — подмена таблицы цен (SONGFRAME_PRICING_FILE) для прогонов без
	// расхода; "" — таблица адаптера провайдера.
	PricingFile string
	// NewToken — одноразовый токен оценки; nil — случайный UUID v4 (randomUUID).
	NewToken func() string
}

// quoteRecord — выданная оценка стоимости: действует только для тех же материалов пакета.
type quoteRecord struct {
	project       string
	directory     string
	decisionToken string
	quote         Quote
	issued        uint64
}

// Quote — ProductionQuote: актуальная стоимость показанного запроса; token одноразовый и не
// переживает перезапуск приложения.
type Quote struct {
	Token      string   `json:"token"`
	RequestSha string   `json:"requestSha"`
	Verdict    string   `json:"verdict"`
	Credits    *float64 `json:"credits"`
	Balance    *float64 `json:"balance"`
	Reasons    []string `json:"reasons"`
}

// Verdict оценки.
const (
	VerdictOK                  = "ok"
	VerdictInsufficientBalance = "insufficient_balance"
	VerdictUnknown             = "cost_or_balance_unknown"
)

// canAgreeToUnknownCost — согласие на неизвестную цену допустимо только для такой оценки.
func canAgreeToUnknownCost(quote Quote) bool {
	return quote.Verdict == VerdictUnknown && quote.Credits == nil
}

// priceAllowsGeneration — оценка разрешает отправку: цена известна и средств хватает, либо цена
// неизвестна и пользователь явно согласился с этой оценкой.
func priceAllowsGeneration(quote Quote, agreed bool) bool {
	return quote.Verdict == VerdictOK || (agreed && canAgreeToUnknownCost(quote))
}

// Service — сервис производства: решения по пакетам, оценки и одноразовые согласования
// стоимости, задания отправки, получения, повтора и приёмки. Состояние (выданные оценки,
// выполняющиеся операции и задания пакетов) живёт в памяти процесса: перезапуск сбрасывает
// оценки, поэтому прежнее согласие не переживает его. Методы безопасны для параллельного вызова
// из Wails: проверка занятости и захват пакета выполняются под одной блокировкой, поэтому
// двойной клик не даёт второй операции над тем же пакетом.
type Service struct {
	options Options

	mu            sync.Mutex
	operations    map[string]bool
	shotJobs      map[string]string
	packageJobs   map[string]string
	bundleJobs    map[string]string
	quotes        map[string]*quoteRecord
	quoteSequence uint64
}

// New создаёт сервис производства.
func New(options Options) *Service {
	if options.Run == nil {
		options.Run = tools.RunContext
	}
	if options.NewToken == nil {
		options.NewToken = randomUUID
	}
	return &Service{
		options: options, operations: map[string]bool{}, shotJobs: map[string]string{}, packageJobs: map[string]string{},
		bundleJobs: map[string]string{}, quotes: map[string]*quoteRecord{},
	}
}

// randomUUID — случайный UUID версии 4 в каноническом виде с дефисами.
func randomUUID() string {
	var data [16]byte
	_, _ = rand.Read(data[:])
	data[6] = data[6]&0x0f | 0x40
	data[8] = data[8]&0x3f | 0x80
	text := hex.EncodeToString(data[:])
	return text[:8] + "-" + text[8:12] + "-" + text[12:16] + "-" + text[16:20] + "-" + text[20:]
}

// pricingArgs — --pricing подменённой таблицы цен.
func (s *Service) pricingArgs() []string {
	if s.options.PricingFile != "" {
		return []string{"--pricing", s.options.PricingFile}
	}
	return []string{}
}

// run — инструмент вне задания; Code nil — процесс остановлен, код завершения не получен.
func (s *Service) run(project, name string, args ...string) (tools.Result, error) {
	return s.options.Run(context.Background(), project, name, args)
}

// failure — ошибка инструмента: обрезанный stderr, иначе stdout, иначе fallback.
func failure(result tools.Result, fallback string) error {
	text := result.Stderr
	if text == "" {
		text = result.Stdout
	}
	if text = dynvalue.Trim(text); text != "" {
		return errors.New(text)
	}
	return errors.New(fallback)
}

// ok — инструмент завершился с кодом 0.
func ok(result tools.Result) bool { return result.Code != nil && *result.Code == 0 }

// realpath — канонический путь; текст ошибки в формате dynvalue, как ждут эталоны.
func realpath(path string) (string, error) { return dynvalue.Realpath(path) }

// packagePattern — допустимое положение пакета внутри проекта.
var packagePattern = regexp.MustCompile(`^plan/(batches|awaiting)/[^/]+$`)

// checkedPackage — обычная папка пакета plan/batches/<имя> или plan/awaiting/<имя> выбранного
// проекта; возвращает её реальный путь.
func checkedPackage(project, packageDir string) (string, error) {
	directory := dynvalue.Resolve(project, packageDir)
	root, err := realpath(project)
	if err != nil {
		return "", err
	}
	real, err := realpath(directory)
	if err != nil {
		return "", err
	}
	info, err := os.Lstat(directory)
	if err != nil {
		return "", dynvalue.FsError("lstat", directory, err)
	}
	if !packagePattern.MatchString(filepath.ToSlash(dynvalue.Relative(root, real))) || info.Mode()&os.ModeSymlink != 0 {
		return "", errors.New(textPackageFolderRequired)
	}
	return real, nil
}

// running — задание с таким ID выполняется.
func (s *Service) running(id string) bool {
	if id == "" || s.options.Jobs == nil {
		return false
	}
	info, found := s.options.Jobs.Get(id)
	return found && info.Status == jobs.StatusRunning
}

// shotKey — ключ задания повтора плана: реальный путь проекта и ID плана.
func shotKey(project, shot string) string {
	root, err := realpath(project)
	if err != nil {
		root = project
	}
	return root + ":" + shot
}

// IsBusy — у пакета идёт операция сервиса, его задание или задание
// повтора его плана. Используют проверка видео и проход агента производства.
func (s *Service) IsBusy(project, packageDir string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.busyLocked(project, packageDir)
}

func (s *Service) busyLocked(project, packageDir string) bool {
	directory := dynvalue.Resolve(project, packageDir)
	if dynvalue.Exists(directory) {
		if real, err := realpath(directory); err == nil {
			directory = real
		}
	}
	shot := dynvalue.ToString(dynvalue.Get(readJSON(filepath.Join(directory, "workflow.json")), "shot"))
	return s.running(s.shotJobs[shotKey(project, shot)]) || s.operations[directory] || s.running(s.packageJobs[directory])
}

// available — проверенный пакет без идущей операции (под s.mu).
func (s *Service) availableLocked(project, packageDir string) (string, error) {
	directory, err := checkedPackage(project, packageDir)
	if err != nil {
		return "", err
	}
	if s.busyLocked(project, directory) {
		return "", errors.New(textPackageBusy)
	}
	return directory, nil
}

// available — проверенный свободный пакет.
func (s *Service) available(project, packageDir string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.availableLocked(project, packageDir)
}

// claim — проверяет свободный пакет и сразу отмечает операцию над ним; release снимает отметку.
// Проверка и отметка под одной блокировкой: второй параллельный вызов получает «пакет занят».
func (s *Service) claim(project, packageDir string) (string, func(), error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	directory, err := s.availableLocked(project, packageDir)
	if err != nil {
		return "", nil, err
	}
	s.operations[directory] = true
	return directory, func() { s.release(directory) }, nil
}

func (s *Service) release(directory string) {
	s.mu.Lock()
	delete(s.operations, directory)
	s.mu.Unlock()
}

// mustPackage — пакет как объект или nil без ошибки; повреждённый пакет, который ReadPackage
// отклоняет целиком, возвращается ошибкой.
func mustPackage(project, directory string) (*PackageView, error) {
	return ReadPackage(project, directory)
}

// isPaid — isPaidMediaProvider: провайдер реестра с платным исполнителем.
func isPaid(provider *string) bool {
	if provider == nil {
		return false
	}
	id, known := mediaproviders.Normalize(*provider)
	if !known {
		return false
	}
	info, _ := mediaproviders.Lookup(id)
	return info.Paid
}

// sha256Text — запрос подтверждается только 64 шестнадцатеричными символами.
var sha256Text = regexp.MustCompile(`^[a-f0-9]{64}$`)

// ready — пакет готов к оценке или отправке показанного запроса expectedSha.
func (s *Service) ready(project, directory, expectedSha, decisionToken string) (*PackageView, error) {
	view, err := mustPackage(project, directory)
	if err != nil {
		return nil, err
	}
	if view != nil && view.SceneChanged {
		return nil, errors.New(textSceneChangedBeforeSubmit(SceneChanged))
	}
	if view == nil || view.DecisionToken == "" || len(view.Problems) > 0 || view.Request == nil || view.Request.SHA256 == nil ||
		*view.Request.SHA256 == "" || *view.Request.SHA256 != expectedSha || !sha256Text.MatchString(expectedSha) {
		return nil, errors.New(textRequestChanged)
	}
	if !slices.Contains([]string{"request_choice", "ready", "image_request_choice"}, view.Stage) || view.attemptStatus() != "prepared" {
		return nil, errors.New(textAttemptNotPrepared)
	}
	// Универсальная подготовка не разрешает отправить запрос через адаптер другого провайдера.
	if !isPaid(view.Request.Provider) {
		return nil, errors.New(textSubmitAdapterMissing(view.Request.Provider))
	}
	if pending := view.Pending(); pending != nil && (decisionToken == "" || decisionToken != view.DecisionToken || !slices.Contains(pending.Options, "send")) {
		return nil, errors.New(textQuestionOrMaterialsChanged)
	}
	return view, nil
}

// finiteCredits — число кредитов, если это конечное неотрицательное число.
func finiteCredits(value any) *float64 {
	number, ok := value.(float64)
	if !ok || math.IsInf(number, 0) || math.IsNaN(number) || number < 0 {
		return nil
	}
	return &number
}

// price — оценка cost_check check. Недоступная оценка остаётся отдельным согласуемым состоянием;
// сырой ответ инструмента может содержать секреты, поэтому он не показывается.
func (s *Service) price(project, requestDir string) Quote {
	unknown := Quote{Verdict: VerdictUnknown, Reasons: []string{textCostAndBalanceUnknown}}
	result, err := s.run(project, "cost_check", append([]string{"check", "--work-dir", requestDir, "--json"}, s.pricingArgs()...)...)
	if err != nil {
		return unknown
	}
	parsed, err := dynvalue.Parse([]byte(result.Stdout))
	value, isObject := dynvalue.AsObject(parsed)
	if err != nil || !isObject {
		return unknown
	}
	code := -1
	if result.Code != nil {
		code = *result.Code
	}
	verdict, _ := value.Value("verdict").(string)
	if (code != 0 && code != 2) || !slices.Contains([]string{VerdictOK, VerdictInsufficientBalance, VerdictUnknown}, dynvalue.ToString(value.Value("verdict"))) {
		return unknown
	}
	credits, balance := finiteCredits(value.Value("estimate_credits")), finiteCredits(value.Value("balance_credits"))
	checked := verdict
	if credits != nil && balance != nil && *balance < *credits {
		checked = VerdictInsufficientBalance
	} else if verdict == VerdictOK && (code != 0 || credits == nil || balance == nil) {
		checked = VerdictUnknown
	}
	reasons := []string{}
	if list, ok := dynvalue.AsArray(value.Value("reasons")); ok {
		for _, item := range list {
			if text, ok := item.(string); ok {
				reasons = append(reasons, text)
			}
		}
	}
	return Quote{Verdict: checked, Credits: credits, Balance: balance, Reasons: reasons}
}

// Quote — метод quote контракта window.api: актуальная стоимость показанного
// запроса и одноразовый token согласия. Для тех же материалов действуют несколько последних
// оценок (окно может запросить оценку повторно), оценки прежних материалов сгорают. Отправка всё
// равно заново сверяет цену и остаток.
func (s *Service) Quote(project, packageDir, expectedSha, decisionToken string) (Quote, error) {
	s.mu.Lock()
	directory, err := s.availableLocked(project, packageDir)
	// Порядок запуска, а не завершения: запоздавшая прежняя оценка не должна вытеснить более
	// новую, которую показывает окно.
	s.quoteSequence++
	issued := s.quoteSequence
	s.mu.Unlock()
	if err != nil {
		return Quote{}, err
	}
	view, err := s.ready(project, directory, expectedSha, decisionToken)
	if err != nil {
		return Quote{}, err
	}
	price := s.price(project, view.Request.Dir)
	current, err := s.ready(project, directory, expectedSha, decisionToken)
	if err != nil {
		return Quote{}, err
	}
	if view.DecisionToken != current.DecisionToken {
		return Quote{}, errors.New(textMaterialsChangedDuringQuote)
	}
	quote := price
	quote.Token, quote.RequestSha = s.options.NewToken(), expectedSha
	root, err := realpath(project)
	if err != nil {
		return Quote{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for token, record := range s.quotes {
		if record.directory == directory && (record.decisionToken != current.DecisionToken || record.quote.RequestSha != expectedSha) {
			delete(s.quotes, token)
		}
	}
	s.quotes[quote.Token] = &quoteRecord{project: root, directory: directory, decisionToken: current.DecisionToken, quote: quote, issued: issued}
	var same []*quoteRecord
	for _, record := range s.quotes {
		if record.directory == directory {
			same = append(same, record)
		}
	}
	slices.SortFunc(same, func(a, b *quoteRecord) int { return int(b.issued) - int(a.issued) })
	for _, record := range same[min(len(same), 4):] {
		delete(s.quotes, record.quote.Token)
	}
	return quote, nil
}

// askNextFrame — опоры согласуются по одной: вопрос задаётся о первом в плане кандидате, ещё не
// утверждённом.
func (s *Service) askNextFrame(project, directory string) error {
	current, err := mustPackage(project, directory)
	if err != nil {
		return err
	}
	if current == nil || current.Pending() != nil {
		return nil
	}
	for _, frame := range current.Keyframes {
		if frame.ImagePath != nil && !frame.Approved {
			result, err := s.run(project, "shot_workflow", "ask", "--dir", directory, "--stage", "keyframes_review", "--frame", frame.ID)
			if err != nil || !ok(result) {
				return errors.New(textFrameQuestionWriteFailed(frame.ID))
			}
			return nil
		}
	}
	return nil
}

// Decide — ответ пользователя на вопрос пакета через shot_workflow decide. send отклоняется:
// отправка требует отдельного подтверждения со стоимостью (Submit).
func (s *Service) Decide(project, packageDir, verdict, note, decisionToken, noteScope string) error {
	directory, err := s.available(project, packageDir)
	if err != nil {
		return err
	}
	view, err := mustPackage(project, directory)
	if err != nil {
		return err
	}
	if decisionToken != "" && (view == nil || decisionToken != view.DecisionToken) {
		return errors.New(textDecisionMaterialsChanged)
	}
	if decisionToken == "" {
		return errors.New(textRefreshQuestion)
	}
	if verdict == "send" {
		return errors.New(textSeparateCostConfirmation)
	}
	directory, release, err := s.claim(project, directory)
	if err != nil {
		return err
	}
	defer release()
	args := []string{"decide", "--dir", directory, "--verdict", verdict}
	if note != "" {
		args = append(args, "--note", note)
	}
	pending := view.Pending()
	// Охват замечания важен только при доработке опоры: оно уходит в генерацию этой опоры или и
	// следующих.
	if verdict == "revise" && pending != nil && pending.Frame != "" {
		scope := "following"
		if noteScope == "frame" {
			scope = "frame"
		}
		args = append(args, "--note-scope", scope)
	}
	result, err := s.run(project, "shot_workflow", args...)
	if err != nil {
		return err
	}
	if !ok(result) {
		return failure(result, textDecideFailed(result.Code))
	}
	if verdict == "revise" && view.Stage == "image_request_choice" && view.attemptStatus() == "prepared" {
		// Неотправленный frozen request остаётся в истории; новая подготовка получает другую
		// папку и новый вопрос.
		reset, err := s.run(project, "shot_workflow", "set-stage", "--dir", directory, "keyframes_review")
		if err != nil || !ok(reset) {
			return errors.New(textReturnToImageFailed)
		}
	}
	// После утверждения одной опоры следующий уже готовый кандидат сразу получает вопрос.
	if verdict == "approve" && pending != nil && pending.Frame != "" {
		return s.askNextFrame(project, directory)
	}
	return nil
}

// framePattern — ID опоры.
var framePattern = regexp.MustCompile(`^K\d{2}$`)

// scope — охват замечания к опоре.
func scope(noteScope string) string {
	if noteScope == "frame" {
		return "frame"
	}
	return "following"
}

// ReopenFrame — вернуть утверждённую опору на доработку с замечанием (shot_workflow reopen).
func (s *Service) ReopenFrame(project, packageDir, frame, note, noteScope string) error {
	directory, err := s.available(project, packageDir)
	if err != nil {
		return err
	}
	if !framePattern.MatchString(frame) {
		return errors.New(textFrameUnknown)
	}
	if dynvalue.Trim(note) == "" {
		return errors.New(textFrameRevisionRequired)
	}
	directory, release, err := s.claim(project, directory)
	if err != nil {
		return err
	}
	defer release()
	result, err := s.run(project, "shot_workflow", "reopen", "--dir", directory, frame, "--note", dynvalue.Trim(note), "--note-scope", scope(noteScope))
	if err != nil {
		return err
	}
	if !ok(result) {
		return failure(result, textReopenFrameFailed)
	}
	return s.askNextFrame(project, directory)
}

// ReopenPrompt — вернуть утверждённый видеопромпт на доработку с замечанием (shot_workflow
// reopen-prompt), пока запрос видео не отправлен. Описание и опоры остаются; замечание агент
// получает при новой подготовке промпта.
func (s *Service) ReopenPrompt(project, packageDir, note string) error {
	directory, err := s.available(project, packageDir)
	if err != nil {
		return err
	}
	if dynvalue.Trim(note) == "" {
		return errors.New(textPromptRevisionRequired)
	}
	directory, release, err := s.claim(project, directory)
	if err != nil {
		return err
	}
	defer release()
	result, err := s.run(project, "shot_workflow", "reopen-prompt", "--dir", directory, "--note", dynvalue.Trim(note))
	if err != nil {
		return err
	}
	if !ok(result) {
		return failure(result, textReopenPromptFailed)
	}
	return nil
}

// AddKeyframeNote — необязательное указание пользователя к опоре до её создания. Занимает пакет
// на время записи, как и другие изменения workflow.json; вопрос пакета не меняется.
func (s *Service) AddKeyframeNote(project, packageDir, frame, note, noteScope string) error {
	directory, err := s.available(project, packageDir)
	if err != nil {
		return err
	}
	if !framePattern.MatchString(frame) {
		return errors.New(textFrameUnknown)
	}
	if dynvalue.Trim(note) == "" {
		return errors.New(textFrameInstructionRequired)
	}
	directory, release, err := s.claim(project, directory)
	if err != nil {
		return err
	}
	defer release()
	return shotworkflow.AddFrameNote(directory, frame, dynvalue.Trim(note), scope(noteScope))
}

// restampPackage — в тексте workflow.json меняется только первое значение
// "scene_sha256" (строка from или null), остальной файл сохраняется байт в байт. false — значения нет.
func restampPackage(directory string, from *string, to string) (bool, error) {
	path := filepath.Join(directory, "workflow.json")
	data, err := os.ReadFile(path)
	if err != nil {
		return false, dynvalue.FsError("open", path, err)
	}
	text := dynvalue.DecodeUTF8(data)
	value := "null"
	if from != nil {
		value = `"` + regexp.QuoteMeta(*from) + `"`
	}
	pattern := regexp.MustCompile(`("scene_sha256"` + wideSpace + `*:` + wideSpace + `*)` + value)
	match := pattern.FindStringSubmatchIndex(text)
	if match == nil {
		return false, nil
	}
	replaced := text[:match[0]] + text[match[2]:match[3]] + `"` + to + `"` + text[match[1]:]
	return true, projectfs.WriteFile(path, []byte(replaced), 0)
}

// wideSpace — пробельные символы вокруг «:» поля scene_sha256: все пробелы Unicode, переводы
// строк, U+2028/U+2029 и BOM (класс \s RE2 в Go покрывает только ASCII).
const wideSpace = `[\t\n\v\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]`

// KeepPackageForScene — пользователь подтверждает, что правка сценария не затрагивает материалы
// неотправленного пакета: отпечаток постановки в workflow.json заменяется текущим.
func (s *Service) KeepPackageForScene(project, packageDir string) error {
	directory, release, err := s.claim(project, packageDir)
	if err != nil {
		return err
	}
	defer release()
	view, err := mustPackage(project, directory)
	if err != nil {
		return err
	}
	if view == nil || !view.SceneChanged {
		return errors.New(textSceneUnchanged)
	}
	if view.Request != nil && view.attemptStatus() != "prepared" {
		return errors.New(textSubmittedOldSceneNoRestamp)
	}
	current := CurrentShotFingerprint(project, view.Shot)
	from := optionalString(view.workflow.Value("scene_sha256"))
	if current == "" {
		return errors.New(textRestampFailed)
	}
	changed, err := restampPackage(directory, from, current)
	if err != nil {
		return err
	}
	if !changed {
		return errors.New(textRestampFailed)
	}
	return nil
}

// SetKeyframeNote — включить или снять замечание к опорам пакета (shot_workflow set-note).
func (s *Service) SetKeyframeNote(project, packageDir string, id float64, active bool) error {
	directory, err := s.available(project, packageDir)
	if err != nil {
		return err
	}
	if id != math.Trunc(id) || id < 1 || math.IsInf(id, 0) {
		return errors.New(textNoteUnknown)
	}
	flag := "false"
	if active {
		flag = "true"
	}
	result, err := s.run(project, "shot_workflow", "set-note", "--dir", directory, "--id", dynvalue.NumberToString(id), "--active", flag)
	if err != nil {
		return err
	}
	if !ok(result) {
		return failure(result, textNoteChangeFailed)
	}
	return nil
}

// blockingStatuses — попытка, у которой отправка ещё не завершена: удаление потеряло бы оплату.
var blockingStatuses = []string{"submitting", "submission_unknown", "submitted", "running", "watermark_free_pending",
	"outputs_pending", "download_pending", "downloading", "polling"}

// DiscardAttempt — отказ от попытки удаляет пакет целиком вместе с оплаченным оригиналом: после
// него повтор по сохранённому запросу снова доступен. Незавершённая отправка, принятый пакет и
// папка сохранённого черновика монтажа не удаляются.
func (s *Service) DiscardAttempt(project, packageDir string) error {
	directory, release, err := s.claim(project, packageDir)
	if err != nil {
		return err
	}
	defer release()
	view, err := mustPackage(project, directory)
	if err != nil {
		return err
	}
	root, err := realpath(project)
	if err != nil {
		return err
	}
	// Отправки удаляемой попытки остаются в журнале расходов: без него удаление не выполняется.
	if err := spend.Sync(project); err != nil {
		return err
	}
	if view == nil {
		// Недописанная папка без workflow.json: удаляется, если в ней нет следов незавершённой
		// отправки.
		status := dynvalue.Get(readJSON(filepath.Join(directory, "request", "attempt.json")), "status")
		if dynvalue.Truthy(status) && !slices.Contains([]string{"prepared", "manual_pending", "downloaded", "failed", "download_failed", "download_partial"}, dynvalue.ToString(status)) {
			return errors.New(textUnfinishedAttemptBlocksRemoval(dynvalue.ToString(status)))
		}
		local := strings.ReplaceAll(dynvalue.Relative(root, directory), `\`, "/")
		if drafts := montageDraftsUsing(project, local); len(drafts) > 0 {
			return errors.New(textFolderUsedByMontageDraft(drafts[0]))
		}
		return removeAll(directory)
	}
	if view.Stage == "accepted" {
		return errors.New(textAcceptedPackageCannotRemove)
	}
	if slices.Contains(blockingStatuses, view.attemptStatus()) {
		return errors.New(textSubmissionBlocksRemoval)
	}
	if drafts := montageDraftsUsing(project, strings.ReplaceAll(view.Relative, `\`, "/")); len(drafts) > 0 {
		return errors.New(textPackageUsedByMontageDraft(drafts[0]))
	}
	return removeAll(directory)
}

// removeAll — рекурсивное удаление папки через шлюз записи проекта; отсутствующая папка не ошибка.
func removeAll(directory string) error {
	if err := projectfs.CheckWrite(directory); err != nil {
		return err
	}
	return os.RemoveAll(directory)
}

// ReopenQuestion — снова задать вопрос о полученном результате, если ответ уже записан, а
// решение нужно принять заново.
func (s *Service) ReopenQuestion(project, packageDir string) error {
	directory, release, err := s.claim(project, packageDir)
	if err != nil {
		return err
	}
	defer release()
	view, err := mustPackage(project, directory)
	if err != nil {
		return err
	}
	if view == nil {
		return errors.New(textPackageMissingRefresh)
	}
	if view.Pending() != nil {
		return errors.New(textQuestionAlreadyAsked)
	}
	if view.Stage != "downloaded" && view.Stage != "edit_review" {
		return errors.New(textResultQuestionOnly)
	}
	result, err := s.run(project, "shot_workflow", "ask", "--dir", directory, "--stage", view.Stage)
	if err != nil {
		return err
	}
	if !ok(result) {
		return failure(result, textAskFailed(result.Code))
	}
	return nil
}

// Park — отложить пакет в очередь (shot_workflow park).
func (s *Service) Park(project, packageDir string) error {
	directory, release, err := s.claim(project, packageDir)
	if err != nil {
		return err
	}
	defer release()
	result, err := s.run(project, "shot_workflow", "park", "--dir", directory)
	if err != nil {
		return err
	}
	if !ok(result) {
		return failure(result, textParkFailed(result.Code))
	}
	return nil
}

// Bounds — границы среза речи в секундах.
type Bounds struct {
	Start float64 `json:"start"`
	End   float64 `json:"end"`
}

// PrepareSpeech — точный срез песни для речевого плана (cut_speech cut в audio/ пакета). WAV
// перезаписывается только до отправки: запрос и приёмка ссылаются на один файл. cut_speech не
// перезаписывает WAV, поэтому прежние speech.wav и audio-recipe.json пакета удаляются перед
// запуском (и при отказе среза пакет остаётся без него). Пакет занят на время среза: проверка и
// отметка операции — одна блокировка claim. Границы bounds передаются инструменту строками в
// кратчайшей десятичной записи dynvalue.NumberToString, без них срез предлагает инструмент по
// разметке.
// Отказ инструмента — его stderr (иначе stdout) или код; результат — свежий PackageView.
func (s *Service) PrepareSpeech(project, packageDir string, bounds *Bounds) (*PackageView, error) {
	directory, release, err := s.claim(project, packageDir)
	if err != nil {
		return nil, err
	}
	defer release()
	view, err := mustPackage(project, directory)
	if err != nil {
		return nil, err
	}
	if view == nil {
		return nil, errors.New(textPackageMissing)
	}
	if status := view.attemptStatus(); view.Request != nil && status != "" && status != "prepared" {
		return nil, errors.New(textSubmittedSpeechImmutable)
	}
	if bounds != nil && (math.IsInf(bounds.Start, 0) || math.IsInf(bounds.End, 0) || math.IsNaN(bounds.Start) || math.IsNaN(bounds.End) || bounds.Start < 0 || bounds.End <= bounds.Start) {
		return nil, errors.New(textSpeechBoundsInvalid)
	}
	audio := filepath.Join(directory, "audio")
	if err := removeSpeech(project, audio); err != nil {
		return nil, err
	}
	args := []string{"cut", view.Shot, "--out", audio, "--json"}
	if bounds != nil {
		args = append(args, "--start", dynvalue.NumberToString(bounds.Start), "--end", dynvalue.NumberToString(bounds.End))
	}
	result, err := s.run(project, "cut_speech", args...)
	if err != nil {
		return nil, err
	}
	if !ok(result) {
		return nil, failure(result, textCutSpeechFailed(result.Code))
	}
	next, err := mustPackage(project, directory)
	if err != nil {
		return nil, err
	}
	if next == nil || next.Speech == nil {
		return nil, errors.New(textSpeechWavMissing)
	}
	return next, nil
}

// removeSpeech — удаляет файл прежнего среза пакета; отсутствующий файл не ошибка.
// Запись в проект проходит шлюз projectfs (незавершённая публикация её запрещает).
func removeSpeech(project, audio string) error {
	if err := projectfs.CheckWrite(project); err != nil {
		return err
	}
	for _, name := range []string{"speech.wav", "audio-recipe.json"} {
		path := filepath.Join(audio, name)
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return dynvalue.FsError("rm", path, err)
		}
	}
	return nil
}

// toolStep — шаг задания, запускающий инструмент комплекса: вывод уходит в журнал, ненулевой код
// — сбой шага с причиной из stderr (иначе stdout).
func (s *Service) toolStep(project, tool string, args []string, label string, optional bool, before func(context.Context) error) jobs.Step {
	arguments := append([]string(nil), args...)
	return jobs.Step{
		Tool: tool, Label: label, Args: arguments, Optional: optional, Before: before,
		Run: func(ctx context.Context, step *jobs.StepContext) error {
			result, err := s.options.Run(ctx, project, tool, arguments)
			if err != nil {
				return err
			}
			step.Log(result.Stdout)
			step.Log(result.Stderr)
			if ctx.Err() != nil || result.Code == nil {
				return &jobs.StepError{Code: -1, Message: jobs.StoppedMessage, Err: ctx.Err()}
			}
			if *result.Code == 0 {
				return nil
			}
			message := dynvalue.Trim(result.Stderr)
			if message == "" {
				message = dynvalue.Trim(result.Stdout)
			}
			return &jobs.StepError{Code: *result.Code, Message: message}
		},
	}
}

// start — задание сервиса; ошибка менеджера — отказ вызова.
func (s *Service) start(kind jobs.Kind, title, project string, steps []jobs.Step) (jobs.Info, error) {
	if s.options.Jobs == nil {
		return jobs.Info{}, errors.New(textJobNotCreated)
	}
	return s.options.Jobs.Start(jobs.Spec{Kind: kind, Title: title, Project: project, Steps: steps})
}

// paidMedia — платный адаптер сохранённого запроса; без подключённого слоя — nil.
func (s *Service) paidMedia(provider *string, kind string) (*providers.PaidMedia, error) {
	if s.options.Layer == nil {
		return nil, nil
	}
	id := ""
	if provider != nil {
		id, _ = mediaproviders.Normalize(*provider)
	}
	media, found := s.options.Layer.PaidMedia(id, kind)
	if !found {
		return nil, errors.New(textAdapterMissing(provider))
	}
	return media, nil
}

// Submit — только показанный запрос и одноразовое подтверждение стоимости допускают новую оплату.
// Оценка quoteToken сгорает вместе с остальными оценками пакета при любом исходе; неизвестная
// цена допускается только с unknownCostConsentToken той же оценки. Перед отправкой цена и
// материалы сверяются заново, а вопрос send записывается в workflow.json.
func (s *Service) Submit(project, packageDir, expectedSha, decisionToken, quoteToken, unknownCostConsentToken string) (jobs.Info, error) {
	root, rootErr := realpath(project)
	s.mu.Lock()
	directory, err := s.availableLocked(project, packageDir)
	if err != nil {
		s.mu.Unlock()
		return jobs.Info{}, err
	}
	record := s.quotes[quoteToken]
	// Отправка одноразовая для пакета: вместе с использованным сгорают остальные оценки материалов.
	for token, candidate := range s.quotes {
		if token == quoteToken || (record != nil && candidate.directory == record.directory) {
			delete(s.quotes, token)
		}
	}
	// Согласие относится ровно к показанной оценке и сгорает вместе с её одноразовым token.
	agreed := record != nil && unknownCostConsentToken == record.quote.Token && canAgreeToUnknownCost(record.quote)
	if record == nil || rootErr != nil || record.project != root || record.directory != directory || record.quote.RequestSha != expectedSha ||
		!priceAllowsGeneration(record.quote, agreed) {
		s.mu.Unlock()
		if rootErr != nil && record != nil {
			return jobs.Info{}, rootErr
		}
		return jobs.Info{}, errors.New(textQuoteRequired)
	}
	s.operations[directory] = true
	s.mu.Unlock()
	defer s.release(directory)
	view, err := s.ready(project, directory, expectedSha, decisionToken)
	if err != nil {
		return jobs.Info{}, err
	}
	if view.DecisionToken != record.decisionToken {
		return jobs.Info{}, errors.New(textQuoteMaterialsChanged)
	}
	price := s.price(project, view.Request.Dir)
	fresh, err := s.ready(project, directory, expectedSha, decisionToken)
	if err != nil {
		return jobs.Info{}, err
	}
	sameCredits := (price.Credits == nil && record.quote.Credits == nil) ||
		(price.Credits != nil && record.quote.Credits != nil && *price.Credits == *record.quote.Credits)
	if !priceAllowsGeneration(price, agreed) || (!agreed && !sameCredits) || fresh.DecisionToken != record.decisionToken {
		return jobs.Info{}, errors.New(textQuoteExpired)
	}
	if fresh.Stage == "ready" {
		// Новая оценка и нажатие подтверждения разрешают прежний frozen request; запись вопроса не
		// создаёт новую попытку.
		if result, err := s.run(project, "shot_workflow", "set-stage", "--dir", directory, "request_choice"); err != nil || !ok(result) {
			return jobs.Info{}, errors.New(textUnparkFailed)
		}
		if result, err := s.run(project, "shot_workflow", "ask", "--dir", directory, "--stage", "request_choice"); err != nil || !ok(result) {
			return jobs.Info{}, errors.New(textQueuedQuestionFailed)
		}
	}
	image := fresh.Request.Kind == "image"
	if image && fresh.Pending() == nil {
		// Отложенный image-запрос снова подтверждается для того же SHA, а прежний park не
		// выдаётся за send.
		if result, err := s.run(project, "shot_workflow", "ask", "--dir", directory, "--stage", "image_request_choice"); err != nil || !ok(result) {
			return jobs.Info{}, errors.New(textImageConfirmationFailed)
		}
	}
	if fresh.Pending() != nil || fresh.Stage == "ready" || image {
		if result, err := s.run(project, "shot_workflow", "decide", "--dir", directory, "--verdict", "send"); err != nil || !ok(result) {
			return jobs.Info{}, errors.New(textSubmitConfirmationFailed)
		}
	}
	requestDir := fresh.Request.Dir
	var started *jobs.Info
	execute := func(context.Context, string, providers.PreparedRequest) error {
		title := textSubmitJob(fresh.Shot)
		submitted := "submitted"
		if image {
			title, submitted = textSubmitImageJob(fresh.Request.FrameID), "image_submitted"
		}
		steps := []jobs.Step{
			s.toolStep(project, "shot_workflow", []string{"check", "--dir", directory}, textVerifyMaterialsStep, false, nil),
			s.toolStep(project, "media_request", []string{"submit", "--work-dir", requestDir, "--confirm", expectedSha}, textSubmitStep, false, nil),
			s.toolStep(project, "cost_check", append([]string{"learn", "--work-dir", requestDir}, s.pricingArgs()...), textRecordChargeStep, true, nil),
			// Журнал расходов получает отправку сразу: сбой его записи не отменяет оплаченную отправку,
			// живая попытка всё равно учитывается, а журнал дополнится при следующей синхронизации.
			s.toolStep(project, "shot_workflow", []string{"set-stage", "--dir", directory, submitted}, textSubmittedStep, false,
				func(context.Context) error { _ = spend.Sync(project); return nil }),
		}
		info, err := s.start(jobs.KindSubmit, title, project, append(steps, s.resumeSteps(project, directory, requestDir, image)...))
		if err != nil {
			return err
		}
		started = &info
		return nil
	}
	kind := "video"
	if image {
		kind = "image"
	}
	media, err := s.paidMedia(fresh.Request.Provider, kind)
	if err != nil {
		return jobs.Info{}, err
	}
	if media != nil {
		reference := providers.PreparedRequest{Provider: media.Paid.ID, Kind: media.Kind, Project: project, RequestDir: requestDir, RequestSha: expectedSha}
		if _, err := media.Submit(context.Background(), reference, execute); err != nil {
			return jobs.Info{}, err
		}
	} else if err := execute(context.Background(), "submit", providers.PreparedRequest{}); err != nil {
		return jobs.Info{}, err
	}
	if started == nil {
		return jobs.Info{}, errors.New(textJobNotCreated)
	}
	s.mu.Lock()
	s.packageJobs[directory] = started.ID
	s.mu.Unlock()
	// Явный отказ сервиса оставляет попытку неотправленной: снова задаём вопрос, чтобы пакет можно
	// было исправить или отправить заново.
	go func(id string) {
		finished, err := s.options.Jobs.Wait(context.Background(), id)
		if err != nil || finished.Status != jobs.StatusFailed {
			return
		}
		if !dynvalue.StrictEqual(dynvalue.Get(readJSON(filepath.Join(requestDir, "attempt.json")), "status"), "prepared") {
			return
		}
		stage := "request_choice"
		if image {
			stage = "image_request_choice"
		}
		_, _ = s.run(project, "shot_workflow", "ask", "--dir", directory, "--stage", stage)
	}(started.ID)
	return *started, nil
}

// Regenerate — подготовка повтора по сохранённому запросу ничего не отправляет: новый пакет снова
// показывается пользователю с вопросом отправки.
func (s *Service) Regenerate(project, shot string) (jobs.Info, error) {
	key := shotKey(project, shot)
	s.mu.Lock()
	busy := s.running(s.shotJobs[key])
	s.mu.Unlock()
	if busy {
		return jobs.Info{}, errors.New(textRetryBusy)
	}
	view, err := ViewProduction(project)
	if err != nil {
		return jobs.Info{}, err
	}
	var current *ShotProduction
	for _, item := range view.Shots {
		if item.ID == shot {
			current = item
			break
		}
	}
	if current == nil {
		return jobs.Info{}, errors.New(textShotMissingRefresh(shot))
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.running(s.shotJobs[key]) {
		return jobs.Info{}, errors.New(textRetryBusy)
	}
	for _, pkg := range current.Packages {
		status := pkg.attemptStatus()
		if status == "submitting" || status == "submission_unknown" || s.busyLocked(project, pkg.Dir) {
			return jobs.Info{}, errors.New(textUnknownSubmissionBlocksRetry)
		}
	}
	if current.RegenerateProblem != nil {
		return jobs.Info{}, errors.New(*current.RegenerateProblem)
	}
	info, err := s.start(jobs.KindRegenerate, textRetryJob(shot), project, []jobs.Step{
		s.toolStep(project, "regenerate_shot", append([]string{shot, "--json"}, s.pricingArgs()...), textPrepareRetryStep, false, nil),
	})
	if err != nil {
		return jobs.Info{}, err
	}
	s.shotJobs[key] = info.ID
	return info, nil
}

// downloadComplete — watch завершается успешно и для failed: принимать можно только полностью
// сохранённый результат.
func downloadComplete(requestDir string) error {
	attempt := readJSON(filepath.Join(requestDir, "attempt.json"))
	downloads, isList := dynvalue.AsArray(dynvalue.Get(attempt, "downloads"))
	if !dynvalue.StrictEqual(dynvalue.Get(attempt, "status"), "downloaded") || !isList || len(downloads) == 0 {
		return errors.New(textResultIncomplete)
	}
	for _, item := range downloads {
		path, isString := dynvalue.Get(item, "path").(string)
		if !isString || path == "" {
			return errors.New(textResultIncomplete)
		}
		info, err := os.Stat(filepath.Join(requestDir, path))
		if err != nil || !info.Mode().IsRegular() {
			return errors.New(textResultIncomplete)
		}
	}
	return nil
}

// resumeSteps — получение по сохранённому ID без новой отправки: ожидание и скачивание, этап
// «скачано», вопрос просмотра и техническая сводка (у изображений — только этап).
func (s *Service) resumeSteps(project, directory, requestDir string, image bool) []jobs.Step {
	downloaded := "downloaded"
	if image {
		downloaded = "image_downloaded"
	}
	steps := []jobs.Step{
		s.toolStep(project, "media_request", []string{"watch", "--work-dir", requestDir, "--max-minutes", "30"}, textRetrievePreviousStep, false, nil),
		s.toolStep(project, "shot_workflow", []string{"set-stage", "--dir", directory, downloaded}, textResultDownloadedStep, false,
			func(context.Context) error { return downloadComplete(requestDir) }),
	}
	if !image {
		steps = append(steps,
			s.toolStep(project, "shot_workflow", []string{"ask", "--dir", directory, "--stage", "downloaded"}, textReviewResultStep, false, nil),
			// Сопутствующая техническая сводка: её сбой (например, нет FFmpeg) не делает задание неудачным.
			s.toolStep(project, "contact_sheet", []string{"--package", directory, "--json"}, textTechnicalSummaryStep, true, nil),
		)
	}
	return steps
}

// Resume — возобновляется сохранённый generation ID; новой отправки в шагах нет.
func (s *Service) Resume(project, packageDir string) (jobs.Info, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	directory, err := s.availableLocked(project, packageDir)
	if err != nil {
		return jobs.Info{}, err
	}
	view, err := mustPackage(project, directory)
	if err != nil {
		return jobs.Info{}, err
	}
	if view == nil || view.Request == nil {
		return jobs.Info{}, errors.New(textAttemptMissing)
	}
	request := view.Request
	if !isPaid(request.Provider) {
		return jobs.Info{}, errors.New(textRetrieveAdapterMissing(request.Provider))
	}
	if view.attemptStatus() == "prepared" {
		return jobs.Info{}, errors.New(textRequestNotSubmitted)
	}
	if (request.GenerationID == nil || *request.GenerationID == "") && !request.ManualResult {
		return jobs.Info{}, errors.New(textGenerationIDUnknown)
	}
	image := request.Kind == "image"
	steps := s.restoreSubmission(project, directory, view.Stage, image)
	steps = append(steps, s.resumeSteps(project, directory, request.Dir, image)...)
	info, err := s.start(jobs.KindSubmit, textRetrieveJob(view.Shot), project, steps)
	if err != nil {
		return jobs.Info{}, err
	}
	s.packageJobs[directory] = info.ID
	return info, nil
}

// restoreSubmission — этап мог остаться на подтверждении, если процесс оборвался между ответом
// сервиса и записью workflow.json.
func (s *Service) restoreSubmission(project, directory, stage string, image bool) []jobs.Step {
	if stage != "request_choice" && stage != "ready" && stage != "image_request_choice" {
		return nil
	}
	submitted := "submitted"
	if image {
		submitted = "image_submitted"
	}
	return []jobs.Step{s.toolStep(project, "shot_workflow", []string{"set-stage", "--dir", directory, submitted}, textRestoreSubmissionStep, false, nil)}
}

// unknownAttempt — попытка с неизвестным исходом и без ID: выяснить исход может только
// пользователь по истории генераций сервиса (под s.mu).
func (s *Service) unknownAttemptLocked(project, packageDir string) (string, *PackageView, error) {
	directory, err := s.availableLocked(project, packageDir)
	if err != nil {
		return "", nil, err
	}
	view, err := mustPackage(project, directory)
	if err != nil {
		return "", nil, err
	}
	status := ""
	if view != nil {
		status = view.attemptStatus()
	}
	if view == nil || view.Request == nil || (view.Request.GenerationID != nil && *view.Request.GenerationID != "") ||
		(status != "submitting" && status != "submission_unknown") {
		return "", nil, errors.New(textUnknownSubmissionOnly)
	}
	if !isPaid(view.Request.Provider) {
		return "", nil, errors.New(textRetrieveAdapterMissing(view.Request.Provider))
	}
	return directory, view, nil
}

// AttachResult — результат, скачанный пользователем из истории генераций сервиса, становится
// оригиналом попытки без новой отправки (media_request attach), затем — обычное получение.
func (s *Service) AttachResult(project, packageDir string, files []string) (jobs.Info, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	directory, view, err := s.unknownAttemptLocked(project, packageDir)
	if err != nil {
		return jobs.Info{}, err
	}
	if len(files) == 0 {
		return jobs.Info{}, errors.New(textResultFileMissing)
	}
	for _, file := range files {
		info, err := os.Stat(file)
		if !filepath.IsAbs(file) || err != nil || !info.Mode().IsRegular() {
			return jobs.Info{}, errors.New(textResultFileMissing)
		}
	}
	image := view.Request.Kind == "image"
	steps := s.restoreSubmission(project, directory, view.Stage, image)
	steps = append(steps, s.toolStep(project, "media_request", append([]string{"attach", "--work-dir", view.Request.Dir, "--file"}, files...), textAttachResultStep, false, nil))
	steps = append(steps, s.resumeSteps(project, directory, view.Request.Dir, image)...)
	info, err := s.start(jobs.KindSubmit, textManualResultJob(view.Shot), project, steps)
	if err != nil {
		return jobs.Info{}, err
	}
	s.packageJobs[directory] = info.ID
	return info, nil
}

// ManualResult — видео, созданное пользователем вне приложения по пакету ручной генерации:
// абсолютный путь файла, источник и необязательные стоимость с единицей и примечание.
type ManualResult struct {
	File       string   `json:"file"`
	Source     string   `json:"source"`
	CostAmount *float64 `json:"costAmount"`
	CostUnit   string   `json:"costUnit"`
	Note       string   `json:"note"`
}

// AttachManual — видео пакета ручной генерации становится оригиналом попытки (media_request
// attach-manual), затем — этапы «отправлено» и «получено», вопрос просмотра и техническая сводка,
// как у обычного результата. Отправки сервису нет.
func (s *Service) AttachManual(project, packageDir string, result ManualResult) (jobs.Info, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	directory, err := s.availableLocked(project, packageDir)
	if err != nil {
		return jobs.Info{}, err
	}
	view, err := mustPackage(project, directory)
	if err != nil {
		return jobs.Info{}, err
	}
	if view == nil || view.Request == nil || view.Request.Mode != "manual" || view.attemptStatus() != "manual_pending" {
		return jobs.Info{}, errors.New(textManualPackageOnly)
	}
	info, statErr := os.Stat(result.File)
	if !filepath.IsAbs(result.File) || statErr != nil || !info.Mode().IsRegular() {
		return jobs.Info{}, errors.New(textResultFileMissing)
	}
	if dynvalue.Trim(result.Source) == "" {
		return jobs.Info{}, errors.New(textManualSourceMissing)
	}
	args := []string{"attach-manual", "--work-dir", view.Request.Dir, "--file", result.File, "--source", result.Source}
	if result.CostAmount != nil {
		args = append(args, "--cost-amount", strconv.FormatFloat(*result.CostAmount, 'f', -1, 64), "--cost-unit", result.CostUnit)
	}
	if note := dynvalue.Trim(result.Note); note != "" {
		args = append(args, "--note", note)
	}
	steps := s.restoreSubmission(project, directory, view.Stage, false)
	steps = append(steps, s.toolStep(project, "media_request", args, textAttachManualStep, false, nil))
	steps = append(steps, s.resumeSteps(project, directory, view.Request.Dir, false)...)
	job, err := s.start(jobs.KindSubmit, textManualResultJob(view.Shot), project, steps)
	if err != nil {
		return jobs.Info{}, err
	}
	s.packageJobs[directory] = job.ID
	return job, nil
}

// MarkNotCreated — генерации нет в истории сервиса: попытка снова ждёт подтверждения, отправка
// требует новой оценки и согласия.
func (s *Service) MarkNotCreated(project, packageDir string) error {
	s.mu.Lock()
	directory, view, err := s.unknownAttemptLocked(project, packageDir)
	if err == nil {
		s.operations[directory] = true
	}
	s.mu.Unlock()
	if err != nil {
		return err
	}
	defer s.release(directory)
	image := view.Request.Kind == "image"
	result, err := s.run(project, "media_request", "not-created", "--work-dir", view.Request.Dir)
	if err != nil {
		return err
	}
	if !ok(result) {
		return failure(result, textMarkNotCreatedFailed)
	}
	// Назад по этапам разрешено: пакет возвращается к вопросу о запросе, прежний ответ send
	// больше не действует.
	stage := "request_choice"
	if image {
		stage = "image_request_choice"
	}
	if view.Stage != stage {
		back, err := s.run(project, "shot_workflow", "set-stage", "--dir", directory, stage)
		if err != nil {
			return err
		}
		if !ok(back) {
			return failure(back, textReturnToRequestFailed)
		}
	}
	question, err := s.run(project, "shot_workflow", "ask", "--dir", directory, "--stage", stage)
	if err != nil {
		return err
	}
	if !ok(question) {
		return failure(question, textRequestQuestionFailed)
	}
	return nil
}

// SelectImage — выбор кандидата опоры: сохраняет кандидат отдельно от оригинала; утверждение
// опоры остаётся отдельным вопросом.
func (s *Service) SelectImage(project, packageDir string, index float64, expectedResultToken string) error {
	directory, err := s.available(project, packageDir)
	if err != nil {
		return err
	}
	view, err := mustPackage(project, directory)
	if err != nil {
		return err
	}
	if view == nil || view.Stage != "image_downloaded" || view.Pending() != nil || view.ResultToken == "" || view.ResultToken != expectedResultToken ||
		view.Request == nil || view.Request.Kind != "image" || index != math.Trunc(index) || index < 0 || int(index) >= len(view.Request.Downloads) {
		return errors.New(textCandidateChanged)
	}
	directory, release, err := s.claim(project, directory)
	if err != nil {
		return err
	}
	defer release()
	request := view.Request
	media, err := s.paidMedia(request.Provider, "image")
	if err != nil {
		return err
	}
	if media != nil {
		sha := ""
		if request.SHA256 != nil {
			sha = *request.SHA256
		}
		if _, err := media.Collect(providers.PreparedRequest{Provider: media.Paid.ID, Kind: "image", Project: project, RequestDir: request.Dir, RequestSha: sha, FrameID: request.FrameID}); err != nil {
			return err
		}
	}
	selected, err := s.run(project, "shot_workflow", "select-image", "--dir", directory, "--file", request.Downloads[int(index)])
	if err != nil {
		return err
	}
	if !ok(selected) {
		return failure(selected, textSelectFrameFailed)
	}
	// Каждая опора утверждается сразу после выбора, не дожидаясь остальных.
	return s.askNextFrame(project, directory)
}

// AcceptOptions — AcceptOptions контракта: режим full (оригинал целиком совпадает с окном) или
// cut (участок оригинала в секундах), скорость и удержания кадров.
type AcceptOptions struct {
	ExpectedResultToken string   `json:"expectedResultToken,omitempty"`
	ReplaceExisting     bool     `json:"replaceExisting,omitempty"`
	Mode                string   `json:"mode"`
	CutStart            *float64 `json:"cutStart,omitempty"`
	CutEnd              *float64 `json:"cutEnd,omitempty"`
	Speed               string   `json:"speed,omitempty"`
	HoldFirst           float64  `json:"holdFirst,omitempty"`
	HoldLast            float64  `json:"holdLast,omitempty"`
}

// cutFrame — UI задаёт секунды, accept_shot принимает кадры; неточные границы не округляются молча.
func cutFrame(seconds *float64) (int, error) {
	if seconds == nil || math.IsInf(*seconds, 0) || math.IsNaN(*seconds) || *seconds < 0 {
		return 0, errors.New(textAcceptBoundsInvalid)
	}
	frames := *seconds * FPS
	rounded := math.Floor(frames + 0.5)
	if rounded > 1<<53-1 || math.Abs(frames-rounded) > 1e-6 {
		return 0, errors.New(textAcceptBoundsInvalid)
	}
	return int(rounded), nil
}

// Accept — приёмка полученного видео в assets/shots/Mxx (accept_shot заданием). Замена принятого
// комплекта необратима для индекса сцены: прежний комплект переезжает в assets/replaced только по
// явному согласию. Режим full — побайтовая копия оригинала, совпадающего с окном и FPS; режим
// участка передаёт accept_shot кадры --cut из секунд UI и, если заданы, --speed, --hold-first и
// --hold-last (рендер FFmpeg выполняет инструмент).
func (s *Service) Accept(project, shot, packageDir string, options AcceptOptions) (jobs.Info, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	directory, err := s.availableLocked(project, packageDir)
	if err != nil {
		return jobs.Info{}, err
	}
	view, err := mustPackage(project, directory)
	if err != nil {
		return jobs.Info{}, err
	}
	if view != nil && view.Request != nil && view.Request.Kind == "image" {
		return jobs.Info{}, errors.New(textImageAcceptedSeparately)
	}
	if view == nil || view.Shot != shot {
		return jobs.Info{}, errors.New(textPackageShotMismatch)
	}
	if view.ResultToken == "" || options.ExpectedResultToken == "" || options.ExpectedResultToken != view.ResultToken {
		return jobs.Info{}, errors.New(textAcceptResultChanged)
	}
	if view.attemptStatus() != "downloaded" || len(view.Request.Downloads) == 0 {
		return jobs.Info{}, errors.New(textCompleteResultRequired)
	}
	accepted := dynvalue.Exists(filepath.Join(project, "assets", "shots", shot, "manifest.json"))
	if accepted && !options.ReplaceExisting {
		return jobs.Info{}, errors.New(textReplacementConsentRequired)
	}
	edit := []string{"--full"}
	if options.Mode != "full" {
		first, err := cutFrame(options.CutStart)
		if err != nil {
			return jobs.Info{}, err
		}
		last, err := cutFrame(options.CutEnd)
		if err != nil {
			return jobs.Info{}, err
		}
		if last <= first {
			return jobs.Info{}, errors.New(textAcceptEndInvalid)
		}
		edit = []string{"--cut", fmt.Sprintf("%d:%d", first, last)}
	}
	extra := []string{}
	if options.Speed != "" && options.Speed != "1" {
		extra = append(extra, "--speed", options.Speed)
	}
	if options.HoldFirst != 0 {
		extra = append(extra, "--hold-first", dynvalue.NumberToString(options.HoldFirst))
	}
	if options.HoldLast != 0 {
		extra = append(extra, "--hold-last", dynvalue.NumberToString(options.HoldLast))
	}
	// Речевой план принимается только с точным срезом песни, подготовленным в пакете.
	lipsync := false
	if list, ok := dynvalue.AsArray(dynvalue.Get(readJSON(filepath.Join(project, "plan", "scenes.json")), "scenes")); ok {
		for _, scene := range list {
			if dynvalue.StrictEqual(dynvalue.Get(scene, "id"), shot) {
				lipsync = dynvalue.Truthy(dynvalue.Get(scene, "lipsync"))
				break
			}
		}
	}
	if lipsync && view.Speech == nil {
		return jobs.Info{}, errors.New(textAcceptSpeechRequired)
	}
	audio := []string{}
	if lipsync && view.Speech != nil {
		audio = []string{"--audio", view.Speech.Path, "--audio-recipe", view.Speech.Recipe}
	}
	args := append(append(append([]string{shot, "--package", directory}, edit...), extra...), audio...)
	label := textMoveAssetsStep
	if accepted {
		args = append(args, "--replace")
		label = textReplaceAssetsStep
	}
	args = append(args, "--clean")
	// Приёмка с очисткой удаляет попытки плана: их отправки сначала переносятся в журнал расходов.
	syncSpend := func(context.Context) error { return spend.Sync(project) }
	info, err := s.start(jobs.KindAccept, textAcceptJob(shot), project, []jobs.Step{s.toolStep(project, "accept_shot", args, label, false, syncSpend)})
	if err != nil {
		return jobs.Info{}, err
	}
	s.packageJobs[directory] = info.ID
	return info, nil
}

// ContactSheet — задание «Сводка <пакет>» с одним
// шагом contact_sheet --package <пакет> --json. Пакет должен быть свободен; задание отмечается за
// пакетом, поэтому до его конца другие операции с пакетом получают «пакет занят». Сам инструмент
// пишет только preview/ пакета (контактный лист, граничные кадры, сравнения, превью 2×).
func (s *Service) ContactSheet(project, packageDir string) (jobs.Info, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	directory, err := s.availableLocked(project, packageDir)
	if err != nil {
		return jobs.Info{}, err
	}
	step := s.toolStep(project, "contact_sheet", []string{"--package", directory, "--json"}, textContactSheetStep, false, nil)
	info, err := s.start(jobs.KindContactSheet, textContactSheetJob(filepath.Base(directory)), project, []jobs.Step{step})
	if err != nil {
		return jobs.Info{}, err
	}
	s.packageJobs[directory] = info.ID
	return info, nil
}

// montageDraftsUsing — названия сохранённых черновиков монтажа, чьи клипы лежат в папке relative.
func montageDraftsUsing(project, relative string) []string {
	folder := filepath.Join(project, "plan", "montage")
	if !dynvalue.Exists(folder) {
		return nil
	}
	entries, err := dynvalue.ReadDir(folder)
	if err != nil {
		return nil
	}
	var names []string
	for _, entry := range entries {
		if !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		draft := readJSON(filepath.Join(folder, entry.Name()))
		clips, _ := dynvalue.AsArray(dynvalue.Get(draft, "clips"))
		for _, clip := range clips {
			if path, ok := dynvalue.Get(clip, "path").(string); ok && strings.HasPrefix(strings.ReplaceAll(path, `\`, "/"), relative+"/") {
				name := dynvalue.Get(draft, "name")
				if dynvalue.IsNullish(name) {
					names = append(names, entry.Name())
				} else {
					names = append(names, dynvalue.ToString(name))
				}
				break
			}
		}
	}
	return names
}

// Bundle — BundleInfo: собранный пакет для монтажёра внутри plan/batches.
type Bundle struct {
	Dir       string  `json:"dir"`
	CreatedAt *string `json:"createdAt"`
	Shots     int     `json:"shots"`
	Videos    int     `json:"videos"`
	Copied    bool    `json:"copied"`
}

// ListBundles — собранные пакеты внутри plan/batches: папки с bundle.json, новые сверху. Пакеты
// вне проекта приложение не отслеживает.
func ListBundles(project string) ([]Bundle, error) {
	folder := filepath.Join(project, "plan", "batches")
	result := []Bundle{}
	if !dynvalue.Exists(folder) {
		return result, nil
	}
	entries, err := dynvalue.ReadDir(folder)
	if err != nil {
		return nil, err
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		path := filepath.Join(folder, entry.Name(), "bundle.json")
		bundle := readJSON(path)
		shots, isList := dynvalue.AsArray(dynvalue.Get(bundle, "shots"))
		if !dynvalue.Truthy(bundle) || !isList {
			continue
		}
		info, err := os.Stat(path)
		if err != nil {
			return nil, dynvalue.FsError("stat", path, err)
		}
		created := info.ModTime().UTC().Format("2006-01-02T15:04:05.000Z")
		videos := 0
		for _, item := range shots {
			if dynvalue.StrictEqual(dynvalue.Get(item, "status"), "video") {
				videos++
			}
		}
		result = append(result, Bundle{Dir: filepath.Join(folder, entry.Name()), CreatedAt: &created, Shots: len(shots), Videos: videos,
			Copied: dynvalue.Exists(filepath.Join(folder, entry.Name(), "media"))})
	}
	slices.SortStableFunc(result, func(a, b Bundle) int {
		if *a.CreatedAt < *b.CreatedAt {
			return 1
		}
		return -1
	})
	return result, nil
}

// ExportBundle — пакет для монтажёра в пустую папку
// target; внутри проекта допускается только plan/batches. Папка создаётся сразу, задание вида tool
// запоминается за ней, и до его конца RemoveBundle отказывает. С копированием первым идёт
// необязательный шаг update_scene_views: в пакет входят карточки неготовых планов, а их рисует
// обновление представлений; его сбой не отменяет сборку.
//
// plan/batches проверяется по границе компонента пути: соседняя папка вроде plan/batches-x
// отклоняется сразу, без создания папки и запуска инструмента.
func (s *Service) ExportBundle(project, requested string, copyMedia bool) (jobs.Info, error) {
	target := dynvalue.Resolve(requested)
	if !filepath.IsAbs(requested) {
		return jobs.Info{}, errors.New(textBundleAbsolutePathRequired)
	}
	separator := string(filepath.Separator)
	root := dynvalue.Resolve(project)
	batches := filepath.Join(root, "plan", "batches")
	if strings.HasPrefix(target, root+separator) && target != batches && !strings.HasPrefix(target, batches+separator) {
		return jobs.Info{}, errors.New(textBundlePathInvalid)
	}
	if dynvalue.Exists(target) {
		entries, err := dynvalue.ReadDir(target)
		if err != nil {
			return jobs.Info{}, err
		}
		if len(entries) > 0 {
			return jobs.Info{}, errors.New(textBundleFolderNotEmpty(target))
		}
	}
	if err := os.MkdirAll(target, 0o777); err != nil {
		return jobs.Info{}, dynvalue.FsError("mkdir", target, err)
	}
	args := []string{"--out", target}
	steps := []jobs.Step{}
	if copyMedia {
		args = append(args, "--copy")
		steps = append(steps, s.toolStep(project, "update_scene_views", []string{}, textBundleViewsStep, true, nil))
	}
	steps = append(steps, s.toolStep(project, "export_edit_bundle", args, textBundleExportStep, false, nil))
	s.mu.Lock()
	defer s.mu.Unlock()
	info, err := s.start(jobs.KindTool, textBundleJob(copyMedia), project, steps)
	if err != nil {
		return jobs.Info{}, err
	}
	s.bundleJobs[target] = info.ID
	return info, nil
}

// RemoveBundle — удаление собранного пакета для монтажёра после завершения сборки; весь пакет
// содержит только экспорт и его копии медиа. Рабочий пакет сцены так не удаляется.
func (s *Service) RemoveBundle(project, path string) error {
	directory, err := builtoutput.Checked(project, path, builtoutput.Directory)
	if err != nil {
		return err
	}
	s.mu.Lock()
	busy := s.running(s.bundleJobs[directory])
	s.mu.Unlock()
	if busy {
		return errors.New(textBundleBusy)
	}
	if _, err := builtoutput.Checked(project, filepath.Join(directory, "bundle.json"), builtoutput.File); err != nil {
		return err
	}
	bundles, err := ListBundles(project)
	if err != nil {
		return err
	}
	if !slices.ContainsFunc(bundles, func(bundle Bundle) bool { return dynvalue.Resolve(bundle.Dir) == directory }) {
		return errors.New(textBundleMissing)
	}
	// Старые рабочие пакеты определяются по запросу, даже если workflow.json ещё не использовался.
	for _, marker := range []string{"workflow.json", "request.json", filepath.Join("request", "request.json")} {
		if dynvalue.Exists(filepath.Join(directory, marker)) {
			return errors.New(textScenePackageNotBundle)
		}
	}
	return removeAll(directory)
}

// SpeechLimits — ограничения предложения среза речи: длительность запроса пакета и lipSync
// провайдера видео проекта из реестра.
func SpeechLimits(project, packageDir string) (requestSeconds *float64, lipSync *mediaproviders.LipSync, err error) {
	if packageDir != "" {
		view, err := ReadPackage(project, packageDir)
		if err != nil {
			return nil, nil, err
		}
		if view != nil {
			requestSeconds = view.RequestSeconds()
		}
	}
	settings, err := projectfile.ReadSettings(project)
	if err != nil {
		return nil, nil, err
	}
	generation, _ := dynvalue.Parse(settings.Generation)
	if id, known := mediaproviders.Normalize(dynvalue.GetPath(generation, "video", "provider")); known && mediaproviders.Supports(id, mediaproviders.Video) {
		info, _ := mediaproviders.Lookup(id)
		lipSync = info.LipSync
	}
	return requestSeconds, lipSync, nil
}

// unused guard: strconv используется в текстах кодов.
var _ = strconv.Itoa
var _ json.RawMessage
