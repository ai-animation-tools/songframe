package productionworkflow

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"songframe/internal/dynvalue"
	"songframe/internal/mediaadapters"
	"songframe/internal/mediaapi"
	"songframe/internal/mediatest"
	"songframe/internal/providers"
	"songframe/internal/tools"
)

// requestRules — правила тестового провайдера для сборки видео: модели и слоты называются по-своему,
// чтобы общая логика не зависела от настоящего адаптера. test-cheap пробуется первой, но не
// объявляет промежуточных кадров; test-keyframes объявляет.
type requestRules struct{ *mediatest.Service }

func (requestRules) RequestRules() mediaapi.RequestRules {
	return mediaapi.RequestRules{
		OutputCount: []string{"count"},
		Enforced:    []mediaapi.Enforced{{Name: "watermark", Value: false, Rejected: []any{true}, Message: "без логотипа"}},
		Video: &mediaapi.VideoRules{
			Command: "image_to_video",
			FrameSlots: func(count int) []string {
				slots := []string{"first_image"}
				for index := 1; index < count-1; index++ {
					slots = append(slots, fmt.Sprintf("keyframe_%d", index))
				}
				if count > 1 {
					slots = append(slots, "tail_image")
				}
				return slots
			},
			SpeechSlot: "audio_1",
			Models:     []string{"test-cheap", "test-keyframes"},
			Defaults: []mediaapi.ParameterDefault{
				{Name: "single_take", Values: []any{false, true}},
				{Name: "sound", Values: []any{false}},
			},
		},
	}
}

// requestCaps — объявления видео: test-keyframes в каталоге первой, обе модели — по 9 и 10 с.
// test-keyframes допускает только single_take=true и объявляет режим mode. test-short даёт только
// 5 и 10 с и плану 9 с не подходит.
const requestCaps = `{"reports":[{"command":"image_to_video","models":{` +
	`"test-keyframes":{"arguments":{"duration":{"allowed":["9","10"]},"resolution":{"allowed":["720p","1080p"]},"single_take":{"allowed":["true"]},"mode":{"allowed":["std","pro"]},"watermark":{"allowed":["false"]},"count":{"allowed":["1"]}},` +
	`"slots":{"first_image":{"required":true},"keyframe_1":{},"keyframe_2":{},"tail_image":{}},"limits":{}},` +
	`"test-cheap":{"arguments":{"duration":{"allowed":["9","10"]},"resolution":{"allowed":["1080p"]},"aspect_ratio":{"allowed":["16:9"]},"single_take":{"allowed":["true","false"]},"sound":{"allowed":["true","false"]}},` +
	`"slots":{"first_image":{"required":true},"tail_image":{}},"limits":{}},` +
	`"test-short":{"arguments":{"duration":{"allowed":["5","10"]},"resolution":{"allowed":["1080p"]}},"slots":{"first_image":{"required":true},"tail_image":{}},"limits":{}}}}],"problems":[]}`

// requestWorkflow — проход с платным адаптером видео тестового провайдера и подставными
// объявлениями requestCaps; остальные инструменты настоящие.
func requestWorkflow(t *testing.T, run *goldenRun) *Workflow {
	t.Helper()
	t.Cleanup(mediaadapters.Register(mediatest.ID, requestRules{Service: &mediatest.Service{Dir: t.TempDir()}}))
	runTool := func(ctx context.Context, project, name string, args []string) (tools.Result, error) {
		if name == "media_request" && len(args) > 0 && args[0] == "capabilities" {
			code := 0
			return tools.Result{Code: &code, Stdout: requestCaps}, nil
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
	return New(Options{
		LocalDir: run.local, Agents: run.agents, Run: runTool, Catalog: &providers.Catalogs{Run: runTool},
		IsScenarioApproved: func(string) bool { return true },
		VideoMedia:         func(provider string) (*providers.PaidMedia, bool) { return video, provider == mediatest.ID },
		ExtractFrame:       fakeExtractFrame,
	})
}

// promptReady — попытка M01-attempt-01 с принятым описанием, frames утверждёнными опорами (разные
// байты) и утверждённым видеопромптом: следующий шаг — запрос.
func promptReady(t *testing.T, run *goldenRun, frames int) string {
	t.Helper()
	dir := filepath.Join(run.project, "plan", "batches", "M01-attempt-01")
	runTool(t, run.project, "shot_workflow", "init", "M01", "--dir", dir, "--mode", "shot")
	args := []string{"plan-keyframes", "--dir", dir, "--request-seconds", "9"}
	for index := 1; index < frames-1; index++ {
		args = append(args, "--middle", fmt.Sprintf("%d:промежуточная", index*3))
	}
	runTool(t, run.project, "shot_workflow", args...)
	write := func(rel string, data []byte) string {
		path := filepath.Join(dir, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(path), 0o777); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, data, 0o664); err != nil {
			t.Fatal(err)
		}
		return path
	}
	write("description.md", []byte("Лодка плывёт.\n"))
	for index := 1; index <= frames; index++ {
		id := "K" + twoDigits(index)
		image := append(append([]byte{}, mediatest.BuiltinPNG...), byte(index))
		runTool(t, run.project, "shot_workflow", "approve", "--dir", dir, id, write("frames/"+id+".png", image))
	}
	prompt := []byte("Лодка плывёт к пристани.\n")
	write("video-prompt.txt", prompt)
	workflow, err := packageDocument(dir, textWorkflowNotCreated)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(prompt)
	record := promptRecord()
	record.Set("approved", true)
	workflow.Set("description_approved", true)
	workflow.Set("prompt", record)
	workflow.Set("approved_prompt_sha256", hex.EncodeToString(digest[:]))
	workflow.Set("stage", "prompt_review")
	if err := writeProjectJSON(filepath.Join(dir, "workflow.json"), workflow); err != nil {
		t.Fatal(err)
	}
	return dir
}

// requestFile — request.json запроса name попытки dir.
func requestFile(t *testing.T, dir, name string) *dynvalue.Object {
	t.Helper()
	value, err := readJSON(filepath.Join(dir, name, "request.json"))
	if err != nil {
		t.Fatal(err)
	}
	object, ok := value.(*dynvalue.Object)
	if !ok {
		t.Fatalf("%s/request.json: не объект", name)
	}
	return object
}

// inputSlots — слоты и роли входов запроса по порядку: «слот:роль».
func inputSlots(request *dynvalue.Object) []string {
	items, _ := dynvalue.AsArray(request.Value("inputs"))
	slots := []string{}
	for _, item := range items {
		slots = append(slots, dynvalue.ToString(dynvalue.Get(item, "slot"))+":"+dynvalue.ToString(dynvalue.Get(item, "role")))
	}
	return slots
}

// Две опоры: первой пробуется модель адаптера test-cheap; длительность — запрос описания,
// разрешение и пропорции — настройки проекта, единый план и выключенный звук — значения адаптера
// (request.json хранит параметры с ключами по алфавиту).
// Попытка переходит к вопросу «Отправить», агент не запускается.
func TestPrepareRequestTwoFrames(t *testing.T) {
	run := ownRun(t)
	workflow := requestWorkflow(t, run)
	dir := promptReady(t, run, 2)
	view, err := workflow.PrepareRequest(context.Background(), run.project, "M01", dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	if view.Stage == nil || *view.Stage != "request_choice" {
		t.Fatalf("этап: %v", view.Stage)
	}
	request := requestFile(t, dir, "request-01")
	if request.Value("model") != "test-cheap" || request.Value("command") != "image_to_video" {
		t.Fatalf("модель и команда: %v %v", request.Value("model"), request.Value("command"))
	}
	if got := dynvalue.Stringify(request.Value("parameters")); got != `{"aspect_ratio":"16:9","duration":9,"resolution":"1080p","single_take":false,"sound":false}` {
		t.Fatalf("параметры: %s", got)
	}
	if got := inputSlots(request); !slices.Equal(got, []string{"first_image:Первый кадр", "tail_image:Последний кадр"}) {
		t.Fatalf("входы: %v", got)
	}
	c, err := ReadContext(run.project, "M01", dir)
	if err != nil {
		t.Fatal(err)
	}
	if c.workflowValue("request_dir") != "request-01" || dynvalue.Get(c.workflowValue("pending_decision"), "stage") != "request_choice" {
		t.Fatalf("workflow: %s", dynvalue.Stringify(c.Workflow))
	}
	if len(run.agents.starts) != 0 {
		t.Fatal("запуск агента")
	}
}

// Три опоры: test-cheap не объявляет промежуточного кадра, поэтому выбирается test-keyframes с её
// собственными параметрами (единый план там допускает только true, звука и пропорций нет);
// обязательное значение провайдера (watermark) дописывает адаптер.
func TestPrepareRequestKeyframes(t *testing.T) {
	run := ownRun(t)
	workflow := requestWorkflow(t, run)
	dir := promptReady(t, run, 3)
	if _, err := workflow.PrepareRequest(context.Background(), run.project, "M01", dir, nil); err != nil {
		t.Fatal(err)
	}
	request := requestFile(t, dir, "request-01")
	if request.Value("model") != "test-keyframes" {
		t.Fatalf("модель: %v", request.Value("model"))
	}
	if got := dynvalue.Stringify(request.Value("parameters")); got != `{"count":1,"duration":9,"resolution":"1080p","single_take":true,"watermark":false}` {
		t.Fatalf("параметры: %s", got)
	}
	if got := inputSlots(request); !slices.Equal(got, []string{"first_image:Первый кадр", "keyframe_1:Промежуточный кадр", "tail_image:Последний кадр"}) {
		t.Fatalf("входы: %v", got)
	}
}

// «Изменить» на вопросе «Отправить»: выбранная модель и её параметр дают новый запрос, прежний
// остаётся историей попытки, вопрос «Отправить» задаётся о новом. Варианты изменения —
// модели команды с параметрами, которые не задают описание, проект и провайдер.
func TestPrepareRequestChange(t *testing.T) {
	run := ownRun(t)
	workflow := requestWorkflow(t, run)
	dir := promptReady(t, run, 2)
	ctx := context.Background()
	if _, err := workflow.PrepareRequest(ctx, run.project, "M01", dir, nil); err != nil {
		t.Fatal(err)
	}
	options, err := workflow.RequestOptions(ctx, run.project, "M01", dir)
	if err != nil {
		t.Fatal(err)
	}
	summary := []string{}
	for _, model := range options.Models {
		names := []string{}
		for _, parameter := range model.Parameters {
			values, _ := json.Marshal(parameter.Values)
			names = append(names, parameter.Name+"="+string(values))
		}
		summary = append(summary, model.ID+"("+strings.Join(names, " ")+")")
	}
	if got := strings.Join(summary, " "); got != `test-keyframes(single_take=[true] mode=["std","pro"]) test-cheap(single_take=[true,false] sound=[true,false]) test-short()` {
		t.Fatalf("варианты: %s", got)
	}
	// Две опоры принимают обе модели адаптера; test-short не даёт 9 с.
	unavailable := []string{}
	for _, model := range options.Models {
		unavailable = append(unavailable, model.ID+":"+model.Unavailable)
	}
	if got := strings.Join(unavailable, " | "); got != "test-keyframes: | test-cheap: | test-short:Модель не даёт видео длиной 9 с: доступно 5, 10 с." {
		t.Fatalf("пригодность: %s", got)
	}
	if current, _ := json.Marshal(options.Parameters); options.Model != "test-cheap" || string(current) != `{"single_take":false,"sound":false}` {
		t.Fatalf("текущий запрос: %s %v", options.Model, options.Parameters)
	}
	change := &RequestChange{Model: "test-keyframes", Parameters: map[string]any{"mode": "pro"}}
	view, err := workflow.PrepareRequest(ctx, run.project, "M01", dir, change)
	if err != nil {
		t.Fatal(err)
	}
	if view.Stage == nil || *view.Stage != "request_choice" {
		t.Fatalf("этап: %v", view.Stage)
	}
	request := requestFile(t, dir, "request-02")
	if request.Value("model") != "test-keyframes" || dynvalue.Get(request.Value("parameters"), "mode") != "pro" {
		t.Fatalf("новый запрос: %s", dynvalue.Stringify(request))
	}
	if requestFile(t, dir, "request-01").Value("model") != "test-cheap" {
		t.Fatal("прежний запрос изменился")
	}
	c, err := ReadContext(run.project, "M01", dir)
	if err != nil {
		t.Fatal(err)
	}
	if c.workflowValue("request_dir") != "request-02" || dynvalue.Get(c.workflowValue("pending_decision"), "stage") != "request_choice" {
		t.Fatalf("workflow: %s", dynvalue.Stringify(c.Workflow))
	}
	// Значение, которого модель не объявляет, — отказ выбранной модели без подмены другой.
	_, err = workflow.PrepareRequest(ctx, run.project, "M01", dir, &RequestChange{Model: "test-cheap", Parameters: map[string]any{"mode": "pro"}})
	if err == nil || !strings.Contains(err.Error(), "test-cheap") {
		t.Fatalf("необъявленный параметр: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "request-03")); !os.IsNotExist(err) {
		t.Fatal("отказ оставил папку запроса")
	}
}

// Модель, которая не примет план, остаётся в вариантах выключенной с причиной той же сборки
// черновика: test-cheap не объявляет промежуточного кадра для трёх опор.
func TestRequestOptionsUnavailable(t *testing.T) {
	run := ownRun(t)
	workflow := requestWorkflow(t, run)
	dir := promptReady(t, run, 3)
	ctx := context.Background()
	if _, err := workflow.PrepareRequest(ctx, run.project, "M01", dir, nil); err != nil {
		t.Fatal(err)
	}
	options, err := workflow.RequestOptions(ctx, run.project, "M01", dir)
	if err != nil {
		t.Fatal(err)
	}
	reasons := map[string]string{}
	for _, model := range options.Models {
		reasons[model.ID] = model.Unavailable
	}
	if reasons["test-keyframes"] != "" || reasons["test-cheap"] == "" {
		t.Fatalf("пригодность: %v", reasons)
	}
	if reasons["test-cheap"] != "Модель не примет опоры плана (3): у неё нет входа «Промежуточный кадр»." {
		t.Fatalf("причина: %s", reasons["test-cheap"])
	}
	// Сборка выключенной моделью отказывает той же проверкой, без подмены модели.
	_, err = workflow.PrepareRequest(ctx, run.project, "M01", dir, &RequestChange{Model: "test-cheap"})
	if err == nil || !strings.Contains(err.Error(), "test-cheap: Вход keyframe_1 не объявлен") {
		t.Fatalf("сборка выключенной моделью: %v", err)
	}
}

// Запрос не готовится, пока промпт не утверждён, без открытого вопроса не изменяется, а агент
// этап запроса больше не выполняет.
func TestPrepareRequestRefusals(t *testing.T) {
	run := ownRun(t)
	workflow := requestWorkflow(t, run)
	dir := promptReady(t, run, 2)
	ctx := context.Background()
	if _, err := workflow.PrepareRequest(ctx, run.project, "M01", dir, &RequestChange{Model: "test-cheap"}); err == nil || err.Error() != textRequestChangeUnavailable {
		t.Fatalf("изменение без вопроса: %v", err)
	}
	if _, err := workflow.Start(ctx, StartInput{Project: run.project, Shot: "M01", PackageDir: dir, Action: "continue"}); err == nil || err.Error() != textRequestByApp {
		t.Fatalf("агент на этапе запроса: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "video-prompt.txt"), []byte("Другой промпт.\n"), 0o664); err != nil {
		t.Fatal(err)
	}
	if _, err := workflow.PrepareRequest(ctx, run.project, "M01", dir, nil); err == nil || err.Error() != textStageUnavailable {
		t.Fatalf("изменённый промпт: %v", err)
	}
}
