package production_test

import (
	"context"
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"songframe-go/internal/acceptshot"
	"songframe-go/internal/jobs"
	"songframe-go/internal/mediacmd"
	"songframe-go/internal/mediaproviders"
	"songframe-go/internal/mediatest"
	"songframe-go/internal/production"
	"songframe-go/internal/pycompat"
	"songframe-go/internal/tools"
)

// Тесты общей логики производства на тестовом провайдере test (internal/mediatest): платные
// сервисы и сеть не вызываются, отправки считаются по журналу calls.jsonl тестового сервиса.
// Проект — копия образца checks-base; пакет M03 готовится настоящими инструментами shot_workflow
// и media_request.

const pricing = `{"schema_version": 1, "currency": "credits", "models": {"test-video": {"base_credits": 2, "per_second": {"1080p": 7, "720p": null}}, "test-video-fast": {"base_credits": 0, "per_second": {"1080p": null}}}, "observed": []}`

// env — проект, тестовый сервис, менеджер заданий и сервис производства одного теста.
type env struct {
	t       *testing.T
	project string
	pkg     string
	service *mediatest.Service
	jobs    *jobs.Manager
	prod    *production.Service
	tokens  int
}

func copyTree(t *testing.T, source, target string) {
	t.Helper()
	err := filepath.WalkDir(source, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		relative, _ := filepath.Rel(source, path)
		destination := filepath.Join(target, relative)
		if entry.IsDir() {
			return os.MkdirAll(destination, 0o755)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(destination, data, 0o644)
	})
	if err != nil {
		t.Fatal(err)
	}
}

func (e *env) tool(name string, args ...string) tools.Result {
	e.t.Helper()
	result, err := tools.Run(e.project, name, args)
	if err != nil || result.Code == nil || *result.Code != 0 {
		e.t.Fatalf("%s %v: %s %s %v", name, args, result.Stdout, result.Stderr, err)
	}
	return result
}

// newEnv — проект с пакетом M03 на вопросе отправки подготовленного запроса (request_choice).
func newEnv(t *testing.T, model string) *env {
	t.Helper()
	root := t.TempDir()
	project := filepath.Join(root, "Проект клипа")
	copyTree(t, filepath.Join("..", "..", "testdata", "golden", "checks-base", "project"), project)
	// Провайдер видео проекта выбран явно: без provider_selected повтор и отправка не разрешены.
	settings := filepath.Join(project, "plan", "project.json")
	data, err := os.ReadFile(settings)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(settings, []byte(strings.Replace(string(data), `"provider": "test",`, `"provider": "test", "provider_selected": true,`, 1)), 0o644); err != nil {
		t.Fatal(err)
	}
	// Образец содержит пакет M03 на согласовании опор; тест готовит свой пакет с запросом.
	if err := os.RemoveAll(filepath.Join(project, "plan", "batches", "M03-attempt-01")); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(mediaproviders.Register("test", mediaproviders.Info{Title: "Тестовый сервис", Kinds: []string{"image", "video"}, Paid: true}))
	serviceDir := filepath.Join(root, "service")
	service, err := mediatest.New(serviceDir, pycompat.NewDict())
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(serviceDir, "video.mp4"), []byte("\x00\x00\x00\x18ftypmp42original video bytes"), 0o644); err != nil {
		t.Fatal(err)
	}
	configure(t, service, `{"balance": 1000, "results": {"video": "video.mp4"}}`)
	t.Cleanup(service.Register())
	state := filepath.Join(root, "state")
	saved := tools.LocalDir
	tools.LocalDir = func() (string, error) { return state, nil }
	t.Cleanup(func() { tools.LocalDir = saved })
	if err := os.WriteFile(filepath.Join(root, "pricing.json"), []byte(pricing), 0o644); err != nil {
		t.Fatal(err)
	}
	manager := jobs.New(filepath.Join(root, "jobs-state"), jobs.Options{SkipRestore: true})
	e := &env{t: t, project: project, service: service, jobs: manager}
	e.prod = production.New(production.Options{Jobs: manager, PricingFile: filepath.Join(root, "pricing.json"), NewToken: func() string {
		e.tokens++
		return "token-" + string(rune('a'+e.tokens-1))
	}})
	e.pkg = filepath.Join(project, "plan", "batches", "M03-attempt-01")
	spec := filepath.Join(root, "spec")
	if err := os.MkdirAll(spec, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(spec, "prompt.txt"), []byte("Один дубль."), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(spec, "frame.png"), mediatest.BuiltinPNG, 0o644); err != nil {
		t.Fatal(err)
	}
	request := `{"schema_version": 1, "shot": "M03", "kind": "video", "provider": "test", "command": "image_to_video", "model": "` + model +
		`", "parameters": {"duration": 5, "resolution": "1080p"}, "inputs": [{"flag": "input", "slot": "first_image", "path": "frame.png", "role": "first"}], "prompt_file": "prompt.txt", "outputs": 1}`
	if err := os.WriteFile(filepath.Join(spec, "spec.json"), []byte(request), 0o644); err != nil {
		t.Fatal(err)
	}
	e.tool("shot_workflow", "init", "M03", "--dir", e.pkg)
	e.tool("media_request", "prepare", "--request", filepath.Join(spec, "spec.json"), "--work-dir", filepath.Join(e.pkg, "request"))
	for _, stage := range []string{"keyframes_review", "prompt_review"} {
		e.tool("shot_workflow", "set-stage", "--dir", e.pkg, stage)
	}
	e.tool("shot_workflow", "set-stage", "--dir", e.pkg, "request_choice", "--request-dir", "request")
	e.tool("shot_workflow", "ask", "--dir", e.pkg, "--stage", "request_choice")
	return e
}

func configure(t *testing.T, service *mediatest.Service, text string) {
	t.Helper()
	value, err := pycompat.LoadsJSON(text)
	if err != nil {
		t.Fatal(err)
	}
	if err := service.Configure(value.(*pycompat.Dict)); err != nil {
		t.Fatal(err)
	}
}

// view — пакет M03 после обновления.
func (e *env) view() *production.PackageView {
	e.t.Helper()
	view, err := production.ReadPackage(e.project, e.pkg)
	if err != nil || view == nil {
		e.t.Fatalf("пакет: %v", err)
	}
	return view
}

func (e *env) sha() string { return *e.view().Request.SHA256 }

func (e *env) quote() production.Quote {
	e.t.Helper()
	view := e.view()
	quote, err := e.prod.Quote(e.project, e.pkg, *view.Request.SHA256, view.DecisionToken)
	if err != nil {
		e.t.Fatalf("оценка: %v", err)
	}
	return quote
}

func (e *env) submit(quote production.Quote, consent string) (jobs.Info, error) {
	view := e.view()
	return e.prod.Submit(e.project, e.pkg, *view.Request.SHA256, view.DecisionToken, quote.Token, consent)
}

func (e *env) wait(info jobs.Info) jobs.Info {
	e.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	finished, err := e.jobs.Wait(ctx, info.ID)
	if err != nil {
		e.t.Fatal(err)
	}
	return finished
}

func (e *env) paid() int { return len(e.service.Calls("submit")) }

func attempt(t *testing.T, pkg string) map[string]any {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(pkg, "request", "attempt.json"))
	if err != nil {
		t.Fatal(err)
	}
	var value map[string]any
	if err := json.Unmarshal(data, &value); err != nil {
		t.Fatal(err)
	}
	return value
}

// TestSubmitRequiresQuote — без оценки, с чужим SHA или прямым ответом send отправки нет.
func TestSubmitRequiresQuote(t *testing.T) {
	e := newEnv(t, "test-video")
	view := e.view()
	if _, err := e.prod.Submit(e.project, e.pkg, *view.Request.SHA256, view.DecisionToken, "", ""); err == nil || !strings.Contains(err.Error(), "стоимость") {
		t.Fatalf("отправка без оценки: %v", err)
	}
	if err := e.prod.Decide(e.project, e.pkg, "send", "", view.DecisionToken, ""); err == nil {
		t.Fatal("send через decide должен отклоняться")
	}
	if _, err := e.prod.Quote(e.project, e.pkg, strings.Repeat("0", 64), view.DecisionToken); err == nil {
		t.Fatal("оценка чужого SHA должна отклоняться")
	}
	quote := e.quote()
	if quote.Verdict != production.VerdictOK || quote.Credits == nil || *quote.Credits != 37 || quote.RequestSha != *view.Request.SHA256 {
		t.Fatalf("оценка %+v", quote)
	}
	if _, err := e.prod.Submit(e.project, e.pkg, strings.Repeat("0", 64), view.DecisionToken, quote.Token, ""); err == nil {
		t.Fatal("отправка по другому SHA")
	}
	// Неудачная попытка сожгла оценку: прежний token больше не действует.
	if _, err := e.submit(quote, ""); err == nil {
		t.Fatal("оценка должна сгорать после попытки отправки")
	}
	if e.paid() != 0 {
		t.Fatalf("отправок %d", e.paid())
	}
}

// TestSubmitOnceAndRetrieve — согласованная оценка даёт одну отправку; двойной клик и повтор
// с тем же token новой оплаты не создают; результат скачивается, пакет ждёт просмотра.
func TestSubmitOnceAndRetrieve(t *testing.T) {
	e := newEnv(t, "test-video")
	quote := e.quote()
	var wait sync.WaitGroup
	results := make([]error, 2)
	infos := make([]jobs.Info, 2)
	for index := range results {
		wait.Add(1)
		go func() {
			defer wait.Done()
			infos[index], results[index] = e.submit(quote, "")
		}()
	}
	wait.Wait()
	started := 0
	var info jobs.Info
	for index, err := range results {
		if err == nil {
			started++
			info = infos[index]
		}
	}
	if started != 1 {
		t.Fatalf("запущено заданий %d: %v", started, results)
	}
	finished := e.wait(info)
	if finished.Status != jobs.StatusDone {
		t.Fatalf("задание %+v", finished)
	}
	if e.paid() != 1 {
		t.Fatalf("отправок %d", e.paid())
	}
	if _, err := e.submit(quote, ""); err == nil {
		t.Fatal("повтор с тем же token")
	}
	view := e.view()
	if view.Stage != "downloaded" || view.Pending() == nil || view.Pending().Stage != "downloaded" || view.Request == nil || view.Request.AttemptStatus == nil || *view.Request.AttemptStatus != "downloaded" {
		t.Fatalf("после получения: этап %s", view.Stage)
	}
	// Повторное получение по сохранённому ID не отправляет запрос заново.
	resumed, err := e.prod.Resume(e.project, e.pkg)
	if err != nil {
		t.Fatal(err)
	}
	e.wait(resumed)
	if e.paid() != 1 {
		t.Fatalf("resume отправил запрос: %d", e.paid())
	}
}

// TestQuoteChangesBurnConsent — смена материалов после оценки делает её недействительной.
func TestQuoteChangesBurnConsent(t *testing.T) {
	e := newEnv(t, "test-video")
	quote := e.quote()
	// Изменение постановки плана меняет decisionToken пакета.
	scenes := filepath.Join(e.project, "plan", "scenes.json")
	data, _ := os.ReadFile(scenes)
	if err := os.WriteFile(scenes, []byte(strings.Replace(string(data), `"id": "M03"`, `"id": "M03"`, 1)+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := e.submit(quote, ""); err == nil {
		t.Fatal("отправка после смены материалов")
	}
	if e.paid() != 0 {
		t.Fatalf("отправок %d", e.paid())
	}
}

// TestUnknownPriceNeedsConsent — неизвестная цена: без согласия отказ, согласие той же оценки
// даёт одну отправку; согласие не переносится на новую оценку.
func TestUnknownPriceNeedsConsent(t *testing.T) {
	e := newEnv(t, "test-video-fast")
	quote := e.quote()
	if quote.Verdict != production.VerdictUnknown || quote.Credits != nil {
		t.Fatalf("оценка %+v", quote)
	}
	if _, err := e.submit(quote, ""); err == nil {
		t.Fatal("неизвестная цена без согласия")
	}
	first := e.quote()
	second := e.quote()
	if _, err := e.submit(second, first.Token); err == nil {
		t.Fatal("согласие другой оценки")
	}
	third := e.quote()
	info, err := e.submit(third, third.Token)
	if err != nil {
		t.Fatal(err)
	}
	e.wait(info)
	if e.paid() != 1 {
		t.Fatalf("отправок %d", e.paid())
	}
}

// TestInsufficientBalance — известная нехватка средств блокирует отправку даже с согласием.
func TestInsufficientBalance(t *testing.T) {
	e := newEnv(t, "test-video")
	configure(t, e.service, `{"balance": 10}`)
	quote := e.quote()
	if quote.Verdict != production.VerdictInsufficientBalance {
		t.Fatalf("оценка %+v", quote)
	}
	if _, err := e.submit(quote, quote.Token); err == nil {
		t.Fatal("отправка при нехватке средств")
	}
	if e.paid() != 0 {
		t.Fatalf("отправок %d", e.paid())
	}
}

// TestPriceChangedBeforeSubmit — цена изменилась между оценкой и отправкой: отказ без оплаты.
func TestPriceChangedBeforeSubmit(t *testing.T) {
	e := newEnv(t, "test-video")
	quote := e.quote()
	configure(t, e.service, `{"balance": 20}`)
	if _, err := e.submit(quote, ""); err == nil {
		t.Fatal("отправка после изменения остатка")
	}
	if e.paid() != 0 {
		t.Fatalf("отправок %d", e.paid())
	}
}

// TestServiceRefusalAsksAgain — явный отказ сервиса оставляет попытку неотправленной: пакет снова
// спрашивает об отправке, прежняя оценка не действует.
func TestServiceRefusalAsksAgain(t *testing.T) {
	e := newEnv(t, "test-video")
	configure(t, e.service, `{"submit": {"reject": "Сервис отклонил запрос."}}`)
	quote := e.quote()
	info, err := e.submit(quote, "")
	if err != nil {
		t.Fatal(err)
	}
	if finished := e.wait(info); finished.Status != jobs.StatusFailed {
		t.Fatalf("задание %+v", finished)
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) && e.view().Pending() == nil {
		time.Sleep(20 * time.Millisecond)
	}
	view := e.view()
	if attempt(t, e.pkg)["status"] != "prepared" || view.Pending() == nil || view.Pending().Stage != "request_choice" {
		t.Fatalf("после отказа: статус %v, этап %s", attempt(t, e.pkg)["status"], view.Stage)
	}
	if _, err := e.submit(quote, ""); err == nil {
		t.Fatal("повтор после ошибки без новой оценки")
	}
	if e.paid() != 1 {
		t.Fatalf("отправок %d", e.paid())
	}
}

// TestBrokenSubmissionWithoutID — обрыв после отправки без ID: исход неизвестен, вопрос не
// возвращается, получение и повтор недоступны до решения пользователя.
func TestBrokenSubmissionWithoutID(t *testing.T) {
	e := newEnv(t, "test-video")
	configure(t, e.service, `{"submit": "unknown"}`)
	info, err := e.submit(e.quote(), "")
	if err != nil {
		t.Fatal(err)
	}
	if finished := e.wait(info); finished.Status != jobs.StatusFailed {
		t.Fatalf("задание %+v", finished)
	}
	time.Sleep(50 * time.Millisecond)
	if status := attempt(t, e.pkg)["status"]; status != "submission_unknown" {
		t.Fatalf("статус %v", status)
	}
	if _, err := e.prod.Resume(e.project, e.pkg); err == nil {
		t.Fatal("получение без ID")
	}
	if _, err := e.prod.Quote(e.project, e.pkg, e.sha(), e.view().DecisionToken); err == nil {
		t.Fatal("оценка при неизвестном исходе")
	}
	if e.paid() != 1 {
		t.Fatalf("отправок %d", e.paid())
	}
}

// TestUnknownOutcomeWithoutID — сбой после отправки без ID: получение недоступно; «не создано»
// возвращает вопрос отправки, «прикрепить» делает файл оригиналом без новой оплаты.
func TestUnknownOutcomeWithoutID(t *testing.T) {
	e := newEnv(t, "test-video")
	path := filepath.Join(e.pkg, "request", "attempt.json")
	state := attempt(t, e.pkg)
	state["status"] = "submission_unknown"
	data, _ := json.MarshalIndent(state, "", "  ")
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
	e.tool("shot_workflow", "set-stage", "--dir", e.pkg, "submitted")
	if _, err := e.prod.Resume(e.project, e.pkg); err == nil {
		t.Fatal("получение без ID")
	}
	if _, err := e.prod.Regenerate(e.project, "M03"); err == nil {
		t.Fatal("повтор при неизвестном исходе")
	}
	if err := e.prod.DiscardAttempt(e.project, e.pkg); err == nil {
		t.Fatal("удаление незавершённой отправки")
	}
	file := filepath.Join(t.TempDir(), "result.mp4")
	if err := os.WriteFile(file, []byte("\x00\x00\x00\x18ftypmp42manual"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := e.prod.AttachResult(e.project, e.pkg, []string{"relative.mp4"}); err == nil {
		t.Fatal("относительный путь файла")
	}
	info, err := e.prod.AttachResult(e.project, e.pkg, []string{file})
	if err != nil {
		t.Fatal(err)
	}
	if finished := e.wait(info); finished.Status != jobs.StatusDone {
		t.Fatalf("задание %+v", finished)
	}
	if e.paid() != 0 || e.view().Stage != "downloaded" {
		t.Fatalf("отправок %d, этап %s", e.paid(), e.view().Stage)
	}
}

// TestMarkNotCreated — генерации нет: попытка снова ждёт подтверждения, нужна новая оценка.
func TestMarkNotCreated(t *testing.T) {
	e := newEnv(t, "test-video")
	path := filepath.Join(e.pkg, "request", "attempt.json")
	state := attempt(t, e.pkg)
	state["status"] = "submitting"
	data, _ := json.MarshalIndent(state, "", "  ")
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
	e.tool("shot_workflow", "set-stage", "--dir", e.pkg, "submitted")
	if err := e.prod.MarkNotCreated(e.project, e.pkg); err != nil {
		t.Fatal(err)
	}
	view := e.view()
	if view.Stage != "request_choice" || view.Pending() == nil || attempt(t, e.pkg)["status"] != "prepared" {
		t.Fatalf("после «не создано»: этап %s, статус %v", view.Stage, attempt(t, e.pkg)["status"])
	}
	info, err := e.submit(e.quote(), "")
	if err != nil {
		t.Fatal(err)
	}
	e.wait(info)
	if e.paid() != 1 {
		t.Fatalf("отправок %d", e.paid())
	}
}

// TestRestartLosesQuotes — оценки живут в памяти: новый сервис (перезапуск) не принимает прежний
// token, а получение по сохранённому ID после перезапуска новой оплаты не создаёт.
func TestRestartLosesQuotes(t *testing.T) {
	e := newEnv(t, "test-video")
	quote := e.quote()
	restarted := production.New(production.Options{Jobs: e.jobs})
	view := e.view()
	if _, err := restarted.Submit(e.project, e.pkg, *view.Request.SHA256, view.DecisionToken, quote.Token, ""); err == nil {
		t.Fatal("оценка пережила перезапуск")
	}
	if e.paid() != 0 {
		t.Fatalf("отправок %d", e.paid())
	}
}

// TestDiscardAndPark — отложенный пакет и удаление попытки до отправки.
func TestDiscardAndPark(t *testing.T) {
	e := newEnv(t, "test-video")
	if err := e.prod.Park(e.project, e.pkg); err != nil {
		t.Fatal(err)
	}
	// Отложенный пакет переезжает в очередь plan/awaiting.
	e.pkg = filepath.Join(e.project, "plan", "awaiting", "M03")
	if e.view().Stage != "ready" {
		t.Fatalf("этап после park: %s", e.view().Stage)
	}
	// Отложенный запрос отправляется заново только по новой оценке и подтверждению.
	info, err := e.submit(e.quote(), "")
	if err != nil {
		t.Fatal(err)
	}
	e.wait(info)
	if e.paid() != 1 {
		t.Fatalf("отправок %d", e.paid())
	}
	if err := e.prod.DiscardAttempt(e.project, e.pkg); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(e.pkg); !os.IsNotExist(err) {
		t.Fatalf("пакет не удалён: %v", err)
	}
	e = newEnv(t, "test-video")
	if err := e.prod.DiscardAttempt(e.project, e.pkg); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(e.pkg); !os.IsNotExist(err) {
		t.Fatalf("пакет не удалён: %v", err)
	}
	if _, err := e.prod.Quote(e.project, filepath.Join(e.project, "plan"), strings.Repeat("0", 64), ""); err == nil {
		t.Fatal("папка вне plan/batches")
	}
}

// fakeMedia — подставные ffprobe и ffmpeg приёмки: оригинал «совпадает» с окном M03 (120 кадров
// 30/1), версия FFmpeg — фиксированная строка. Настоящий FFmpeg тесту не нужен.
func fakeMedia(t *testing.T, frames string) {
	t.Helper()
	dir := t.TempDir()
	probe := filepath.Join(dir, "ffprobe")
	script := "#!/bin/sh\nprintf '%s' '{\"streams\": [{\"codec_type\": \"video\", \"width\": 1920, \"height\": 1080, \"r_frame_rate\": \"30/1\", \"duration\": \"4.000000\", \"nb_frames\": \"" + frames + "\"}], \"format\": {}, \"chapters\": []}'\n"
	if err := os.WriteFile(probe, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	ffmpeg := filepath.Join(dir, "ffmpeg")
	if err := os.WriteFile(ffmpeg, []byte("#!/bin/sh\necho 'ffmpeg version test-build'\necho 'built with test'\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	saved := mediacmd.Programs
	mediacmd.Programs = func() (string, string) { return ffmpeg, probe }
	t.Cleanup(func() { mediacmd.Programs = saved })
}

// TestAcceptFullAndRegenerate — приёмка полного оригинала заданием accept_shot: комплект в
// assets, отпечаток приёмки, очистка пакета; повтор по снимку комплекта готовит новый пакет с
// вопросом отправки без оплаты.
func TestAcceptFullAndRegenerate(t *testing.T) {
	e := newEnv(t, "test-video")
	fakeMedia(t, "120")
	info, err := e.submit(e.quote(), "")
	if err != nil {
		t.Fatal(err)
	}
	e.wait(info)
	view := e.view()
	if _, err := e.prod.Accept(e.project, "M03", e.pkg, production.AcceptOptions{Mode: "full", ExpectedResultToken: "чужой"}); err == nil {
		t.Fatal("приёмка по устаревшему результату")
	}
	cut := 0.5
	if _, err := e.prod.Accept(e.project, "M03", e.pkg, production.AcceptOptions{Mode: "cut", ExpectedResultToken: view.ResultToken, CutStart: &cut, CutEnd: &cut}); err == nil {
		t.Fatal("участок без длины")
	}
	end := 4.0
	// Участок запускает accept_shot --cut со скоростью и удержаниями; подставной ffprobe не видит
	// звука песни, поэтому приёмка отказывает до записи комплекта.
	partial, err := e.prod.Accept(e.project, "M03", e.pkg, production.AcceptOptions{Mode: "cut", ExpectedResultToken: view.ResultToken, CutStart: &cut, CutEnd: &end, Speed: "1.5", HoldFirst: 2})
	if err != nil {
		t.Fatalf("участок: %v", err)
	}
	if finished := e.wait(partial); finished.Status != jobs.StatusFailed || finished.Error == nil || *finished.Error != "Нет звуковой дорожки." ||
		!strings.Contains(finished.Log, `"--cut" "15:120" "--speed" "1.5" "--hold-first" "2"`) && !strings.Contains(finished.Log, "--cut 15:120 --speed 1.5 --hold-first 2") {
		t.Fatalf("участок %+v", finished)
	}
	if _, err := os.Stat(filepath.Join(e.project, "assets", "shots", "M03")); !os.IsNotExist(err) {
		t.Fatalf("комплект участка записан: %v", err)
	}
	accepted, err := e.prod.Accept(e.project, "M03", e.pkg, production.AcceptOptions{Mode: "full", ExpectedResultToken: view.ResultToken})
	if err != nil {
		t.Fatal(err)
	}
	if finished := e.wait(accepted); finished.Status != jobs.StatusDone {
		_, debug := acceptshot.Accept(context.Background(), e.project, "M03", acceptshot.Options{Package: e.pkg, Full: true, UpdateViews: true})
		t.Fatalf("приёмка %+v: %v", finished, debug)
	}
	for _, name := range []string{"manifest.json", "video.mp4", "original.mp4", "generation-request.json", "generation-prompt.txt", "preparation.json"} {
		if _, err := os.Stat(filepath.Join(e.project, "assets", "shots", "M03", name)); err != nil {
			t.Fatalf("комплект без %s: %v", name, err)
		}
	}
	if _, err := os.Stat(e.pkg); !os.IsNotExist(err) {
		t.Fatalf("пакет не очищен: %v", err)
	}
	status, _ := os.ReadFile(filepath.Join(e.project, "plan", "production-status.json"))
	if !strings.Contains(string(status), `"M03"`) {
		t.Fatalf("отпечаток приёмки не записан: %s", status)
	}
	productionView, err := production.ViewProduction(e.project)
	if err != nil {
		t.Fatal(err)
	}
	for _, shot := range productionView.Shots {
		if shot.ID == "M03" && (shot.State != production.StateCompleted || shot.RegenerateProblem != nil) {
			t.Fatalf("M03 после приёмки: %s %v", shot.State, *shot.RegenerateProblem)
		}
	}
	retry, err := e.prod.Regenerate(e.project, "M03")
	if err != nil {
		t.Fatal(err)
	}
	if finished := e.wait(retry); finished.Status != jobs.StatusDone {
		t.Fatalf("повтор %s", finished.Log)
	}
	retried := e.view()
	if retried.Stage != "request_choice" || retried.Pending() == nil || retried.Request == nil || *retried.Request.AttemptStatus != "prepared" {
		t.Fatalf("новый пакет: этап %s", retried.Stage)
	}
	if e.paid() != 1 {
		t.Fatalf("повтор отправил запрос: %d", e.paid())
	}
}
