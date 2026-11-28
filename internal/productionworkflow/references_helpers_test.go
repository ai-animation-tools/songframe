package productionworkflow

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"testing"

	"songframe/internal/mediaadapters"
	"songframe/internal/mediaapi"
	"songframe/internal/mediatest"
	"songframe/internal/providers"
	"songframe/internal/tools"
)

// refsTestRules — правила тестового провайдера с режимом по референсам: команда reference_video,
// модель test-refs, слоты image_N и обозначение IMGN. Обычный режим по опорам объявлен как у
// requestRules.
type refsTestRules struct{ requestRules }

func (r refsTestRules) RequestRules() mediaapi.RequestRules {
	rules := r.requestRules.RequestRules()
	rules.Video.References = &mediaapi.ReferenceRules{
		Command:   "reference_video",
		Models:    []string{"test-refs"},
		ImageSlot: func(index int) string { return fmt.Sprintf("image_%d", index+1) },
		Mention:   func(index int) string { return fmt.Sprintf("IMG%d", index+1) },
		Defaults:  []mediaapi.ParameterDefault{{Name: "single_take", Values: []any{true}}, {Name: "sound", Values: []any{false}}},
	}
	return rules
}

// refsCaps — объявления: команда режима по референсам с моделью test-refs (три картинки) и
// команда по опорам с моделью test-cheap, которой референсы не касаются.
const refsCaps = `{"reports":[` +
	`{"command":"reference_video","models":{"test-refs":{"arguments":{"duration":{"allowed":["9","10"]},"resolution":{"allowed":["720p","1080p"]},"single_take":{"allowed":["true","false"]},"sound":{"allowed":["true","false"]}},` +
	`"slots":{"image_1":{"required":true},"image_2":{},"image_3":{}},"limits":{}},` +
	`"test-other":{"arguments":{"duration":{"allowed":["9"]}},"slots":{"image_1":{"required":true}},"limits":{}}}},` +
	`{"command":"image_to_video","models":{"test-cheap":{"arguments":{"duration":{"allowed":["9","10"]},"resolution":{"allowed":["1080p"]}},"slots":{"first_image":{"required":true},"tail_image":{}},"limits":{}}}}],"problems":[]}`

// refsWorkflow — проход с платным адаптером видео, объявляющим режим по референсам, и каталогом
// refsCaps; остальные инструменты настоящие.
func refsWorkflow(t *testing.T, run *goldenRun) *Workflow {
	t.Helper()
	t.Cleanup(mediaadapters.Register(mediatest.ID, refsTestRules{requestRules{Service: &mediatest.Service{Dir: t.TempDir()}}}))
	runTool := func(ctx context.Context, project, name string, args []string) (tools.Result, error) {
		if name == "media_request" && len(args) > 0 && args[0] == "capabilities" {
			code := 0
			return tools.Result{Code: &code, Stdout: refsCaps}, nil
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
		ExtractFrame:       pngExtractFrame,
	})
}

// pngExtractFrame — кадр без FFmpeg, как fakeExtractFrame, но с сигнатурой PNG: референс должен
// быть изображением.
func pngExtractFrame(_ context.Context, video, position, target string, side int) error {
	return os.WriteFile(target, append(append([]byte{}, mediatest.BuiltinPNG...), []byte(filepath.Base(filepath.Dir(video))+":"+position+":"+strconv.Itoa(side))...), 0o666)
}

// refsAnswer — ответ описания по референсам с запросом seconds секунд и списком references (JSON).
func refsAnswer(seconds string, references string) string {
	return `{"schemaVersion":1,"stage":"description","description":"Герой смотрит на воду.","requestSeconds":` + seconds + `,"references":[` + references + `]}`
}

// writePNG пишет в проект файл с сигнатурой PNG и уникальным хвостом tail и возвращает путь от проекта.
func writePNG(t *testing.T, project, rel, tail string) string {
	t.Helper()
	full := filepath.Join(project, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(full), 0o777); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(full, append(append([]byte{}, pngSignature...), []byte(tail)...), 0o664); err != nil {
		t.Fatal(err)
	}
	return rel
}

// refsStart запускает описание по референсам плана shot и возвращает правила записанного задания.
func refsStart(t *testing.T, run *goldenRun, workflow *Workflow, shot string) Rules {
	t.Helper()
	if _, err := workflow.Start(context.Background(), StartInput{Project: run.project, Shot: shot, Action: "prepare", Method: "references"}); err != nil {
		t.Fatal(err)
	}
	return workflow.store.Read(run.project, shot).Rules()
}

// refsFinish завершает последнее задание агента ответом result, разбирает его видом плана и
// применяет предложение; возвращает вид попытки.
func refsFinish(t *testing.T, run *goldenRun, workflow *Workflow, shot, result string) View {
	t.Helper()
	job := run.agents.last(t)
	job.Result, job.Status = result, "completed"
	code := 0
	job.ExitCode = &code
	if _, err := workflow.View(run.project, shot, ""); err != nil {
		t.Fatal(err)
	}
	stored := workflow.store.Read(run.project, shot)
	id, _ := stored.Proposal().Value("id").(string)
	view, err := workflow.Apply(context.Background(), run.project, shot, "", id)
	if err != nil {
		t.Fatal(err)
	}
	return view
}

// fullDir — полный путь попытки по пути из вида (от проекта или полному).
func fullDir(run *goldenRun, dir string) string {
	if filepath.IsAbs(dir) {
		return dir
	}
	return filepath.Join(run.project, filepath.FromSlash(dir))
}

// attemptDir — полный путь попытки из вида.
func attemptDir(run *goldenRun, view View) string { return fullDir(run, *view.PackageDir) }
