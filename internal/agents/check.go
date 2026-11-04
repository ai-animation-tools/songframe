package agents

import (
	"context"
	"errors"
	"os"
	"regexp"
	"sync"
	"time"

	"songframe-go/internal/jscompat"
	"songframe-go/internal/process"
)

// Значения availability и authorization результата проверки (AgentCheckResult).
const (
	Available   = "available"
	NotFound    = "not_found"
	Unavailable = "error"

	Authenticated   = "authenticated"
	Unauthenticated = "unauthenticated"
	AuthUnknown     = "unknown"
)

// CheckResult — AgentCheckResult: найденная программа, распознанная версия и признак входа.
// Данные аккаунта и сырой вывод CLI сюда не попадают.
type CheckResult struct {
	ExecutablePath string `json:"executablePath,omitempty"`
	Version        string `json:"version,omitempty"`
	Availability   string `json:"availability"`
	Authorization  string `json:"authorization"`
	Message        string `json:"message"`
}

// CheckOptions подменяют окружение, домашний каталог, тайм-аут и платформу в тестах.
// Нулевые поля — окружение и home приложения, 10 секунд, платформа текущей ОС.
type CheckOptions struct {
	Env  []string
	Home string
	// System — системные каталоги поиска после PATH и ~/.local/bin; nil — каталоги платформы.
	// Тесты передают пустой список, чтобы установленные на машине CLI не находились.
	System   []string
	Timeout  time.Duration
	Platform string
}

// environment — окружение запуска CLI с дополненным PATH (после resolve).
func (o CheckOptions) environment() []string {
	return AgentEnvironment(o.Env, o.Home, o.System, o.Platform)
}

// process — параметры служебных сессий CLI (после resolve).
func (o CheckOptions) process() ProcessOptions {
	return ProcessOptions{Env: o.environment(), Home: o.Home, Timeout: o.Timeout, Platform: o.Platform}
}

// resolve заполняет значения по умолчанию.
func (o CheckOptions) resolve() CheckOptions {
	if o.Env == nil {
		o.Env = os.Environ()
	}
	if o.Home == "" {
		o.Home, _ = os.UserHomeDir()
	}
	if o.Timeout <= 0 {
		o.Timeout = 10 * time.Second
	}
	if o.Platform == "" {
		o.Platform = hostPlatform()
	}
	return o
}

// commandResult — итог короткой команды диагностики: код (nil — убита или не запущена),
// stdout и общий вывод stdout+"\n"+stderr, по которому распознаются версия и вход.
type commandResult struct {
	code    *int
	stdout  string
	output  string
	failure string // "", "timeout", "output_limit", "launch"
}

// probe — как распознать версию и вход конкретного CLI (agent-probes.ts оригинала).
type probe struct {
	version    *regexp.Regexp
	statusArgs []string
	// authorization возвращает ok=false, если ответ не распознан: решение принимает общий разбор.
	authorization func(result commandResult) (authorization, message string, ok bool)
}

var probes = map[string]probe{
	Claude: {
		version:    mustJS(`(?m)^(\d+\.\d+\.\d+(?:[-+][\w.-]+)?) \(Claude Code\)\s*$`, false),
		statusArgs: []string{"auth", "status", "--json"},
		authorization: func(result commandResult) (string, string, bool) {
			// CLI может вернуть адрес аккаунта и другие поля: наружу передаётся только признак входа.
			// Старый или изменившийся формат не доказывает отсутствие входа.
			data, err := jscompat.Parse([]byte(jscompat.Trim(result.stdout)))
			if err != nil {
				return "", "", false
			}
			loggedIn := jscompat.Get(data, "loggedIn")
			if loggedIn == true && result.code != nil && *result.code == 0 {
				return Authenticated, textCheckAuthenticated(Claude), true
			}
			if loggedIn == false && result.code != nil && *result.code == 1 {
				return Unauthenticated, textLogin(Providers[Claude].LoginCommand), true
			}
			return "", "", false
		},
	},
	Codex: {
		version:    mustJS(`(?m)^codex-cli (\d+\.\d+\.\d+(?:[-+][\w.-]+)?)\s*$`, false),
		statusArgs: []string{"login", "status"},
		authorization: func(result commandResult) (string, string, bool) {
			output := jsLines(result.output)
			if result.code != nil && *result.code == 0 && codexLoggedIn.MatchString(output) {
				return Authenticated, textCheckAuthenticated(Codex), true
			}
			if result.code != nil && *result.code == 1 && codexLoggedOut.MatchString(output) {
				return Unauthenticated, textLogin(Providers[Codex].LoginCommand), true
			}
			return "", "", false
		},
	},
}

var (
	codexLoggedIn  = regexp.MustCompile(`(?m)^Logged in using [^\r\n]+$`)
	codexLoggedOut = mustJS(`(?m)^Not logged in\s*$`, false)
	networkFailure = mustJS(`\b(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ENETUNREACH)\b|\b(network is unreachable|failed to connect|connection refused)\b`, true)
)

// parseVersion выделяет версию из вывода --version; неизвестный формат не доказывает
// несовместимость, а только не позволяет запустить рабочее задание.
func parseVersion(provider, output string) string {
	match := probes[provider].version.FindStringSubmatch(jsLines(output))
	if match == nil {
		return ""
	}
	return match[1]
}

// commandOutputLimit — предел каждого потока короткой команды (maxBuffer execFile оригинала).
const commandOutputLimit = 32 * 1024

// runCommand выполняет команду диагностики: без shell, с пустым stdin, в домашнем каталоге и
// тайм-аутом; превышение вывода любого потока завершает программу вместе с потомками.
func runCommand(ctx context.Context, executable string, args []string, options CheckOptions) commandResult {
	command := AgentCommand(executable, args, options.Env, options.Platform)
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	var mu sync.Mutex
	sizes := [2]int{}
	overflow := false
	result, err := process.Run(runCtx, process.Command{
		Path: command.File, Args: command.Args, Dir: options.Home, Env: options.Env, Timeout: options.Timeout,
		StdoutLimit: commandOutputLimit + 1, StderrLimit: commandOutputLimit + 1,
		OnOutput: func(data []byte, stderr bool) {
			mu.Lock()
			defer mu.Unlock()
			index := 0
			if stderr {
				index = 1
			}
			sizes[index] += len(data)
			if sizes[index] > commandOutputLimit && !overflow {
				overflow = true
				cancel()
			}
		},
	})
	mu.Lock()
	exceeded := overflow
	mu.Unlock()
	stdout := jscompat.DecodeUTF8(result.Stdout)
	value := commandResult{stdout: stdout, output: stdout + "\n" + jscompat.DecodeUTF8(result.Stderr)}
	var exit *process.ExitError
	var start *process.StartError
	switch {
	case exceeded:
		value.failure = "output_limit"
	case errors.Is(err, process.ErrTimeout), errors.Is(err, process.ErrCanceled):
		value.failure = "timeout"
	case errors.As(err, &start):
		value.failure = "launch"
	case errors.As(err, &exit):
		if exit.Signal == "" {
			code := exit.Code
			value.code = &code
		}
	case err == nil:
		code := 0
		value.code = &code
	}
	return value
}

// failureMessage — сообщение о сбое самой команды (тайм-аут, вывод, запуск) или "".
func failureMessage(result commandResult) string {
	switch result.failure {
	case "timeout":
		return textCheckTimeout
	case "output_limit":
		return textCheckOutputLimit
	case "launch":
		return textCheckLaunchFailed
	}
	return ""
}

// authorizationOf — итог проверки входа: сбой команды, распознанный ответ CLI, явная сетевая
// ошибка или неизвестное состояние. Отсутствие входа подтверждается только штатным статусом.
func authorizationOf(provider string, result commandResult) (string, string) {
	if failed := failureMessage(result); failed != "" {
		return AuthUnknown, failed
	}
	if authorization, message, ok := probes[provider].authorization(result); ok {
		return authorization, message
	}
	if (result.code == nil || *result.code != 0) && networkFailure.MatchString(result.output) {
		return AuthUnknown, textCheckConnectionFailed
	}
	return AuthUnknown, textAuthorizationUnknown
}

// CheckAgent — диагностика CLI: поиск файла в PATH, ~/.local/bin и стандартных каталогах, команда
// версии и статус входа. Рабочих запросов нет, вывод не хранится. Ручной путь к CLI не
// поддерживается. Отмена ctx завершает текущую команду; результат тогда сообщает тайм-аут.
func CheckAgent(ctx context.Context, input Settings, options CheckOptions) (CheckResult, error) {
	config, err := Normalize(&input)
	if err != nil {
		return CheckResult{}, err
	}
	options = options.resolve()
	title := Title(config.Provider)
	env := options.environment()
	options.Env = env
	path, found := FindExecutable(Providers[config.Provider].Executable, env, options.Platform)
	if !found {
		return CheckResult{Availability: NotFound, Authorization: AuthUnknown, Message: textNotFound(title, options.Platform == "win32")}, nil
	}
	base := CheckResult{ExecutablePath: path, Authorization: AuthUnknown}
	versionResult := runCommand(ctx, path, []string{"--version"}, options)
	if failed := failureMessage(versionResult); failed != "" || versionResult.code == nil || *versionResult.code != 0 {
		base.Availability = Unavailable
		base.Message = failed
		if failed == "" {
			base.Message = textVersionCheckFailed(title)
		}
		return base, nil
	}
	base.Availability = Available
	base.Version = parseVersion(config.Provider, versionResult.output)
	if base.Version == "" {
		base.Message = textCheckVersionUnknown(title)
		return base, nil
	}
	status := runCommand(ctx, path, probes[config.Provider].statusArgs, options)
	base.Authorization, base.Message = authorizationOf(config.Provider, status)
	return base, nil
}
