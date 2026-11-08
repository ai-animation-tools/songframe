package jobs

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"

	"songframe-go/internal/process"
)

// TestMain скрывает служебные предупреждения менеджера (пропуск повреждённых файлов,
// паника подписчика): тесты проверяют их последствия, а не текст в stderr.
func TestMain(m *testing.M) {
	flag.Parse()
	if !testing.Verbose() {
		log.SetOutput(io.Discard)
	}
	os.Exit(m.Run())
}

// helperEnv выбирает поведение дочернего экземпляра тестового бинарника (TestHelperProcess).
const helperEnv = "SONGFRAME_JOBS_HELPER"

// TestHelperProcess — не тест, а внешняя программа для шагов с Exec: печатает заданный
// stdout, затем stderr (с паузой, чтобы порядок в журнале был детерминирован) и выходит с кодом.
func TestHelperProcess(t *testing.T) {
	mode := os.Getenv(helperEnv)
	if mode == "" {
		t.Skip("только дочерний процесс")
	}
	if mode == "hang" {
		fmt.Fprint(os.Stdout, "начато\n")
		time.Sleep(time.Minute)
		os.Exit(0)
	}
	var spec struct {
		Stdout, Stderr string
		Code           int
	}
	json.Unmarshal([]byte(mode), &spec)
	os.Stdout.WriteString(spec.Stdout)
	time.Sleep(30 * time.Millisecond)
	os.Stderr.WriteString(spec.Stderr)
	os.Exit(spec.Code)
}

// helperStep — шаг, запускающий помощника через Exec с заданным выводом и кодом.
func helperStep(tool, label string, args []string, stdout, stderr string, code int) Step {
	mode, _ := json.Marshal(map[string]any{"Stdout": stdout, "Stderr": stderr, "Code": code})
	return Step{Tool: tool, Label: label, Args: args, Run: func(ctx context.Context, step *StepContext) error {
		_, err := step.Exec(process.Command{Path: os.Args[0], Args: []string{"-test.run=^TestHelperProcess$"}, Env: append(os.Environ(), helperEnv+"="+string(mode))})
		return err
	}}
}

// readGolden читает эталон оригинала из testdata.
func readGolden(t *testing.T, name string, value any) {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, value); err != nil {
		t.Fatal(err)
	}
}

// asJSON приводит значение к универсальному виду для сравнения независимо от порядка ключей.
func asJSON(t *testing.T, value any) any {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var result any
	json.Unmarshal(data, &result)
	return result
}

func wait(t *testing.T, m *Manager, id string) Info {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	info, err := m.Wait(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	return info
}

// TestRunMatchesOriginal повторяет эталонное задание из шести шагов на настоящих процессах:
// статусы и коды шагов, код и error задания, журнал и файл сведений совпадают с оригиналом.
func TestRunMatchesOriginal(t *testing.T) {
	var golden struct {
		Job  map[string]any `json:"job"`
		File map[string]any `json:"file"`
		Keys []string       `json:"keys"`
		Log  string         `json:"log"`
	}
	readGolden(t, "original-run-634fd94.json", &golden)
	m := New(t.TempDir(), Options{SkipRestore: true})
	optional := helperStep("optional", "Сопутствующий", nil, "", "необязательный сбой\n", 3)
	optional.Optional = true
	silent := helperStep("silent", "Тихий", []string{"x"}, "", "", 4)
	silent.Continue = true
	stdoutOnly := helperStep("stdoutOnly", "", nil, " только stdout \n", "", 6)
	stdoutOnly.Continue = true
	started, err := m.Start(Spec{Kind: KindTool, Title: "Проверка", Project: "/p", Steps: []Step{
		helperStep("ok", "", []string{"--json", "a b"}, "вывод\n", "", 0),
		optional, silent, stdoutOnly,
		helperStep("fatal", "Главный", []string{"--y"}, "частично\n", "  причина  \n", 5),
		helperStep("never", "", nil, "", "", 0),
	}})
	if err != nil || started.Status != StatusRunning {
		t.Fatal(started, err)
	}
	final := wait(t, m, started.ID)
	actual := asJSON(t, final).(map[string]any)
	for _, key := range []string{"id", "startedAt", "finishedAt"} {
		delete(actual, key)
	}
	if !reflect.DeepEqual(actual, golden.Job) {
		t.Fatalf("JobInfo отличается:\n%v\n%v", actual, golden.Job)
	}
	data, _ := os.ReadFile(filepath.Join(m.directory, started.ID+".json"))
	var file map[string]any
	json.Unmarshal(data, &file)
	keys := []string{}
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.Token()
	for decoder.More() {
		key, _ := decoder.Token()
		keys = append(keys, key.(string))
		var skip json.RawMessage
		decoder.Decode(&skip)
	}
	for _, key := range []string{"id", "startedAt", "finishedAt"} {
		delete(file, key)
	}
	if !reflect.DeepEqual(file, golden.File) || !reflect.DeepEqual(keys, golden.Keys) {
		t.Fatalf("файл сведений отличается:\n%v\n%v\n%v", file, golden.File, keys)
	}
	if text := m.ReadLog(started.ID, 1<<20); text != golden.Log {
		t.Fatalf("журнал отличается:\n%q\n%q", text, golden.Log)
	}
}

// TestRestoreMatchesOriginal: восстановление прошлых сеансов (interrupted, лимит, повреждённый
// и чужой файлы) даёт те же сведения и те же файлы, что loadSavedJobs оригинала.
func TestRestoreMatchesOriginal(t *testing.T) {
	var golden struct {
		Loaded []map[string]any  `json:"loaded"`
		Files  map[string]string `json:"files"`
		Tail   []string          `json:"tail"`
		Rest   map[string]any    `json:"-"`
	}
	readGolden(t, "original-634fd94.json", &golden)
	local := t.TempDir()
	directory := filepath.Join(local, "jobs")
	os.MkdirAll(directory, 0o700)
	saved := func(id, startedAt, status string, extra map[string]any) {
		stepStatus := "done"
		if status == "running" {
			stepStatus = "running"
		}
		value := map[string]any{"id": id, "project": nil, "kind": "tool", "title": "Задание " + id, "status": status, "startedAt": startedAt, "finishedAt": nil, "code": nil,
			"steps": []any{map[string]any{"label": "Шаг", "tool": "tool", "status": stepStatus, "code": nil}, map[string]any{"label": "Ещё", "tool": "tool2", "status": "pending", "code": nil}}}
		for key, item := range extra {
			value[key] = item
		}
		data, _ := json.Marshal(value)
		os.WriteFile(filepath.Join(directory, id+".json"), data, 0o600)
	}
	saved("a-1", "2026-11-01T00:00:00.000Z", "done", map[string]any{"code": 0, "finishedAt": "2026-11-01T00:00:01.000Z"})
	saved("b-2", "2026-11-02T00:00:00.000Z", "running", map[string]any{"modelDownload": map[string]any{"model": "song-timing-v1", "directory": "/m"}})
	saved("c-3", "2026-11-03T00:00:00.000Z", "running", map[string]any{"error": "старая"})
	saved("d-4", "2026-10-01T00:00:00.000Z", "done", nil)
	os.WriteFile(filepath.Join(directory, "d-4.log"), []byte("журнал"), 0o600)
	os.WriteFile(filepath.Join(directory, "e-5.json"), []byte("{broken"), 0o600)
	os.WriteFile(filepath.Join(directory, "agent-x.json"), []byte("{}"), 0o600)
	now, _ := time.Parse(time.RFC3339, "2026-11-04T12:00:00Z")
	m := New(local, Options{SavedLimit: 3, Now: func() time.Time { return now }})
	if actual, expected := asJSON(t, m.List()), asJSON(t, golden.Loaded); !reflect.DeepEqual(actual, expected) {
		t.Fatalf("восстановленные задания отличаются:\n%v\n%v", actual, expected)
	}
	for _, name := range []string{"a-1.json", "b-2.json", "c-3.json"} {
		data, _ := os.ReadFile(filepath.Join(directory, name))
		if expected := golden.Files[name]; name != "a-1.json" && string(data) != expected {
			t.Fatalf("%s:\n%s\n%s", name, data, expected)
		}
	}
	entries, _ := os.ReadDir(directory)
	names := []string{}
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	if !reflect.DeepEqual(names, []string{"a-1.json", "agent-x.json", "b-2.json", "c-3.json", "e-5.json"}) {
		t.Fatalf("лишние или удалённые файлы: %v", names)
	}
	// Хвост журнала прошлого сеанса читается Get из файла, в List он пуст.
	os.WriteFile(filepath.Join(directory, "a-1.log"), []byte("строка журнала"), 0o600)
	if info, ok := m.Get("a-1"); !ok || info.Log != "строка журнала" || !info.PreviousSession {
		t.Fatal(info, ok)
	}
}

// TestReadLogTailMatchesOriginal: обрезка в середине многобайтного символа даёт те же строки.
func TestReadLogTailMatchesOriginal(t *testing.T) {
	var golden struct {
		Tail []string `json:"tail"`
	}
	readGolden(t, "original-634fd94.json", &golden)
	path := filepath.Join(t.TempDir(), "tail.log")
	os.WriteFile(path, []byte("ааааaбв"), 0o600)
	for index, expected := range golden.Tail {
		if actual := readLogTail(path, int64(index+1)); actual != expected {
			t.Fatalf("хвост %d байт: %q, ожидалось %q", index+1, actual, expected)
		}
	}
	if readLogTail(filepath.Join(t.TempDir(), "нет.log"), 10) != "" {
		t.Fatal("отсутствующий журнал")
	}
}

// TestCopyTextMatchesOriginal сравнивает текст копирования (сведения, шаги, скрытие домашнего
// каталога и секретов, пустой журнал) с jobText оригинала.
func TestCopyTextMatchesOriginal(t *testing.T) {
	var golden struct {
		Text  string `json:"text"`
		Empty string `json:"empty"`
	}
	readGolden(t, "original-634fd94.json", &golden)
	project, finished, message := "/home/tester/Клипы/Огород", "2026-11-04T10:01:00.000Z", `сбой sk-abcdefghijkl и api_key="секрет"`
	zero, two := 0, 2
	info := Info{ID: "abc-1", Project: &project, Kind: KindTool, Title: "Сборка", Status: StatusFailed, StartedAt: "2026-11-04T10:00:00.000Z", FinishedAt: &finished, Code: &two, Error: &message, PreviousSession: true,
		Steps: []StepInfo{{"Первый", "one", StepDone, &zero}, {"Второй", "two", StepFailed, &two}, {"Третий", "three", StepPending, nil}}}
	if text := JobText(info, "\n  строка /home/tester/x Bearer abc.def\nAuthorization: xyz\n\n", "/home/tester"); text != golden.Text {
		t.Fatalf("%q\n%q", text, golden.Text)
	}
	empty := Info{ID: "abc-1", Kind: KindTool, Title: "Сборка", Status: StatusFailed, StartedAt: "2026-11-04T10:00:00.000Z", Steps: []StepInfo{}}
	if text := JobText(empty, " \n ", "/home/tester"); text != golden.Empty {
		t.Fatalf("%q\n%q", text, golden.Empty)
	}
	m := New(t.TempDir(), Options{SkipRestore: true})
	if _, err := m.CopyText("нет-1"); !errors.Is(err, ErrNotFound) {
		t.Fatal(err)
	}
	started, _ := m.Start(Spec{Kind: KindCheck, Title: "Копия", Steps: []Step{{Tool: "go", Run: func(ctx context.Context, step *StepContext) error {
		step.Log("готово\n")
		return nil
	}}}})
	wait(t, m, started.ID)
	text, err := m.CopyText(started.ID)
	if err != nil || !strings.Contains(text, "проект: общее задание приложения; статус: done; код: 0") || !strings.HasSuffix(text, "Журнал:\n$ go \nготово\n") {
		t.Fatalf("%v\n%s", err, text)
	}
}

// TestCancelStopsProcessAndMarksFailed: отмена убивает внешнюю программу шага, задание
// получает failed с error = причина отмены и кодом -1, следующий шаг не выполняется,
// а Go-шаг после отмены не публикует результат (видит отменённый context).
func TestCancelStopsProcessAndMarksFailed(t *testing.T) {
	m := New(t.TempDir(), Options{SkipRestore: true})
	started := make(chan struct{})
	var once sync.Once
	published := false
	steps := []Step{
		{Tool: "hang", Run: func(ctx context.Context, step *StepContext) error {
			_, err := step.Exec(process.Command{Path: os.Args[0], Args: []string{"-test.run=^TestHelperProcess$"}, Env: append(os.Environ(), helperEnv+"=hang"),
				OnOutput: func([]byte, bool) { once.Do(func() { close(started) }) }})
			if ctx.Err() == nil {
				published = true
			}
			return err
		}},
		{Tool: "after", Run: func(context.Context, *StepContext) error { published = true; return nil }},
	}
	info, _ := m.Start(Spec{Kind: KindTool, Title: "Отмена", Project: "/p", Steps: steps})
	select {
	case <-started:
	case <-time.After(10 * time.Second):
		t.Fatal("программа шага не запустилась")
	}
	if snapshot, ok := m.Cancel(info.ID, "Отменено пользователем."); !ok || snapshot.Status != StatusRunning {
		t.Fatal(snapshot, ok)
	}
	final := wait(t, m, info.ID)
	if final.Status != StatusFailed || *final.Code != -1 || *final.Error != "Отменено пользователем." || final.Steps[0].Status != StepFailed || *final.Steps[0].Code != -1 || final.Steps[1].Status != StepPending || published {
		t.Fatalf("%+v published=%v", final, published)
	}
	if log := m.ReadLog(info.ID, 1<<20); !strings.Contains(log, "начато\n\nВыполнение остановлено пользователем.\n") || !strings.Contains(log, "задание остановлено") {
		t.Fatalf("%q", log)
	}
	if again, ok := m.Cancel(info.ID, "ещё"); !ok || *again.Error != "Отменено пользователем." {
		t.Fatal("отмена завершённого задания изменила его")
	}
	if _, ok := m.Cancel("нет-1", ""); ok {
		t.Fatal("неизвестное задание")
	}
}

// TestCancelContinueSteps: после отмены оставшиеся шаги с Continue не выполняются, а
// завершаются failed с кодом -1, как пустые запуски launcher оригинала после abort.
func TestCancelContinueSteps(t *testing.T) {
	m := New(t.TempDir(), Options{SkipRestore: true})
	release := make(chan struct{})
	ran := false
	block := Step{Tool: "block", Continue: true, Run: func(ctx context.Context, _ *StepContext) error {
		close(release)
		<-ctx.Done()
		return ctx.Err()
	}}
	next := Step{Tool: "next", Continue: true, Before: func(context.Context) error { ran = true; return nil }, Run: func(context.Context, *StepContext) error { ran = true; return nil }}
	info, _ := m.Start(Spec{Kind: KindTool, Title: "Отмена", Steps: []Step{block, next}})
	<-release
	m.Cancel(info.ID, "")
	final := wait(t, m, info.ID)
	if ran || final.Status != StatusFailed || *final.Error != StoppedMessage || final.Steps[1].Status != StepFailed || *final.Steps[1].Code != -1 {
		t.Fatalf("%+v ran=%v", final, ran)
	}
}

// TestStepTimeout: истечение лимита шага останавливает программу и даёт причину оригинала.
func TestStepTimeout(t *testing.T) {
	m := New(t.TempDir(), Options{SkipRestore: true})
	step := Step{Tool: "hang", Timeout: 300 * time.Millisecond, Run: func(ctx context.Context, step *StepContext) error {
		_, err := step.Exec(process.Command{Path: os.Args[0], Args: []string{"-test.run=^TestHelperProcess$"}, Env: append(os.Environ(), helperEnv+"=hang")})
		return err
	}}
	goStep := Step{Tool: "go", Timeout: 100 * time.Millisecond, Continue: true, Run: func(ctx context.Context, _ *StepContext) error {
		<-ctx.Done()
		return ctx.Err()
	}}
	info, _ := m.Start(Spec{Kind: KindTool, Title: "Лимит", Steps: []Step{goStep, step}})
	final := wait(t, m, info.ID)
	if *final.Error != "Превышено время выполнения (100 мс)." || *final.Steps[1].Code != -1 {
		t.Fatalf("%+v", final)
	}
	if log := m.ReadLog(info.ID, 1<<20); !strings.Contains(log, "начато\n\nПревышено время выполнения (300 мс).\n") {
		t.Fatalf("%q", log)
	}
}

// TestBeforeAndGoErrors: ошибка Before и обычная ошибка Go-шага становятся причиной,
// паника шага не роняет приложение, StepError задаёт код.
func TestBeforeAndGoErrors(t *testing.T) {
	m := New(t.TempDir(), Options{SkipRestore: true})
	info, _ := m.Start(Spec{Kind: KindTool, Title: "Ошибки", Steps: []Step{
		{Tool: "before", Continue: true, Before: func(context.Context) error { return errors.New("нет результата") }, Run: func(context.Context, *StepContext) error { return nil }},
		{Tool: "coded", Continue: true, Run: func(context.Context, *StepContext) error { return &StepError{Code: 9} }},
		{Tool: "panic", Continue: true, Run: func(context.Context, *StepContext) error { panic("сбой") }},
	}})
	final := wait(t, m, info.ID)
	if *final.Error != "нет результата" || *final.Code != -1 || *final.Steps[1].Code != 9 || final.Steps[2].Status != StepFailed {
		t.Fatalf("%+v", final)
	}
	log := m.ReadLog(info.ID, 1<<20)
	if !strings.Contains(log, "\nОшибка запуска: нет результата\n") || !strings.Contains(log, "Шаг «coded» завершился с кодом 9.") || !strings.Contains(log, "внутренняя ошибка шага: сбой") {
		t.Fatalf("%q", log)
	}
}

// TestInterruptedAfterRestart: задание, выполнявшееся при «закрытии», в новом сеансе
// становится interrupted, а его running-шаг — failed.
func TestInterruptedAfterRestart(t *testing.T) {
	local := t.TempDir()
	first := New(local, Options{})
	running := make(chan struct{})
	info, _ := first.Start(Spec{Kind: KindReview, Title: "Сводка", Project: "/p", Steps: []Step{
		{Tool: "wait", Run: func(ctx context.Context, step *StepContext) error {
			step.Log("частичный вывод\n")
			close(running)
			<-ctx.Done()
			return ctx.Err()
		}},
		{Tool: "rest", Run: func(context.Context, *StepContext) error { return nil }},
	}})
	<-running
	second := New(local, Options{})
	restored, ok := second.Get(info.ID)
	if !ok || restored.Status != StatusInterrupted || *restored.Error != InterruptedMessage || restored.FinishedAt == nil || restored.Steps[0].Status != StepFailed || restored.Steps[1].Status != StepPending || !restored.PreviousSession || restored.Code != nil {
		t.Fatalf("%+v", restored)
	}
	if !strings.Contains(restored.Log, "частичный вывод") {
		t.Fatalf("журнал прошлого сеанса: %q", restored.Log)
	}
	if list := second.List(); len(list) != 1 || list[0].Log != "" {
		t.Fatalf("%+v", list)
	}
	first.Shutdown(context.Background(), "")
}

// TestSavedLimitAndDamagedFiles: хранится не больше 200 заданий прошлых сеансов (старые
// удаляются с журналами), повреждённые и слишком большие файлы пропускаются и не удаляются.
func TestSavedLimitAndDamagedFiles(t *testing.T) {
	local := t.TempDir()
	directory := filepath.Join(local, "jobs")
	os.MkdirAll(directory, 0o700)
	for index := 0; index < SavedJobsLimit+5; index++ {
		id := fmt.Sprintf("j-%d", index)
		data := fmt.Sprintf(`{"id":%q,"kind":"tool","title":"t","status":"done","startedAt":"2026-01-01T00:00:%02d.%03dZ","finishedAt":null,"code":0,"steps":[]}`, id, index/1000, index%1000)
		os.WriteFile(filepath.Join(directory, id+".json"), []byte(data), 0o600)
		os.WriteFile(filepath.Join(directory, id+".log"), []byte("log"), 0o600)
	}
	damaged := map[string]string{
		"x-1.json": `{"id":"x-1","kind":"tool","title":"t","status":"unknown","startedAt":"s","finishedAt":null,"code":null,"steps":[]}`,
		"x-2.json": `{"id":"другой","kind":"tool","title":"t","status":"done","startedAt":"s","finishedAt":null,"code":null,"steps":[]}`,
		"x-3.json": `{"id":"x-3","kind":"tool","title":"t","status":"done","startedAt":"s","code":null,"steps":[]}`,
		"x-4.json": `{"id":"x-4","kind":"tool","title":"t","status":"done","startedAt":"s","finishedAt":null,"code":1.5,"steps":[]}`,
		"x-5.json": `[]`,
		"x-6.json": `{"id":"x-6","kind":"tool","title":"t","status":"done","startedAt":"s","finishedAt":null,"code":null,"steps":[{"label":"l","tool":"t","status":"?"}]}`,
		"x-7.json": `{"id":"x-7","kind":"tool","title":"` + strings.Repeat("я", savedFileLimit) + `","status":"done","startedAt":"s","finishedAt":null,"code":null,"steps":[]}`,
	}
	for name, data := range damaged {
		os.WriteFile(filepath.Join(directory, name), []byte(data), 0o600)
	}
	m := New(local, Options{})
	list := m.List()
	if len(list) != SavedJobsLimit || list[0].ID != "j-204" || list[len(list)-1].ID != "j-5" {
		t.Fatalf("%d %s %s", len(list), list[0].ID, list[len(list)-1].ID)
	}
	for index := 0; index < 5; index++ {
		for _, extension := range []string{".json", ".log"} {
			if _, err := os.Stat(filepath.Join(directory, fmt.Sprintf("j-%d%s", index, extension))); !os.IsNotExist(err) {
				t.Fatalf("старое задание j-%d%s не удалено", index, extension)
			}
		}
	}
	for name := range damaged {
		if _, err := os.Stat(filepath.Join(directory, name)); err != nil {
			t.Fatalf("повреждённый %s удалён", name)
		}
	}
}

// TestDTOShape проверяет JSON-контракт JobInfo: null там, где TS допускает null,
// отсутствие необязательных полей и [] вместо null для steps.
func TestDTOShape(t *testing.T) {
	m := New(t.TempDir(), Options{SkipRestore: true})
	info, err := m.Start(Spec{Kind: KindModelDownload, Title: "Пусто"})
	if err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(info)
	text := string(data)
	for _, part := range []string{`"project":null`, `"finishedAt":null`, `"code":null`, `"steps":[]`, `"log":""`} {
		if !strings.Contains(text, part) {
			t.Fatalf("нет %s в %s", part, text)
		}
	}
	for _, part := range []string{`"error"`, `"modelDownload"`, `"previousSession"`} {
		if strings.Contains(text, part) {
			t.Fatalf("лишнее %s в %s", part, text)
		}
	}
	final := wait(t, m, info.ID)
	if final.Status != StatusDone || *final.Code != 0 {
		t.Fatalf("%+v", final)
	}
	if _, err := m.Start(Spec{Kind: KindTool, Title: "t", Steps: []Step{{Tool: "x"}}}); err == nil {
		t.Fatal("шаг без Run принят")
	}
	download, err := m.Start(Spec{Kind: KindTool, Title: "t", ModelDownload: &ModelDownload{"song-timing-v1", "/m"}})
	if err != nil {
		t.Fatal(err)
	}
	if data, _ := json.Marshal(wait(t, m, download.ID)); !strings.Contains(string(data), `"modelDownload":{"model":"song-timing-v1","directory":"/m"}`) {
		t.Fatal(string(data))
	}
}

// TestLogTailIsBoundedAndValid: хвост в памяти — последние LogTail символов, без разрезанных
// многобайтных символов, даже если программа выдаёт символ по частям.
func TestLogTailIsBoundedAndValid(t *testing.T) {
	m := New(t.TempDir(), Options{SkipRestore: true})
	info, _ := m.Start(Spec{Kind: KindTool, Title: "Журнал", Steps: []Step{{Tool: "go", Run: func(ctx context.Context, step *StepContext) error {
		text := []byte(strings.Repeat("ж", LogTail) + "конец")
		for index := 0; index < len(text); index += 3 {
			step.Write(text[index:min(index+3, len(text))])
		}
		return nil
	}}}})
	final := wait(t, m, info.ID)
	if utf8.RuneCountInString(final.Log) != LogTail || !utf8.ValidString(final.Log) || !strings.HasSuffix(final.Log, "конец") {
		t.Fatalf("%d %v", utf8.RuneCountInString(final.Log), utf8.ValidString(final.Log))
	}
	if log := m.ReadLog(info.ID, 1<<20); !strings.HasPrefix(log, "\n$ go \nжж") {
		t.Fatal("полный журнал на диске обрезан")
	}
}

// TestSubscriptions: подписчик изменений получает ID и проект, onFinished — копию итога
// и проект; паника подписчика не мешает остальным и заданию, отписка работает.
func TestSubscriptions(t *testing.T) {
	m := New(t.TempDir(), Options{SkipRestore: true})
	var mu sync.Mutex
	changes := []Change{}
	unsubscribe := m.Subscribe(func(change Change) {
		mu.Lock()
		changes = append(changes, change)
		mu.Unlock()
	})
	m.Subscribe(func(Change) { panic("подписчик") })
	finished := make(chan Info, 1)
	projects := make(chan string, 1)
	m.OnFinished(func(job Info, project string) {
		if job.Title != "События" {
			return
		}
		job.Steps[0].Status = StepPending
		finished <- job
		projects <- project
	})
	info, _ := m.Start(Spec{Kind: KindTool, Title: "События", Project: "/клип", Steps: []Step{{Tool: "go", Run: func(context.Context, *StepContext) error { return nil }}}})
	job := <-finished
	if job.Status != StatusDone || <-projects != "/клип" {
		t.Fatalf("%+v", job)
	}
	final := wait(t, m, info.ID)
	if final.Steps[0].Status != StepDone {
		t.Fatal("подписчик изменил состояние менеджера")
	}
	mu.Lock()
	last := changes[len(changes)-1]
	count := len(changes)
	mu.Unlock()
	if count < 3 || changes[0].Status != StatusRunning || last.ID != info.ID || *last.Project != "/клип" || last.Status != StatusDone {
		t.Fatalf("%+v", changes)
	}
	unsubscribe()
	second, _ := m.Start(Spec{Kind: KindTool, Title: "После отписки"})
	wait(t, m, second.ID)
	mu.Lock()
	defer mu.Unlock()
	if len(changes) != count {
		t.Fatal("отписанный подписчик получил событие")
	}
}

// TestConcurrentJobs проверяет под -race параллельные задания, чтение списка и отмену.
func TestConcurrentJobs(t *testing.T) {
	m := New(t.TempDir(), Options{SkipRestore: true})
	ids := []string{}
	for index := 0; index < 8; index++ {
		info, err := m.Start(Spec{Kind: KindTool, Title: fmt.Sprint(index), Steps: []Step{{Tool: "go", Run: func(ctx context.Context, step *StepContext) error {
			for line := 0; line < 50; line++ {
				step.Log("строка\n")
			}
			return nil
		}}}})
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, info.ID)
	}
	var group sync.WaitGroup
	for range 4 {
		group.Go(func() {
			for range 20 {
				for _, info := range m.List() {
					m.Get(info.ID)
				}
			}
		})
	}
	m.Cancel(ids[0], "")
	group.Wait()
	seen := map[string]bool{}
	for _, id := range ids {
		if seen[id] {
			t.Fatal("повтор ID", id)
		}
		seen[id] = true
		if final := wait(t, m, id); final.Status == StatusRunning {
			t.Fatal(final)
		}
	}
	if err := m.Shutdown(context.Background(), ""); err != nil {
		t.Fatal(err)
	}
}
