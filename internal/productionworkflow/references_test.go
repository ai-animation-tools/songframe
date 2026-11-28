package productionworkflow

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"songframe/internal/dynvalue"
	"songframe/internal/production"
	"songframe/resources"
)

const (
	refsFrame = "plan/batches/M02-attempt-01/continuity/M01-last.png"
	refsMira  = "source/heroes/mira.png"
	refsLev   = "source/heroes/lev.png"
	refsBoat  = "source/vehicles/boat.png"
)

// refsRules — правила описания по референсам плана с окном 4 с: кадр предшественника и
// изображения Миры, Льва и лодки допустимы, предел — три картинки.
func refsRules() Rules {
	return Rules{
		Stage: "description", WindowSeconds: 4, DurationRule: "min_supported_strictly_greater_than_window",
		AllowedPaths: []string{refsFrame, refsMira, refsLev, refsBoat, "source/locations/pier.png"},
		References:   true, MaxReferences: 3, ReferenceEntities: []string{"mira", "lev", "boat"},
	}
}

func refItem(id, role, entity, path string) string {
	text := `{"id":"` + id + `","role":"` + role + `"`
	if entity != "" {
		text += `,"entity":"` + entity + `"`
	}
	return text + `,"path":"` + path + `"}`
}

// parseRefs разбирает ответ описания по референсам с картинками items.
func parseRefs(rules Rules, seconds string, items ...string) error {
	_, err := ParseProposal(refsAnswer(seconds, strings.Join(items, ",")), rules)
	return err
}

// TestParseReferences — разбор ответа описания по референсам: верный ответ принимается, ошибки ID,
// ролей, путей, сущностей, повторов, числа картинок, длительности и лишних ключей отклоняются.
func TestParseReferences(t *testing.T) {
	rules := refsRules()
	start := refItem("R01", "start", "", refsFrame)
	mira := refItem("R02", "entity", "mira", refsMira)
	if err := parseRefs(rules, "9", start, mira, refItem("R03", "entity", "boat", refsBoat)); err != nil {
		t.Fatalf("верный ответ: %v", err)
	}
	if err := parseRefs(rules, "9", refItem("R01", "entity", "mira", refsMira)); err != nil {
		t.Fatalf("одна картинка сущности без начала: %v", err)
	}
	invalid := map[string][]string{
		"ID не по порядку":        {start, refItem("R03", "entity", "mira", refsMira)},
		"ID с первого не R01":     {refItem("R02", "entity", "mira", refsMira)},
		"start не первый":         {mira, refItem("R02", "start", "", refsFrame)},
		"start не кадр плана":     {refItem("R01", "start", "", refsMira)},
		"start с сущностью":       {refItem("R01", "start", "mira", refsFrame)},
		"сущности нет в плане":    {start, refItem("R02", "entity", "pier", "source/locations/pier.png")},
		"entity без кода":         {start, refItem("R02", "entity", "", refsMira)},
		"путь вне allowedPaths":   {start, refItem("R02", "entity", "mira", "source/heroes/other.png")},
		"путь не изображение":     {start, refItem("R02", "entity", "mira", "source/text.md")},
		"неизвестная роль":        {start, refItem("R02", "place", "mira", refsMira)},
		"картинка не объект":      {start, `"R02"`},
		"нет пути":                {start, `{"id":"R02","role":"entity","entity":"mira"}`},
		"путь не строка":          {start, `{"id":"R02","role":"entity","entity":"mira","path":5}`},
		"ID не строка":            {`{"id":1,"role":"entity","entity":"mira","path":"` + refsMira + `"}`},
		"роль не строка":          {`{"id":"R01","role":3,"entity":"mira","path":"` + refsMira + `"}`},
		"сущность не строка":      {start, `{"id":"R02","role":"entity","entity":4,"path":"` + refsMira + `"}`},
		"ID из одной цифры":       {refItem("R1", "entity", "mira", refsMira)},
		"неотрицательный индекс":  {start, refItem("R00", "entity", "mira", refsMira)},
		"тот же ID повторён":      {start, refItem("R01", "entity", "mira", refsMira)},
		"ID с лишними символами":  {refItem("R01 ", "entity", "mira", refsMira)},
		"ID в нижнем регистре":    {refItem("r01", "entity", "mira", refsMira)},
		"сущность другого плана":  {refItem("R01", "entity", "world", refsMira)},
		"путь с обратным слэшем":  {refItem("R01", "entity", "mira", `source\\heroes\\mira.png`)},
		"путь на другое место":    {refItem("R01", "entity", "mira", "source/heroes/../heroes/mira.png")},
		"роль в верхнем регистре": {refItem("R01", "ENTITY", "mira", refsMira)},
	}
	for name, items := range invalid {
		if err := parseRefs(rules, "9", items...); err == nil || err.Error() != textReferencesInvalid {
			t.Errorf("%s: %v", name, err)
		}
	}
	if err := parseRefs(rules, "9", start, mira, refItem("R03", "entity", "mira", refsMira)); err == nil || err.Error() != textReferencesDuplicate {
		t.Errorf("одна картинка дважды: %v", err)
	}
	if err := parseRefs(rules, "9", start, `{"id":"R02","role":"entity","entity":"mira","path":"`+refsMira+`","note":"x"}`); err == nil {
		t.Error("лишний ключ в картинке принят")
	}
	over := []string{start, mira, refItem("R03", "entity", "lev", refsLev), refItem("R04", "entity", "boat", refsBoat)}
	if err := parseRefs(rules, "9", over...); err == nil || err.Error() != textReferencesCount {
		t.Errorf("больше предела: %v", err)
	}
	if err := parseRefs(rules, "9"); err == nil || err.Error() != textReferencesCount {
		t.Errorf("без картинок: %v", err)
	}
	// Предел 0 в записи правил — предел по умолчанию.
	wide := rules
	wide.MaxReferences = 0
	if err := parseRefs(wide, "9", over...); err != nil {
		t.Errorf("предел по умолчанию: %v", err)
	}
	if err := parseRefs(rules, "4", start); err == nil || err.Error() != textDurationRuleViolation(4, "min_supported_strictly_greater_than_window", 4) {
		t.Errorf("длительность, равная окну: %v", err)
	}
	keyframesKey := `{"schemaVersion":1,"stage":"description","description":"Текст.","requestSeconds":9,"keyframes":[],"references":[` + start + `]}`
	if _, err := ParseProposal(keyframesKey, rules); err == nil {
		t.Error("ключ keyframes принят")
	}
	noDescription := `{"schemaVersion":1,"stage":"description","description":"","requestSeconds":9,"references":[` + start + `]}`
	if _, err := ParseProposal(noDescription, rules); err == nil || err.Error() != textDescriptionInvalid {
		t.Errorf("пустое описание: %v", err)
	}
	notArray := `{"schemaVersion":1,"stage":"description","description":"Текст.","requestSeconds":9,"references":{}}`
	if _, err := ParseProposal(notArray, rules); err == nil || err.Error() != textDescriptionInvalid {
		t.Errorf("references не массив: %v", err)
	}
	// Без режима по референсам тот же ответ — описание по опорам и ему не подходит.
	plain := rules
	plain.References = false
	if err := parseRefs(plain, "9", start); err == nil {
		t.Error("ответ по референсам принят описанием по опорам")
	}
}

// TestReferencesRulesTree — режим по референсам, предел и сущности переживают запись правил; у
// попытки по опорам этих ключей нет.
func TestReferencesRulesTree(t *testing.T) {
	rules := refsRules()
	got := RulesFromTree(rules.Tree())
	if !got.References || got.MaxReferences != 3 || !slices.Equal(got.ReferenceEntities, rules.ReferenceEntities) {
		t.Fatalf("правила: %+v", got)
	}
	plain := Rules{Stage: "description", WindowSeconds: 4}
	for _, key := range []string{"referencesMethod", "maxReferences", "referenceEntities"} {
		if plain.Tree().Has(key) {
			t.Fatalf("ключ %s у попытки по опорам", key)
		}
	}
}

// TestReferenceMarks — метки [#Rnn] находятся, сломанные записи называются, подстановка идёт по
// порядку картинок в запросе.
func TestReferenceMarks(t *testing.T) {
	text := "Начало [#R01], Мира [#R02] и снова [#R01]."
	if got := referenceMarks(text); !slices.Equal(got, []string{"R01", "R02"}) {
		t.Fatalf("метки: %v", got)
	}
	if got := brokenReferenceMark(text); got != "" {
		t.Fatalf("целые метки названы сломанными: %q", got)
	}
	for _, broken := range []string{"Мира [# R01]", "Мира [#R1]", "Мира [#]", "Мира [ #R01]"} {
		if brokenReferenceMark(broken) == "" {
			t.Errorf("сломанная метка не найдена: %q", broken)
		}
	}
	mention := func(index int) string { return "IMG" + dynvalue.NumberToString(float64(index+1)) }
	got := replaceReferenceMarks(text+" [#R09]", []string{"R02", "R01"}, mention)
	if got != "Начало IMG2, Мира IMG1 и снова IMG2. [#R09]" {
		t.Fatalf("подстановка: %q", got)
	}
}

// refsApprovedAttempt доводит план shot до принятого описания по референсам и утверждённых
// референсов: попытка в состоянии, из которого следует видеопромпт. Возвращает путь попытки.
func refsApprovedAttempt(t *testing.T, run *goldenRun, workflow *Workflow, shot string) string {
	t.Helper()
	refsStart(t, run, workflow, shot)
	answer := refsAnswer("9", strings.Join([]string{
		refItem("R01", "start", "", refsFrame), refItem("R02", "entity", "mira", refsMira), refItem("R03", "entity", "boat", refsBoat),
	}, ","))
	view := refsFinish(t, run, workflow, shot, answer)
	decideApprove(t, run, *view.PackageDir)
	if _, err := workflow.ApproveReferences(run.project, shot, *view.PackageDir); err != nil {
		t.Fatal(err)
	}
	return *view.PackageDir
}

// decideApprove утверждает описание попытки dir решением пользователя.
func decideApprove(t *testing.T, run *goldenRun, dir string) {
	t.Helper()
	pkg, err := production.ReadPackage(run.project, dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := production.New(production.Options{}).Decide(run.project, dir, "approve", "", pkg.DecisionToken, "", ""); err != nil {
		t.Fatalf("утверждение описания: %v", err)
	}
}

// workflowOf — workflow.json попытки (путь от проекта или полный).
func workflowOf(t *testing.T, run *goldenRun, dir string) *dynvalue.Object {
	t.Helper()
	value, err := readJSON(filepath.Join(fullDir(run, dir), "workflow.json"))
	if err != nil {
		t.Fatal(err)
	}
	return value.(*dynvalue.Object)
}

// TestStartReferencesRefusals — способ «По референсам» недоступен речевому плану, плану из опор,
// провайдеру без режима и сочетанию с числом опор; другой способ у не-prepare запуска — ошибка.
func TestStartReferencesRefusals(t *testing.T) {
	run := ownRun(t)
	workflow := refsWorkflow(t, run)
	start := func(input StartInput) error {
		input.Project = run.project
		_, err := workflow.Start(context.Background(), input)
		return err
	}
	if err := start(StartInput{Shot: "M04", Action: "prepare", Method: "references"}); err == nil || err.Error() != textReferencesPlanKind {
		t.Fatalf("речевой план: %v", err)
	}
	scenes := filepath.Join(run.project, "plan", "scenes.json")
	data, err := os.ReadFile(scenes)
	if err != nil {
		t.Fatal(err)
	}
	text := strings.Replace(string(data), `"id": "M03"`, `"static_shot": true, "id": "M03"`, 1)
	if text == string(data) {
		t.Fatal("в scenes.json не нашлась строка плана M03")
	}
	if err := os.WriteFile(scenes, []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := start(StartInput{Shot: "M03", Action: "prepare", Method: "references"}); err == nil || err.Error() != textReferencesPlanKind {
		t.Fatalf("план из опор: %v", err)
	}
	if err := start(StartInput{Shot: "M02", Action: "prepare", Method: "other"}); err == nil || err.Error() != textReferencesMethodInvalid {
		t.Fatalf("неизвестный способ: %v", err)
	}
	zero := 0
	two := 2
	if err := start(StartInput{Shot: "M02", Action: "prepare", Method: "references", Keyframes: &two}); err == nil || err.Error() != textReferencesKeyframes {
		t.Fatalf("число опор: %v", err)
	}
	if err := start(StartInput{Shot: "M02", Action: "prepare", Method: "references", Keyframes: &zero}); err != nil {
		t.Fatalf("«авто» у способа по референсам: %v", err)
	}
	// Адаптер без режима по референсам: способ не предлагается.
	plain := ownRun(t)
	if err := plainStart(plain); err == nil || err.Error() != textReferencesUnavailable {
		t.Fatalf("адаптер без режима: %v", err)
	}
}

// plainStart запускает описание по референсам у проекта с обычным адаптером (requestRules).
func plainStart(run *goldenRun) error {
	_, err := run.workflow.Start(context.Background(), StartInput{Project: run.project, Shot: "M02", Action: "prepare", Method: "references"})
	return err
}

// TestStartReferencesTask — задание описания по референсам: правила с режимом и пределом по слотам
// модели, часть скилла и контракт в промпте, referencesVideo в контексте, из команд — только режим по
// референсам.
func TestStartReferencesTask(t *testing.T) {
	run := ownRun(t)
	workflow := refsWorkflow(t, run)
	view, err := workflow.View(run.project, "M02", "")
	if err != nil || !view.ReferencesAvailable {
		t.Fatalf("способ предлагается: %v %v", view.ReferencesAvailable, err)
	}
	rules := refsStart(t, run, workflow, "M02")
	if !rules.References || rules.MaxReferences != 3 || !slices.Equal(rules.ReferenceEntities, []string{"mira", "lev", "boat"}) {
		t.Fatalf("правила: %+v", rules)
	}
	tree := workflow.store.Read(run.project, "M02").Tree.Value("rules")
	if dynvalue.Get(tree, "referencesMethod") != true {
		t.Fatalf("дерево правил: %s", dynvalue.Stringify(tree))
	}
	if !slices.Contains(rules.AllowedPaths, refsFrame) {
		t.Fatalf("кадр предшественника не в allowedPaths: %v", rules.AllowedPaths)
	}
	task := run.agents.starts[0]
	skill, err := resources.SkillFile(resources.SkillScene, "references/references-video.md")
	if err != nil || strings.TrimSpace(skill) == "" {
		t.Fatalf("часть скилла: %v", err)
	}
	if !strings.Contains(task.Prompt, strings.TrimSpace(skill)) || !strings.Contains(task.Prompt, referencesContract) {
		t.Fatal("в промпте нет части скилла или контракта")
	}
	context, err := dynvalue.Parse([]byte(task.Context))
	if err != nil {
		t.Fatal(err)
	}
	if dynvalue.Get(dynvalue.Get(context, "referencesVideo"), "maxImages") != float64(3) {
		t.Fatalf("referencesVideo: %v", dynvalue.Get(context, "referencesVideo"))
	}
	commands := dynvalue.Get(context, "capabilities")
	text := dynvalue.Stringify(commands)
	if !strings.Contains(text, "reference_video") || strings.Contains(text, "image_to_video") {
		t.Fatalf("команды в capabilities: %s", text)
	}
	// Обычное описание такого ключа не получает и скилла по референсам не читает.
	failed, code := run.agents.last(t), 1
	failed.Status, failed.ExitCode = "failed", &code
	if _, err := workflow.View(run.project, "M02", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := workflow.Discard(run.project, "M02", "", workflow.store.Read(run.project, "M02").ID()); err != nil {
		t.Fatal(err)
	}
	if _, err := workflow.Start(ctxBackground, StartInput{Project: run.project, Shot: "M02", Action: "prepare"}); err != nil {
		t.Fatal(err)
	}
	plain := run.agents.starts[len(run.agents.starts)-1]
	if strings.Contains(plain.Context, "referencesVideo") || strings.Contains(plain.Prompt, referencesContract) || strings.Contains(plain.Prompt, strings.TrimSpace(skill)) {
		t.Fatal("обычное описание получило данные способа по референсам")
	}
	if workflow.store.Read(run.project, "M02").Rules().References {
		t.Fatal("режим по референсам остался в правилах обычного описания")
	}
}

var ctxBackground = context.Background()

// TestApplyReferencesDescription — применение описания копирует картинки в references/, пишет
// workflow попытки и ведёт к утверждению описания; повторное применение той же попытки сохраняет
// утверждение неизменных референсов.
func TestApplyReferencesDescription(t *testing.T) {
	run := ownRun(t)
	workflow := refsWorkflow(t, run)
	refsStart(t, run, workflow, "M02")
	answer := refsAnswer("9", strings.Join([]string{
		refItem("R01", "start", "", refsFrame), refItem("R02", "entity", "mira", refsMira), refItem("R03", "entity", "boat", refsBoat),
	}, ","))
	view := refsFinish(t, run, workflow, "M02", answer)
	dir := attemptDir(run, view)
	if view.Stage == nil || *view.Stage != "description_review" {
		t.Fatalf("этап: %v", view.Stage)
	}
	document := workflowOf(t, run, dir)
	if document.Value("generation_method") != "references" {
		t.Fatalf("generation_method: %v", document.Value("generation_method"))
	}
	if keyframes, _ := dynvalue.AsArray(document.Value("keyframes")); len(keyframes) != 0 {
		t.Fatalf("опоры: %v", keyframes)
	}
	if document.Has("keyframe_count") {
		t.Fatal("keyframe_count записан")
	}
	if dynvalue.Get(document.Value("timing"), "request_seconds") != float64(9) {
		t.Fatalf("timing: %s", dynvalue.Stringify(document.Value("timing")))
	}
	references, _ := dynvalue.AsArray(document.Value("references"))
	if len(references) != 3 {
		t.Fatalf("references: %s", dynvalue.Stringify(document.Value("references")))
	}
	sources := []any{refsFrame, refsMira, refsBoat}
	roles := []string{"start", "entity", "entity"}
	for index, item := range references {
		id := "R0" + dynvalue.NumberToString(float64(index+1))
		path := "references/" + id + ".png"
		if dynvalue.Get(item, "id") != id || dynvalue.Get(item, "role") != roles[index] || dynvalue.Get(item, "path") != path ||
			dynvalue.Get(item, "source") != sources[index] || dynvalue.Get(item, "approved") != false {
			t.Fatalf("референс %d: %s", index, dynvalue.Stringify(item))
		}
		if _, err := os.Stat(filepath.Join(dir, path)); err != nil {
			t.Fatalf("копия %s: %v", path, err)
		}
		if digest := dynvalue.ToString(dynvalue.Get(item, "sha256")); len(digest) != 64 {
			t.Fatalf("sha256 референса %d: %q", index, digest)
		}
	}
	if dynvalue.Get(references[0], "entity") != nil || dynvalue.Get(references[1], "entity") != "mira" {
		t.Fatalf("сущности: %s", dynvalue.Stringify(document.Value("references")))
	}
	if data, err := os.ReadFile(filepath.Join(dir, "references", "R02.png")); err != nil {
		t.Fatal(err)
	} else if want, _ := os.ReadFile(filepath.Join(run.project, refsMira)); string(data) != string(want) {
		t.Fatal("копия R02 отличается от исходника")
	}
	if want, _ := os.ReadFile(filepath.Join(dir, "description.md")); !strings.Contains(string(want), "Герой смотрит на воду.") {
		t.Fatalf("description.md: %q", want)
	}
	if prompts, _ := os.ReadFile(filepath.Join(dir, "keyframe-prompts.json")); strings.TrimSpace(string(prompts)) != "[]" {
		t.Fatalf("keyframe-prompts.json: %q", prompts)
	}
	if document.Value("stage") != "description_review" || dynvalue.Get(document.Value("pending_decision"), "stage") != "description_review" {
		t.Fatalf("вопрос описания: %s", dynvalue.Stringify(document.Value("pending_decision")))
	}

	// Описание утверждено, референсы утверждены; доработка описания с другим R03 в той же попытке
	// оставляет утверждёнными неизменные R01 и R02.
	decideApprove(t, run, *view.PackageDir)
	if _, err := workflow.ApproveReferences(run.project, "M02", *view.PackageDir); err != nil {
		t.Fatal(err)
	}
	note := "Лев вместо лодки"
	stage := "description"
	if _, err := workflow.Start(ctxBackground, StartInput{Project: run.project, Shot: "M02", PackageDir: *view.PackageDir, Action: "revise", Stage: &stage, Note: &note}); err != nil {
		t.Fatalf("доработка описания: %v", err)
	}
	second := refsAnswer("10", strings.Join([]string{
		refItem("R01", "start", "", refsFrame), refItem("R02", "entity", "mira", refsMira), refItem("R03", "entity", "lev", refsLev),
	}, ","))
	job := run.agents.last(t)
	job.Result, job.Status = second, "completed"
	code := 0
	job.ExitCode = &code
	if _, err := workflow.View(run.project, "M02", *view.PackageDir); err != nil {
		t.Fatal(err)
	}
	if _, err := workflow.Apply(ctxBackground, run.project, "M02", *view.PackageDir, workflow.store.Read(run.project, "M02").ID()); err != nil {
		t.Fatal(err)
	}
	references, _ = dynvalue.AsArray(workflowOf(t, run, dir).Value("references"))
	approved := []bool{}
	for _, item := range references {
		approved = append(approved, dynvalue.Get(item, "approved") == true)
	}
	if !slices.Equal(approved, []bool{true, true, false}) {
		t.Fatalf("утверждения после доработки: %v (%s)", approved, dynvalue.Stringify(workflowOf(t, run, dir).Value("references")))
	}
}

// refsDescribed доводит план до принятого и утверждённого описания по референсам; референсы ещё не
// утверждены. Возвращает путь попытки от проекта.
func refsDescribed(t *testing.T, run *goldenRun, workflow *Workflow, shot string) string {
	t.Helper()
	refsStart(t, run, workflow, shot)
	answer := refsAnswer("9", strings.Join([]string{
		refItem("R01", "start", "", refsFrame), refItem("R02", "entity", "mira", refsMira), refItem("R03", "entity", "boat", refsBoat),
	}, ","))
	view := refsFinish(t, run, workflow, shot, answer)
	decideApprove(t, run, *view.PackageDir)
	return *view.PackageDir
}

// refsPrompt запускает этап видеопромпта попытки dir, завершает его ответом prompt и применяет.
func refsPrompt(t *testing.T, run *goldenRun, workflow *Workflow, dir, prompt string) (View, error) {
	t.Helper()
	if _, err := workflow.Start(ctxBackground, StartInput{Project: run.project, Shot: "M02", PackageDir: dir, Action: "continue"}); err != nil {
		t.Fatalf("запуск видеопромпта: %v", err)
	}
	job := run.agents.last(t)
	job.Result, job.Status = `{"schemaVersion":1,"stage":"prompt","prompt":`+dynvalue.Stringify(prompt)+`}`, "completed"
	code := 0
	job.ExitCode = &code
	if _, err := workflow.View(run.project, "M02", dir); err != nil {
		return View{}, err
	}
	return workflow.Apply(ctxBackground, run.project, "M02", dir, workflow.store.Read(run.project, "M02").ID())
}

// TestEditReferences — референсы меняются после утверждения описания и до видеопромпта: до
// утверждения, при предложении и после видеопромпта правка отказывает; последний референс не убрать,
// чужой ID и не изображение отклоняются.
func TestEditReferences(t *testing.T) {
	run := ownRun(t)
	workflow := refsWorkflow(t, run)
	refsStart(t, run, workflow, "M02")
	answer := refsAnswer("9", strings.Join([]string{
		refItem("R01", "start", "", refsFrame), refItem("R02", "entity", "mira", refsMira), refItem("R03", "entity", "boat", refsBoat),
	}, ","))
	view := refsFinish(t, run, workflow, "M02", answer)
	dir := *view.PackageDir
	if view.CanEditReferences || view.Reasons.References == nil || *view.Reasons.References != textResolvePackageQuestionFirst {
		t.Fatalf("до утверждения описания: %v %v", view.CanEditReferences, view.Reasons.References)
	}
	if _, err := workflow.ApproveReferences(run.project, "M02", dir); err == nil || err.Error() != textResolvePackageQuestionFirst {
		t.Fatalf("утверждение до описания: %v", err)
	}
	decideApprove(t, run, dir)
	if view, err := workflow.View(run.project, "M02", dir); err != nil || !view.CanEditReferences || view.Reasons.References != nil {
		t.Fatalf("после утверждения описания: %v %v", view.CanEditReferences, err)
	}
	if _, err := workflow.RemoveReference(run.project, "M02", dir, "R09"); err == nil || err.Error() != textReferenceMissing {
		t.Fatalf("чужой ID: %v", err)
	}
	if _, err := workflow.RemoveReference(run.project, "M02", dir, "R02"); err != nil {
		t.Fatal(err)
	}
	document := workflowOf(t, run, dir)
	items, _ := dynvalue.AsArray(document.Value("references"))
	ids := []any{}
	for _, item := range items {
		ids = append(ids, dynvalue.Get(item, "id"))
	}
	if !slices.Equal(ids, []any{"R01", "R03"}) {
		t.Fatalf("после удаления R02: %v", ids)
	}
	// Файл убранного референса остаётся в папке попытки: его не удаляют, запрос его не берёт.
	if _, err := os.Stat(filepath.Join(fullDir(run, dir), "references", "R02.png")); err != nil {
		t.Fatalf("копия убранного референса: %v", err)
	}
	if _, err := workflow.RemoveReference(run.project, "M02", dir, "R01"); err != nil {
		t.Fatal(err)
	}
	if _, err := workflow.RemoveReference(run.project, "M02", dir, "R03"); err == nil || err.Error() != textReferenceLast {
		t.Fatalf("последний референс: %v", err)
	}

	// Замена своим файлом внутри проекта: утверждён сразу, исходный путь сохранён; PNG снаружи
	// проекта — без исходного пути; не изображение отклоняется.
	inside := filepath.Join(run.project, writePNG(t, run.project, "assets/own.png", "inside"))
	if _, err := workflow.ReplaceReference(run.project, "M02", dir, "R03", inside); err != nil {
		t.Fatal(err)
	}
	item := workflowReference(t, run, dir, "R03")
	if item.Value("approved") != true || item.Value("source") != "assets/own.png" || item.Value("path") != "references/R03.png" {
		t.Fatalf("замена внутри проекта: %s", dynvalue.Stringify(item))
	}
	if data, _ := os.ReadFile(filepath.Join(fullDir(run, dir), "references", "R03.png")); !strings.HasSuffix(string(data), "inside") {
		t.Fatalf("копия R03: %q", data)
	}
	outside := filepath.Join(t.TempDir(), "outside.png")
	if err := os.WriteFile(outside, append(append([]byte{}, pngSignature...), "outside"...), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := workflow.ReplaceReference(run.project, "M02", dir, "R03", outside); err != nil {
		t.Fatal(err)
	}
	item = workflowReference(t, run, dir, "R03")
	if item.Has("source") || item.Value("approved") != true {
		t.Fatalf("замена снаружи проекта: %s", dynvalue.Stringify(item))
	}
	notImage := filepath.Join(t.TempDir(), "note.txt")
	if err := os.WriteFile(notImage, []byte("текст"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := workflow.ReplaceReference(run.project, "M02", dir, "R03", notImage); err == nil || err.Error() != textReferenceImageRequired {
		t.Fatalf("не изображение: %v", err)
	}
	if _, err := workflow.ReplaceReference(run.project, "M02", dir, "R03", "assets/own.png"); err == nil {
		t.Fatal("относительный путь принят")
	}
	if _, err := workflow.ReplaceReference(run.project, "M02", dir, "R07", inside); err == nil || err.Error() != textReferenceMissing {
		t.Fatalf("замена чужого ID: %v", err)
	}
}

// workflowReference — запись референса id из workflow.json попытки dir.
func workflowReference(t *testing.T, run *goldenRun, dir, id string) *dynvalue.Object {
	t.Helper()
	items, _ := dynvalue.AsArray(workflowOf(t, run, dir).Value("references"))
	for _, item := range items {
		if dynvalue.Get(item, "id") == id {
			return item.(*dynvalue.Object)
		}
	}
	t.Fatalf("референса %s нет", id)
	return nil
}

// TestReferencesMethodFixed — способ попытки выбирается до описания: доработка описания с другим
// способом отказывает, с тем же или без выбора проходит.
func TestReferencesMethodFixed(t *testing.T) {
	run := ownRun(t)
	workflow := refsWorkflow(t, run)
	dir := refsDescribed(t, run, workflow, "M02")
	stage, note := "description", "короче"
	revise := func(method string) error {
		_, err := workflow.Start(ctxBackground, StartInput{Project: run.project, Shot: "M02", PackageDir: dir, Action: "revise", Stage: &stage, Note: &note, Method: method})
		return err
	}
	if err := revise("keyframes"); err == nil || err.Error() != textReferencesMethodFixed {
		t.Fatalf("другой способ: %v", err)
	}
	if err := revise("references"); err != nil {
		t.Fatalf("тот же способ: %v", err)
	}
	if !workflow.store.Read(run.project, "M02").Rules().References {
		t.Fatal("доработка потеряла режим по референсам")
	}
}

// TestReferencesAfterApprove — после утверждения референсов попытка идёт к видеопромпту: вид несёт
// способ, возможность правки и картинки пакета; метки видеопромпта с чужим ID и с ошибкой записи
// отклоняются; после предложения и утверждения промпта референсы не меняются.
func TestReferencesAfterApprove(t *testing.T) {
	run := ownRun(t)
	workflow := refsWorkflow(t, run)
	dir := refsApprovedAttempt(t, run, workflow, "M02")
	view, err := workflow.View(run.project, "M02", dir)
	if err != nil {
		t.Fatal(err)
	}
	if view.GenerationMethod != "references" || !view.ReferencesAvailable || !view.CanEditReferences || view.Reasons.References != nil {
		t.Fatalf("вид: способ %q, доступно %v, правка %v", view.GenerationMethod, view.ReferencesAvailable, view.CanEditReferences)
	}
	c, err := ReadContext(run.project, "M02", dir)
	if err != nil {
		t.Fatal(err)
	}
	if next, err := c.StageFor(); err != nil || next != "prompt" {
		t.Fatalf("следующий этап: %q %v", next, err)
	}
	if approved, err := c.FramesApproved(); err != nil || !approved {
		t.Fatalf("референсы утверждены: %v %v", approved, err)
	}
	pkg, err := production.ReadPackage(run.project, dir)
	if err != nil {
		t.Fatal(err)
	}
	if pkg.GenerationMethod != "references" || len(pkg.References) != 3 || !pkg.References[0].Approved || pkg.References[0].ImagePath == nil || len(pkg.Keyframes) != 0 {
		t.Fatalf("пакет: %+v", pkg.References)
	}

	// Задание видеопромпта получает утверждённые референсы с их ID.
	if _, err := workflow.Start(ctxBackground, StartInput{Project: run.project, Shot: "M02", PackageDir: dir, Action: "continue"}); err != nil {
		t.Fatal(err)
	}
	task := run.agents.starts[len(run.agents.starts)-1]
	context, err := dynvalue.Parse([]byte(task.Context))
	if err != nil {
		t.Fatal(err)
	}
	attached, _ := dynvalue.AsArray(dynvalue.Get(context, "attachedReferences"))
	if len(attached) != 3 || dynvalue.Get(attached[0], "id") != "R01" || dynvalue.Get(attached[1], "name") != "Мира" || dynvalue.Get(attached[0], "attached") != true {
		t.Fatalf("attachedReferences: %s", dynvalue.Stringify(dynvalue.Get(context, "attachedReferences")))
	}
	if len(task.Images) < 3 || !strings.HasSuffix(task.Images[0], "reference-R01.jpg") || !strings.HasSuffix(task.Images[2], "reference-R03.jpg") {
		t.Fatalf("картинок задания: %v", task.Images)
	}
	if view, err := workflow.View(run.project, "M02", dir); err != nil || view.CanEditReferences || view.Reasons.References == nil {
		t.Fatalf("правка при заданном видеопромпте: %v %+v", err, view.Reasons.References)
	}
	if _, err := workflow.RemoveReference(run.project, "M02", dir, "R02"); err == nil {
		t.Fatal("референс убран при заданном видеопромпте")
	}
}

// TestReferencePromptMarks — применение видеопромпта отклоняет метку с неизвестным ID и метку с
// ошибкой записи (в промпте и в переводе); верный промпт принимается, а после него референсы
// не меняются.
func TestReferencePromptMarks(t *testing.T) {
	run := ownRun(t)
	workflow := refsWorkflow(t, run)
	dir := refsApprovedAttempt(t, run, workflow, "M02")
	for _, prompt := range []string{"Камера [#R04] смотрит на воду.", "Камера [# R01] смотрит на воду.", "Камера [#R1] смотрит на воду."} {
		if _, err := refsPrompt(t, run, workflow, dir, prompt); err == nil || !strings.Contains(err.Error(), "[#") {
			t.Fatalf("%q: %v", prompt, err)
		}
		failed, code := run.agents.last(t), 1
		failed.Status, failed.ExitCode = "failed", &code
		workflow.Discard(run.project, "M02", dir, workflow.store.Read(run.project, "M02").ID())
	}
	if _, err := refsPrompt(t, run, workflow, dir, "Камера держит [#R01] и [#R02]."); err != nil {
		t.Fatal(err)
	}
	if data, _ := os.ReadFile(filepath.Join(fullDir(run, dir), "video-prompt.txt")); !strings.Contains(string(data), "[#R02]") {
		t.Fatalf("video-prompt.txt: %q", data)
	}
	if _, err := workflow.RemoveReference(run.project, "M02", dir, "R03"); err == nil || err.Error() != textResolvePackageQuestionFirst {
		t.Fatalf("правка при вопросе о видеопромпте: %v", err)
	}
}

// TestPrepareReferencesRequest — запрос по референсам: команда и модель режима, входы в слотах
// картинок с подписями «Начало» и именем сущности, метки промпта стали обозначениями провайдера,
// параметры режима; смена способа у такой попытки отказывает.
func TestPrepareReferencesRequest(t *testing.T) {
	run := ownRun(t)
	// Модель проекта выбрана для запроса по опорам: по референсам автоматическая сборка её не берёт.
	settings := filepath.Join(run.project, "plan", "project.json")
	data, err := os.ReadFile(settings)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(settings, []byte(strings.Replace(string(data), `"provider":"test","`, `"provider":"test","model":"test-other","`, 1)), 0o644); err != nil {
		t.Fatal(err)
	}
	workflow := refsWorkflow(t, run)
	dir := refsApprovedAttempt(t, run, workflow, "M02")
	if _, err := refsPrompt(t, run, workflow, dir, "Начинаем с [#R01]. В кадре [#R02] у [#R03]."); err != nil {
		t.Fatal(err)
	}
	decideApprove(t, run, dir)
	if _, err := workflow.RemoveReference(run.project, "M02", dir, "R03"); err == nil || err.Error() != textReferencesNotEditable {
		t.Fatalf("правка после утверждения видеопромпта: %v", err)
	}
	view, err := workflow.PrepareRequest(ctxBackground, run.project, "M02", dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	if view.Stage == nil || *view.Stage != "request_choice" {
		t.Fatalf("этап: %v", view.Stage)
	}
	folder := fullDir(run, dir)
	request := requestFile(t, folder, "request-01")
	if request.Value("command") != "reference_video" || request.Value("model") != "test-refs" {
		t.Fatalf("команда и модель: %v %v", request.Value("command"), request.Value("model"))
	}
	if got := inputSlots(request); !slices.Equal(got, []string{"image_1:Начало", "image_2:Мира", "image_3:Лодка"}) {
		t.Fatalf("входы: %v", got)
	}
	if got := dynvalue.Stringify(request.Value("parameters")); got != `{"duration":9,"resolution":"1080p","single_take":true,"sound":false}` {
		t.Fatalf("параметры: %s", got)
	}
	if got := requestPrompt(t, folder, "request-01"); got != "Начинаем с IMG1. В кадре IMG2 у IMG3." {
		t.Fatalf("промпт запроса: %q", got)
	}
	if _, err := workflow.SetGenerationMethod(run.project, "M02", dir, "manual"); err == nil || err.Error() != textReferencesManualNotAllow {
		t.Fatalf("смена способа: %v", err)
	}
}
