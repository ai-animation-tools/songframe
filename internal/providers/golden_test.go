package providers

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"songframe-go/internal/golden"
	"songframe-go/internal/jscompat"
	"songframe-go/internal/mediaapi"
	"songframe-go/internal/mediaproviders"
	"songframe-go/internal/providers/kling"
	"songframe-go/internal/tools"
)

// goldenCases — эталон testdata/golden/media-providers/cases.json.
type goldenCases struct {
	Select []struct {
		Name      string                     `json:"name"`
		Provider  string                     `json:"provider"`
		Files     map[string]map[string]any  `json:"files"`
		Input     json.RawMessage            `json:"input"`
		Caps      mediaapi.Capabilities      `json:"caps"`
		Candidate map[string]json.RawMessage `json:"candidate"`
		Result    json.RawMessage            `json:"result"`
		Error     *string                    `json:"error"`
	} `json:"select"`
	Capabilities []struct {
		Name   string `json:"name"`
		Kind   string `json:"kind"`
		Code   *int   `json:"code"`
		Stdout string `json:"stdout"`
		Stderr string `json:"stderr"`
		Calls  []struct {
			Name string   `json:"name"`
			Args []string `json:"args"`
		} `json:"calls"`
		Result mediaapi.Capabilities `json:"result"`
	} `json:"capabilities"`
	Guides []struct {
		Kind     string  `json:"kind"`
		Provider any     `json:"provider"`
		Guide    *string `json:"guide"`
	} `json:"guides"`
	Environment struct {
		Checks  []mediaapi.EnvironmentCheck `json:"checks"`
		Updates []struct {
			ID    string `json:"id"`
			Patch struct {
				Status    string  `json:"status"`
				OK        *bool   `json:"ok"`
				Detail    *string `json:"detail"`
				ElapsedMs *int    `json:"elapsedMs"`
			} `json:"patch"`
		} `json:"updates"`
	} `json:"environment"`
}

func loadGolden(t *testing.T) goldenCases {
	t.Helper()
	var cases goldenCases
	if err := json.Unmarshal(golden.ReadFile(t, "media-providers", "cases.json"), &cases); err != nil {
		t.Fatal(err)
	}
	return cases
}

// registerTest — платный провайдер test эталона: правила Kling без frameDefined.
func registerTest(t *testing.T) Paid {
	t.Helper()
	t.Cleanup(mediaproviders.Register("test", mediaproviders.Info{Title: "Тестовый сервис", Kinds: []string{"image", "video"}, Paid: true}))
	rules := kling.RequestRules()
	rules.FrameDefined = nil
	return Paid{ID: "test", Rules: rules}
}

// png — заголовок PNG с размерами, как во входах эталона.
func png(width, height int) []byte {
	header := make([]byte, 33)
	copy(header, []byte{137, 80, 78, 71, 13, 10, 26, 10})
	header[11] = 13
	copy(header[12:], "IHDR")
	put := func(offset, value int) {
		header[offset], header[offset+1], header[offset+2], header[offset+3] = byte(value>>24), byte(value>>16), byte(value>>8), byte(value)
	}
	put(16, width)
	put(20, height)
	header[24], header[25] = 8, 2
	return header
}

// paidInput — PaidInput из JSON случая.
func paidInput(t *testing.T, raw json.RawMessage, project string) PaidInput {
	t.Helper()
	value, err := jscompat.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	object := value.(*jscompat.Object)
	text := func(key string) string { value, _ := object.Value(key).(string); return value }
	objectOf := func(key string) *jscompat.Object { value, _ := object.Value(key).(*jscompat.Object); return value }
	input := PaidInput{
		Project: project, WorkDir: text("workDir"), Shot: text("shot"), Kind: text("kind"), Command: text("command"), Model: text("model"),
		Prompt: text("prompt"), Parameters: objectOf("parameters"), ProjectOptions: objectOf("projectOptions"),
		RequiredParameters: objectOf("requiredParameters"), Outputs: int(jscompat.ToNumber(object.Value("outputs"))), FrameID: text("frameId"),
	}
	if object.Has("preferredModel") {
		preferred, _ := object.Value("preferredModel").(string)
		input.PreferredModel = &preferred
	}
	if selection, ok := object.Value("modelSelection").(*jscompat.Object); ok {
		input.ModelSelection = &ModelSelection{SelectedModel: jscompat.ToString(selection.Value("selectedModel")), Reason: jscompat.ToString(selection.Value("reason"))}
		if preferred, ok := selection.Value("preferredModel").(string); ok {
			input.ModelSelection.PreferredModel = &preferred
		}
	}
	if constraint, ok := object.Value("durationConstraint").(*jscompat.Object); ok {
		input.DurationConstraint = &DurationConstraint{WindowSeconds: jscompat.ToNumber(constraint.Value("windowSeconds")), Rule: jscompat.ToString(constraint.Value("rule"))}
		if constraint.Has("minSeconds") {
			minimum := jscompat.ToNumber(constraint.Value("minSeconds"))
			input.DurationConstraint.MinSeconds = &minimum
		}
	}
	items, _ := jscompat.AsArray(object.Value("inputs"))
	for _, item := range items {
		get := func(key string) string { value, _ := jscompat.Get(item, key).(string); return value }
		input.Inputs = append(input.Inputs, PaidInputItem{Flag: get("flag"), Slot: get("slot"), Path: get("path"), Role: get("role")})
	}
	return input
}

// TestSelectPaidRequestGolden сверяет выбор модели, нормализацию запроса и тексты отказов с
// эталоном.
func TestSelectPaidRequestGolden(t *testing.T) {
	cases := loadGolden(t)
	test := registerTest(t)
	klingPaid, ok := PaidAdapter("kling")
	if !ok {
		t.Fatal("kling не платный адаптер")
	}
	for _, item := range cases.Select {
		t.Run(item.Name, func(t *testing.T) {
			project := t.TempDir()
			for path, spec := range item.Files {
				file := filepath.Join(project, path)
				if err := os.MkdirAll(filepath.Dir(file), 0o777); err != nil {
					t.Fatal(err)
				}
				data := []byte(jscompat.ToString(spec["text"]))
				if size, ok := spec["png"].([]any); ok {
					data = png(int(size[0].(float64)), int(size[1].(float64)))
				}
				if err := os.WriteFile(file, data, 0o666); err != nil {
					t.Fatal(err)
				}
			}
			paid := test
			if item.Provider == "kling" {
				paid = klingPaid
			}
			var candidate CandidateParameters
			if item.Candidate != nil {
				candidate = func(model mediaapi.Model) *jscompat.Object {
					value, err := jscompat.Parse(item.Candidate[model.ID])
					if err != nil {
						t.Fatal(err)
					}
					return value.(*jscompat.Object)
				}
			}
			result, err := SelectPaidRequest(paid, paidInput(t, item.Input, project), item.Caps, candidate)
			if item.Error != nil {
				if err == nil {
					t.Fatalf("ожидалась ошибка %q", *item.Error)
				}
				if got := strings.ReplaceAll(err.Error(), project, "<project>"); got != *item.Error {
					t.Fatalf("ошибка\n%s\nожидалась\n%s", got, *item.Error)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			var expected struct {
				Model          string          `json:"model"`
				PreferredModel *string         `json:"preferredModel"`
				ModelSelection ModelSelection  `json:"modelSelection"`
				Parameters     json.RawMessage `json:"parameters"`
				Inputs         []PaidInputItem `json:"inputs"`
				Outputs        int             `json:"outputs"`
			}
			if err := json.Unmarshal(item.Result, &expected); err != nil {
				t.Fatal(err)
			}
			wantParameters, _ := jscompat.Parse(expected.Parameters)
			if result.Model != expected.Model || jscompat.Stringify(result.Parameters) != jscompat.Stringify(wantParameters) || result.Outputs != expected.Outputs {
				t.Fatalf("модель %s параметры %s, ожидались %s %s", result.Model, jscompat.Stringify(result.Parameters), expected.Model, jscompat.Stringify(wantParameters))
			}
			gotSelection, _ := json.Marshal(result.ModelSelection)
			wantSelection, _ := json.Marshal(expected.ModelSelection)
			if string(gotSelection) != string(wantSelection) {
				t.Fatalf("выбор %s, ожидался %s", gotSelection, wantSelection)
			}
			preferred := ""
			if expected.PreferredModel != nil {
				preferred = *expected.PreferredModel
			}
			if result.PreferredModel == nil || *result.PreferredModel != preferred {
				t.Fatalf("preferredModel %v, ожидался %q", result.PreferredModel, preferred)
			}
			gotInputs, _ := json.Marshal(result.Inputs)
			wantInputs, _ := json.Marshal(expected.Inputs)
			if string(gotInputs) != string(wantInputs) {
				t.Fatalf("входы %s, ожидались %s", gotInputs, wantInputs)
			}
		})
	}
}

// TestCapabilitiesGolden сверяет разбор каталога и проблемы команд с PaidMediaProvider.capabilities.
func TestCapabilitiesGolden(t *testing.T) {
	cases := loadGolden(t)
	test := registerTest(t)
	for _, item := range cases.Capabilities {
		t.Run(item.Name, func(t *testing.T) {
			var calls [][]string
			run := func(_ context.Context, project, name string, args []string) (tools.Result, error) {
				calls = append(calls, append([]string{name}, args...))
				return tools.Result{Code: item.Code, Stdout: item.Stdout, Stderr: item.Stderr}, nil
			}
			media := NewPaidMedia(test, item.Kind, PaidOptions{Run: run})
			result := media.Capabilities(context.Background(), "/клип")
			result.CheckedAt = ""
			item.Result.CheckedAt = ""
			got, _ := json.Marshal(result)
			want, _ := json.Marshal(item.Result)
			if !jsonEqual(t, got, want) {
				t.Fatalf("возможности\n%s\nожидались\n%s", got, want)
			}
			if len(calls) != 1 || strings.Join(calls[0], " ") != strings.Join(append([]string{item.Calls[0].Name}, item.Calls[0].Args...), " ") {
				t.Fatalf("вызовы %v", calls)
			}
		})
	}
}

// jsonEqual сравнивает JSON без учёта порядка ключей.
func jsonEqual(t *testing.T, left, right []byte) bool {
	t.Helper()
	var a, b any
	if json.Unmarshal(left, &a) != nil || json.Unmarshal(right, &b) != nil {
		return false
	}
	x, _ := json.Marshal(a)
	y, _ := json.Marshal(b)
	return string(x) == string(y)
}

// TestGuidesGolden сверяет разделы «Указания агенту» с эталоном.
func TestGuidesGolden(t *testing.T) {
	cases := loadGolden(t)
	registerTest(t)
	for _, item := range cases.Guides {
		guide, ok := Guide(item.Kind, item.Provider)
		if (item.Guide != nil) != ok || (ok && guide != *item.Guide) {
			t.Errorf("%s/%v: %q, ожидалось %v", item.Kind, item.Provider, guide, item.Guide)
		}
	}
}

// TestKlingEnvironmentGolden сверяет строку «Среды» Kling и её результат с эталоном.
func TestKlingEnvironmentGolden(t *testing.T) {
	cases := loadGolden(t)
	paid, _ := PaidAdapter("kling")
	environment := paid.adapter.(mediaapi.EnvironmentProvider).Environment()
	got, _ := json.Marshal(environment.Checks)
	want, _ := json.Marshal(cases.Environment.Checks)
	if !jsonEqual(t, got, want) {
		t.Fatalf("строки %s, ожидались %s", got, want)
	}
	var updates []string
	environment.Run(context.Background(), func(id string, patch mediaapi.EnvironmentUpdate) {
		data, _ := json.Marshal(map[string]any{"id": id, "status": patch.Status, "ok": patch.OK, "detail": patch.Detail, "elapsedMs": patch.ElapsedMs})
		updates = append(updates, string(data))
	})
	var expected []string
	for _, update := range cases.Environment.Updates {
		data, _ := json.Marshal(map[string]any{"id": update.ID, "status": update.Patch.Status, "ok": update.Patch.OK, "detail": update.Patch.Detail, "elapsedMs": update.Patch.ElapsedMs})
		expected = append(expected, string(data))
	}
	if strings.Join(updates, "\n") != strings.Join(expected, "\n") {
		t.Fatalf("обновления %v, ожидались %v", updates, expected)
	}
}
