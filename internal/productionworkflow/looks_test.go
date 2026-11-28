package productionworkflow

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"reflect"
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
		{name: "один образ у двух", caps: looksCaps, prompt: "Лодка [@boat] у причала [@pier].\n", want: "У «Лодка» и «Причал» один и тот же образ «Лодка»",
			setup: func(t *testing.T, run *goldenRun, service *mediatest.Service, store savedlooks.Store) {
				bindLook(t, run, service, store, "boat", "look-3", "Лодка", true)
				bindLook(t, run, service, store, "pier", "look-3", "Лодка", false)
			}},
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

// «Изменить»: у каждой модели сказано, что станет с метками героев — модель без образов теряет
// облик героев по именам, модель с образами — без предупреждения; модель при этом доступна.
func TestRequestOptionsLooks(t *testing.T) {
	run := ownRun(t)
	workflow, service, store := looksWorkflow(t, run, looksCaps)
	dir := promptReady(t, run, 2)
	markedPrompt(t, dir, "Лодка [@boat] плывёт к причалу [@pier].\n")
	bindLook(t, run, service, store, "boat", "look-3", "Лодка", true)
	bindLook(t, run, service, store, "pier", "look-7", "Причал", true)
	if _, err := workflow.PrepareRequest(context.Background(), run.project, "M01", dir, nil); err != nil {
		t.Fatal(err)
	}
	options, err := workflow.RequestOptions(context.Background(), run.project, "M01", dir)
	if err != nil {
		t.Fatal(err)
	}
	if !options.Marked {
		t.Fatal("промпт с метками: запрос можно собрать заново без изменений")
	}
	looks := map[string]string{}
	for _, model := range options.Models {
		looks[model.ID] = model.Looks
	}
	want := map[string]string{
		"test-cheap":     "",
		"test-keyframes": "Модель test-keyframes не принимает сохранённые образы: облик по образу не получат Лодка, Причал.",
		"test-short":     "Модель test-short не принимает сохранённые образы: облик по образу не получат Лодка, Причал.",
	}
	for id, text := range want {
		if looks[id] != text {
			t.Fatalf("%s: %q, нужно %q", id, looks[id], text)
		}
	}
}

// Ожидаемая модель плана до описания — первая модель адаптера, если проект не предпочёл другую;
// предел — из её способа передачи облика, у модели без образов — 0.
func TestExpectedLookModel(t *testing.T) {
	for _, item := range []struct {
		caps  string
		limit int
		kinds []string
	}{{looksCaps, 2, []string{"character", "prop", "costume"}}, {requestCaps, 0, []string{}}} {
		run := ownRun(t)
		workflow, _, _ := looksWorkflow(t, run, item.caps)
		got, err := workflow.ExpectedLookModel(context.Background(), run.project)
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(got, LookModel{Model: "test-cheap", Limit: item.limit, Kinds: item.kinds}) {
			t.Fatalf("ожидаемая модель: %+v, нужно test-cheap с пределом %d", got, item.limit)
		}
	}
}

// startedLooks — ключ savedLooks контекста последнего задания агента; nil — ключа нет.
func startedLooks(t *testing.T, run *goldenRun) any {
	t.Helper()
	run.agents.mu.Lock()
	input := run.agents.starts[len(run.agents.starts)-1]
	run.agents.mu.Unlock()
	value, err := dynvalue.Parse([]byte(input.Context))
	if err != nil {
		t.Fatal(err)
	}
	if looks := dynvalue.Get(value, "savedLooks"); looks != dynvalue.Undefined {
		return dynvalue.Stringify(looks)
	}
	return nil
}

// Задание описания получает героев «В кадре» с действующим образом видов, которые принимает
// модель; без привязок у проекта список аккаунта не запрашивается и ключа нет. При избытке над
// пределом описание без выбора не начинается, выбранные герои записываются в правила задания.
func TestDescriptionSavedLooks(t *testing.T) {
	run := ownRun(t)
	workflow, service, store := looksWorkflow(t, run, looksCaps)
	// rules — правила последнего запущенного задания (до его отклонения).
	var rules Rules
	start := func(looks []string) error {
		t.Helper()
		_, err := workflow.Start(context.Background(), StartInput{Project: run.project, Shot: "M02", Action: "prepare", Looks: looks})
		if err != nil {
			return err
		}
		rules = workflow.store.Read(run.project, "M02").Rules()
		// Задание завершается ошибкой, и предложение отклоняется: следующий запуск начинается заново.
		job := run.agents.last(t)
		code := 1
		job.Status, job.ExitCode = "failed", &code
		if _, err := workflow.View(run.project, "M02", ""); err != nil {
			t.Fatal(err)
		}
		_, err = workflow.Discard(run.project, "M02", "", workflow.store.Read(run.project, "M02").Tree.Value("proposal").(*dynvalue.Object).Value("id").(string))
		return err
	}
	if err := start(nil); err != nil {
		t.Fatal(err)
	}
	if got := startedLooks(t, run); got != nil || len(service.Calls("list_looks")) != 0 {
		t.Fatalf("без привязок: savedLooks %v, списков %d", got, len(service.Calls("list_looks")))
	}
	// Лодка — вид, которого модель не принимает: в задание не идёт.
	bindLook(t, run, service, store, "lev", "look-1", "Лев", true)
	bindLook(t, run, service, store, "boat", "look-2", "Лодка", true)
	if err := start(nil); err != nil {
		t.Fatal(err)
	}
	if got := startedLooks(t, run); got != `{"model":"test-cheap","limit":2,"entities":[{"code":"lev","name":"Лев","kind":"character"}]}` {
		t.Fatalf("герои с образами: %v", got)
	}
	if rules.Looks != nil {
		t.Fatalf("выбирать было не из чего, а выбор записан: %v", rules.Looks)
	}

	// Модель с пределом 1 и образы у двоих персонажей.
	run = ownRun(t)
	workflow, service, store = looksWorkflow(t, run, strings.Replace(looksCaps, `"max_items":2`, `"max_items":1`, 1))
	bindLook(t, run, service, store, "lev", "look-1", "Лев", true)
	bindLook(t, run, service, store, "mira", "look-3", "Мира", true)
	if err := start(nil); err == nil || !strings.Contains(err.Error(), "Образы есть у 2 героев плана, а модель test-cheap примет не больше 1") {
		t.Fatalf("избыток без выбора: %v", err)
	}
	for _, item := range []struct {
		looks []string
		want  string
	}{{[]string{"boat"}, "Выбранного героя «boat» нет среди героев плана"}, {[]string{"mira", "lev"}, "Выбрано героев: 2, а модель test-cheap примет не больше 1"}} {
		if err := start(item.looks); err == nil || !strings.Contains(err.Error(), item.want) {
			t.Fatalf("выбор %v: %v", item.looks, err)
		}
	}
	if err := start([]string{"lev"}); err != nil {
		t.Fatal(err)
	}
	if got := startedLooks(t, run); got != `{"model":"test-cheap","limit":1,"entities":[{"code":"lev","name":"Лев","kind":"character"}]}` {
		t.Fatalf("выбранный герой: %v", got)
	}
	if !reflect.DeepEqual(rules.Looks, []string{"lev"}) {
		t.Fatalf("выбор в правилах задания: %v", rules.Looks)
	}
}

// Видеопромпт получает героев, выбранных для попытки (saved_looks), а без записи — всех героев
// с образами; ручная генерация героев не получает.
func TestPromptSavedLooks(t *testing.T) {
	run := ownRun(t)
	workflow, service, store := looksWorkflow(t, run, looksCaps)
	bindLook(t, run, service, store, "mira", "look-1", "Мира", true)
	bindLook(t, run, service, store, "lev", "look-2", "Лев", true)
	c, err := ReadContext(run.project, "M02", "")
	if err != nil {
		t.Fatal(err)
	}
	c.Workflow = dynvalue.NewObject()
	codes := func() []string {
		t.Helper()
		looks, err := workflow.lookHeroes(context.Background(), c, "prompt", nil, true)
		if err != nil {
			t.Fatal(err)
		}
		result := []string{}
		if looks != nil {
			for _, entity := range looks.entities {
				result = append(result, entity.Code)
			}
		}
		return result
	}
	if got := codes(); !reflect.DeepEqual(got, []string{"mira", "lev"}) {
		t.Fatalf("без записи: %v", got)
	}
	c.Workflow.Set("saved_looks", stringsArray([]string{"lev"}))
	if got := codes(); !reflect.DeepEqual(got, []string{"lev"}) {
		t.Fatalf("по записи попытки: %v", got)
	}
	c.Workflow.Set("saved_looks", stringsArray([]string{}))
	if got := codes(); len(got) != 0 {
		t.Fatalf("выбор «никого»: %v", got)
	}
	c.Manual = true
	c.Workflow.Delete("saved_looks")
	if got := codes(); len(got) != 0 {
		t.Fatalf("ручная генерация: %v", got)
	}
}

// preferModel записывает модель видео model предпочтением проекта прохода run.
func preferModel(t *testing.T, run *goldenRun, model string) {
	t.Helper()
	path := filepath.Join(run.project, "plan", "project.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	updated := strings.Replace(string(data), `"video":{"provider":"test",`, `"video":{"provider":"test","model":"`+model+`",`, 1)
	if updated == string(data) {
		t.Fatal("нет блока видео в настройках проекта")
	}
	if err := os.WriteFile(path, []byte(updated), 0o644); err != nil {
		t.Fatal(err)
	}
}

// Метки образов при модели проекта без образов: сборка берёт совместимую модель с образами и
// объясняет выбор; при трёх опорах модели с образами нет, и сборка, как раньше, отдаёт запрос
// модели проекта без меток. Выбор пользователя в «Изменить» правило не трогает.
func TestPrepareRequestPrefersLookModel(t *testing.T) {
	text := "Лодка [@boat] плывёт к причалу.\n"
	t.Run("две опоры", func(t *testing.T) {
		run := ownRun(t)
		workflow, service, store := looksWorkflow(t, run, looksCaps)
		preferModel(t, run, "test-keyframes")
		dir := promptReady(t, run, 2)
		markedPrompt(t, dir, text)
		bindLook(t, run, service, store, "boat", "look-3", "Лодка", true)
		if _, err := workflow.PrepareRequest(context.Background(), run.project, "M01", dir, nil); err != nil {
			t.Fatal(err)
		}
		request := requestFile(t, dir, "request-01")
		if request.Value("model") != "test-cheap" || !request.Has("saved_looks") {
			t.Fatalf("модель и образы: %v %s", request.Value("model"), dynvalue.Stringify(request.Value("saved_looks")))
		}
		reason, _ := dynvalue.Get(request.Value("model_selection"), "reason").(string)
		if want := "Предпочтительная модель test-keyframes не подходит: в запросе по опорам она не принимает сохранённые образы, а в видеопромпте отмечены герои с образом (Лодка): без образа они потеряли бы облик. Выбрана совместимая модель test-cheap."; reason != want {
			t.Fatalf("причина выбора: %q", reason)
		}
		change := &RequestChange{Model: "test-keyframes", Parameters: map[string]any{}}
		if _, err := workflow.PrepareRequest(context.Background(), run.project, "M01", dir, change); err != nil {
			t.Fatal(err)
		}
		if got := requestFile(t, dir, "request-02"); got.Value("model") != "test-keyframes" || got.Has("saved_looks") {
			t.Fatalf("«Изменить»: %v", got.Value("model"))
		}
	})
	t.Run("три опоры", func(t *testing.T) {
		run := ownRun(t)
		workflow, service, store := looksWorkflow(t, run, looksCaps)
		preferModel(t, run, "test-keyframes")
		dir := promptReady(t, run, 3)
		markedPrompt(t, dir, text)
		bindLook(t, run, service, store, "boat", "look-3", "Лодка", true)
		if _, err := workflow.PrepareRequest(context.Background(), run.project, "M01", dir, nil); err != nil {
			t.Fatal(err)
		}
		request := requestFile(t, dir, "request-01")
		if request.Value("model") != "test-keyframes" || request.Has("saved_looks") {
			t.Fatalf("модель и образы: %v", request.Value("model"))
		}
		if got := requestPrompt(t, dir, "request-01"); got != "Лодка плывёт к причалу.\n" {
			t.Fatalf("промпт запроса: %q", got)
		}
	})
}

// Модель проекта без образов: ожидаемая модель перед описанием — первая модель с образами, на
// которую перейдёт сборка по меткам; без моделей с образами — модель проекта с пределом 0.
func TestExpectedLookModelSkipsModelWithoutLooks(t *testing.T) {
	for _, item := range []struct {
		caps, model string
		limit       int
	}{{looksCaps, "test-cheap", 2}, {requestCaps, "test-keyframes", 0}} {
		run := ownRun(t)
		workflow, _, _ := looksWorkflow(t, run, item.caps)
		preferModel(t, run, "test-keyframes")
		got, err := workflow.ExpectedLookModel(context.Background(), run.project)
		if err != nil {
			t.Fatal(err)
		}
		if got.Model != item.model || got.Limit != item.limit {
			t.Fatalf("ожидаемая модель: %+v, нужно %s с пределом %d", got, item.model, item.limit)
		}
	}
}
