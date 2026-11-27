package productionworkflow

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"songframe/internal/dynvalue"
	"songframe/internal/mediaadapters"
	"songframe/internal/mediatest"
	"songframe/internal/providers"
	"songframe/internal/savedlooks"
	"songframe/internal/toolrt"
	"songframe/internal/tools"
)

// looksCaps — test-cheap принимает до двух сохранённых образов аргументом looks; остальное как
// в requestCaps.
var looksCaps = strings.Replace(requestCaps, `"sound":{"allowed":["true","false"]}},`, `"sound":{"allowed":["true","false"]},"looks":{"max_items":2}},`, 1)

// looksWorkflow — проход с объявлениями caps, тестовым сервисом (его библиотека образов
// настраивается в service.json) и каталогом состояния во временной папке.
func looksWorkflow(t *testing.T, run *goldenRun, caps string) (*Workflow, *mediatest.Service, savedlooks.Store) {
	t.Helper()
	service := &mediatest.Service{Dir: t.TempDir()}
	t.Cleanup(mediaadapters.Register(mediatest.ID, requestRules{Service: service}))
	state := t.TempDir()
	saved := mediaadapters.StateDir
	mediaadapters.StateDir = func() (string, error) { return state, nil }
	t.Cleanup(func() { mediaadapters.StateDir = saved })
	runTool := func(ctx context.Context, project, name string, args []string) (tools.Result, error) {
		if name == "media_request" && len(args) > 0 && args[0] == "capabilities" {
			code := 0
			return tools.Result{Code: &code, Stdout: caps}, nil
		}
		return tools.RunContext(ctx, project, name, args)
	}
	paid, ok := providers.PaidAdapter(mediatest.ID)
	if !ok {
		t.Fatal("нет платного адаптера test")
	}
	video := providers.NewPaidMedia(paid, "video", providers.PaidOptions{
		Catalogs: &providers.Catalogs{Run: runTool}, Run: runTool, ValidateImage: func(string) bool { return true },
	})
	workflow := New(Options{
		LocalDir: run.local, Agents: run.agents, Run: runTool, Catalog: &providers.Catalogs{Run: runTool},
		IsScenarioApproved: func(string) bool { return true },
		VideoMedia:         func(provider string) (*providers.PaidMedia, bool) { return video, provider == mediatest.ID },
		ExtractFrame:       fakeExtractFrame,
	})
	return workflow, service, savedlooks.Store{Dir: state}
}

// limitedLooks — правила с пределом промпта 25 символов.
type limitedLooks struct{ requestRules }

func (limitedLooks) PromptWarningChars() int { return 25 }

// markedPrompt заменяет утверждённый видеопромпт попытки dir текстом с метками.
func markedPrompt(t *testing.T, dir, text string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, "video-prompt.txt"), []byte(text), 0o664); err != nil {
		t.Fatal(err)
	}
	workflow, err := packageDocument(dir, textWorkflowNotCreated)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256([]byte(text))
	workflow.Set("approved_prompt_sha256", hex.EncodeToString(digest[:]))
	if err := writeProjectJSON(filepath.Join(dir, "workflow.json"), workflow); err != nil {
		t.Fatal(err)
	}
}

// bindLook привязывает образ look к референсу reference по его текущим снимкам и кладёт образ в
// библиотеку тестового сервиса (inLibrary=false — образ удалён в аккаунте).
func bindLook(t *testing.T, run *goldenRun, service *mediatest.Service, store savedlooks.Store, reference, look, name string, inLibrary bool) {
	t.Helper()
	references, err := savedlooks.References(run.project)
	if err != nil {
		t.Fatal(err)
	}
	images := []string{}
	for _, item := range references {
		if item.ID == reference {
			images = item.Images
		}
	}
	if err := store.Bind(mediatest.ID, savedlooks.Binding{
		Account: mediatest.DefaultAccount, Project: savedlooks.ProjectKey(run.project), Reference: reference, Look: look, Name: name, Images: images,
	}); err != nil {
		t.Fatal(err)
	}
	library, _ := service.Config().Value("saved_looks").([]any)
	if inLibrary {
		entry := toolrt.NewDict()
		entry.Set("id", look)
		entry.Set("name", name)
		library = append(library, entry)
	}
	values := toolrt.NewDict()
	values.Set("saved_looks", library)
	if err := service.Configure(values); err != nil {
		t.Fatal(err)
	}
}

// requestPrompt — замороженный текст запроса name попытки dir.
func requestPrompt(t *testing.T, dir, name string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(dir, name, "prompt.txt"))
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

// Модель с образами: метки становятся разметкой провайдера у каждого упоминания, образы —
// аргументом модели и списком saved_looks в request.json (в порядке первого упоминания); файл
// промпта попытки сохраняет метки.
func TestPrepareRequestSavedLooks(t *testing.T) {
	run := ownRun(t)
	workflow, service, store := looksWorkflow(t, run, looksCaps)
	dir := promptReady(t, run, 2)
	text := "Лодка [@boat] плывёт к причалу [@pier]; у причала [@pier] лодка [@boat] замедляется.\n"
	markedPrompt(t, dir, text)
	bindLook(t, run, service, store, "pier", "look-7", "Причал", true)
	bindLook(t, run, service, store, "boat", "look-3", "Лодка", true)
	if _, err := workflow.PrepareRequest(context.Background(), run.project, "M01", dir, nil); err != nil {
		t.Fatal(err)
	}
	if got := requestPrompt(t, dir, "request-01"); got != "Лодка {look:look-3} плывёт к причалу {look:look-7}; у причала {look:look-7} лодка {look:look-3} замедляется.\n" {
		t.Fatalf("промпт запроса: %q", got)
	}
	request := requestFile(t, dir, "request-01")
	if got := dynvalue.Stringify(dynvalue.Get(request.Value("parameters"), "looks")); got != `["look-3","look-7"]` {
		t.Fatalf("аргумент образов: %s", got)
	}
	if got := dynvalue.Stringify(request.Value("saved_looks")); got != `[{"code":"boat","entity":"Лодка","look":"look-3","name":"Лодка"},{"code":"pier","entity":"Причал","look":"look-7","name":"Причал"}]` {
		t.Fatalf("saved_looks: %s", got)
	}
	if kept, _ := os.ReadFile(filepath.Join(dir, "video-prompt.txt")); string(kept) != text {
		t.Fatalf("файл промпта попытки изменился: %q", kept)
	}
	if calls := service.Calls("list_looks"); len(calls) != 1 {
		t.Fatalf("списков образов: %d", len(calls))
	}
}

// Модель без образов: метки убираются вместе с пробелом перед ними, аккаунт не запрашивается,
// request.json — как у запроса без меток.
func TestPrepareRequestStripsMarks(t *testing.T) {
	run := ownRun(t)
	workflow, service, _ := looksWorkflow(t, run, requestCaps)
	dir := promptReady(t, run, 2)
	markedPrompt(t, dir, "Лодка [@boat] плывёт к причалу [@pier].\n")
	if _, err := workflow.PrepareRequest(context.Background(), run.project, "M01", dir, nil); err != nil {
		t.Fatal(err)
	}
	if got := requestPrompt(t, dir, "request-01"); got != "Лодка плывёт к причалу.\n" {
		t.Fatalf("промпт запроса: %q", got)
	}
	request := requestFile(t, dir, "request-01")
	if request.Has("saved_looks") || dynvalue.Get(request.Value("parameters"), "looks") != dynvalue.Undefined {
		t.Fatalf("образы в запросе без образов: %s", dynvalue.Stringify(request))
	}
	if calls := service.Calls("list_looks"); len(calls) != 0 {
		t.Fatalf("список образов без модели с образами: %d", len(calls))
	}
}

// Ошибки меток: сущность не в кадре или опечатка, герой без образа, образ удалён в аккаунте,
// образов больше предела модели. Запрос не собирается, папки request-01 нет.
func TestPrepareRequestSavedLookRefusals(t *testing.T) {
	cases := []struct {
		name, caps, prompt, want string
		setup                    func(t *testing.T, run *goldenRun, service *mediatest.Service, store savedlooks.Store)
	}{
		{name: "не в кадре", caps: requestCaps, prompt: "Мира [@mira] машет.\n", want: "метка [@mira], но такой сущности нет в кадре плана (коды сущностей в кадре: boat, pier)"},
		{name: "опечатка", caps: looksCaps, prompt: "Лодка [@Boat] плывёт.\n", want: "метка [@Boat]"},
		{name: "без образа", caps: looksCaps, prompt: "Лодка [@boat] плывёт.\n", want: "У «Лодка» нет сохранённого образа"},
		{name: "удалён", caps: looksCaps, prompt: "Лодка [@boat] плывёт.\n", want: "Образа «Старая лодка» у «Лодка» больше нет в аккаунте",
			setup: func(t *testing.T, run *goldenRun, service *mediatest.Service, store savedlooks.Store) {
				bindLook(t, run, service, store, "boat", "look-1", "Старая лодка", false)
			}},
		{name: "сверх предела", caps: strings.Replace(looksCaps, `"max_items":2`, `"max_items":1`, 1), prompt: "Лодка [@boat] у причала [@pier].\n",
			want: "Модель test-cheap принимает не больше 1 образов в запросе, а в промпте отмечено 2"},
		{name: "метка с пробелом", caps: looksCaps, prompt: "Лодка [@boat ] плывёт.\n", want: "метка записана с ошибкой: «[@boat ] плывёт.»"},
		{name: "метка с пробелом без образов", caps: requestCaps, prompt: "Лодка [@boat плывёт.\n", want: "метка записана с ошибкой: «[@boat плывёт.»"},
		{name: "длиннее предела после подстановки", caps: looksCaps, prompt: "Лодка [@boat] плывёт.\n", want: "После подстановки образов промпт занимает 27 символов при пределе 25",
			setup: func(t *testing.T, run *goldenRun, service *mediatest.Service, store savedlooks.Store) {
				bindLook(t, run, service, store, "boat", "look-1", "Лодка", true)
				t.Cleanup(mediaadapters.Register(mediatest.ID, limitedLooks{requestRules{Service: service}}))
			}},
		{name: "сбой списка", caps: looksCaps, prompt: "Лодка [@boat] плывёт.\n", want: "Не удалось проверить образы аккаунта провайдера видео: нет связи.",
			setup: func(t *testing.T, _ *goldenRun, service *mediatest.Service, _ savedlooks.Store) {
				values := toolrt.NewDict()
				values.Set("looks_error", "нет связи")
				if err := service.Configure(values); err != nil {
					t.Fatal(err)
				}
			}},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			run := ownRun(t)
			workflow, service, store := looksWorkflow(t, run, item.caps)
			dir := promptReady(t, run, 2)
			markedPrompt(t, dir, item.prompt)
			if item.setup != nil {
				item.setup(t, run, service, store)
			}
			_, err := workflow.PrepareRequest(context.Background(), run.project, "M01", dir, nil)
			if err == nil || !strings.Contains(err.Error(), item.want) {
				t.Fatalf("ошибка: %v; нужно «%s»", err, item.want)
			}
			if dynvalue.Exists(filepath.Join(dir, "request-01")) {
				t.Fatal("папка запроса осталась")
			}
		})
	}
}
