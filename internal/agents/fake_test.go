package agents

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"
)

// Поддельные Codex и Claude для тестов. Настоящие CLI в тестах не запускаются никогда: TestMain
// подменяет HOME и PATH пустыми временными каталогами, а каждый тест передаёт окружение
// с единственным каталогом подделок и пустым списком системных каталогов.
//
// Подделка — тот же тестовый бинарник: символическая ссылка с именем CLI (codex, claude) в
// каталоге сценария. При запуске с fakeEnv=1 TestMain не выполняет тесты, а читает сценарий
// <каталог>/<имя>.json и отвечает по первому подходящему правилу. Тем же бинарником, собранным
// `go test -c`, снимались эталоны оригинала (testdata/golden/agents-cli), поэтому сценарий —
// часть эталона.

const (
	fakeEnv      = "SONGFRAME_FAKE_AGENT"
	fakeSleepEnv = "SONGFRAME_FAKE_AGENT_SLEEP"
)

// fakeRule — ответ подделки на запуск с подходящими аргументами.
type fakeRule struct {
	// Args — точные аргументы; Prefix — начало аргументов. Без обоих правило подходит всегда.
	Args   []string `json:"args,omitempty"`
	Prefix []string `json:"prefix,omitempty"`
	// Record — файл (относительно каталога сценария), куда записываются args, cwd и stdin.
	Record string `json:"record,omitempty"`
	Stdout string `json:"stdout,omitempty"`
	// Lines — строки stdout, каждая с \n, после чтения stdin, с паузой LineDelayMs между ними.
	Lines       []string `json:"lines,omitempty"`
	LineDelayMs int      `json:"lineDelayMs,omitempty"`
	Stderr      string   `json:"stderr,omitempty"`
	Code        int      `json:"code,omitempty"`
	// Bytes — объём мусора в stdout (проверка предела вывода).
	Bytes int `json:"bytes,omitempty"`
	// Hang — после вывода ждать завершения (отмена, тайм-аут).
	Hang bool `json:"hang,omitempty"`
	// Child — запустить потомка, который пишет свой pid в Child и ждёт (отмена дерева).
	Child string `json:"child,omitempty"`
	// RPC — app-server Codex: метод → result; значение {"$error": …} отвечает ошибкой.
	RPC map[string]json.RawMessage `json:"rpc,omitempty"`
	// Control — control protocol Claude: subtype → response.
	Control map[string]json.RawMessage `json:"control,omitempty"`
}

// fakeScenario — правила одной поддельной программы.
type fakeScenario struct {
	Rules []fakeRule `json:"rules"`
}

func TestMain(m *testing.M) {
	if pidFile := os.Getenv(fakeSleepEnv); pidFile != "" {
		_ = os.WriteFile(pidFile, []byte(strconv.Itoa(os.Getpid())), 0o600)
		time.Sleep(time.Minute)
		os.Exit(0)
	}
	if os.Getenv(fakeEnv) == "1" {
		os.Exit(fakeMain())
	}
	// Защита от настоящих CLI: даже ошибочный тест не найдёт ~/.local/bin/codex пользователя.
	isolated, err := os.MkdirTemp("", "songframe-agents-test-")
	if err != nil {
		panic(err)
	}
	os.Setenv("HOME", isolated)
	os.Setenv("USERPROFILE", isolated)
	os.Setenv("PATH", isolated)
	code := m.Run()
	os.RemoveAll(isolated)
	os.Exit(code)
}

// fakeMain исполняет правило сценария и возвращает код выхода.
func fakeMain() int {
	self := os.Args[0]
	name := strings.TrimSuffix(filepath.Base(self), filepath.Ext(self))
	dir := filepath.Dir(self)
	data, err := os.ReadFile(filepath.Join(dir, name+".json"))
	if err != nil {
		fmt.Fprintln(os.Stderr, "fake: нет сценария:", err)
		return 97
	}
	var scenario fakeScenario
	if err := json.Unmarshal(data, &scenario); err != nil {
		fmt.Fprintln(os.Stderr, "fake: сценарий:", err)
		return 97
	}
	args := os.Args[1:]
	for _, rule := range scenario.Rules {
		if rule.Args != nil && !slices.Equal(rule.Args, args) {
			continue
		}
		if rule.Prefix != nil && (len(args) < len(rule.Prefix) || !slices.Equal(rule.Prefix, args[:len(rule.Prefix)])) {
			continue
		}
		return runRule(rule, dir, args)
	}
	fmt.Fprintln(os.Stderr, "fake: неожиданные аргументы", args)
	return 98
}

// runRule выполняет одно правило.
func runRule(rule fakeRule, dir string, args []string) int {
	if rule.Child != "" {
		child := exec.Command(os.Args[0])
		child.Env = append(os.Environ(), fakeSleepEnv+"="+filepath.Join(dir, rule.Child))
		if err := child.Start(); err != nil {
			return 96
		}
	}
	switch {
	case rule.RPC != nil:
		return serveRPC(rule.RPC)
	case rule.Control != nil:
		return serveControl(rule.Control)
	}
	if rule.Record != "" || rule.Lines != nil {
		stdin, _ := io.ReadAll(os.Stdin)
		if rule.Record != "" {
			cwd, _ := os.Getwd()
			record, _ := json.Marshal(map[string]any{"args": args, "cwd": cwd, "stdin": string(stdin)})
			_ = os.WriteFile(filepath.Join(dir, rule.Record), record, 0o600)
		}
	}
	os.Stdout.WriteString(rule.Stdout)
	for index, line := range rule.Lines {
		if index > 0 && rule.LineDelayMs > 0 {
			time.Sleep(time.Duration(rule.LineDelayMs) * time.Millisecond)
		}
		os.Stdout.WriteString(line + "\n")
	}
	if rule.Bytes > 0 {
		chunk := strings.Repeat("x", 64*1024)
		for written := 0; written < rule.Bytes; written += len(chunk) {
			if _, err := os.Stdout.WriteString(chunk); err != nil {
				break
			}
		}
	}
	os.Stderr.WriteString(rule.Stderr)
	if rule.Hang {
		time.Sleep(time.Minute)
	}
	return rule.Code
}

// serveRPC — построчный JSON-RPC app-server: ответ по методу, уведомления без id пропускаются.
func serveRPC(results map[string]json.RawMessage) int {
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 1024*1024), 1024*1024)
	for scanner.Scan() {
		var request struct {
			ID     *json.RawMessage `json:"id"`
			Method string           `json:"method"`
		}
		if json.Unmarshal(scanner.Bytes(), &request) != nil || request.ID == nil {
			continue
		}
		reply := map[string]any{"id": request.ID}
		result, ok := results[request.Method]
		var failure struct {
			Error json.RawMessage `json:"$error"`
		}
		switch {
		case !ok:
			reply["error"] = map[string]any{"code": -32601, "message": "unknown method"}
		case json.Unmarshal(result, &failure) == nil && failure.Error != nil:
			reply["error"] = failure.Error
		default:
			reply["result"] = result
		}
		line, _ := json.Marshal(reply)
		os.Stdout.Write(append(line, '\n'))
	}
	return 0
}

// serveControl — control protocol Claude: сначала служебная строка system, затем ответы
// control_response на control_request по subtype.
func serveControl(responses map[string]json.RawMessage) int {
	os.Stdout.WriteString(`{"type":"system","subtype":"init"}` + "\n")
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 1024*1024), 1024*1024)
	for scanner.Scan() {
		var request struct {
			Type      string `json:"type"`
			RequestID string `json:"request_id"`
			Request   struct {
				Subtype string `json:"subtype"`
			} `json:"request"`
		}
		if json.Unmarshal(scanner.Bytes(), &request) != nil || request.Type != "control_request" {
			continue
		}
		response, ok := responses[request.Request.Subtype]
		subtype := "success"
		if !ok {
			subtype, response = "error", json.RawMessage("null")
		}
		line, _ := json.Marshal(map[string]any{"type": "control_response", "response": map[string]any{"subtype": subtype, "request_id": request.RequestID, "response": response}})
		os.Stdout.Write(append(line, '\n'))
	}
	return 0
}

// fakeDir — каталог с поддельными CLI. scenarios: имя программы → сценарий.
func fakeDir(t testing.TB, scenarios map[string]fakeScenario) string {
	t.Helper()
	dir := t.TempDir()
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	for name, scenario := range scenarios {
		if err := os.Symlink(self, filepath.Join(dir, name)); err != nil {
			t.Fatal(err)
		}
		data, err := json.Marshal(scenario)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, name+".json"), data, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

// fakeOptions — окружение запуска только с каталогом подделок: ни ~/.local/bin пользователя,
// ни системные каталоги не просматриваются.
func fakeOptions(t testing.TB, dir string) CheckOptions {
	t.Helper()
	return CheckOptions{
		Env:      []string{fakeEnv + "=1", "PATH=" + dir, "HOME=" + t.TempDir()},
		Home:     t.TempDir(),
		System:   []string{},
		Platform: "linux",
	}
}

// Готовые правила диагностики подделок.
var (
	claudeReady = []fakeRule{
		{Args: []string{"--version"}, Stdout: "2.1.5 (Claude Code)\n"},
		{Args: []string{"auth", "status", "--json"}, Stdout: `{"loggedIn":true,"email":"user@example.com"}`},
	}
	codexReady = []fakeRule{
		{Args: []string{"--version"}, Stdout: "codex-cli 0.160.0\n"},
		{Args: []string{"login", "status"}, Stderr: "Logged in using ChatGPT\n"},
	}
)

// TestFakeIsolation подтверждает, что тестовое окружение не видит установленных CLI.
func TestFakeIsolation(t *testing.T) {
	options := fakeOptions(t, t.TempDir()).resolve()
	for _, name := range []string{"codex", "claude"} {
		if path, found := FindExecutable(name, options.environment(), "linux"); found {
			t.Fatalf("найден настоящий %s: %s", name, path)
		}
	}
}
