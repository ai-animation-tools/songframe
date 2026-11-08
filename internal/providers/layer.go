package providers

import (
	"context"
	"errors"
	"io/fs"
	"math"
	"os/exec"
	"regexp"
	"sync"
	"time"

	"songframe-go/internal/agents"
	"songframe-go/internal/jscompat"
	"songframe-go/internal/mediaapi"
	"songframe-go/internal/mediaproviders"
	"songframe-go/internal/process"
	"songframe-go/internal/providers/agentexec"
)

// Тексты строк «Среды» и проверки команд (environmentTexts.main оригинала).
const (
	textGitLabel        = "Git"
	textGitHint         = "Приложению не нужен: все страницы и производство работают без него. Если Git установлен, новый проект сразу создаётся репозиторием, чтобы при желании вести историю версий клипа."
	textVersionChecking = "Проверяется версия"
)

func textCommandTimedOut(timeout time.Duration) string {
	return "Превышено время выполнения (" + jscompat.NumberToString(float64(timeout.Milliseconds())) + " мс)."
}

func textCommandNotFound(command string) string {
	return "Команда не найдена: " + command
}

const (
	// authTimeout — проверка входа делает один бесплатный вызов сервиса; предел покрывает
	// обновление токена (AUTH_TIMEOUT_MS оригинала). Сам вызов ждёт сервис 30 с (--timeout по
	// умолчанию media_request auth-status).
	authTimeout     = 135 * time.Second
	authCallTimeout = 30 * time.Second
	// loginTimeout — адаптер ждёт подтверждения в браузере до пяти минут; наружный предел оставляет
	// время на обмен кода (LOGIN_TIMEOUT_MS оригинала).
	loginTimeout     = 330 * time.Second
	loginWaitTimeout = 300 * time.Second
	// commandTimeout — первый запуск программы на Windows может идти долго (антивирус, холодный
	// диск): запас на проверку версии (COMMAND_TIMEOUT_MS оригинала).
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

// Layer — маршруты слоя провайдеров главного процесса оригинала (ipc.ts): проверка и вход к
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

// PaidMedia — общий платный адаптер провайдера и вида медиа из реестра (paidMedia оригинала);
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

// RequirePaidMedia — платный адаптер для замороженного запроса: id нормализуется, как
// requirePaid оригинала, вид медиа берётся из реестра.
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

// AgentImages — исполнитель опор провайдера-агента по точному id (agentImages оригинала).
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

// Capabilities — media:capabilities оригинала: объявления моделей провайдера для вида медиа без
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

// ProviderAuth — environment:providerAuth оригинала: вход в платного провайдера (без генерации).
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

// Login — environment:loginProvider оригинала: вход к платному провайдеру через браузер. Новый
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

// CancelLogin — environment:cancelLogin оригинала: отменяет ожидание входа к провайдеру. Ключ —
// id провайдера как есть (без нормализации), как в оригинале.
func (l *Layer) CancelLogin(provider string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if call, found := l.logins[provider]; found {
		call.cancel()
	}
}

// CheckEnvironment — environment:check оригинала: строки страницы «Среда» с прогрессом.
// onProgress получает каждую строку до и во время проверки; одновременные вызовы ждут одну
// проверку, поздний подписчик сначала получает последние состояния строк. Возвращает итог в
// порядке показа.
//
// Отличие от оригинала: строки инструментов, Python, библиотек, модели Whisper и FFmpeg заменены
// страницей «Компоненты» (D-028); остаются строки платных провайдеров и Git.
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
// (одинаковая строка показывается один раз), Git проверяется версией программы.
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
	wait.Add(1)
	go func() {
		defer wait.Done()
		detail := textVersionChecking
		update("git", mediaapi.EnvironmentUpdate{Status: "running", Detail: &detail})
		ok, output, elapsed := l.versionProbe()
		update("git", mediaapi.EnvironmentUpdate{Status: "done", OK: &ok, Detail: &output, ElapsedMs: &elapsed})
	}()
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

// versionProbe — `git --version` с пределом commandTimeout. Успех — первая непустая из stdout и
// stderr без крайних пробелов; отсутствие программы и истёкший предел — понятные тексты.
func (l *Layer) versionProbe() (bool, string, int) {
	command := l.options.Git
	if command == "" {
		command = "git"
	}
	started := time.Now()
	result, err := process.Run(context.Background(), process.Command{
		Path: command, Args: []string{"--version"}, Timeout: commandTimeout, StdoutLimit: 64 * 1024, StderrLimit: 64 * 1024,
	})
	elapsed := int(math.Round(float64(time.Since(started).Microseconds()) / 1000))
	stdout, stderr := string(result.Stdout), string(result.Stderr)
	if err == nil {
		output := stdout
		if output == "" {
			output = stderr
		}
		return true, jscompat.Trim(output), elapsed
	}
	var start *process.StartError
	switch {
	case errors.Is(err, process.ErrTimeout):
		return false, textCommandTimedOut(commandTimeout), elapsed
	case errors.As(err, &start) && (errors.Is(start.Err, exec.ErrNotFound) || errors.Is(start.Err, fs.ErrNotExist)):
		return false, textCommandNotFound(command), elapsed
	}
	if message := jscompat.Trim(stderr); message != "" {
		return false, message, elapsed
	}
	// Текст ошибки execFile Node.js: «Command failed: <команда>» и пустой stderr с новой строки.
	return false, "Command failed: " + command + " --version\n", elapsed
}
