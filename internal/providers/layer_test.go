package providers

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"songframe-go/internal/agents"
	"songframe-go/internal/jscompat"
	"songframe-go/internal/mediaadapters"
	"songframe-go/internal/mediaapi"
	"songframe-go/internal/mediaproviders"
	"songframe-go/internal/providers/kling"
	"songframe-go/internal/tools"
)

// fakePaid — платный провайдер test для общей логики слоя: правила, вход, проверка входа и
// строка «Среды» задаются тестом.
type fakePaid struct {
	auth   mediaapi.AuthStatus
	login  func(ctx context.Context, options mediaapi.LoginOptions) mediaapi.LoginResult
	mu     sync.Mutex
	checks int
}

func (f *fakePaid) RequestRules() mediaapi.RequestRules {
	rules := kling.RequestRules()
	rules.FrameDefined = nil
	return rules
}

func (f *fakePaid) AuthStatus(context.Context, time.Duration) mediaapi.AuthStatus {
	f.mu.Lock()
	f.checks++
	f.mu.Unlock()
	time.Sleep(20 * time.Millisecond)
	return f.auth
}

func (f *fakePaid) Login(ctx context.Context, options mediaapi.LoginOptions) mediaapi.LoginResult {
	return f.login(ctx, options)
}

func (f *fakePaid) Environment() mediaapi.Environment {
	bundled := true
	return mediaapi.Environment{
		Checks: []mediaapi.EnvironmentCheck{{ID: "test", Label: "Тестовый сервис", Detail: mediaapi.TextEnvironmentWaiting, Status: "pending", Bundled: &bundled, LoginProvider: "test", ProductionOnly: true}},
		Run: func(_ context.Context, update func(string, mediaapi.EnvironmentUpdate)) {
			ok, detail, elapsed := true, mediaapi.TextBundledClient, 0
			update("test", mediaapi.EnvironmentUpdate{Status: "done", OK: &ok, Detail: &detail, ElapsedMs: &elapsed})
		},
	}
}

// withFake регистрирует test в реестре и таблице адаптеров.
func withFake(t *testing.T, fake *fakePaid) {
	t.Helper()
	t.Cleanup(mediaproviders.Register("test", mediaproviders.Info{Title: "Тестовый сервис", Kinds: []string{"image", "video"}, Paid: true}))
	t.Cleanup(mediaadapters.Register("test", fake))
}

func TestProviderAuthSharesCurrentCheck(t *testing.T) {
	fake := &fakePaid{auth: mediaapi.AuthStatus{Status: agents.Unauthenticated, Message: "Войдите."}}
	withFake(t, fake)
	layer := NewLayer(Options{})
	var wait sync.WaitGroup
	results := make([]agents.ProviderAuth, 3)
	for index := range results {
		wait.Add(1)
		go func() {
			defer wait.Done()
			results[index], _ = layer.ProviderAuth(context.Background(), " TEST ")
		}()
	}
	wait.Wait()
	for _, result := range results {
		if result != (agents.ProviderAuth{Status: agents.Unauthenticated, Message: "Войдите."}) {
			t.Fatalf("результат %+v", result)
		}
	}
	if fake.checks != 1 {
		t.Fatalf("проверок %d, ожидалась одна общая", fake.checks)
	}
	// Готовый результат не кэшируется; подтверждённый вход не несёт пояснения.
	fake.auth = mediaapi.AuthStatus{Status: agents.Authenticated, Message: "лишнее"}
	if result, _ := layer.CheckAuth(context.Background(), "test"); result != (agents.ProviderAuth{Status: agents.Authenticated}) || fake.checks != 2 {
		t.Fatalf("повтор %+v, проверок %d", result, fake.checks)
	}
	fake.auth = mediaapi.AuthStatus{Status: "strange"}
	if result, _ := layer.ProviderAuth(context.Background(), "test"); result.Status != agents.AuthUnknown || result.Message != "Не удалось проверить вход в Тестовый сервис. Проверьте соединение и повторите проверку." {
		t.Fatalf("неизвестный ответ %+v", result)
	}
	if _, err := layer.ProviderAuth(context.Background(), "codex"); err == nil || err.Error() != textPaidExecutorMissing {
		t.Fatalf("не платный провайдер: %v", err)
	}
}

func TestLoginAnnouncesURLAndCancels(t *testing.T) {
	started := make(chan struct{})
	fake := &fakePaid{login: func(ctx context.Context, options mediaapi.LoginOptions) mediaapi.LoginResult {
		if options.OpenBrowser || options.Timeout != 300*time.Second {
			t.Errorf("параметры входа %+v", options)
		}
		options.Report("BROWSER_NOT_OPENED")
		options.Report("AUTHORIZE_URL https://example.invalid/authorize?x=1")
		options.Report("AUTHORIZE_URL https://example.invalid/second")
		close(started)
		<-ctx.Done()
		return mediaapi.LoginResult{Message: "прервано"}
	}}
	withFake(t, fake)
	var opened []string
	layer := NewLayer(Options{OpenURL: func(url string) error { opened = append(opened, url); return nil }})
	var urls []LoginURL
	done := make(chan LoginResult)
	go func() {
		result, _ := layer.Login(context.Background(), "test", func(url LoginURL) { urls = append(urls, url) })
		done <- result
	}()
	<-started
	layer.CancelLogin("TEST") // ключ — id как есть: другое написание не отменяет вход
	select {
	case <-done:
		t.Fatal("вход отменён ключом другого написания")
	case <-time.After(30 * time.Millisecond):
	}
	layer.CancelLogin("test")
	result := <-done
	if result != (LoginResult{Message: "Вход в Тестовый сервис отменён."}) {
		t.Fatalf("результат %+v", result)
	}
	if len(opened) != 1 || opened[0] != "https://example.invalid/authorize?x=1" || len(urls) != 1 || urls[0] != (LoginURL{Provider: "test", URL: opened[0]}) {
		t.Fatalf("адреса %v %v", opened, urls)
	}
	fake.login = func(context.Context, mediaapi.LoginOptions) mediaapi.LoginResult {
		return mediaapi.LoginResult{OK: false}
	}
	if result, _ := layer.Login(context.Background(), "test", nil); result.Message != "Вход в Тестовый сервис не завершён. Подтвердите вход в браузере и повторите при необходимости." {
		t.Fatalf("пустое сообщение %+v", result)
	}
}

func TestCheckEnvironmentRowsAndGit(t *testing.T) {
	withFake(t, &fakePaid{})
	dir := t.TempDir()
	git := filepath.Join(dir, "git")
	if runtime.GOOS == "windows" {
		t.Skip("поддельный git — shell-скрипт")
	}
	if err := os.WriteFile(git, []byte("#!/bin/sh\necho '  git version 2.43.0  '\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	layer := NewLayer(Options{Git: git})
	var mu sync.Mutex
	var progress []mediaapi.EnvironmentCheck
	checks, err := layer.CheckEnvironment(context.Background(), func(check mediaapi.EnvironmentCheck) {
		mu.Lock()
		progress = append(progress, check)
		mu.Unlock()
	})
	if err != nil {
		t.Fatal(err)
	}
	ids := []string{}
	for _, check := range checks {
		ids = append(ids, check.ID)
	}
	// Kling и test — строки платных провайдеров в порядке реестра, затем Git.
	if strings.Join(ids, ",") != "kling,test,git" {
		t.Fatalf("строки %v", ids)
	}
	last := checks[2]
	if !last.OK || last.Detail != "git version 2.43.0" || last.Status != "done" || last.External == nil || !*last.External || last.ElapsedMs == nil {
		t.Fatalf("git %+v", last)
	}
	if len(progress) < 6 || progress[0].Status != "pending" {
		t.Fatalf("прогресс %+v", progress)
	}
	layer = NewLayer(Options{Git: filepath.Join(dir, "нет")})
	checks, _ = layer.CheckEnvironment(context.Background(), nil)
	if checks[2].OK || checks[2].Detail != "Команда не найдена: "+filepath.Join(dir, "нет") {
		t.Fatalf("нет git: %+v", checks[2])
	}
	failing := filepath.Join(dir, "failing")
	if err := os.WriteFile(failing, []byte("#!/bin/sh\nexit 3\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	layer = NewLayer(Options{Git: failing})
	checks, _ = layer.CheckEnvironment(context.Background(), nil)
	if checks[2].Detail != "Command failed: "+failing+" --version\n" {
		t.Fatalf("сбой git: %q", checks[2].Detail)
	}
}

func TestCapabilitiesDispatch(t *testing.T) {
	layer := NewLayer(Options{})
	if _, err := layer.Capabilities(context.Background(), "/клип", "audio", "kling"); err == nil || err.Error() != "Неизвестный вид медиа." {
		t.Fatalf("вид медиа: %v", err)
	}
	for _, provider := range []string{"Kling", "unknown", ""} {
		caps, err := layer.Capabilities(context.Background(), "/клип", "video", provider)
		if err != nil || caps.Provider != provider || caps.Available || len(caps.Models) != 0 || len(caps.Problems) != 1 || caps.Problems[0] != textProviderUnsupported {
			t.Fatalf("%q: %+v %v", provider, caps, err)
		}
		if !regexp.MustCompile(`^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$`).MatchString(caps.CheckedAt) {
			t.Fatalf("checkedAt %q", caps.CheckedAt)
		}
	}
	if _, ok := layer.PaidMedia("kling", "video"); !ok {
		t.Fatal("платный адаптер Kling для видео")
	}
	if _, ok := layer.AgentImages("codex"); !ok {
		t.Fatal("исполнитель опор Codex")
	}
	if _, err := layer.ProjectAgentImages(" Kling "); err == nil || err.Error() != textImageAgentUnsupported {
		t.Fatalf("Kling не рисует опоры агентом: %v", err)
	}
	if _, err := layer.JobAgentImages(agents.Job{Provider: "claude"}); err == nil || err.Error() != textImageExecutorMissing {
		t.Fatalf("задание claude: %v", err)
	}
	if executor, err := layer.JobAgentImages(agents.Job{Provider: "codex"}); err != nil || executor.Provider() != "codex" {
		t.Fatalf("задание codex: %v", err)
	}
}

func TestAcceptsAudioInput(t *testing.T) {
	parse := func(text string) *jscompat.Object {
		value, _ := jscompat.Parse([]byte(text))
		return value.(*jscompat.Object)
	}
	if AcceptsAudioInput([]CatalogReport{{Command: "a", Models: parse(`{"m":{"slots":{"first_image":{}}}}`)}}) {
		t.Fatal("без звукового слота")
	}
	if !AcceptsAudioInput([]CatalogReport{{Command: "a", Models: parse(`{"m":{"slots":{}}}`)}, {Command: "b", Models: parse(`{"m":{"slots":{"Voice_1":{}}}}`)}}) {
		t.Fatal("слот Voice_1 — звуковой вход")
	}
}

func TestCatalogSharesCurrentRequest(t *testing.T) {
	release := make(chan struct{})
	calls := 0
	var mu sync.Mutex
	catalogs := &Catalogs{Run: func(context.Context, string, string, []string) (tools.Result, error) {
		mu.Lock()
		calls++
		mu.Unlock()
		<-release
		code := 0
		return tools.Result{Code: &code, Stdout: `{"reports":[],"problems":[]}`}, nil
	}}
	var wait sync.WaitGroup
	for range 3 {
		wait.Add(1)
		go func() {
			defer wait.Done()
			if _, err := catalogs.Read(context.Background(), "/клип", "kling", "image"); err != nil {
				t.Error(err)
			}
		}()
	}
	time.Sleep(20 * time.Millisecond)
	close(release)
	wait.Wait()
	if _, err := catalogs.Read(context.Background(), "/клип", "kling", "image"); err != nil || calls != 2 {
		t.Fatalf("вызовов %d, ожидалось 2 (общий и новый): %v", calls, err)
	}
}

// TestPaidLifecycle — подготовка офлайн-подменой media_request prepare, проверка, отправка через
// владельца согласования и получение оригинала.
func TestPaidLifecycle(t *testing.T) {
	withFake(t, &fakePaid{})
	project := t.TempDir()
	if err := os.WriteFile(filepath.Join(project, "ref.png"), png(64, 64), 0o666); err != nil {
		t.Fatal(err)
	}
	sum := func(data []byte) string { hash := sha256.Sum256(data); return hex.EncodeToString(hash[:]) }
	var spec *jscompat.Object
	run := func(_ context.Context, _ string, name string, args []string) (tools.Result, error) {
		data, err := os.ReadFile(args[2])
		if err != nil {
			t.Fatal(err)
		}
		value, _ := jscompat.Parse(data)
		spec = value.(*jscompat.Object)
		dir := args[4]
		_ = os.MkdirAll(filepath.Join(dir, "inputs"), 0o777)
		prompt := []byte("Промпт.")
		_ = os.WriteFile(filepath.Join(dir, "prompt.txt"), prompt, 0o666)
		reference := png(64, 64)
		_ = os.WriteFile(filepath.Join(dir, "inputs", "ref.png"), reference, 0o666)
		request := `{"kind":"image","outputs":1,"prompt":{"path":"prompt.txt","sha256":"` + sum(prompt) + `"},"inputs":[{"path":"inputs/ref.png","sha256":"` + sum(reference) + `"}]}`
		_ = os.WriteFile(filepath.Join(dir, "request.json"), []byte(request), 0o666)
		_ = os.WriteFile(filepath.Join(dir, "attempt.json"), []byte(`{"status":"prepared","request_sha256":"`+sum([]byte(request))+`"}`), 0o666)
		code := 0
		return tools.Result{Code: &code, Stdout: `{"request_sha256":"` + sum([]byte(request)) + `"}`}, nil
	}
	paid, _ := PaidAdapter("test")
	media := NewPaidMedia(paid, "image", PaidOptions{Run: run})
	caps := mediaapi.Capabilities{Provider: "test", Kind: "image", Available: true, Models: []mediaapi.Model{{
		ID: "m", Command: "image_to_image", Arguments: json.RawMessage(`{"prompt":{},"image_count":{"allowed":["1"]}}`),
		Slots: json.RawMessage(`{"image_1":{"required":true}}`), Limits: json.RawMessage(`{}`),
	}}}
	input := PaidInput{Project: project, WorkDir: "attempt", Shot: "M01", Kind: "image", Command: "image_to_image", Model: "m", Prompt: "Промпт.",
		Inputs: []PaidInputItem{{Flag: "image", Path: "ref.png"}}, Outputs: 1, FrameID: "K01"}
	prepared, err := media.Prepare(context.Background(), input, caps)
	if err != nil {
		t.Fatal(err)
	}
	if got := jscompat.Stringify(spec); !strings.Contains(got, `"model_selection":{"preferredModel":"m","selectedModel":"m","reason":"Предпочтительная модель m поддерживает все параметры запроса."}`) ||
		!strings.Contains(got, `"parameters":{"image_count":1}`) || !strings.Contains(got, `"inputs":[{"flag":"input","slot":"image_1","path":"`+filepath.Join(project, "ref.png")) {
		t.Fatalf("spec %s", got)
	}
	if prepared.RequestDir != filepath.Join(project, "attempt") || prepared.FrameID != "K01" {
		t.Fatalf("подготовка %+v", prepared)
	}
	if _, err := media.Collect(prepared); err == nil || err.Error() != textOriginalsIncomplete {
		t.Fatalf("до скачивания: %v", err)
	}
	var actions []string
	execute := func(_ context.Context, action string, _ PreparedRequest) error {
		actions = append(actions, action)
		return nil
	}
	if _, err := media.Submit(context.Background(), prepared, execute); err != nil {
		t.Fatal(err)
	}
	original := png(32, 16)
	if err := os.WriteFile(filepath.Join(prepared.RequestDir, "out.png"), original, 0o666); err != nil {
		t.Fatal(err)
	}
	attempt := `{"status":"downloaded","generation_id":"g","request_sha256":"` + prepared.RequestSha + `","downloads":[{"number":1,"path":"out.png","bytes":` + jscompat.NumberToString(float64(len(original))) + `,"sha256":"` + sum(original) + `"}]}`
	if err := os.WriteFile(filepath.Join(prepared.RequestDir, "attempt.json"), []byte(attempt), 0o666); err != nil {
		t.Fatal(err)
	}
	if _, err := media.Submit(context.Background(), prepared, execute); err == nil || err.Error() != textAlreadySubmitted {
		t.Fatalf("повторная отправка: %v", err)
	}
	if _, err := media.Resume(context.Background(), prepared, execute); err != nil || strings.Join(actions, ",") != "submit,resume" {
		t.Fatalf("resume: %v %v", err, actions)
	}
	artifacts, err := media.Collect(prepared)
	if err != nil {
		t.Fatal(err)
	}
	if len(artifacts) != 1 || artifacts[0].Width != 32 || artifacts[0].Height != 16 || artifacts[0].FrameID != "K01" || artifacts[0].SHA256 != sum(original) {
		t.Fatalf("оригиналы %+v", artifacts)
	}
	if err := os.WriteFile(filepath.Join(prepared.RequestDir, "prompt.txt"), []byte("Другой."), 0o666); err != nil {
		t.Fatal(err)
	}
	if _, err := media.Collect(prepared); err == nil || err.Error() != textRequestInputChanged {
		t.Fatalf("изменённый промпт: %v", err)
	}
}

// TestTextsMatchFrontend — постоянные тексты слоя совпадают со словарями renderer.
func TestTextsMatchFrontend(t *testing.T) {
	read := func(name string) string {
		data, err := os.ReadFile(filepath.Join("..", "..", "frontend", "src", "shared", "texts", name))
		if err != nil {
			t.Fatal(err)
		}
		return string(data)
	}
	files := map[string][]string{
		"media.ts": {textJSONObjectRequired, textSlotRequiresNamed, textModelNotDeclared, textInvalidRequest, textOutputCountMismatch, textInvalidNamedInput,
			textLocalInputsRequired, textInvalidCombinedLimit, textCombinedLimitExceeded, textExecutorKindMismatch, textRequestShaMissing, textExecutorRequestMismach,
			textRequestChanged, textRequestInputsDamaged, textRequestInputChanged, textAlreadySubmitted, textOriginalsIncomplete, textOriginalListDamaged,
			textOriginalChanged, textOriginalHashMismatch, textInvalidImage, textImageExtensionMismatch, textInvalidVideo},
		"application.ts": {textPaidExecutorMissing, textProviderUnsupported, textMediaKindUnknown, textImageAgentUnsupported, textImageExecutorMissing},
		"environment.ts": {textGitLabel, textGitHint, textVersionChecking, mediaapi.TextEnvironmentWaiting},
		"providers.ts":   {mediaapi.TextBundledClient},
	}
	for name, texts := range files {
		source := read(name)
		for _, text := range texts {
			if !strings.Contains(source, "'"+text+"'") && !strings.Contains(source, "\n      '"+text) && !strings.Contains(source, "`"+text) {
				t.Errorf("%s: нет текста %q", name, text)
			}
		}
	}
}
