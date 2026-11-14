package providers

import (
	"context"
	"errors"
	"io/fs"
	"math"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"time"

	"songframe/internal/agents"
	"songframe/internal/dynvalue"
	"songframe/internal/mediaapi"
	"songframe/internal/mediaproviders"
	"songframe/internal/process"
	"songframe/internal/providers/agentexec"
)

// Тексты строк «Среды» и проверки команд.
const (
	textGitLabel        = "Git"
	textGitHint         = "Приложению не нужен: все страницы и производство работают без него. Если Git установлен, новый проект сразу создаётся репозиторием, чтобы при желании вести историю версий клипа."
	textGitLfsLabel     = "Git LFS"
	textGitLfsHint      = "Приложению не нужен. Если Git LFS установлен, новый проект хранит видео, аудио и изображения в Git через LFS, а не в обычной истории."
	textGitLfsMissing   = "Git LFS не установлен."
	textVersionChecking = "Проверяется версия"
)

func textCommandTimedOut(timeout time.Duration) string {
	return "Превышено время выполнения (" + dynvalue.NumberToString(float64(timeout.Milliseconds())) + " мс)."
}

func textCommandNotFound(command string) string {
	return "Команда не найдена: " + command
}

const (
	// authTimeout — проверка входа делает один бесплатный вызов сервиса; предел покрывает
	// обновление токена. Сам вызов ждёт сервис 30 с (--timeout по умолчанию media_request
	// auth-status).
	authTimeout     = 135 * time.Second
	authCallTimeout = 30 * time.Second
	// loginTimeout — адаптер ждёт подтверждения в браузере до пяти минут; наружный предел оставляет
	// время на обмен кода.
	loginTimeout     = 330 * time.Second
	loginWaitTimeout = 300 * time.Second
	// commandTimeout — первый запуск программы на Windows может идти долго (антивирус, холодный
	// диск): запас на проверку версии.
	commandTimeout = 45 * time.Second
)

// LoginResult — ответ environment.loginProvider.
type LoginResult struct {
	OK      bool   `json:"ok"`
	Message string `json:"message"`
}

// LoginURL — событие environment:loginUrl: адрес авторизации, который приложение уже открыло в
// браузере; страница показывает его на случай, если браузер не открылся.
type LoginURL struct {
	Provider string `json:"provider"`
	URL      string `json:"url"`
}

// Options — зависимости слоя провайдеров приложения. Нулевые поля — поведение приложения.
type Options struct {
	// Catalogs — общий каталог моделей; nil — собственный.
	Catalogs *Catalogs
	// Paid — зависимости платных адаптеров (ValidateImage и др.); Catalogs заменяется общим.
	Paid PaidOptions
	// Agents — зависимости исполнителей опор провайдеров-агентов; Agent nil — программа
	// провайдера из реестра (agents.ImageAgent) с моделью проекта.
	Agents agentexec.Deps
	// OpenURL открывает адрес авторизации в браузере; ошибка открытия не прерывает вход.
	OpenURL func(url string) error
	// Git — программа Git строки «Среды»; "" — git из PATH.
	Git string
}

// authCall — текущая проверка входа, которую ждут все одновременные запросы.
type authCall struct {
	done   chan struct{}
	result agents.ProviderAuth
}

// loginCall — ожидание входа, которое отменяет повторный вход или CancelLogin.
type loginCall struct{ cancel context.CancelFunc }

// environmentRun — текущая проверка среды: последние строки для поздних подписчиков и слушатели.
type environmentRun struct {
	done      chan struct{}
	checks    []mediaapi.EnvironmentCheck
	order     []string
	latest    map[string]mediaapi.EnvironmentCheck
	listeners map[int]func(mediaapi.EnvironmentCheck)
	next      int
}

// Layer — маршруты слоя провайдеров приложения: проверка и вход к
// платному провайдеру, проверка среды и возможности медиа, а также платные адаптеры и
// исполнители опор для производства и обложек. Владеет только состоянием текущих запросов (общая
// проверка входа, отмена ожидания входа, общая проверка среды); результаты не кэширует.
type Layer struct {
	options Options

	mu          sync.Mutex
	auth        map[string]*authCall
	logins      map[string]*loginCall
	environment *environmentRun
	paid        map[[2]string]*PaidMedia
	agents      map[string]agentexec.Executor
}

// NewLayer создаёт слой провайдеров.
func NewLayer(options Options) *Layer {
	if options.Catalogs == nil {
		options.Catalogs = &Catalogs{}
	}
	options.Paid.Catalogs = options.Catalogs
	return &Layer{options: options, auth: map[string]*authCall{}, logins: map[string]*loginCall{}, paid: map[[2]string]*PaidMedia{}, agents: map[string]agentexec.Executor{}}
}

// Catalogs — общий свежий каталог моделей слоя (производство читает тот же снимок, что настройки).
func (l *Layer) Catalogs() *Catalogs { return l.options.Catalogs }

// requirePaid — платный адаптер провайдера или ошибка «не подключён исполнитель».
func requirePaid(provider any) (Paid, error) {
	paid, ok := PaidAdapter(provider)
	if !ok {
		return Paid{}, errors.New(textPaidExecutorMissing)
	}
	return paid, nil
}

// PaidMedia — общий платный адаптер провайдера и вида медиа из реестра;
// false — провайдер не платный (точный id) или не поддерживает вид медиа.
func (l *Layer) PaidMedia(provider, kind string) (*PaidMedia, bool) {
	if !mediaproviders.Supports(provider, kind) {
		return nil, false
	}
	paid, ok := PaidAdapter(provider)
	if !ok || paid.ID != provider {
		return nil, false
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	key := [2]string{provider, kind}
	if media, found := l.paid[key]; found {
		return media, true
	}
	media := NewPaidMedia(paid, kind, l.options.Paid)
	l.paid[key] = media
	return media, true
}

// RequirePaidMedia — платный адаптер для зафиксированного запроса: id нормализуется (регистр и
// крайние пробелы), вид медиа берётся из реестра.
func (l *Layer) RequirePaidMedia(provider any, kind string) (*PaidMedia, error) {
	paid, err := requirePaid(provider)
	if err != nil {
		return nil, err
	}
	media, ok := l.PaidMedia(paid.ID, kind)
	if !ok {
		return nil, errors.New(textPaidExecutorMissing)
	}
	return media, nil
}

// AgentImages — исполнитель опор провайдера-агента по точному id.
func (l *Layer) AgentImages(provider string) (agentexec.Executor, bool) {
	adapter, ok := Agent(provider)
	if !ok || adapter.ID != provider || !mediaproviders.Supports(provider, mediaproviders.Image) {
		return nil, false
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if executor, found := l.agents[provider]; found {
		return executor, true
	}
	deps := l.options.Agents
	if deps.Agent == nil {
		info, _ := mediaproviders.Lookup(provider)
		deps.Agent = func(model string) (agents.Settings, error) { return agents.ImageAgent(info.Executor, model) }
	}
	executor := adapter.Images(deps)
	l.agents[provider] = executor
	return executor, true
}

// ProjectAgentImages — исполнитель опор провайдера изображений проекта (generation.image.provider,
// регистр и пробелы несущественны). imageProvider — сохранённое значение настройки.
func (l *Layer) ProjectAgentImages(imageProvider any) (agentexec.Executor, error) {
	id, _ := mediaproviders.Normalize(imageProvider)
	if executor, ok := l.AgentImages(id); ok {
		return executor, nil
	}
	return nil, errors.New(textImageAgentUnsupported)
}

// JobAgentImages — исполнитель провайдера, чья программа-агент выполнила задание опор, даже если
// настройки проекта уже сменились.
func (l *Layer) JobAgentImages(job agents.Job) (agentexec.Executor, error) {
	for _, adapter := range Agents() {
		info, _ := mediaproviders.Lookup(adapter.ID)
		if info.Executor == job.Provider {
			if executor, ok := l.AgentImages(adapter.ID); ok {
				return executor, nil
			}
		}
	}
	return nil, errors.New(textImageExecutorMissing)
}

// Capabilities — объявления моделей провайдера для вида медиа без
// загрузки референсов и генерации. Неизвестный провайдер вида даёт недоступный ответ с проблемой
// «Провайдер не поддерживается», неизвестный вид медиа — ошибку.
func (l *Layer) Capabilities(ctx context.Context, project, kind, provider string) (mediaapi.Capabilities, error) {
	if kind != mediaproviders.Image && kind != mediaproviders.Video {
		return mediaapi.Capabilities{}, errors.New(textMediaKindUnknown)
	}
	if media, ok := l.PaidMedia(provider, kind); ok {
		return media.Capabilities(ctx, project), nil
	}
	if kind == mediaproviders.Image {
		if executor, ok := l.AgentImages(provider); ok {
			return executor.Capabilities(ctx, project), nil
		}
	}
	return mediaapi.Capabilities{
		Provider: provider, Kind: kind, Available: false, CheckedAt: checkedAt(time.Now()),
		Models: []mediaapi.Model{}, Problems: []string{textProviderUnsupported}, GenerationVerified: false,
	}, nil
}

// ProviderAuth — вход в платного провайдера (без генерации).
// Повторное открытие страницы ждёт уже выполняющуюся проверку; готовый результат не сохраняется,
// следующая проверка снова обращается к сервису. Не платный провайдер — ошибка.
func (l *Layer) ProviderAuth(ctx context.Context, provider any) (agents.ProviderAuth, error) {
	paid, err := requirePaid(provider)
	if err != nil {
		return agents.ProviderAuth{}, err
	}
	l.mu.Lock()
	call, found := l.auth[paid.ID]
	if !found {
		call = &authCall{done: make(chan struct{})}
		l.auth[paid.ID] = call
		go func() {
			call.result = checkAuth(paid)
			l.mu.Lock()
			delete(l.auth, paid.ID)
			l.mu.Unlock()
			close(call.done)
		}()
	}
	l.mu.Unlock()
	select {
	case <-call.done:
		return call.result, nil
	case <-ctx.Done():
		return agents.ProviderAuth{}, ctx.Err()
	}
}

// CheckAuth — checkProviderAuth для проверки доступа ИИ (agents.AccessChecker.ProviderAuth).
func (l *Layer) CheckAuth(ctx context.Context, provider string) (agents.ProviderAuth, error) {
	return l.ProviderAuth(ctx, provider)
}

// authStatuses — состояния входа, которые адаптер может сообщить.
var authStatuses = map[string]bool{agents.Authenticated: true, agents.Unauthenticated: true, agents.AuthUnknown: true}

// checkAuth спрашивает адаптер о входе (auth-status). Пояснение сохраняется только для
// неподтверждённого входа; неизвестный ответ — unknown с советом повторить проверку: сбой
// клиента не подтверждает отсутствие сохранённого входа.
func checkAuth(paid Paid) agents.ProviderAuth {
	title := Title(paid.ID, paid.ID)
	failed := agents.ProviderAuth{Status: agents.AuthUnknown, Message: textAuthCheckFailed(title)}
	reader, ok := paid.adapter.(mediaapi.AuthStatusReader)
	if !ok {
		return failed
	}
	ctx, cancel := context.WithTimeout(context.Background(), authTimeout)
	defer cancel()
	answer := reader.AuthStatus(ctx, authCallTimeout)
	if !authStatuses[answer.Status] || ctx.Err() != nil {
		return failed
	}
	result := agents.ProviderAuth{Status: answer.Status}
	if answer.Status != agents.Authenticated {
		result.Message = answer.Message
	}
	return result
}

var authorizeLine = regexp.MustCompile(`^AUTHORIZE_URL (\S+)\r?$`)

// Login — вход к платному провайдеру через браузер. Новый
// вход к тому же провайдеру отменяет прежнее ожидание. Адрес авторизации приложение открывает
// само (OpenURL) и сообщает странице через onURL. Отмена через CancelLogin даёт ответ «Вход
// отменён», не ошибку.
func (l *Layer) Login(ctx context.Context, provider any, onURL func(LoginURL)) (LoginResult, error) {
	paid, err := requirePaid(provider)
	if err != nil {
		return LoginResult{}, err
	}
	title := Title(paid.ID, paid.ID)
	loginCtx, cancel := context.WithTimeout(ctx, loginTimeout)
	defer cancel()
	cancelled, cancelLogin := context.WithCancel(loginCtx)
	defer cancelLogin()
	call := &loginCall{cancel: cancelLogin}
	l.mu.Lock()
	if previous, found := l.logins[paid.ID]; found {
		previous.cancel()
	}
	l.logins[paid.ID] = call
	l.mu.Unlock()
	defer func() {
		l.mu.Lock()
		if l.logins[paid.ID] == call {
			delete(l.logins, paid.ID)
		}
		l.mu.Unlock()
	}()
	fallback := textLoginIncomplete(title)
	loginer, ok := paid.adapter.(mediaapi.Loginer)
	if !ok {
		return LoginResult{Message: fallback}, nil
	}
	var announce sync.Once
	report := func(line string) {
		match := authorizeLine.FindStringSubmatch(line)
		if match == nil {
			return
		}
		announce.Do(func() {
			if l.options.OpenURL != nil {
				_ = l.options.OpenURL(match[1])
			}
			if onURL != nil {
				onURL(LoginURL{Provider: paid.ID, URL: match[1]})
			}
		})
	}
	// Браузер открывает приложение: адаптер только ждёт ответа и сообщает адрес.
	answer := loginer.Login(cancelled, mediaapi.LoginOptions{OpenBrowser: false, Timeout: loginWaitTimeout, Report: report})
	if cancelled.Err() != nil && loginCtx.Err() == nil {
		return LoginResult{Message: textLoginCancelled(title)}, nil
	}
	if answer.Message == "" {
		answer.Message = fallback
	}
	return LoginResult{OK: answer.OK, Message: answer.Message}, nil
}

// CancelLogin отменяет ожидание входа к провайдеру. Ключ — id провайдера как есть (без
// нормализации).
func (l *Layer) CancelLogin(provider string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if call, found := l.logins[provider]; found {
		call.cancel()
	}
}

// CheckEnvironment — строки страницы «Среда» с прогрессом.
// onProgress получает каждую строку до и во время проверки; одновременные вызовы ждут одну
// проверку, поздний подписчик сначала получает последние состояния строк. Возвращает итог в
// порядке показа. Строки — платные провайдеры, Git и Git LFS; программы и модели проверяет страница
// «Компоненты».
func (l *Layer) CheckEnvironment(ctx context.Context, onProgress func(mediaapi.EnvironmentCheck)) ([]mediaapi.EnvironmentCheck, error) {
	l.mu.Lock()
	run := l.environment
	if run == nil {
		run = &environmentRun{done: make(chan struct{}), latest: map[string]mediaapi.EnvironmentCheck{}, listeners: map[int]func(mediaapi.EnvironmentCheck){}}
		l.environment = run
		go func() {
			checks := l.runEnvironment(func(check mediaapi.EnvironmentCheck) {
				l.mu.Lock()
				if _, seen := run.latest[check.ID]; !seen {
					run.order = append(run.order, check.ID)
				}
				run.latest[check.ID] = check
				listeners := make([]func(mediaapi.EnvironmentCheck), 0, len(run.listeners))
				for index := 0; index < run.next; index++ {
					if listener, ok := run.listeners[index]; ok {
						listeners = append(listeners, listener)
					}
				}
				l.mu.Unlock()
				for _, listener := range listeners {
					listener(check)
				}
			})
			l.mu.Lock()
			run.checks = checks
			l.environment = nil
			l.mu.Unlock()
			close(run.done)
		}()
	}
	id := run.next
	run.next++
	replay := make([]mediaapi.EnvironmentCheck, 0, len(run.order))
	for _, key := range run.order {
		replay = append(replay, run.latest[key])
	}
	if onProgress != nil {
		run.listeners[id] = onProgress
	}
	l.mu.Unlock()
	defer func() {
		l.mu.Lock()
		delete(run.listeners, id)
		l.mu.Unlock()
	}()
	if onProgress != nil {
		for _, check := range replay {
			onProgress(check)
		}
	}
	select {
	case <-run.done:
		return append([]mediaapi.EnvironmentCheck(nil), run.checks...), nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// runEnvironment выполняет одну проверку среды. Строки платных провайдеров задают их адаптеры
// (одинаковая строка показывается один раз), Git и Git LFS проверяются версией программы.
func (l *Layer) runEnvironment(progress func(mediaapi.EnvironmentCheck)) []mediaapi.EnvironmentCheck {
	environments := []mediaapi.Environment{}
	for _, paid := range PaidAdapters() {
		if provider, ok := paid.adapter.(mediaapi.EnvironmentProvider); ok {
			environments = append(environments, provider.Environment())
		}
	}
	checks := []mediaapi.EnvironmentCheck{}
	seen := map[string]bool{}
	for _, environment := range environments {
		for _, check := range environment.Checks {
			if !seen[check.ID] {
				seen[check.ID] = true
				checks = append(checks, check)
			}
		}
	}
	external := true
	checks = append(checks, mediaapi.EnvironmentCheck{
		ID: "git", Label: textGitLabel, Hint: textGitHint, ProductionOnly: true, Detail: mediaapi.TextEnvironmentWaiting,
		Status: "pending", External: &external,
	}, mediaapi.EnvironmentCheck{
		ID: "git-lfs", Label: textGitLfsLabel, Hint: textGitLfsHint, ProductionOnly: true, Detail: mediaapi.TextEnvironmentWaiting,
		Status: "pending", External: &external,
	})
	var mu sync.Mutex
	for _, check := range checks {
		progress(check)
	}
	update := func(id string, patch mediaapi.EnvironmentUpdate) {
		mu.Lock()
		defer mu.Unlock()
		for index := range checks {
			if checks[index].ID != id {
				continue
			}
			check := &checks[index]
			if patch.Status != "" {
				check.Status = patch.Status
			}
			if patch.OK != nil {
				check.OK = *patch.OK
			}
			if patch.Detail != nil {
				check.Detail = *patch.Detail
			}
			if patch.ElapsedMs != nil {
				elapsed := *patch.ElapsedMs
				check.ElapsedMs = &elapsed
			}
			progress(*check)
			return
		}
	}
	var wait sync.WaitGroup
	probe := func(id string, run func() (bool, string, int)) {
		wait.Add(1)
		go func() {
			defer wait.Done()
			detail := textVersionChecking
			update(id, mediaapi.EnvironmentUpdate{Status: "running", Detail: &detail})
			ok, output, elapsed := run()
			update(id, mediaapi.EnvironmentUpdate{Status: "done", OK: &ok, Detail: &output, ElapsedMs: &elapsed})
		}()
	}
	probe("git", l.versionProbe)
	probe("git-lfs", l.lfsProbe)
	for _, environment := range environments {
		if environment.Run == nil {
			continue
		}
		wait.Add(1)
		go func() {
			defer wait.Done()
			environment.Run(context.Background(), update)
		}()
	}
	wait.Wait()
	mu.Lock()
	defer mu.Unlock()
	return append([]mediaapi.EnvironmentCheck(nil), checks...)
}

// gitCommand — программа Git строки «Среды»: Options.Git либо git из PATH.
func (l *Layer) gitCommand() string {
	if l.options.Git != "" {
		return l.options.Git
	}
	return "git"
}

// versionProbe — `git --version` с пределом commandTimeout. Успех — весь вывод (stdout, иначе
// stderr) без крайних пробелов; отсутствие программы и истёкший предел — понятные тексты.
func (l *Layer) versionProbe() (bool, string, int) {
	command := l.gitCommand()
	result, elapsed, err := runVersion(command, "--version")
	stdout, stderr := string(result.Stdout), string(result.Stderr)
	if err == nil {
		output := stdout
		if output == "" {
			output = stderr
		}
		return true, dynvalue.Trim(output), elapsed
	}
	if text, known := startProblem(err, command); known {
		return false, text, elapsed
	}
	if message := dynvalue.Trim(stderr); message != "" {
		return false, message, elapsed
	}
	// Команда завершилась с ошибкой и ничего не написала в stderr: деталь называет саму команду.
	return false, "Команда завершилась с ошибкой: " + command + " --version", elapsed
}

// lfsProbe — `git lfs version` той же программой Git: так проверяется именно то, что выполнит
// создание проекта. Успех — первая непустая строка вывода. Ненулевой код при найденном git
// означает, что подкоманды lfs нет (git пишет «'lfs' is not a git command»): деталь —
// textGitLfsMissing вместо английского вывода git. Отсутствие самого git и истёкший предел —
// те же тексты, что у строки Git.
func (l *Layer) lfsProbe() (bool, string, int) {
	command := l.gitCommand()
	result, elapsed, err := runVersion(command, "lfs", "version")
	if err == nil {
		output := string(result.Stdout)
		if dynvalue.Trim(output) == "" {
			output = string(result.Stderr)
		}
		return true, firstLine(output), elapsed
	}
	if text, known := startProblem(err, command); known {
		return false, text, elapsed
	}
	return false, textGitLfsMissing, elapsed
}

// runVersion запускает проверку версии с пределом commandTimeout и захватом обоих потоков;
// elapsed — длительность в миллисекундах.
func runVersion(command string, args ...string) (process.Result, int, error) {
	started := time.Now()
	result, err := process.Run(context.Background(), process.Command{
		Path: command, Args: args, Timeout: commandTimeout, StdoutLimit: 64 * 1024, StderrLimit: 64 * 1024,
	})
	return result, int(math.Round(float64(time.Since(started).Microseconds()) / 1000)), err
}

// startProblem — понятный текст для истёкшего предела и ненайденной программы; known=false для
// остальных ошибок, которые разбирает вызывающий.
func startProblem(err error, command string) (string, bool) {
	var start *process.StartError
	switch {
	case errors.Is(err, process.ErrTimeout):
		return textCommandTimedOut(commandTimeout), true
	case errors.As(err, &start) && (errors.Is(start.Err, exec.ErrNotFound) || errors.Is(start.Err, fs.ErrNotExist)):
		return textCommandNotFound(command), true
	}
	return "", false
}

// firstLine — первая непустая строка текста без крайних пробелов; "" для пустого текста.
func firstLine(text string) string {
	for _, line := range strings.Split(text, "\n") {
		if line = dynvalue.Trim(line); line != "" {
			return line
		}
	}
	return ""
}
