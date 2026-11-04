package agents

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"songframe-go/internal/golden"
	"songframe-go/internal/jscompat"
)

// Эталоны testdata/golden/agents-* сняты с замороженного оригинала (634fd94): чистые функции
// протокола, SettingsStore и вызовы на тех же поддельных CLI (fake_test.go), что и здесь.

// assertGolden сравнивает значение Go (после JSON) с эталоном как деревья JSON.
func assertGolden(t *testing.T, label string, want json.RawMessage, got any) {
	t.Helper()
	data, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	diffs, err := golden.Diff(want, data)
	if err != nil {
		t.Fatalf("%s: %v", label, err)
	}
	if len(diffs) > 0 {
		t.Fatalf("%s: отличие от оригинала:\n%s\nполучено: %s", label, strings.Join(diffs, "\n"), data)
	}
}

// outcome — результат или отказ в форме эталона: {throws: {code, detail}} для *Error,
// {throws: {message}} для прочих ошибок.
func outcome(value any, err error) any {
	if err == nil {
		return value
	}
	var agentErr *Error
	if errors.As(err, &agentErr) {
		return map[string]any{"throws": map[string]string{"code": agentErr.Code, "detail": agentErr.Detail}}
	}
	return map[string]any{"throws": map[string]string{"message": err.Error()}}
}

// jsValue — значение JSON как значение JS (jscompat).
func jsValue(t *testing.T, raw json.RawMessage) any {
	t.Helper()
	value, err := jscompat.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	return value
}

// tsUpdate — AgentUpdate оригинала: поле сообщения notice называется message.
func tsUpdate(update Update) map[string]any {
	result := map[string]any{"type": update.Type}
	switch update.Type {
	case UpdateSession:
		result["id"] = update.ID
	case UpdateTextDelta:
		result["text"] = update.Text
	case UpdateNotice:
		result["message"] = update.Text
	case UpdateToolStarted, UpdateToolFinished:
		result["tool"] = update.Tool
	case UpdateCompleted:
		if update.Result != nil {
			result["result"] = *update.Result
		}
	case UpdateFailed:
		result["error"] = map[string]string{"code": update.Err.Code, "detail": update.Err.Detail}
	}
	return result
}

type goldenImage struct {
	Path      string `json:"path"`
	MediaType string `json:"mediaType"`
	Size      int    `json:"size"`
	Fill      byte   `json:"fill"`
}

func (g goldenImage) image() Image {
	return Image{Path: g.Path, MediaType: g.MediaType, Data: []byte(strings.Repeat(string([]byte{g.Fill}), g.Size))}
}

func images(specs []goldenImage) []Image {
	result := []Image{}
	for _, spec := range specs {
		result = append(result, spec.image())
	}
	return result
}

func TestGoldenProtocol(t *testing.T) {
	var cases struct {
		Args []struct {
			Provider string        `json:"provider"`
			Config   Settings      `json:"config"`
			Version  string        `json:"version"`
			Mode     Mode          `json:"mode"`
			Images   []goldenImage `json:"images"`
			Expected json.RawMessage
		} `json:"args"`
		Input []struct {
			Provider string          `json:"provider"`
			Prompt   json.RawMessage `json:"prompt"`
			Images   []goldenImage   `json:"images"`
			Expected json.RawMessage `json:"expected"`
		} `json:"input"`
		Parse []struct {
			Name     string            `json:"name"`
			Provider string            `json:"provider"`
			Events   []json.RawMessage `json:"events"`
			Expected []json.RawMessage `json:"expected"`
		} `json:"parse"`
		JSONL []struct {
			Name      string          `json:"name"`
			Chunks    []string        `json:"chunks"`
			LineBytes int             `json:"lineBytes"`
			Expected  json.RawMessage `json:"expected"`
		} `json:"jsonl"`
		Redact []struct {
			Input    string `json:"input"`
			Expected string `json:"expected"`
		} `json:"redact"`
		Detail []struct {
			Input    json.RawMessage `json:"input"`
			Expected string          `json:"expected"`
		} `json:"detail"`
		Failure []struct {
			Value    json.RawMessage `json:"value"`
			Detail   json.RawMessage `json:"detail"`
			Expected json.RawMessage `json:"expected"`
		} `json:"failure"`
		Version []struct {
			Provider string  `json:"provider"`
			Output   string  `json:"output"`
			Expected *string `json:"expected"`
		} `json:"version"`
		Authorization []struct {
			Provider string `json:"provider"`
			Result   struct {
				Code   *int   `json:"code"`
				Stdout string `json:"stdout"`
				Output string `json:"output"`
			} `json:"result"`
			Expected json.RawMessage `json:"expected"`
		} `json:"authorization"`
		Normalize []struct {
			Input    json.RawMessage `json:"input"`
			Expected json.RawMessage `json:"expected"`
		} `json:"normalize"`
	}
	if err := json.Unmarshal(golden.ReadFile(t, "agents-protocol", "cases.json"), &cases); err != nil {
		t.Fatal(err)
	}
	if len(cases.Args) == 0 || len(cases.Parse) == 0 {
		t.Fatal("пустой эталон")
	}
	t.Run("args", func(t *testing.T) {
		for _, item := range cases.Args {
			args, err := NewAdapter(item.Provider).Args(item.Config, item.Version, item.Mode, images(item.Images))
			assertGolden(t, item.Provider+" "+item.Version+" "+string(item.Mode), item.Expected, outcome(args, err))
		}
	})
	t.Run("input", func(t *testing.T) {
		for _, item := range cases.Input {
			var prompt string
			if json.Unmarshal(item.Prompt, &prompt) != nil {
				var repeat struct {
					Repeat string `json:"repeat"`
					Length int    `json:"length"`
				}
				if err := json.Unmarshal(item.Prompt, &repeat); err != nil {
					t.Fatal(err)
				}
				prompt = strings.Repeat(repeat.Repeat, repeat.Length)
			}
			input, err := NewAdapter(item.Provider).(InputEncoder).Input(prompt, images(item.Images))
			var got any = input
			var digest struct {
				Length int    `json:"length"`
				SHA256 string `json:"sha256"`
			}
			if err == nil && json.Unmarshal(item.Expected, &digest) == nil && digest.SHA256 != "" {
				sum := sha256.Sum256([]byte(input))
				got = map[string]any{"length": len(input), "sha256": hex.EncodeToString(sum[:])}
			}
			assertGolden(t, item.Provider, item.Expected, outcome(got, err))
		}
	})
	t.Run("parse", func(t *testing.T) {
		for _, item := range cases.Parse {
			adapter := NewAdapter(item.Provider)
			for index, raw := range item.Events {
				updates, err := adapter.Parse(jsValue(t, raw).(*jscompat.Object))
				converted := []map[string]any{}
				for _, update := range updates {
					converted = append(converted, tsUpdate(update))
				}
				assertGolden(t, item.Name+" #"+jscompat.NumberToString(float64(index)), item.Expected[index], outcome(converted, err))
			}
		}
	})
	t.Run("jsonl", func(t *testing.T) {
		for _, item := range cases.JSONL {
			values := []json.RawMessage{}
			lineBytes := item.LineBytes
			if lineBytes == 0 {
				lineBytes = DefaultLineBytes
			}
			parser := NewJSONLines(func(value *jscompat.Object) error {
				values = append(values, json.RawMessage(jscompat.Stringify(value)))
				return nil
			}, lineBytes)
			var failure any
			run := func() error {
				for _, chunk := range item.Chunks {
					data, _ := base64.StdEncoding.DecodeString(chunk)
					if err := parser.Push(data); err != nil {
						return err
					}
				}
				return parser.Finish()
			}
			if err := run(); err != nil {
				failure = outcome(nil, err).(map[string]any)["throws"]
			}
			assertGolden(t, item.Name, item.Expected, map[string]any{"values": values, "error": failure})
		}
	})
	t.Run("redact", func(t *testing.T) {
		for _, item := range cases.Redact {
			if got := Redact(item.Input); got != item.Expected {
				t.Fatalf("Redact(%q) = %q, ожидалось %q", item.Input, got, item.Expected)
			}
		}
		for _, item := range cases.Detail {
			if got := providerDetail(jsValue(t, item.Input)); got != item.Expected {
				t.Fatalf("providerDetail(%s) = %q, ожидалось %q", item.Input, got, item.Expected)
			}
		}
		for _, item := range cases.Failure {
			failure := providerFailure(jsValue(t, item.Value), jsValue(t, item.Detail))
			assertGolden(t, string(item.Value), item.Expected, map[string]string{"code": failure.Code, "detail": failure.Detail})
		}
	})
	t.Run("probes", func(t *testing.T) {
		for _, item := range cases.Version {
			want := ""
			if item.Expected != nil {
				want = *item.Expected
			}
			if got := parseVersion(item.Provider, item.Output); got != want {
				t.Fatalf("версия %s %q = %q, ожидалось %q", item.Provider, item.Output, got, want)
			}
		}
		for _, item := range cases.Authorization {
			authorization, message, ok := probes[item.Provider].authorization(commandResult{code: item.Result.Code, stdout: item.Result.Stdout, output: item.Result.Output})
			var got any
			if ok {
				got = map[string]string{"authorization": authorization, "message": message}
			}
			assertGolden(t, item.Provider+" "+item.Result.Output, item.Expected, got)
		}
	})
	t.Run("normalize", func(t *testing.T) {
		for _, item := range cases.Normalize {
			settings, err := normalizeValue(jsValue(t, item.Input))
			assertGolden(t, string(item.Input), item.Expected, outcome(settings, err))
		}
	})
}

// settingsArg — аргумент операции настроек, представимый типом контракта (*Settings).
// Значения других типов renderer передать не может: такие операции эталона пропускаются.
func settingsArg(raw json.RawMessage) (*Settings, bool) {
	if string(raw) == "null" || len(raw) == 0 {
		return nil, true
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil {
		return nil, false
	}
	var value Settings
	for key, field := range fields {
		var text string
		if json.Unmarshal(field, &text) != nil {
			return nil, false
		}
		switch key {
		case "provider":
			value.Provider = text
		case "model":
			value.Model = text
		default:
			return nil, false
		}
	}
	return &value, true
}

func TestGoldenSettings(t *testing.T) {
	var cases []struct {
		Name     string              `json:"name"`
		Initial  *string             `json:"initial"`
		Ops      [][]json.RawMessage `json:"ops"`
		Expected []json.RawMessage   `json:"expected"`
		Final    *string             `json:"final"`
	}
	if err := json.Unmarshal(golden.ReadFile(t, "agents-settings", "cases.json"), &cases); err != nil {
		t.Fatal(err)
	}
	for _, item := range cases {
		t.Run(item.Name, func(t *testing.T) {
			dir := t.TempDir()
			file := filepath.Join(dir, SettingsFile)
			if item.Initial != nil {
				if err := os.WriteFile(file, []byte(*item.Initial), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			store := NewSettingsStore(dir)
			for index, op := range item.Ops {
				var name string
				_ = json.Unmarshal(op[0], &name)
				var arg json.RawMessage
				if len(op) > 1 {
					arg = op[1]
				}
				var value any
				var err error
				switch name {
				case "getAgent":
					value, err = store.Agent()
				case "getProviderAgent":
					var provider string
					_ = json.Unmarshal(arg, &provider)
					value, err = store.ProviderAgent(provider)
				case "saveAgent", "saveProviderAgent":
					settings, ok := settingsArg(arg)
					if !ok {
						continue
					}
					if name == "saveAgent" {
						value, err = store.SaveAgent(settings)
					} else {
						value, err = store.SaveProviderAgent(settings)
					}
				default:
					t.Fatalf("неизвестная операция %s", name)
				}
				label := item.Name + " " + name
				var want struct {
					Throws *struct {
						Message string `json:"message"`
					} `json:"throws"`
				}
				_ = json.Unmarshal(item.Expected[index], &want)
				if want.Throws != nil && err != nil {
					assertMessage(t, label, want.Throws.Message, strings.ReplaceAll(err.Error(), dir, "<local>"))
					continue
				}
				assertGolden(t, label, item.Expected[index], outcome(value, err))
			}
			data, err := os.ReadFile(file)
			switch {
			case item.Final == nil && err == nil:
				t.Fatalf("файл создан: %s", data)
			case item.Final != nil && string(data) != *item.Final:
				t.Fatalf("байты settings.json:\n%s\nожидалось:\n%s", data, *item.Final)
			}
		})
	}
}

// assertMessage сравнивает текст отказа; причина разбора JSON у Node и Go разная, поэтому в
// сообщении readFailed сверяются только части, сформированные SongFrame.
func assertMessage(t *testing.T, label, want, got string) {
	t.Helper()
	const prefix = "Не удалось прочитать <local>/settings.json: "
	const suffix = ". Файл сохранён; исправьте его или перенесите в резервную папку."
	if strings.HasPrefix(want, prefix) && strings.HasSuffix(want, suffix) {
		if !strings.HasPrefix(got, prefix) || !strings.HasSuffix(got, suffix) {
			t.Fatalf("%s: %q, ожидалось сообщение вида %q", label, got, want)
		}
		return
	}
	if got != want {
		t.Fatalf("%s: %q, ожидалось %q", label, got, want)
	}
}

var (
	isoTime = regexp.MustCompile(`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z`)
	uuidV4  = regexp.MustCompile(`[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}`)
)

// normalizer заменяет пути, время и id задания маркерами эталона.
type normalizer struct {
	replacements [][2]string
	ids          map[string]string
}

func (n *normalizer) text(text string) string {
	for _, pair := range n.replacements {
		text = strings.ReplaceAll(text, pair[0], pair[1])
	}
	text = isoTime.ReplaceAllString(text, "<time>")
	return uuidV4.ReplaceAllStringFunc(text, func(id string) string {
		if _, ok := n.ids[id]; !ok {
			n.ids[id] = "<id" + jscompat.NumberToString(float64(len(n.ids)+1)) + ">"
		}
		return n.ids[id]
	})
}

func (n *normalizer) value(t *testing.T, value any) json.RawMessage {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return json.RawMessage(n.text(string(data)))
}

type cliCase struct {
	Name      string                  `json:"name"`
	Call      string                  `json:"call"`
	Config    Settings                `json:"config"`
	Scenarios map[string]fakeScenario `json:"scenarios"`
	Agent     *Settings               `json:"agent"`
	Project   map[string]string       `json:"project"`
	Images    [][2]string             `json:"images"`
	ImageJob  *struct {
		Executor string `json:"executor"`
		Model    string `json:"model"`
	} `json:"imageJob"`
	Input    json.RawMessage `json:"input"`
	Expected json.RawMessage `json:"expected"`
}

func TestGoldenCLI(t *testing.T) {
	var cases []cliCase
	if err := json.Unmarshal(golden.ReadFile(t, "agents-cli", "cases.json"), &cases); err != nil {
		t.Fatal(err)
	}
	calls := map[string]int{}
	for _, item := range cases {
		calls[item.Call]++
		t.Run(item.Call+"/"+item.Name, func(t *testing.T) {
			t.Parallel()
			dir := fakeDir(t, item.Scenarios)
			options := fakeOptions(t, dir)
			n := &normalizer{replacements: [][2]string{{dir, "<fake>"}}, ids: map[string]string{}}
			ctx := context.Background()
			switch item.Call {
			case "check":
				result, err := CheckAgent(ctx, item.Config, options)
				assertGolden(t, "check", item.Expected, jsonAny(t, n.value(t, outcome(result, err))))
			case "account":
				result, err := NewAdapterOptions(item.Config.Provider, options).Account(ctx, item.Config)
				assertGolden(t, "account", item.Expected, jsonAny(t, n.value(t, outcome(result, err))))
			case "models":
				result, err := ReadModels(ctx, NewAdapterOptions(item.Config.Provider, options), item.Config, options)
				assertGolden(t, "models", item.Expected, jsonAny(t, n.value(t, outcome(result, err))))
			case "manager":
				replayManager(t, item, dir, options, n)
			default:
				t.Fatalf("неизвестный вызов %s", item.Call)
			}
		})
	}
	if calls["check"] == 0 || calls["account"] == 0 || calls["models"] == 0 || calls["manager"] == 0 {
		t.Fatalf("неполный эталон: %v", calls)
	}
}

func jsonAny(t *testing.T, raw json.RawMessage) any {
	t.Helper()
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		t.Fatal(err)
	}
	return value
}

// replayManager повторяет случай менеджера: тот же проект, вложения, настройки и сценарий
// подделки; сравниваются снимок старта, события, итог, байты истории и запуск CLI (args, cwd, stdin).
func replayManager(t *testing.T, item cliCase, dir string, options CheckOptions, n *normalizer) {
	root := t.TempDir()
	project := filepath.Join(root, "project")
	imagesDir := filepath.Join(root, "images")
	local := filepath.Join(root, "local")
	workDir := filepath.Join(local, "image-jobs", "job-1")
	for _, path := range []string{project, imagesDir, workDir} {
		if err := os.MkdirAll(path, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	for path, content := range item.Project {
		writeTestFile(t, filepath.Join(project, path), []byte(content))
	}
	for _, pair := range item.Images {
		data, _ := base64.StdEncoding.DecodeString(pair[1])
		writeTestFile(t, filepath.Join(imagesDir, pair[0]), data)
	}
	if item.Agent != nil {
		data, _ := json.Marshal(map[string]any{"agent": item.Agent})
		writeTestFile(t, filepath.Join(local, SettingsFile), data)
	}
	n.replacements = append([][2]string{{workDir, "<workdir>"}, {project, "<project>"}, {imagesDir, "<images>"}}, n.replacements...)
	var input StartInput
	text := strings.ReplaceAll(strings.ReplaceAll(string(item.Input), "<project>", project), "<images>", imagesDir)
	if err := json.Unmarshal([]byte(text), &input); err != nil {
		t.Fatal(err)
	}
	manager := NewManager(NewSettingsStore(local), Options{Check: options})
	events := []Event{}
	done := make(chan struct{})
	manager.OnEvent(func(event Event) {
		events = append(events, event)
		if event.Type == EventCompleted || event.Type == EventFailed {
			close(done)
		}
	})
	var job Job
	var err error
	if item.ImageJob != nil {
		job, err = manager.StartImages(input, workDir, Settings{Provider: item.ImageJob.Executor, Model: item.ImageJob.Model})
	} else {
		job, err = manager.Start(input)
	}
	if err == nil {
		select {
		case <-done:
		case <-time.After(30 * time.Second):
			t.Fatal("задание не завершилось")
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := manager.ShutdownAndWait(ctx); err != nil {
		t.Fatal(err)
	}
	var expected struct {
		Start   json.RawMessage `json:"start"`
		Events  json.RawMessage `json:"events"`
		Final   json.RawMessage `json:"final"`
		History []string        `json:"history"`
		Record  json.RawMessage `json:"record"`
	}
	if err := json.Unmarshal(item.Expected, &expected); err != nil {
		t.Fatal(err)
	}
	assertGolden(t, "start", expected.Start, jsonAny(t, n.value(t, outcome(job, err))))
	assertGolden(t, "events", expected.Events, jsonAny(t, n.value(t, events)))
	var final any
	if err == nil {
		snapshot, _ := manager.Get(job.ID)
		final = jsonAny(t, n.value(t, snapshot))
	}
	assertGolden(t, "final", expected.Final, final)
	history := []string{}
	entries, _ := os.ReadDir(filepath.Join(local, "jobs"))
	for _, entry := range entries {
		data, _ := os.ReadFile(filepath.Join(local, "jobs", entry.Name()))
		history = append(history, n.text(string(data)))
	}
	if len(history) != len(expected.History) {
		t.Fatalf("история: %d файлов, ожидалось %d", len(history), len(expected.History))
	}
	for index := range history {
		if history[index] != expected.History[index] {
			t.Fatalf("байты истории:\n%s\nожидалось:\n%s", history[index], expected.History[index])
		}
	}
	var record any
	if data, err := os.ReadFile(filepath.Join(dir, "run.json")); err == nil {
		record = jsonAny(t, json.RawMessage(n.text(string(data))))
	}
	assertGolden(t, "record", expected.Record, record)
}

func writeTestFile(t *testing.T, path string, data []byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
}
