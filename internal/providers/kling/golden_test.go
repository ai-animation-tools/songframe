package kling

import (
	"context"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"encoding/base64"

	"songframe-go/internal/golden"
	"songframe-go/internal/providers/kling/mcp"
	"songframe-go/internal/pycompat"
)

// Эталоны kling-request сняты с kling_request.py оригинала (capture-kling.py этапа 45b):
// cases.json — чистые функции адаптера, adapter.json — submit/poll/account/auth_status/login/
// capabilities на подменённом сеансе MCP (исход и журнал вызовов сеанса).

const domain = "kling-request"

func field(value any, key string) any { return value.(*pycompat.Dict).Value(key) }

// arg — аргумент случая, записанный строкой json.dumps.
func arg(t *testing.T, entry any, key string) any {
	t.Helper()
	return golden.PyParse(t, golden.PyString(t, field(entry, "args"), key))
}

func dumps(t *testing.T, value any) string {
	t.Helper()
	text, err := pycompat.DumpsJSON(value, pycompat.DumpOptions{})
	if err != nil {
		t.Fatalf("сериализация: %v", err)
	}
	return text
}

// assertOutcome сверяет исход с {result} или {error: {type, message}} эталона.
func assertOutcome(t *testing.T, label string, expected any, got any, err error, normalize func(string) string) {
	t.Helper()
	if normalize == nil {
		normalize = func(text string) string { return text }
	}
	want := expected.(*pycompat.Dict)
	if failure, ok := want.Value("error").(*pycompat.Dict); ok {
		wantType, wantMessage := failure.Value("type").(string), failure.Value("message").(string)
		if err == nil {
			t.Errorf("%s: ожидалось %s: %s, получено %s", label, wantType, wantMessage, dumps(t, got))
			return
		}
		if gotType := mcp.ErrorTypeName(err); gotType != wantType || normalize(err.Error()) != wantMessage {
			t.Errorf("%s: исключение\n  ожидалось %s: %s\n  получено  %s: %s", label, wantType, wantMessage, gotType, normalize(err.Error()))
		}
		return
	}
	if err != nil {
		t.Errorf("%s: ожидалось %s, получено исключение %s: %v", label, want.Value("result"), mcp.ErrorTypeName(err), err)
		return
	}
	if text := normalize(dumps(t, got)); text != want.Value("result") {
		t.Errorf("%s:\n  ожидалось %s\n  получено  %s", label, want.Value("result"), text)
	}
}

// snapshotOf — снимок каталога из списка имён инструментов и тела who_am_i.
func snapshotOf(tools any, body any) catalog {
	names := map[string]bool{}
	for _, name := range tools.([]any) {
		names[name.(string)] = true
	}
	values, _ := body.(*pycompat.Dict)
	return catalog{tools: names, body: values}
}

// strings — []string как список Python.
func list(items []string) []any {
	result := make([]any, len(items))
	for index, item := range items {
		result[index] = item
	}
	return result
}

// TestPureGolden — чистые функции адаптера на cases.json.
func TestPureGolden(t *testing.T) {
	cases := golden.PyFile(t, domain, "cases.json").([]any)
	var who any
	for _, entry := range cases {
		if golden.PyString(t, entry, "name") == "command_capabilities all-models" {
			who = arg(t, entry, "body")
		}
	}
	adapter := &Adapter{}
	count := 0
	for _, entry := range cases {
		name, call := golden.PyString(t, entry, "name"), golden.PyString(t, entry, "call")
		expected := field(entry, "expected")
		var got any
		var err error
		switch call {
		case "validate_spec":
			err = adapter.ValidateSpec(arg(t, entry, "spec").(*pycompat.Dict))
		case "validate_prompt":
			got = list(adapter.ValidatePrompt(arg(t, entry, "prompt").(string)))
		case "capability_fields":
			got, err = capabilityFields(arg(t, entry, "values"))
		case "command_capabilities":
			got, err = commandCapabilities(arg(t, entry, "command").(string), arg(t, entry, "model"), snapshotOf(arg(t, entry, "tools"), arg(t, entry, "body")))
		case "capabilities":
			got, err = capabilityReport(arg(t, entry, "kind").(string), snapshotOf(arg(t, entry, "tools"), arg(t, entry, "body")))
		case "normalize_inputs":
			spec, _ := arg(t, entry, "spec").(*pycompat.Dict)
			loads := []any{}
			got, err = adapter.normalizeInputs(spec, func(command string) (catalog, error) {
				loads = append(loads, []any{command})
				tools := []any{}
				for _, name := range []string{"image_to_image", "image_to_video", "motion_control", "text_to_image", "text_to_video"} {
					tools = append(tools, name)
				}
				return snapshotOf(tools, pycompat.DeepCopy(who)), nil
			})
			want := expected.(*pycompat.Dict)
			if dumps(t, spec) != want.Value("spec") || dumps(t, loads) != want.Value("catalog") {
				t.Errorf("%s: spec %s каталог %s, ожидалось %s %s", name, dumps(t, spec), dumps(t, loads), want.Value("spec"), want.Value("catalog"))
			}
		case "argument":
			got, err = argument(arg(t, entry, "value"))
		case "envelope":
			value := arg(t, entry, "request").(*pycompat.Dict)
			if parameters, ok := value.Value("parameters").(*pycompat.Dict); ok && parameters.Value("x") == "nan" {
				parameters.Set("x", nanValue())
			}
			inputs := []slotURL{}
			for _, item := range arg(t, entry, "inputs").([]any) {
				pair := item.([]any)
				inputs = append(inputs, slotURL{pair[0].(string), pair[1].(string)})
			}
			got, err = envelope(value, arg(t, entry, "prompt").(string), inputs)
		case "find_balance":
			var found []BalanceField
			found, err = FindBalance(arg(t, entry, "value"), "")
			items := []any{}
			for _, item := range found {
				items = append(items, []any{item.Name, item.Value})
			}
			got = items
		default:
			continue
		}
		count++
		assertOutcome(t, name, expected, got, err, nil)
	}
	if count < 120 {
		t.Fatalf("проверено %d случаев адаптера — меньше ожидаемого", count)
	}
}

// fakeSession — сеанс MCP сценария adapter.json: отвечает по script и пишет журнал вызовов в
// формате FakeSession съёмки.
type fakeSession struct {
	script *pycompat.Dict
	log    *[]any
}

// seconds — таймаут в секундах как его передавал Python (целое или None для 0).
func seconds(timeout time.Duration) any {
	if timeout == 0 {
		return nil
	}
	if timeout%time.Second == 0 {
		return pycompat.NewInt(int64(timeout / time.Second))
	}
	return timeout.Seconds()
}

func (f *fakeSession) behave(script any) (any, error) {
	values, ok := script.(*pycompat.Dict)
	if !ok {
		panic("вызов без сценария")
	}
	if kind, ok := values.Value("raise").(string); ok {
		message, _ := values.Value("message").(string)
		switch kind {
		case "TransportError":
			var status int64
			if number, ok := values.Value("status").(pycompat.Int); ok {
				status, _ = number.Int64()
			}
			return nil, &mcp.TransportError{Status: int(status), Text: values.Value("text").(string)}
		case "AuthRequired":
			return nil, &mcp.AuthRequiredError{Message: message}
		case "NotSent":
			return nil, &mcp.NotSentError{Message: message}
		case "ProtocolError":
			return nil, &mcp.ProtocolError{Message: message}
		case "ToolError":
			return nil, &mcp.ToolError{Message: message}
		default:
			return nil, pycompat.New(kind, message)
		}
	}
	return pycompat.DeepCopy(values.Value("return")), nil
}

func (f *fakeSession) Initialize(context.Context) (any, error) {
	*f.log = append(*f.log, []any{"initialize"})
	script, found := f.script.Get("initialize")
	if !found {
		return pycompat.NewDict(), nil
	}
	return f.behave(script)
}

func (f *fakeSession) Tools(context.Context) ([]any, error) {
	*f.log = append(*f.log, []any{"tools"})
	value, err := f.behave(f.script.Value("tools"))
	if err != nil {
		return nil, err
	}
	return value.([]any), nil
}

func (f *fakeSession) Call(_ context.Context, name string, arguments *pycompat.Dict, timeout time.Duration, _ any) (any, error) {
	var logged any
	if arguments != nil {
		logged = pycompat.DeepCopy(arguments)
	}
	*f.log = append(*f.log, []any{"call", name, logged, seconds(timeout)})
	calls, _ := f.script.Value("call").(*pycompat.Dict)
	return f.behave(calls.Value(name))
}

func (f *fakeSession) Upload(_ context.Context, path string, _ any) (string, error) {
	name := filepath.Base(path)
	*f.log = append(*f.log, []any{"upload", name})
	uploads, _ := f.script.Value("upload").(*pycompat.Dict)
	value, err := f.behave(uploads.Value(name))
	if err != nil {
		return "", err
	}
	return value.(string), nil
}

// loginErrors — исключения, которыми съёмка подменяла mcp.login.
var loginErrors = map[string]error{
	"auth":      &mcp.AuthRequiredError{Message: "отменён"},
	"transport": &mcp.TransportError{Status: 400, Text: "Kling не обменял код авторизации на токен."},
	"value":     pycompat.New(pycompat.ValueError, "Недопустимый адрес сервера."),
	"not-sent":  &mcp.NotSentError{Message: "Порты входа 8787–8790 заняты: закройте программу, которая их использует, и повторите вход."},
}

var debugTime = regexp.MustCompile(`(?m)^--- (\S+) \d\d:\d\d:\d\d `)

// TestAdapterGolden — сетевые функции адаптера на сценарии сеанса adapter.json.
func TestAdapterGolden(t *testing.T) {
	ctx := context.Background()
	for _, entry := range golden.PyFile(t, domain, "adapter.json").([]any) {
		name, call := golden.PyString(t, entry, "name"), golden.PyString(t, entry, "call")
		expected := field(entry, "expected").(*pycompat.Dict)
		t.Run(name, func(t *testing.T) {
			state := t.TempDir()
			debug := filepath.Join(t.TempDir(), "debug.log")
			log := []any{}
			script := arg(t, entry, "script").(*pycompat.Dict)
			adapter := &Adapter{Client: &mcp.Client{StateDir: state, DebugFile: debug}}
			adapter.newSession = func(timeout time.Duration, traceID any) session {
				log = append(log, []any{"session", seconds(timeout), traceID})
				return &fakeSession{script: script, log: &log}
			}
			if field(field(entry, "args"), "credentials") == true {
				record := pycompat.NewDict()
				record.Set("access_token", "a")
				if err := adapter.Client.WriteCredentials(record); err != nil {
					t.Fatal(err)
				}
			}
			directory := t.TempDir()
			for file, content := range iterDict(arg(t, entry, "files")) {
				data, _ := base64.StdEncoding.DecodeString(content.(string))
				path := filepath.Join(directory, filepath.FromSlash(file))
				if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(path, data, 0o644); err != nil {
					t.Fatal(err)
				}
			}
			timeout := func() time.Duration {
				value, _ := arg(t, entry, "timeout").(pycompat.Int).Int64()
				return time.Duration(value) * time.Second
			}
			var got any
			var err error
			switch call {
			case "submit", "poll":
				request := arg(t, entry, "request").(*pycompat.Dict)
				if parameters, ok := request.Value("parameters").(*pycompat.Dict); ok && name == "submit parameters-nan" {
					parameters.Set("duration", nanValue())
				}
				if call == "submit" {
					got, err = adapter.Submit(ctx, directory, request, arg(t, entry, "state").(*pycompat.Dict), timeout())
				} else {
					got, err = adapter.Poll(ctx, directory, request, arg(t, entry, "state").(*pycompat.Dict), timeout())
				}
			case "account":
				got, err = adapter.Account(ctx, timeout())
			case "auth_status":
				got = adapter.AuthStatus(ctx, timeout())
			case "capabilities_catalog":
				got, err = adapter.Capabilities(ctx, arg(t, entry, "kind").(string), timeout())
			case "login":
				failure := loginErrors[strings.TrimPrefix(name, "login ")]
				adapter.clientLogin = func(context.Context, mcp.LoginOptions) (*pycompat.Dict, error) {
					if failure != nil {
						return nil, failure
					}
					return pycompat.NewDict(), nil
				}
				got = adapter.Login(ctx, mcp.LoginOptions{Timeout: time.Second})
			default:
				t.Fatalf("неизвестный вызов %s", call)
			}
			normalize := func(text string) string { return strings.ReplaceAll(text, directory, "<dir>") }
			assertOutcome(t, name, expected, got, err, normalize)
			if text := dumps(t, log); text != expected.Value("log") {
				t.Errorf("журнал сеанса\n  ожидалось %s\n  получено  %s", expected.Value("log"), text)
			}
			data, readErr := os.ReadFile(debug)
			if want, ok := expected.Value("debug").(string); ok {
				if text := debugTime.ReplaceAllString(string(data), "--- $1 <time> "); readErr != nil || text != want {
					t.Errorf("отладка\n  ожидалось %q\n  получено  %q", want, text)
				}
			} else if readErr == nil {
				t.Errorf("лишняя отладочная запись: %s", data)
			}
		})
	}
}

// iterDict — пары словаря эталона.
func iterDict(value any) map[string]any {
	result := map[string]any{}
	values := value.(*pycompat.Dict)
	for _, key := range values.Keys() {
		result[key] = values.Value(key)
	}
	return result
}

// nanValue — float("nan"): во входах эталона NaN записан строкой.
func nanValue() float64 {
	zero := 0.0
	return zero / zero
}
