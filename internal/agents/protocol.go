package agents

import (
	"bytes"
	"regexp"

	"songframe/internal/dynvalue"
)

// Коды диагностики задания (AgentDiagnosticCode контракта). Код сохраняется в истории
// и показывается интерфейсом вместе с текстом причины.
const (
	CodeInvalidInput       = "INVALID_INPUT"
	CodeProjectBusy        = "PROJECT_BUSY"
	CodeCLINotFound        = "CLI_NOT_FOUND"
	CodeCLIUnavailable     = "CLI_UNAVAILABLE"
	CodeAuthRequired       = "AUTH_REQUIRED"
	CodeAuthUnknown        = "AUTH_UNKNOWN"
	CodeUnsupportedVersion = "UNSUPPORTED_VERSION"
	CodeProtocolError      = "PROTOCOL_ERROR"
	CodeOutputLimit        = "OUTPUT_LIMIT"
	CodeTimeout            = "TIMEOUT"
	CodeCancelled          = "CANCELLED"
	CodeInterrupted        = "INTERRUPTED"
	CodeCLIError           = "CLI_ERROR"
	CodeRateLimit          = "RATE_LIMIT"
)

// Error — AgentError контракта: код диагностики и пользовательская причина. Текст ошибки
// «[КОД] причина» доходит до renderer как сообщение отказа agents.start.
type Error struct {
	Code   string
	Detail string
}

func (e *Error) Error() string { return "[" + e.Code + "] " + e.Detail }

func agentError(code, detail string) *Error { return &Error{Code: code, Detail: detail} }

// DefaultLineBytes — предел одной строки JSONL (256 КиБ).
const DefaultLineBytes = 256 * 1024

// oversizePrefix — сколько начальных байтов слишком длинной строки получает Oversize для решения:
// хватает на тип события и первый блок содержимого, а остаток строки не накапливается.
const oversizePrefix = 1024

// JSONLines разбирает поток JSONL по строкам независимо от границ фрагментов вывода.
// Разделитель \n не встречается внутри многобайтных символов UTF-8, поэтому строка режется
// по байтам и декодируется целиком (недопустимые байты — U+FFFD, как StringDecoder).
// Ошибка строки (не JSON, не объект, слишком длинная) не включает её текст: CLI может печатать
// секреты. Не потокобезопасен: менеджер вызывает его из сериализованного обработчика вывода.
type JSONLines struct {
	onValue   func(value *dynvalue.Object) error
	lineBytes int
	pending   []byte
	// Oversize решает по началу строки длиннее предела, можно ли её пропустить: true — строка
	// отбрасывается до перевода строки без накопления, false — ошибка OUTPUT_LIMIT. Без обработчика
	// любая длинная строка — ошибка. Так CLI, повторяющий в выводе прочитанные файлы, не обрывает задание.
	Oversize func(prefix []byte) (bool, error)
	// skipping — остаток пропускаемой строки ещё не дочитан до перевода строки.
	skipping bool
	// skipped — сколько байтов вывода (с переводами строк) отброшено пропуском длинных строк.
	skipped int
}

// NewJSONLines создаёт разборщик; lineBytes <= 0 означает DefaultLineBytes.
func NewJSONLines(onValue func(value *dynvalue.Object) error, lineBytes int) *JSONLines {
	if lineBytes <= 0 {
		lineBytes = DefaultLineBytes
	}
	return &JSONLines{onValue: onValue, lineBytes: lineBytes}
}

// Skipped — число байтов вывода, отброшенных пропуском длинных строк: менеджер не учитывает
// их в общем пределе вывода, потому что они не хранятся.
func (p *JSONLines) Skipped() int { return p.skipped }

// Push принимает очередной фрагмент stdout и разбирает все завершённые строки.
func (p *JSONLines) Push(chunk []byte) error {
	for len(chunk) > 0 {
		end := bytes.IndexByte(chunk, '\n')
		if p.skipping {
			if end < 0 {
				p.skipped += len(chunk)
				return nil
			}
			p.skipped += end + 1
			p.skipping = false
			chunk = chunk[end+1:]
			continue
		}
		if end < 0 {
			p.pending = append(p.pending, chunk...)
			if len(p.pending) <= p.lineBytes {
				return nil
			}
			// Строка уже длиннее предела: решение принимается сразу, остаток не копится.
			line := p.pending
			p.skipped += len(line)
			p.pending, p.skipping = nil, true
			return p.oversize(line)
		}
		line := append(p.pending, chunk[:end]...)
		p.pending = nil
		chunk = chunk[end+1:]
		if len(line) > p.lineBytes {
			p.skipped += len(line) + 1
			if err := p.oversize(line); err != nil {
				return err
			}
			continue
		}
		if err := p.parse(line); err != nil {
			return err
		}
	}
	return nil
}

// oversize применяет Oversize к началу строки длиннее предела; без обработчика или при отказе
// пропустить — ошибка OUTPUT_LIMIT без текста строки.
func (p *JSONLines) oversize(line []byte) error {
	if p.Oversize == nil {
		return agentError(CodeOutputLimit, textLineTooLarge)
	}
	skip, err := p.Oversize(line[:min(len(line), oversizePrefix)])
	if err != nil {
		return err
	}
	if !skip {
		return agentError(CodeOutputLimit, textLineTooLarge)
	}
	return nil
}

// Finish разбирает последнюю строку без завершающего перевода строки; недочитанная
// пропускаемая строка просто отбрасывается.
func (p *JSONLines) Finish() error {
	line := p.pending
	p.pending = nil
	if p.skipping || dynvalue.Trim(dynvalue.DecodeUTF8(line)) == "" {
		return nil
	}
	return p.parse(line)
}

func (p *JSONLines) parse(raw []byte) error {
	line := dynvalue.DecodeUTF8(raw)
	if dynvalue.Trim(line) == "" {
		return nil
	}
	value, err := dynvalue.Parse([]byte(line))
	if err != nil {
		return agentError(CodeProtocolError, textInvalidJSONLines)
	}
	object, ok := value.(*dynvalue.Object)
	if !ok {
		return agentError(CodeProtocolError, textEventObjectRequired)
	}
	return p.onValue(object)
}

// Маркер «[скрыто]» входит в очищенные результаты и журналы; это не подпись интерфейса.
var (
	redactTokens = mustPattern(`\b(?:sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._~-]+)`, true)
	redactFields = mustPattern(`((?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization)\s*[=:]\s*["']?)[^\s,"'}]+`, true)
	spaces       = mustPattern(`\s+`, false)
)

// Redact убирает распознаваемые секреты из текста результата, задачи и журнала: в историю не
// попадает сырой вывод CLI, но ответ агента может процитировать ключ.
func Redact(text string) string {
	text = redactTokens.ReplaceAllLiteralString(text, "[скрыто]")
	return redactFields.ReplaceAllString(text, "${1}[скрыто]")
}

// detailLimit — длина причины от CLI для показа (в кодовых единицах UTF-16, как считает эталон).
const detailLimit = 400

// providerDetail — текст причины от CLI: без секретов, в одну строку и ограниченной длины.
// Не строка — пустая причина.
func providerDetail(value any) string {
	text, _ := value.(string)
	text = dynvalue.Trim(spaces.ReplaceAllString(Redact(text), " "))
	if utf16Len(text) > detailLimit {
		return utf16Slice(text, detailLimit) + "…"
	}
	return text
}

var (
	authPattern = mustPattern(`auth|not logged|login|unauthorized|invalid`+lineDot+`?api`+lineDot+`?key|\b401\b`, true)
	ratePattern = mustPattern(`rate`+lineDot+`?limit|quota|usage`+lineDot+`?limit|budget|\b429\b`, true)
)

// providerFailure классифицирует сбой задания. value служит только классификации (в нём может
// быть stderr и потому секреты); detail — структурированное сообщение агента, которое
// показывается пользователю, чтобы причина не терялась за общей фразой.
func providerFailure(value, detail any) *Error {
	text, _ := value.(string)
	reason := providerDetail(detail)
	switch {
	case authPattern.MatchString(text):
		return agentError(CodeAuthRequired, textAuthorizationFailed(reason))
	case ratePattern.MatchString(text):
		return agentError(CodeRateLimit, textRateLimited(reason))
	}
	return agentError(CodeCLIError, textTaskFailed(reason))
}

// sessionPattern — допустимый идентификатор сеанса CLI: только ASCII-буквы, цифры, «_», «.» и «-».
var sessionPattern = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,128}$`)
