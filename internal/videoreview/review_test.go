package videoreview

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"songframe-go/internal/agents"
	"songframe-go/internal/jscompat"
)

// promptDigest — закреплённый SHA-256 встроенного скилла проверки видео.
const promptDigest = "edacbfacff0237f9b918ed559b105527e912f881b7749312cf26c3aecac64aad"

// TestPromptDigest фиксирует байты промпта: правка встроенного SKILL.md меняет вход агента и
// должна быть осознанной.
func TestPromptDigest(t *testing.T) {
	sum := sha256.Sum256([]byte(prompt))
	if got := hex.EncodeToString(sum[:]); got != promptDigest {
		t.Fatalf("SHA-256 промпта %s, ожидался %s", got, promptDigest)
	}
}

// TestTextsMatchGolden — тексты renderer совпадают с frontend/src/shared/texts, остальные тексты
// подготовки кадров — со строками эталона testdata/golden/video-review-frames/texts.json
// (плейсхолдеры подставлены).
func TestTextsMatchGolden(t *testing.T) {
	var frontend strings.Builder
	for _, name := range []string{"video-review.ts", "production.ts"} {
		data, err := os.ReadFile(filepath.Join("..", "..", "frontend", "src", "shared", "texts", name))
		if err != nil {
			t.Fatal(err)
		}
		frontend.Write(data)
	}
	data, err := os.ReadFile(filepath.Join("..", "..", "testdata", "golden", "video-review-frames", "texts.json"))
	if err != nil {
		t.Fatal(err)
	}
	var python map[string]string
	if err := json.Unmarshal(data, &python); err != nil {
		t.Fatal(err)
	}
	file, err := parser.ParseFile(token.NewFileSet(), "texts.go", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	checked, seen := 0, map[string]bool{}
	ast.Inspect(file, func(node ast.Node) bool {
		spec, ok := node.(*ast.ValueSpec)
		if !ok || len(spec.Values) != 1 {
			return true
		}
		literal, ok := spec.Values[0].(*ast.BasicLit)
		if !ok || literal.Kind != token.STRING {
			return true
		}
		value, _ := strconv.Unquote(literal.Value)
		checked++
		if strings.Contains(frontend.String(), "'"+value+"'") || strings.Contains(frontend.String(), "`"+value) {
			return true
		}
		name := spec.Names[0].Name
		seen[name] = true
		if !strings.Contains(python[name], value) {
			t.Errorf("%s = %q нет ни в текстах renderer, ни в строке video_review.py %q", name, value, python[name])
		}
		return true
	})
	for name := range python {
		if !seen[name] {
			t.Errorf("в texts.json лишний текст %s", name)
		}
	}
	if checked < 15 {
		t.Fatalf("проверено слишком мало текстов: %d", checked)
	}
}

// countingExtract считает вызовы подготовки кадров.
type countingExtract struct{ calls int }

func (c *countingExtract) run(context.Context, ExtractInput) (Manifest, error) {
	c.calls++
	return Manifest{}, errors.New("не должно вызываться")
}

// TestViewDoesNotStartAgent — просмотр (в том числе готового и устаревшего отчёта) не запускает
// ни подготовку кадров, ни агента, а представление готового отчёта не меняет latest.json.
func TestViewDoesNotStartAgent(t *testing.T) {
	h := newHarness(t)
	review := h.service(nil)
	if _, err := review.Start(h.project, h.directory); err != nil {
		t.Fatal(err)
	}
	h.wait(review, StatusRunning)
	complete(h, 0, reportJSON())
	if view, err := review.View(h.project, h.directory); err != nil || view.Status != StatusCompleted || view.Report == nil {
		t.Fatalf("%+v %v", view, err)
	}
	before := readFile(t, filepath.Join(h.directory, "video-review", "latest.json"))
	counter := &countingExtract{}
	viewer := New(Options{Agents: h.agents, Tools: func() (Tools, bool) { return Tools{}, true }, Extract: counter.run, Brief: h.brief})
	writeFile(t, h.original, []byte("Изменённый оригинал"))
	for range 3 {
		view, err := viewer.View(h.project, h.directory)
		if err != nil || !view.Stale || view.Status != StatusCompleted || !view.CanStart {
			t.Fatalf("%+v %v", view, err)
		}
	}
	if counter.calls != 0 || len(h.agents.starts) != 1 {
		t.Fatalf("просмотр запустил подготовку (%d) или агента (%d)", counter.calls, len(h.agents.starts))
	}
	if after := readFile(t, filepath.Join(h.directory, "video-review", "latest.json")); string(after) != string(before) {
		t.Fatal("просмотр изменил latest.json")
	}
	if _, err := os.Stat(filepath.Join(h.project, "assets", "shots", "M01", "manifest.json")); err == nil {
		t.Fatal("проверка приняла видео")
	}
}

// TestInvalidAnswerKeepsReportEmpty — повреждённый ответ агента и ответ с непоказанным кадром не
// становятся отчётом; повреждённый latest.json не отдаётся как отчёт и не переписывается просмотром.
func TestInvalidAnswerKeepsReportEmpty(t *testing.T) {
	for _, answer := range []string{"", "{", `{"schemaVersion":1}`, strings.Replace(reportJSON(), `"F002"`, `"F009"`, 1), strings.Replace(reportJSON(), `"limitations"`, `"accept":true,"limitations"`, 1)} {
		h := newHarness(t)
		review := h.service(nil)
		if _, err := review.Start(h.project, h.directory); err != nil {
			t.Fatal(err)
		}
		h.wait(review, StatusRunning)
		complete(h, 0, answer)
		view, err := review.View(h.project, h.directory)
		if err != nil || view.Status != StatusFailed || view.Report != nil || deref(view.Error) != textInvalidReport {
			t.Fatalf("%q: %+v %v", answer, view, err)
		}
		value, err := jscompat.Parse(readFile(t, filepath.Join(h.directory, "video-review", "latest.json")))
		if err != nil || jscompat.Get(value, "report") != nil {
			t.Fatalf("%q: отчёт записан: %v", answer, err)
		}
	}
	h := newHarness(t)
	latest := filepath.Join(h.directory, "video-review", "latest.json")
	writeFile(t, latest, []byte(`{"schemaVersion":1,"status":"completed"}`))
	view, err := h.service(nil).View(h.project, h.directory)
	if err != nil || view.Status != StatusFailed || view.Report != nil || !view.Stale {
		t.Fatalf("%+v %v", view, err)
	}
	if string(readFile(t, latest)) != `{"schemaVersion":1,"status":"completed"}` {
		t.Fatal("просмотр переписал повреждённый файл")
	}
}

// TestCancelStopsBeforeAgent — отмена во время подготовки не создаёт задание агента даже после
// того, как инструмент завершился; отмена задания вызывает менеджер.
func TestCancelStopsBeforeAgent(t *testing.T) {
	h := newHarness(t)
	h.block()
	review := h.service(nil)
	if _, err := review.Start(h.project, h.directory); err != nil {
		t.Fatal(err)
	}
	view, err := review.Cancel(h.project, h.directory)
	if err != nil || view.Status != StatusCancelled || view.CanStart {
		t.Fatalf("%+v %v", view, err)
	}
	h.open()
	review.Shutdown()
	if len(h.agents.starts) != 0 {
		t.Fatal("после отмены запущен агент")
	}
	if view, err := review.View(h.project, h.directory); err != nil || view.Status != StatusCancelled || !view.CanStart {
		t.Fatalf("%+v %v", view, err)
	}
	if _, err := review.Start(h.project, h.directory); err != nil {
		t.Fatal(err)
	}
	h.wait(review, StatusRunning)
	view, err = review.Cancel(h.project, h.directory)
	if err != nil || view.Status != StatusCancelled || deref(view.Error) != textCancelled {
		t.Fatalf("%+v %v", view, err)
	}
	if job, _ := h.agents.Get(h.agents.order[0]); job.Status != "cancelled" {
		t.Fatalf("задание агента не отменено: %s", job.Status)
	}
}

// TestBusyPackageRejectsStart — занятый пакет, идущая подготовка или задание агента проекта
// запрещают новый запуск без записи latest.json.
func TestBusyPackageRejectsStart(t *testing.T) {
	h := newHarness(t)
	h.busy = true
	review := h.service(nil)
	if _, err := review.Start(h.project, h.directory); err == nil || err.Error() != textBusy {
		t.Fatalf("ожидался отказ «занято»: %v", err)
	}
	if _, err := os.Stat(filepath.Join(h.directory, "video-review")); err == nil {
		t.Fatal("отказ создал папку проверки")
	}
	h.busy = false
	h.block()
	if _, err := review.Start(h.project, h.directory); err != nil {
		t.Fatal(err)
	}
	if _, err := review.Start(h.project, h.directory); err == nil || err.Error() != textBusy {
		t.Fatalf("второй запуск: %v", err)
	}
	h.open()
	h.wait(review, StatusRunning)
	if _, err := review.Start(h.project, h.directory); err == nil || err.Error() != textBusy {
		t.Fatalf("запуск при задании агента: %v", err)
	}
	if len(h.agents.starts) != 1 {
		t.Fatalf("запусков агента %d", len(h.agents.starts))
	}
}

// TestBudgetRejectedBeforeProcesses — неверный бюджет и пути отклоняются до запуска FFmpeg.
func TestBudgetRejectedBeforeProcesses(t *testing.T) {
	dir := t.TempDir()
	video := filepath.Join(dir, "video.mkv")
	writeFile(t, video, []byte("x"))
	missing := Tools{FFmpeg: filepath.Join(dir, "нет-ffmpeg"), FFprobe: filepath.Join(dir, "нет-ffprobe")}
	for _, budget := range []int{0, -1, DefaultImageBudget + 1} {
		_, err := Extract(context.Background(), ExtractInput{Tools: missing, Video: video, Out: filepath.Join(dir, "out"), BudgetBytes: budget})
		if err == nil || err.Error() != textFramesPrefix+textBudgetRange {
			t.Fatalf("бюджет %d: %v", budget, err)
		}
	}
	if _, err := os.Stat(filepath.Join(dir, "out")); err == nil {
		t.Fatal("результат создан")
	}
	// Бюджет передаётся подготовке как есть: выбранный CLI задаёт свою долю.
	h := newHarness(t)
	review := h.service(intPointer(agents.Providers[agents.Claude].ReviewImageBudgetBytes))
	if _, err := review.Start(h.project, h.directory); err != nil {
		t.Fatal(err)
	}
	h.wait(review, StatusRunning)
	if args, _ := h.toolCalls[0]["args"].([]any); args[6] != "6291456" || len(h.agents.starts[0].Images) != 5 {
		t.Fatalf("бюджет %v, изображений %d", args[6], len(h.agents.starts[0].Images))
	}
}

// TestRealFramesThroughService — сквозная проверка на настоящем FFmpeg: шумовые кадры больше
// прежних 20 МиБ PNG упаковываются в бюджет, агент получает все 21 кадр и 2 опоры с реальными PTS,
// исходники и workflow.json не меняются, видео не принимается.
func TestRealFramesThroughService(t *testing.T) {
	tools := mediaTools(t)
	h := newHarness(t)
	for _, path := range h.references {
		if output, err := exec.Command(tools.FFmpeg, "-v", "error", "-nostdin", "-y", "-f", "lavfi", "-i", "color=c=gray:s=960x540,noise=alls=100:allf=t+u",
			"-frames:v", "1", "-pix_fmt", "rgb24", path).CombinedOutput(); err != nil {
			t.Fatalf("%v %s", err, output)
		}
	}
	if output, err := exec.Command(tools.FFmpeg, "-v", "error", "-nostdin", "-y", "-f", "lavfi", "-i", "color=c=gray:s=960x540:r=2,noise=alls=100:allf=t+u",
		"-frames:v", "21", "-c:v", "ffv1", "-f", "matroska", h.original).CombinedOutput(); err != nil {
		t.Fatalf("%v %s", err, output)
	}
	before := map[string]string{}
	for _, path := range append([]string{h.original, filepath.Join(h.directory, "workflow.json")}, h.references...) {
		before[path] = fileSHA(t, path)
	}
	review := New(Options{Agents: h.agents, Tools: func() (Tools, bool) { return tools, true }, Brief: h.brief})
	h.services = append(h.services, review)
	if _, err := review.Start(h.project, h.directory); err != nil {
		t.Fatal(err)
	}
	for attempt := 0; ; attempt++ {
		view, err := review.View(h.project, h.directory)
		if err != nil || attempt > 600 {
			t.Fatalf("%+v %v", view, err)
		}
		if view.Status == StatusRunning {
			break
		}
		if view.Status != StatusPreparing {
			t.Fatalf("подготовка завершилась %s: %v", view.Status, deref(view.Error))
		}
		time.Sleep(50 * time.Millisecond)
	}
	complete(h, 0, reportJSON())
	view, err := review.View(h.project, h.directory)
	if err != nil || view.Status != StatusCompleted || view.Stale || *view.DurationSeconds != 10.5 {
		t.Fatalf("%+v %v", view, err)
	}
	if len(view.Frames) != 21 {
		t.Fatalf("кадров %d", len(view.Frames))
	}
	for index, frame := range view.Frames {
		if frame.TimeSeconds != float64(index)/2 {
			t.Fatalf("кадр %s: %v", frame.ID, frame.TimeSeconds)
		}
	}
	images := h.agents.starts[0].Images
	total := int64(0)
	jpegs := 0
	for _, path := range images {
		info, err := os.Stat(path)
		if err != nil || info.Size() == 0 || info.Size() > 5*1024*1024 {
			t.Fatalf("%s: %v", path, err)
		}
		total += info.Size()
		if strings.HasSuffix(path, ".jpg") {
			jpegs++
		}
	}
	if len(images) != 23 || jpegs == 0 || total > DefaultImageBudget {
		t.Fatalf("изображений %d, JPEG %d, байт %d", len(images), jpegs, total)
	}
	for path, digest := range before {
		if fileSHA(t, path) != digest {
			t.Fatalf("%s изменён", path)
		}
	}
	if _, err := os.Stat(filepath.Join(h.project, "assets")); err == nil {
		t.Fatal("проверка приняла видео")
	}
}
