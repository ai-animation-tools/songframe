package agents

import (
	"context"
	"encoding/base64"
	"regexp"
	"strconv"
	"strings"

	"songframe-go/internal/jscompat"
)

// Виды обновлений потокового протокола, общие для всех CLI.
const (
	UpdateSession      = "session"
	UpdateTextDelta    = "text_delta"
	UpdateToolStarted  = "tool_started"
	UpdateToolFinished = "tool_finished"
	UpdateCompleted    = "completed"
	// UpdateNotice — нефатальное уведомление CLI (переподключение, предупреждение): задание идёт.
	UpdateNotice = "notice"
	UpdateFailed = "failed"
)

// Update — одно событие CLI, приведённое адаптером к общему виду. Значимы только поля его вида:
// ID (session), Text (text_delta, notice), Tool (tool_*), Result (completed: nil — результат
// не сообщён), Err (failed).
type Update struct {
	Type   string
	ID     string
	Text   string
	Tool   string
	Result *string
	Err    *Error
}

// Mode — режим задания: read — чтение проекта, write — кандидаты изображений в отдельной папке.
type Mode string

const (
	ModeRead  Mode = "read"
	ModeWrite Mode = "write"
)

// Image — вложение изображения: байты уже проверены менеджером (сигнатура и размер), адаптер
// выбирает только штатный транспорт CLI.
type Image struct {
	Path      string
	Data      []byte
	MediaType string // image/png или image/jpeg
}

// Adapter знает аргументы CLI и формат его событий; жизненным циклом задания владеет Manager.
// Экземпляр хранит состояние разбора одного задания, поэтому создаётся на каждый запуск.
// Новый CLI подключается записью в Providers, описанием проверки в probes и адаптером здесь.
type Adapter interface {
	Provider() string
	Check(ctx context.Context, config Settings) (CheckResult, error)
	Account(ctx context.Context, config Settings) (AccountResult, error)
	// Models — каталог моделей найденного CLI служебным вызовом, без хода модели.
	Models(ctx context.Context, executable string, options ProcessOptions) ([]Model, error)
	// Args — аргументы рабочего запуска; неподдерживаемые режим или версия — *Error до запуска.
	Args(config Settings, version string, mode Mode, images []Image) ([]string, error)
	// Parse переводит событие JSONL в обновления; *Error — нарушение протокола.
	Parse(value *jscompat.Object) ([]Update, error)
}

// InputEncoder — адаптер, который умеет передать промпт и вложения через stdin. Без него
// вложения не превращаются молча в текстовые пути: менеджер отказывает до запуска.
type InputEncoder interface {
	Input(prompt string, images []Image) (string, error)
}

// NewAdapter создаёт адаптер исполнителя реестра с окружением приложения; для неизвестного id — nil.
func NewAdapter(provider string) Adapter { return NewAdapterOptions(provider, CheckOptions{}) }

// NewAdapterOptions — адаптер с заданными окружением, home и тайм-аутом служебных команд
// (тесты на поддельных CLI, менеджер с общими параметрами запуска).
func NewAdapterOptions(provider string, options CheckOptions) Adapter {
	switch provider {
	case Claude:
		return &claudeAdapter{options: options, tools: map[string]bool{}}
	case Codex:
		return &codexAdapter{options: options, messages: map[string]string{}}
	}
	return nil
}

// object — `value && typeof value === 'object' && !Array.isArray(value) ? value : {}`.
func object(value any) *jscompat.Object {
	if record, ok := value.(*jscompat.Object); ok {
		return record
	}
	return jscompat.NewObject()
}

// text — строковое значение или "".
func text(value any) string {
	result, _ := value.(string)
	return result
}

// blocks — элементы массива, приведённые к объектам; не массив — пустой список.
func blocks(value any) []*jscompat.Object {
	items, ok := jscompat.AsArray(value)
	if !ok {
		return nil
	}
	result := make([]*jscompat.Object, len(items))
	for index, item := range items {
		result[index] = object(item)
	}
	return result
}

// session — обновление идентификатора сеанса, если он допустим.
func session(value any) []Update {
	id := text(value)
	if !sessionPattern.MatchString(id) {
		return nil
	}
	return []Update{{Type: UpdateSession, ID: id}}
}

var versionNumbers = regexp.MustCompile(`^(\d+)\.(\d+)\.(\d+)$`)

// numbers — major, minor, patch строгой версии X.Y.Z; ok=false для иного формата.
func numbers(version string) (major, minor, patch float64, ok bool) {
	match := versionNumbers.FindStringSubmatch(version)
	if match == nil {
		return 0, 0, 0, false
	}
	parse := func(text string) float64 { value, _ := strconv.ParseFloat(text, 64); return value }
	return parse(match[1]), parse(match[2]), parse(match[3]), true
}

// supported — версия CLI совпадает по major и не старше minor.patch подтверждённого контракта.
func supported(version string, major, minor, patch float64) error {
	a, b, c, ok := numbers(version)
	if !ok || a != major || b < minor || (b == minor && c < patch) {
		return agentError(CodeUnsupportedVersion, textUnsupportedVersion)
	}
	return nil
}

// claudeInputLimit — предел stdin Claude, выбранный SongFrame (10 МБ опубликованы для piped stdin,
// отдельный предел stream-json не подтверждён). Проверяется целиком до запуска.
const claudeInputLimit = 10_000_000

// claudeAdapter — Claude Code в режиме -p со stream-json: только чтение (Read, Glob, Grep).
type claudeAdapter struct {
	options CheckOptions
	// partial — уже получены частичные text_delta текущего сообщения; полный текст assistant
	// тогда не дублируется.
	partial bool
	// tools — уже показанные запуски инструментов (по id блока tool_use).
	tools map[string]bool
}

func (a *claudeAdapter) Provider() string { return Claude }

func (a *claudeAdapter) Check(ctx context.Context, config Settings) (CheckResult, error) {
	return CheckAgent(ctx, config, a.options)
}

func (a *claudeAdapter) Account(ctx context.Context, config Settings) (AccountResult, error) {
	return claudeAccount(ctx, config, a.options)
}

func (a *claudeAdapter) Models(ctx context.Context, executable string, options ProcessOptions) ([]Model, error) {
	return readClaudeModels(ctx, executable, options)
}

func (a *claudeAdapter) Args(config Settings, version string, mode Mode, images []Image) ([]string, error) {
	if err := supported(version, 2, 1, 0); err != nil {
		return nil, err
	}
	if mode == ModeWrite {
		return nil, agentError(CodeUnsupportedVersion, textUnsupportedWriteMode)
	}
	inputFormat := "text"
	if len(images) > 0 {
		inputFormat = "stream-json"
	}
	args := []string{
		"-p", "--input-format", inputFormat, "--output-format", "stream-json", "--verbose", "--include-partial-messages",
		"--permission-mode", "dontAsk", "--tools", "Read,Glob,Grep", "--allowedTools", "Read,Glob,Grep",
	}
	if config.Model != "" {
		args = append(args, "--model", config.Model)
	}
	return args, nil
}

// Input передаёт промпт как есть, а с вложениями — user-конвертом потокового SDK: байты
// изображений идут в content base64, а не текстом путей. Порядок ключей зафиксирован эталонами.
func (a *claudeAdapter) Input(prompt string, images []Image) (string, error) {
	input := prompt
	if len(images) > 0 {
		content := &jscompat.Array{Items: []any{object2("type", "text", "text", prompt)}}
		for _, image := range images {
			source := object2("type", "base64", "media_type", image.MediaType)
			source.Set("data", base64.StdEncoding.EncodeToString(image.Data))
			content.Items = append(content.Items, object2("type", "image", "source", source))
		}
		message := object2("role", "user", "content", content)
		envelope := object2("type", "user", "message", message)
		envelope.Set("parent_tool_use_id", nil)
		input = jscompat.Stringify(envelope) + "\n"
	}
	if len(input) > claudeInputLimit {
		return "", agentError(CodeInvalidInput, textClaudeInputTooLarge)
	}
	return input, nil
}

// object2 — объект с двумя ключами в заданном порядке.
func object2(k1 string, v1 any, k2 string, v2 any) *jscompat.Object {
	result := jscompat.NewObject()
	result.Set(k1, v1)
	result.Set(k2, v2)
	return result
}

func (a *claudeAdapter) Parse(value *jscompat.Object) ([]Update, error) {
	kind := value.Value("type")
	switch kind {
	case "system":
		if value.Value("subtype") == "init" {
			return session(value.Value("session_id")), nil
		}
	case "stream_event":
		delta := object(object(value.Value("event")).Value("delta"))
		if delta.Value("type") == "text_delta" {
			if chunk, ok := delta.Value("text").(string); ok {
				a.partial = true
				return []Update{{Type: UpdateTextDelta, Text: chunk}}, nil
			}
		}
		return nil, nil
	case "assistant":
		updates := []Update{}
		for _, block := range blocks(object(value.Value("message")).Value("content")) {
			if block.Value("type") == "text" && !a.partial {
				updates = append(updates, Update{Type: UpdateTextDelta, Text: text(block.Value("text"))})
			}
			if id := text(block.Value("id")); block.Value("type") == "tool_use" && !a.tools[id] {
				a.tools[id] = true
				updates = append(updates, Update{Type: UpdateToolStarted, Tool: utf16Slice(text(block.Value("name")), 100)})
			}
		}
		a.partial = false
		return updates, nil
	case "user":
		updates := []Update{}
		for _, block := range blocks(object(value.Value("message")).Value("content")) {
			if block.Value("type") == "tool_result" {
				updates = append(updates, Update{Type: UpdateToolFinished, Tool: phaseReading})
			}
		}
		return updates, nil
	case "result":
		if value.Value("is_error") == true || value.Value("subtype") != "success" {
			reason := []any{value.Value("subtype"), value.Value("result")}
			if errors, ok := jscompat.AsArray(value.Value("errors")); ok {
				for _, item := range errors {
					if _, isString := item.(string); isString {
						reason = append(reason, item)
					}
				}
			}
			joined := jscompat.Join(reason, " ")
			return []Update{{Type: UpdateFailed, Err: providerFailure(joined, joined)}}, nil
		}
		result := text(value.Value("result"))
		return append(session(value.Value("session_id")), Update{Type: UpdateCompleted, Result: &result}), nil
	}
	return nil, nil
}

// codexAdapter — codex exec --json: песочница read-only для предложений и workspace-write
// только для рабочей папки кандидатов изображений.
type codexAdapter struct {
	options CheckOptions
	// messages — уже полученный текст каждого agent_message по id: Codex присылает полный текст
	// заново, а наружу уходит только приращение.
	messages map[string]string
	// completedMessage — последнее завершённое сообщение: результатом служит оно, а не commentary.
	completedMessage string
}

func (a *codexAdapter) Provider() string { return Codex }

func (a *codexAdapter) Check(ctx context.Context, config Settings) (CheckResult, error) {
	return CheckAgent(ctx, config, a.options)
}

func (a *codexAdapter) Account(ctx context.Context, config Settings) (AccountResult, error) {
	return codexAccount(ctx, config, a.options)
}

func (a *codexAdapter) Models(ctx context.Context, executable string, options ProcessOptions) ([]Model, error) {
	return readCodexAgentModels(ctx, executable, options)
}

func (a *codexAdapter) Args(config Settings, version string, mode Mode, images []Image) ([]string, error) {
	if err := supported(version, 0, 159, 0); err != nil {
		return nil, err
	}
	if len(images) > 0 && mode != ModeRead {
		return nil, agentError(CodeInvalidInput, textImageAttachmentsReadOnly)
	}
	sandbox := "workspace-write"
	if mode == ModeRead {
		sandbox = "read-only"
	}
	args := []string{"-a", "never", "exec", "--json", "--sandbox", sandbox, "--skip-git-repo-check", "--color", "never"}
	if config.Model != "" {
		args = append(args, "--model", config.Model)
	}
	for _, image := range images {
		args = append(args, "--image", image.Path)
	}
	return append(args, "-"), nil
}

// Input — codex exec загружает изображения через --image, а промпт по-прежнему читает из stdin.
func (a *codexAdapter) Input(prompt string, _ []Image) (string, error) { return prompt, nil }

// codexTools — элементы, которые показываются как работа инструмента.
var codexTools = map[string]bool{"command_execution": true, "mcp_tool_call": true, "web_search": true, "file_change": true}

func (a *codexAdapter) Parse(value *jscompat.Object) ([]Update, error) {
	kind := value.Value("type")
	switch kind {
	case "thread.started":
		return session(value.Value("thread_id")), nil
	case "turn.completed":
		result := a.completedMessage
		return []Update{{Type: UpdateCompleted, Result: &result}}, nil
	case "turn.failed":
		// Фатален только turn.failed. Событие error верхнего уровня Codex шлёт и при переподключении
		// потока, после которого ход продолжается; если ход оборвётся, менеджер покажет уведомление.
		reason := jscompat.Coalesce(object(value.Value("error")).Value("message"), value.Value("message"))
		return []Update{{Type: UpdateFailed, Err: providerFailure(reason, reason)}}, nil
	case "error":
		message := jscompat.Coalesce(value.Value("message"), object(value.Value("error")).Value("message"))
		return []Update{{Type: UpdateNotice, Text: text(message)}}, nil
	case "item.completed", "item.updated", "item.started":
		item := object(value.Value("item"))
		itemType := text(item.Value("type"))
		switch {
		case itemType == "agent_message":
			id := text(item.Value("id"))
			message := text(item.Value("text"))
			// Промежуточные сообщения остаются прогрессом; результат — последнее полное сообщение.
			if kind == "item.completed" {
				a.completedMessage = message
			}
			previous := a.messages[id]
			a.messages[id] = message
			if !strings.HasPrefix(message, previous) {
				return nil, agentError(CodeProtocolError, "Codex изменил уже полученный текст сообщения.")
			}
			delta := message[len(previous):]
			if delta == "" {
				return nil, nil
			}
			if previous == "" && len(a.messages) > 1 {
				delta = "\n" + delta
			}
			return []Update{{Type: UpdateTextDelta, Text: delta}}, nil
		case codexTools[itemType]:
			update := UpdateToolStarted
			if kind == "item.completed" {
				update = UpdateToolFinished
			}
			return []Update{{Type: update, Tool: itemType}}, nil
		case itemType == "error" && kind == "item.completed":
			// Элемент error в codex exec — нефатальное уведомление; ход продолжается.
			return []Update{{Type: UpdateNotice, Text: text(item.Value("message"))}}, nil
		}
	}
	return nil, nil
}
