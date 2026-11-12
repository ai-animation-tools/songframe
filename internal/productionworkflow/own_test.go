package productionworkflow

import (
	"context"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"songframe/internal/dynvalue"
	"songframe/internal/golden"
	"songframe/internal/mediaadapters"
	"songframe/internal/mediaproviders"
	"songframe/internal/mediatest"
	"songframe/internal/tools"
)

// ownRun — проект-образец с провайдером test и проход без агента для проверки своего текста.
func ownRun(t *testing.T) *goldenRun {
	t.Helper()
	t.Cleanup(mediaproviders.Register("test", mediaproviders.Info{Title: "Тестовый сервис", Kinds: []string{mediaproviders.Image, mediaproviders.Video},
		Paid: true, DefaultImageResolution: "2k"}))
	t.Cleanup(mediaproviders.Register("test-agent", mediaproviders.Info{Title: "Тестовый агент изображений", Kinds: []string{mediaproviders.Image}, Executor: "codex"}))
	t.Cleanup(mediaadapters.Register(mediatest.ID, testRules{Service: &mediatest.Service{Dir: t.TempDir()}}))
	root, err := golden.Root()
	if err != nil {
		t.Fatal(err)
	}
	run := newRun(t, filepath.Join(root, "checks-base", "project"), map[string]string{})
	project := `{"schema_version":1,"name":"Пробный клип","animatic_video":"sample-animatic.mp4","fps":30,"generation":{` +
		`"video":{"provider":"test","resolution":"1080p","aspect_ratio":"16:9","watermark":false,"duration_rule":"min_supported_strictly_greater_than_window","provider_selected":true},` +
		`"image":{"provider":"test-agent","provider_selected":true}}}`
	if err := os.WriteFile(filepath.Join(run.project, "plan", "project.json"), []byte(project), 0o644); err != nil {
		t.Fatal(err)
	}
	return run
}

// ownFrames — свой план опор count штук на запрос seconds: K01 first, KNN last, middle между.
func ownFrames(count int, seconds float64) []OwnKeyframe {
	frames := []OwnKeyframe{}
	for index := 0; index < count; index++ {
		frame := OwnKeyframe{ID: "K" + twoDigits(index+1), Role: "middle", TimeSeconds: float64(index), Prompt: "Кадр " + twoDigits(index+1), ReferencePaths: []string{}}
		switch {
		case index == 0:
			frame.Role, frame.TimeSeconds = "first", 0
		case index == count-1:
			frame.Role, frame.TimeSeconds = "last", seconds
		}
		frames = append(frames, frame)
	}
	return frames
}

// TestSaveOwnDescription — своё описание без агента создаёт попытку с планом опор, которую после
// принятия ведут к первой опоре; неверные ID и время опор отклоняются до записи.
func TestSaveOwnDescription(t *testing.T) {
	run := ownRun(t)
	c, err := ReadContext(run.project, "M01", "")
	if err != nil {
		t.Fatal(err)
	}
	seconds := math.Floor(c.Window) + 1
	input := OwnInput{Project: run.project, Shot: "M01", Stage: "description", Description: "Герой идёт к воротам.", RequestSeconds: seconds}
	wrongID := input
	wrongID.Keyframes = ownFrames(3, seconds)
	wrongID.Keyframes[1].ID = "K05"
	if _, err := run.workflow.SaveOwn(context.Background(), wrongID); err == nil || err.Error() != textFramePlanInvalid {
		t.Fatalf("неверный ID опоры: %v", err)
	}
	late := input
	late.Keyframes = ownFrames(2, seconds)
	late.Keyframes[1].TimeSeconds = seconds - 1
	if _, err := run.workflow.SaveOwn(context.Background(), late); err == nil || err.Error() != textFrameBoundariesInvalid {
		t.Fatalf("последняя опора не на конце запроса: %v", err)
	}
	if _, err := os.Stat(filepath.Join(run.project, "plan", "batches", "M01-attempt-01")); !os.IsNotExist(err) {
		t.Fatalf("отклонённый текст создал попытку: %v", err)
	}
	input.Keyframes = ownFrames(3, seconds)
	view, err := run.workflow.SaveOwn(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	if view.PackageDir == nil || len(run.agents.starts) != 0 {
		t.Fatalf("попытка без агента: %v, запусков %d", view.PackageDir, len(run.agents.starts))
	}
	dir := *view.PackageDir
	description, _ := os.ReadFile(filepath.Join(dir, "description.md"))
	if strings.TrimSpace(string(description)) != input.Description {
		t.Fatalf("description.md: %q", description)
	}
	workflow, err := readJSON(filepath.Join(dir, "workflow.json"))
	if err != nil {
		t.Fatal(err)
	}
	frames, _ := dynvalue.AsArray(dynvalue.Get(workflow, "keyframes"))
	if dynvalue.Get(workflow, "stage") != "description_review" || len(frames) != 3 || dynvalue.Get(workflow, "keyframe_count") != float64(3) {
		t.Fatalf("workflow.json: %s", dynvalue.Stringify(workflow))
	}
	if result, err := tools.Run(run.project, "shot_workflow", []string{"decide", "--dir", dir, "--verdict", "approve"}); err != nil || result.Code == nil || *result.Code != 0 {
		t.Fatalf("принятие описания: %+v %v", result, err)
	}
	view, err = run.workflow.View(run.project, "M01", dir)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(view.NextFrame), `"K01"`) || !view.CanGenerateFrames {
		t.Fatalf("после своего описания следующий шаг — опора K01: %s %v", view.NextFrame, view.CanGenerateFrames)
	}
	single := input
	single.PackageDir, single.Keyframes = dir, ownFrames(1, seconds)
	view, err = run.workflow.SaveOwn(context.Background(), single)
	if err != nil {
		t.Fatalf("правка описания на одну опору: %v", err)
	}
	if *view.PackageDir != dir {
		t.Fatalf("правка неоплаченной попытки пишет в неё же: %s", *view.PackageDir)
	}
	prompts, _ := readJSON(filepath.Join(dir, "keyframe-prompts.json"))
	if items, _ := dynvalue.AsArray(prompts); len(items) != 1 {
		t.Fatalf("keyframe-prompts.json после правки: %s", dynvalue.Stringify(prompts))
	}
}

// limitedRules — провайдер test с пределом видеопромпта для проверки своего промпта.
type limitedRules struct{ testRules }

func (limitedRules) PromptWarningChars() int { return 40 }

// TestSaveOwnPrompt — свой видеопромпт после утверждённых опор записывается в попытку и
// утверждается тем же ответом; длиннее предела провайдера он отклоняется до записи.
func TestSaveOwnPrompt(t *testing.T) {
	run := ownRun(t)
	t.Cleanup(mediaadapters.Register(mediatest.ID, limitedRules{testRules{Service: &mediatest.Service{Dir: t.TempDir()}}}))
	c, err := ReadContext(run.project, "M01", "")
	if err != nil {
		t.Fatal(err)
	}
	seconds := math.Floor(c.Window) + 1
	description := OwnInput{Project: run.project, Shot: "M01", Stage: "description", Description: "Герой идёт к воротам.", RequestSeconds: seconds,
		Keyframes: ownFrames(1, seconds)}
	view, err := run.workflow.SaveOwn(context.Background(), description)
	if err != nil {
		t.Fatal(err)
	}
	dir := *view.PackageDir
	prompt := OwnInput{Project: run.project, Shot: "M01", PackageDir: dir, Stage: "prompt", Prompt: "Камера медленно приближается."}
	shot := func(args ...string) {
		t.Helper()
		if result, err := tools.Run(run.project, "shot_workflow", append(args, "--dir", dir)); err != nil || result.Code == nil || *result.Code != 0 {
			t.Fatalf("shot_workflow %v: %+v %v", args, result, err)
		}
	}
	shot("decide", "--verdict", "approve")
	if _, err := run.workflow.SaveOwn(context.Background(), prompt); err == nil {
		t.Fatal("свой промпт до утверждения опор принят")
	}
	image := filepath.Join(run.project, "source", "locations", "pier.png")
	shot("approve", "K01", image)
	long := prompt
	long.Prompt = strings.Repeat("Камера приближается. ", 3)
	if _, err := run.workflow.SaveOwn(context.Background(), long); err == nil || err.Error() != textOwnPromptOverLimit(63, 40) {
		t.Fatalf("промпт сверх предела: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "video-prompt.txt")); !os.IsNotExist(err) {
		t.Fatalf("отклонённый промпт записан: %v", err)
	}
	if view, err = run.workflow.SaveOwn(context.Background(), prompt); err != nil {
		t.Fatal(err)
	}
	if *view.PackageDir != dir || len(run.agents.starts) != 0 {
		t.Fatalf("свой промпт пишется в ту же попытку без агента: %s, запусков %d", *view.PackageDir, len(run.agents.starts))
	}
	// Открытый вопрос о промпте не мешает заменить его своим: применение спросит заново.
	prompt.Prompt = "Камера медленно отъезжает."
	if _, err = run.workflow.SaveOwn(context.Background(), prompt); err != nil {
		t.Fatalf("замена промпта на согласовании: %v", err)
	}
	text, _ := os.ReadFile(filepath.Join(dir, "video-prompt.txt"))
	if strings.TrimSpace(string(text)) != prompt.Prompt {
		t.Fatalf("video-prompt.txt: %q", text)
	}
	shot("decide", "--verdict", "approve")
	workflow, err := readJSON(filepath.Join(dir, "workflow.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !dynvalue.Truthy(dynvalue.Get(workflow, "approved_prompt_sha256")) {
		t.Fatalf("свой промпт не утверждён: %s", dynvalue.Stringify(workflow))
	}
}

// TestManualAttempt — попытка обычного плана со способом «Вручную вне приложения»: промпт без
// предела провайдера, пакет ручной генерации из всех утверждённых опор без звука; после
// утверждения промпта способ не меняется.
func TestManualAttempt(t *testing.T) {
	run := ownRun(t)
	t.Cleanup(mediaadapters.Register(mediatest.ID, limitedRules{testRules{Service: &mediatest.Service{Dir: t.TempDir()}}}))
	c, err := ReadContext(run.project, "M01", "")
	if err != nil {
		t.Fatal(err)
	}
	seconds := math.Floor(c.Window) + 1
	view, err := run.workflow.SaveOwn(context.Background(), OwnInput{Project: run.project, Shot: "M01", Stage: "description",
		Description: "Герой идёт к воротам.", RequestSeconds: seconds, Keyframes: ownFrames(2, seconds)})
	if err != nil {
		t.Fatal(err)
	}
	dir := *view.PackageDir
	shot := func(args ...string) {
		t.Helper()
		if result, err := tools.Run(run.project, "shot_workflow", append(args, "--dir", dir)); err != nil || result.Code == nil || *result.Code != 0 {
			t.Fatalf("shot_workflow %v: %+v %v", args, result, err)
		}
	}
	shot("decide", "--verdict", "approve")
	if _, err := run.workflow.SetGenerationMethod(run.project, "M01", dir, "вручную"); err == nil {
		t.Fatal("неизвестный способ принят")
	}
	view, err = run.workflow.SetGenerationMethod(run.project, "M01", dir, "manual")
	if err != nil {
		t.Fatal(err)
	}
	if !view.Manual || view.SingleFrame || view.GenerationMethod != "manual" || view.PromptMaxChars != 0 {
		t.Fatalf("ручная попытка: manual %v, singleFrame %v, method %q, предел %d", view.Manual, view.SingleFrame, view.GenerationMethod, view.PromptMaxChars)
	}
	image := filepath.Join(run.project, "source", "locations", "pier.png")
	shot("approve", "K01", image)
	shot("approve", "K02", image)
	// Предела провайдера у ручной попытки нет: длинный промпт сохраняется и утверждается.
	long := strings.Repeat("Камера приближается. ", 3)
	if _, err := run.workflow.SaveOwn(context.Background(), OwnInput{Project: run.project, Shot: "M01", PackageDir: dir, Stage: "prompt", Prompt: long}); err != nil {
		t.Fatal(err)
	}
	shot("decide", "--verdict", "approve")
	if _, err := run.workflow.SetGenerationMethod(run.project, "M01", dir, "provider"); err == nil || err.Error() != textMethodPromptApproved {
		t.Fatalf("смена способа после утверждения промпта: %v", err)
	}
	view, err = run.workflow.View(run.project, "M01", dir)
	if err != nil {
		t.Fatal(err)
	}
	if !view.CanBuildManual || view.NextStage != nil && *view.NextStage == "request" {
		t.Fatalf("пакет ручной генерации без звука: %v, следующий этап %v", view.CanBuildManual, view.NextStage)
	}
	if _, err := run.workflow.BuildManual(context.Background(), run.project, "M01", dir); err != nil {
		t.Fatal(err)
	}
	request, err := readJSON(filepath.Join(dir, "request-01", "request.json"))
	if err != nil {
		t.Fatal(err)
	}
	inputs, _ := dynvalue.AsArray(dynvalue.Get(request, "inputs"))
	if dynvalue.Get(request, "mode") != "manual" || len(inputs) != 2 || dynvalue.Get(inputs[1], "role") != "Опора K02" {
		t.Fatalf("пакет ручной генерации: %s", dynvalue.Stringify(request))
	}
	if len(run.agents.starts) != 0 {
		t.Fatalf("ручная попытка запускала агента: %d", len(run.agents.starts))
	}
}

// TestProjectManualVideo — способ видео проекта «Вручную вне приложения»: сервиса и адаптера нет,
// план без агента проходит от описания до пакета ручной генерации; способ попытки не выбирается.
func TestProjectManualVideo(t *testing.T) {
	run := ownRun(t)
	project := `{"schema_version":1,"name":"Пробный клип","animatic_video":"sample-animatic.mp4","fps":30,"generation":{` +
		`"video":{"provider":"manual","resolution":"1080p","aspect_ratio":"16:9","watermark":false,"duration_rule":"min_supported_strictly_greater_than_window","provider_selected":true},` +
		`"image":{"provider":"test-agent","provider_selected":true}}}`
	if err := os.WriteFile(filepath.Join(run.project, "plan", "project.json"), []byte(project), 0o644); err != nil {
		t.Fatal(err)
	}
	c, err := ReadContext(run.project, "M01", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(c.Problems) != 0 || !c.Manual || c.SingleFrame {
		t.Fatalf("проект без сервиса видео: problems %v, manual %v, singleFrame %v", c.Problems, c.Manual, c.SingleFrame)
	}
	seconds := math.Floor(c.Window) + 1
	view, err := run.workflow.SaveOwn(context.Background(), OwnInput{Project: run.project, Shot: "M01", Stage: "description",
		Description: "Герой идёт к воротам.", RequestSeconds: seconds, Keyframes: ownFrames(3, seconds)})
	if err != nil {
		t.Fatal(err)
	}
	dir := *view.PackageDir
	shot := func(args ...string) {
		t.Helper()
		if result, err := tools.Run(run.project, "shot_workflow", append(args, "--dir", dir)); err != nil || result.Code == nil || *result.Code != 0 {
			t.Fatalf("shot_workflow %v: %+v %v", args, result, err)
		}
	}
	shot("decide", "--verdict", "approve")
	if _, err := run.workflow.SetGenerationMethod(run.project, "M01", dir, "provider"); err == nil || err.Error() != textMethodProjectManual {
		t.Fatalf("способ попытки в проекте без сервиса: %v", err)
	}
	image := filepath.Join(run.project, "source", "locations", "pier.png")
	for _, id := range []string{"K01", "K02", "K03"} {
		shot("approve", id, image)
	}
	if _, err := run.workflow.SaveOwn(context.Background(), OwnInput{Project: run.project, Shot: "M01", PackageDir: dir, Stage: "prompt",
		Prompt: "Камера приближается к воротам."}); err != nil {
		t.Fatal(err)
	}
	shot("decide", "--verdict", "approve")
	if _, err := run.workflow.BuildManual(context.Background(), run.project, "M01", dir); err != nil {
		t.Fatal(err)
	}
	request, err := readJSON(filepath.Join(dir, "request-01", "request.json"))
	if err != nil {
		t.Fatal(err)
	}
	inputs, _ := dynvalue.AsArray(dynvalue.Get(request, "inputs"))
	if dynvalue.Get(request, "provider") != "manual" || dynvalue.Get(request, "mode") != "manual" || len(inputs) != 3 {
		t.Fatalf("пакет ручной генерации проекта без сервиса: %s", dynvalue.Stringify(request))
	}
}

// TestOwnDescriptionFrameWithoutPrompt — в своём описании промпт опоры может быть пустым: такую
// опору нельзя создать, только загрузить своим файлом. Ответ агента с пустым промптом по-прежнему
// отклоняется.
func TestOwnDescriptionFrameWithoutPrompt(t *testing.T) {
	run := ownRun(t)
	c, err := ReadContext(run.project, "M01", "")
	if err != nil {
		t.Fatal(err)
	}
	seconds := math.Floor(c.Window) + 1
	frames := ownFrames(2, seconds)
	frames[0].Prompt = ""
	agent := `{"schemaVersion":1,"stage":"description","description":"Герой.","requestSeconds":` + dynvalue.NumberToString(seconds) +
		`,"keyframes":[{"id":"K01","role":"first","timeSeconds":0,"prompt":"","referencePaths":[]},{"id":"K02","role":"last","timeSeconds":` +
		dynvalue.NumberToString(seconds) + `,"prompt":"Кадр","referencePaths":[]}]}`
	if _, err := ParseProposal(agent, c.RulesFor("description")); err == nil || err.Error() != textFramePlanInvalid {
		t.Fatalf("ответ агента с пустым промптом опоры: %v", err)
	}
	view, err := run.workflow.SaveOwn(context.Background(), OwnInput{Project: run.project, Shot: "M01", Stage: "description",
		Description: "Герой идёт к воротам.", RequestSeconds: seconds, Keyframes: frames})
	if err != nil {
		t.Fatalf("своё описание с опорой без промпта: %v", err)
	}
	dir := *view.PackageDir
	if result, err := tools.Run(run.project, "shot_workflow", []string{"decide", "--dir", dir, "--verdict", "approve"}); err != nil || result.Code == nil || *result.Code != 0 {
		t.Fatalf("принятие описания: %+v %v", result, err)
	}
	if _, err := run.workflow.GenerateFrames(context.Background(), run.project, "M01", dir); err == nil || err.Error() != textFramePromptMissing("K01") {
		t.Fatalf("создание опоры без промпта: %v", err)
	}
	image := filepath.Join(t.TempDir(), "k01.png")
	source, err := os.ReadFile(filepath.Join(run.project, "source", "heroes", "mira.png"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(image, source, 0o644); err != nil {
		t.Fatal(err)
	}
	view, err = run.workflow.ImportFrames(run.project, "M01", dir, []FrameCandidate{{ID: "K01", Path: image}})
	if err != nil {
		t.Fatalf("своя опора без промпта: %v", err)
	}
	stored := run.workflow.store.Read(run.project, "M01")
	if _, err := run.workflow.Apply(context.Background(), run.project, "M01", dir, dynvalue.ToString(stored.Proposal().Value("id"))); err != nil {
		t.Fatalf("применение своей опоры без промпта: %v", err)
	}
}

// TestCreateOwnVideo — попытка своего видео без агента: новая папка с отметкой own_video на этапе
// request_choice и пакетом без промпта и входов с провайдером способа «вручную»; следующая
// попытка получает следующий номер.
func TestCreateOwnVideo(t *testing.T) {
	run := ownRun(t)
	dir, err := run.workflow.CreateOwnVideo(context.Background(), run.project, "M01")
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Base(dir) != "M01-attempt-01" || len(run.agents.starts) != 0 {
		t.Fatalf("попытка своего видео: %s, запусков агента %d", dir, len(run.agents.starts))
	}
	workflow, err := readJSON(filepath.Join(dir, "workflow.json"))
	if err != nil {
		t.Fatal(err)
	}
	if dynvalue.Get(workflow, "own_video") != true || dynvalue.Get(workflow, "stage") != "request_choice" || dynvalue.Get(workflow, "request_dir") != "request-01" ||
		!dynvalue.Truthy(dynvalue.Get(workflow, "scene_sha256")) {
		t.Fatalf("workflow.json своего видео: %s", dynvalue.Stringify(workflow))
	}
	request, err := readJSON(filepath.Join(dir, "request-01", "request.json"))
	if err != nil {
		t.Fatal(err)
	}
	inputs, _ := dynvalue.AsArray(dynvalue.Get(request, "inputs"))
	if dynvalue.Get(request, "own_video") != true || dynvalue.Get(request, "mode") != "manual" || len(inputs) != 0 ||
		dynvalue.Get(request, "provider") != mediaproviders.ManualID() {
		t.Fatalf("request.json своего видео: %s", dynvalue.Stringify(request))
	}
	prompt, _ := os.ReadFile(filepath.Join(dir, "request-01", "prompt.txt"))
	if len(prompt) != 0 {
		t.Fatalf("промпт своего видео: %q", prompt)
	}
	again, err := run.workflow.CreateOwnVideo(context.Background(), run.project, "M01")
	if err != nil || filepath.Base(again) != "M01-attempt-02" {
		t.Fatalf("вторая попытка своего видео: %s %v", again, err)
	}
}

// TestOwnVideoNoAgent — в попытку своего видео нельзя ни запустить агента, ни записать своё описание.
func TestOwnVideoNoAgent(t *testing.T) {
	run := ownRun(t)
	dir, err := run.workflow.CreateOwnVideo(context.Background(), run.project, "M01")
	if err != nil {
		t.Fatal(err)
	}
	stage, note := "description", "Короче"
	if _, err := run.workflow.Start(context.Background(), StartInput{Project: run.project, Shot: "M01", PackageDir: dir, Action: "revise", Stage: &stage, Note: &note}); err == nil || err.Error() != textOwnVideoNoAgent {
		t.Fatalf("агент в попытке своего видео: %v", err)
	}
	if _, err := run.workflow.SaveOwn(context.Background(), OwnInput{Project: run.project, Shot: "M01", PackageDir: dir, Stage: "description",
		Description: "Герой.", RequestSeconds: 6, Keyframes: ownFrames(2, 6)}); err == nil || err.Error() != textOwnVideoNoAgent {
		t.Fatalf("своё описание в попытке своего видео: %v", err)
	}
}
