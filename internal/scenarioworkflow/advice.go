package scenarioworkflow

import (
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"

	"songframe/internal/agents"
	"songframe/internal/cast"
	"songframe/internal/dynvalue"
	"songframe/internal/projectfs"
	"songframe/internal/scenario"
	"songframe/internal/viewframe"
	"songframe/resources"
)

// Рекомендации по референсам: агент только читает идею, текст песни, кастинг, сценарий и опись
// изображений вместе с фактами, которые приложение считает само (в каких планах сущность, где она
// крупно, с каких сторон её снимает камера, есть ли у неё изображения), и советует, какие
// референсы подготовить: ракурсы, количество, состояния и почему. Проект он не меняет. Основной
// вход — страница «Кастинг» после сценария; без сценария, по одной идее и тексту, совет
// помечается предварительным.
//
// Совет — подсказка, а не данные клипа: запись хранится вне Git рядом с ожидающими предложениями
// (AdvicePath), с отпечатками входов, по которым вид видит, что сценарий или кастинг изменились
// после совета. Сохранить совет в файл человек может кнопкой страницы (AdviceMarkdown).
//
// Владение: запись меняется под mu Workflow, задание — у менеджера агентов. Совет, проверка и
// сценарный проход не идут одновременно: все запускаются, только когда у проекта нет работающего
// задания (busy).

// AdvicePath — запись рекомендаций по референсам относительно папки проекта, вне Git.
const AdvicePath = "plan/batches/proposals/reference-advice.json"

// AdviceTask — имя задания агента рекомендаций: по нему интерфейс относит задание к странице
// «Кастинг» (уведомления, журнал отправок).
const AdviceTask = "ai-clip-reference-advice"

// Пределы ответа агента; те же числа подставляются в промпт (advicePrompt).
const (
	adviceSummaryMaxLength = 800
	adviceItemsMax         = 40
	adviceTextMaxLength    = 800
	adviceListMax          = 8
	adviceLabelMaxLength   = 120
	adviceCountMax         = 20
)

// adviceReportKeys и adviceItemKeys — ровно эти поля в ответе агента.
var (
	adviceReportKeys = []string{"schemaVersion", "summary", "items"}
	adviceItemKeys   = []string{"entity", "name", "need", "views", "count", "states", "why", "have"}
)

// AdviceItem — пункт рекомендаций по одной сущности: Entity — ID кастинга или "" для того, чего в
// кастинге ещё нет; Views и States — ракурсы и состояния, для которых нужен свой референс.
type AdviceItem struct {
	Entity string   `json:"entity"`
	Name   string   `json:"name"`
	Need   string   `json:"need"`
	Views  []string `json:"views"`
	Count  int      `json:"count"`
	States []string `json:"states"`
	Why    string   `json:"why"`
	Have   string   `json:"have"`
}

// AdviceReport — проверенный ответ агента.
type AdviceReport struct {
	Summary string       `json:"summary"`
	Items   []AdviceItem `json:"items"`
}

// AdviceView — ReferenceAdviceView: последние рекомендации проекта и доступность новых. Status —
// те же состояния, что у проверки сценария (CheckNone, CheckRunning, CheckReady, …);
// Preliminary — совет дан без сценария; Stale — входы изменились после совета.
type AdviceView struct {
	Status      string        `json:"status"`
	Job         *AgentJob     `json:"job"`
	Report      *AdviceReport `json:"report"`
	Message     *string       `json:"message"`
	Preliminary bool          `json:"preliminary"`
	Stale       bool          `json:"stale"`
	CanStart    bool          `json:"canStart"`
	Reason      *string       `json:"reason"`
}

// adviceRecord — запись рекомендаций (schemaVersion 1): status, jobId, preliminary, entities
// (ID кастинга, на которые может ссылаться ответ), hashes (отпечатки входов), report и message.
type adviceRecord struct{ doc *dynvalue.Object }

func (r *adviceRecord) status() string { text, _ := r.doc.Value("status").(string); return text }

// readAdvice — запись рекомендаций проекта; nil — записи нет или она не читается.
func readAdvice(project string) *adviceRecord {
	data, err := os.ReadFile(filepath.Join(project, filepath.FromSlash(AdvicePath)))
	if err != nil {
		return nil
	}
	value, err := dynvalue.Parse(data)
	doc, ok := dynvalue.AsObject(value)
	if err != nil || !ok || !dynvalue.StrictEqual(doc.Value("schemaVersion"), 1.0) || !slices.Contains(checkStatuses, dynvalue.ToString(doc.Value("status"))) {
		return nil
	}
	return &adviceRecord{doc: doc}
}

// writeAdvice — запись через шлюз записи проекта (вне Git, рядом с ожидающими предложениями).
func writeAdvice(project string, record *adviceRecord) error {
	if err := projectfs.CheckWrite(project); err != nil {
		return err
	}
	return projectfs.WriteFile(filepath.Join(project, filepath.FromSlash(AdvicePath)), []byte(dynvalue.StringifyIndent(record.doc, "  ")+"\n"), 0o666)
}

// report — сохранённый ответ; nil, если его нет или он не читается.
func (r *adviceRecord) report() *AdviceReport {
	value := r.doc.Value("report")
	if value == nil || value == dynvalue.Undefined {
		return nil
	}
	report, err := parseAdviceReport(dynvalue.Stringify(value), r.entities())
	if err != nil {
		return nil
	}
	return &report
}

// entities — ID кастинга на момент запуска.
func (r *adviceRecord) entities() []string {
	result := []string{}
	for _, item := range arrayItems(r.doc.Value("entities")) {
		result = append(result, dynvalue.ToString(item))
	}
	return result
}

// AdviceView — scenarioWorkflow.adviceView: последние рекомендации с учётом итога задания агента.
func (w *Workflow) AdviceView(project string) (AdviceView, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	view, _, err := w.adviceView(project)
	return view, err
}

// adviceView — вид под mu: итог завершившегося задания записывается, затем считается доступность.
func (w *Workflow) adviceView(project string) (AdviceView, *inputs, error) {
	input, err := readInputs(project)
	if err != nil {
		return AdviceView{}, nil, err
	}
	view := AdviceView{Status: CheckNone, Preliminary: input.documents.Scenes == nil}
	if record := readAdvice(input.project); record != nil {
		job, err := w.refreshAdvice(input.project, record)
		if err != nil {
			return AdviceView{}, nil, err
		}
		view.Status = record.status()
		view.Job = job
		view.Report = record.report()
		view.Preliminary = record.doc.Value("preliminary") == true
		if text, ok := record.doc.Value("message").(string); ok && text != "" {
			view.Message = &text
		}
		view.Stale = !hashesFrom(record.doc.Value("hashes")).matches(checkHashes(input))
	}
	reason := ""
	switch {
	case w.busy(input.project):
		reason = textAdviceBusy
	case input.documents.Scenes == nil && (!sourceTextPresent(input.project, "source/text.md") || !ideaPresent(input)):
		reason = textAdviceNoInputs
	case input.documents.Scenes != nil && !input.scenesValid:
		reason = textAdviceScenarioInvalid
	}
	view.CanStart = reason == ""
	if reason != "" {
		view.Reason = &reason
	}
	return view, input, nil
}

// ideaPresent — в описи исходников есть непустая идея клипа.
func ideaPresent(input *inputs) bool {
	text, err := readText(input.project, "source", dynvalue.ToString(dynvalue.GetPath(input.manifest, "idea", "path")))
	return err == nil && dynvalue.Trim(text) != ""
}

// sourceTextPresent — непустой текстовый файл проекта по пути от его папки.
func sourceTextPresent(project, path string) bool {
	text, err := readText(project, filepath.FromSlash(path))
	return err == nil && dynvalue.Trim(text) != ""
}

// refreshAdvice — итог задания работающих рекомендаций: запись обновляется один раз, когда
// задание завершилось.
func (w *Workflow) refreshAdvice(project string, record *adviceRecord) (*AgentJob, error) {
	var job *AgentJob
	if id, _ := record.doc.Value("jobId").(string); id != "" {
		if found, ok := w.options.Agents.Get(id); ok {
			job = &found
		}
	}
	if record.status() != CheckRunning {
		return job, nil
	}
	message := ""
	switch {
	case job == nil || job.Project != project || job.Status == "interrupted":
		record.doc.Set("status", CheckInterrupted)
		message = textAdviceInterrupted
	case job.Status == "running":
		return job, nil
	case job.Status == "cancelled":
		record.doc.Set("status", CheckCancelled)
		message = textAdviceCancelled
	case job.Status != "completed" || job.ExitCode == nil || *job.ExitCode != 0:
		record.doc.Set("status", CheckFailed)
		message = job.Message
		if message == "" {
			message = textAdviceAgentFailed
		}
	default:
		report, err := parseAdviceReport(job.Result, record.entities())
		if err != nil {
			record.doc.Set("status", CheckInvalid)
			message = err.Error()
		} else {
			record.doc.Set("status", CheckReady)
			record.doc.Set("report", adviceTree(report))
		}
	}
	if message != "" {
		record.doc.Set("message", message)
	} else {
		record.doc.Set("message", nil)
	}
	return job, writeAdvice(project, record)
}

// StartAdvice — scenarioWorkflow.startAdvice: контекст и факты, запуск задания агента и запись
// рекомендаций в состоянии running. Проект не меняется, изображения к заданию не прикладываются.
func (w *Workflow) StartAdvice(project string) (AdviceView, error) {
	if w.options.RequireAgentAccess != nil {
		if err := w.options.RequireAgentAccess(project); err != nil {
			return AdviceView{}, err
		}
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	view, input, err := w.adviceView(project)
	if err != nil {
		return AdviceView{}, err
	}
	if !view.CanStart {
		return AdviceView{}, errors.New(*view.Reason)
	}
	skill, err := resources.Skill(resources.SkillReferenceAdvice)
	if err != nil {
		return AdviceView{}, err
	}
	context, entities, err := adviceContext(input)
	if err != nil {
		return AdviceView{}, err
	}
	if len(context) > agents.TextLimit {
		return AdviceView{}, errors.New(textAdviceTooLarge(len(context), agents.TextLimit))
	}
	job, err := w.options.Agents.Start(AgentStartInput{
		Project: input.project,
		Task:    AdviceTask,
		Prompt:  advicePrompt(skill),
		Context: context,
		Images:  []string{},
		Place:   &AgentPlace{Page: "cast"},
	})
	if err != nil {
		return AdviceView{}, err
	}
	doc := dynvalue.NewObject()
	doc.Set("schemaVersion", 1.0)
	doc.Set("status", CheckRunning)
	doc.Set("jobId", job.ID)
	doc.Set("preliminary", input.documents.Scenes == nil)
	doc.Set("entities", stringArray(entities))
	doc.Set("hashes", checkHashes(input).object())
	doc.Set("report", nil)
	doc.Set("message", nil)
	if err := writeAdvice(input.project, &adviceRecord{doc: doc}); err != nil {
		return AdviceView{}, err
	}
	view, _, err = w.adviceView(input.project)
	return view, err
}

// advicePrompt — скилл рекомендаций с пределами ответа, которые проверяет parseAdviceReport.
func advicePrompt(skill string) string {
	return strings.NewReplacer(
		"{{summaryMaxLength}}", strconv.Itoa(adviceSummaryMaxLength),
		"{{itemsMax}}", strconv.Itoa(adviceItemsMax),
		"{{textMaxLength}}", strconv.Itoa(adviceTextMaxLength),
		"{{listMax}}", strconv.Itoa(adviceListMax),
		"{{labelMaxLength}}", strconv.Itoa(adviceLabelMaxLength),
		"{{countMax}}", strconv.Itoa(adviceCountMax),
	).Replace(skill)
}

// adviceContext — контекст задания (JSON без отступов) и ID кастинга, на которые может ссылаться
// ответ. Факты по сущностям приложение считает само, чтобы агент не пересчитывал планы вручную:
// shots — планы, где сущность в кадре (scenario.PlanEntities); closeShots — те из них, где
// крупность точки съёмки «close» или «detail»; cameraSides — стороны камеры точки съёмки по
// счёту; images — опись изображений сущности с подписью и заметкой автора.
func adviceContext(input *inputs) (string, []string, error) {
	idea, err := readText(input.project, "source", dynvalue.ToString(dynvalue.GetPath(input.manifest, "idea", "path")))
	if err != nil {
		return "", nil, err
	}
	lyrics, err := readText(input.project, "source/text.md")
	if err != nil {
		return "", nil, err
	}
	castValue := input.documents.Cast
	scenes := input.documents.Scenes
	type fact struct {
		shots, close []string
		sides        *dynvalue.Object
	}
	facts := map[string]*fact{}
	entities := []string{}
	// Мир сцены — общие правила места и времени, а не то, что рисуют по изображению: в советы не входит.
	referable := []any{}
	for _, entity := range arrayItems(dynvalue.Get(castValue, "entities")) {
		if dynvalue.ToString(dynvalue.Get(entity, "id")) == cast.WorldID {
			continue
		}
		referable = append(referable, entity)
		id := dynvalue.ToString(dynvalue.Get(entity, "id"))
		entities = append(entities, id)
		facts[id] = &fact{shots: []string{}, close: []string{}, sides: dynvalue.NewObject()}
	}
	for _, scene := range arrayItems(dynvalue.Get(scenes, "scenes")) {
		shot := dynvalue.ToString(dynvalue.Get(scene, "id"))
		var viewpoint *viewframe.Viewpoint
		if value := dynvalue.Get(scene, "viewpoint"); value != nil && value != dynvalue.Undefined {
			if parsed, err := viewframe.ParseViewpoint(dynvalue.Raw(value)); err == nil {
				viewpoint = &parsed
			}
		}
		scope := scenario.PlanEntities(scene)
		for _, id := range entities {
			if !scope[id] {
				continue
			}
			entry := facts[id]
			entry.shots = append(entry.shots, shot)
			if viewpoint == nil {
				continue
			}
			if viewpoint.Size == "close" || viewpoint.Size == "detail" {
				entry.close = append(entry.close, shot)
			}
			if viewpoint.Side != "" {
				count, _ := entry.sides.Value(viewpoint.Side).(float64)
				entry.sides.Set(viewpoint.Side, count+1)
			}
		}
	}
	images := map[string][]any{}
	for _, image := range castImageList(castValue, input.manifest) {
		item := dynvalue.NewObject()
		item.Set("label", image.label)
		if image.note != "" {
			item.Set("note", image.note)
		}
		images[image.entity] = append(images[image.entity], item)
	}
	factList := make([]any, 0, len(entities))
	for _, entity := range referable {
		id := dynvalue.ToString(dynvalue.Get(entity, "id"))
		entry := facts[id]
		item := dynvalue.NewObject()
		item.Set("entity", id)
		item.Set("name", dynvalue.ToString(dynvalue.Get(entity, "name")))
		item.Set("kind", dynvalue.ToString(dynvalue.Get(entity, "kind")))
		item.Set("shots", stringArray(entry.shots))
		item.Set("closeShots", stringArray(entry.close))
		item.Set("cameraSides", entry.sides)
		list := images[id]
		if list == nil {
			list = []any{}
		}
		item.Set("images", &dynvalue.Array{Items: list})
		item.Set("hasImages", len(list) > 0)
		factList = append(factList, item)
	}
	context := dynvalue.NewObject()
	context.Set("mode", "advice")
	context.Set("preliminary", scenes == nil)
	context.Set("idea", idea)
	context.Set("lyrics", lyrics)
	context.Set("cast", nullable(castValue))
	context.Set("scenes", nullable(scenes))
	context.Set("facts", &dynvalue.Array{Items: factList})
	return dynvalue.Stringify(context), entities, nil
}

// parseAdviceReport — проверка ответа агента целиком: один неверный пункт отклоняет весь ответ,
// как у проверки сценария, — частичный совет вводил бы в заблуждение.
func parseAdviceReport(result string, entities []string) (AdviceReport, error) {
	value, err := dynvalue.Parse([]byte(strings.TrimSpace(result)))
	object, ok := dynvalue.AsObject(value)
	if err != nil || !ok {
		return AdviceReport{}, errors.New(textAdviceNotObject)
	}
	if !onlyKeys(object, adviceReportKeys) || !dynvalue.StrictEqual(object.Value("schemaVersion"), 1.0) {
		return AdviceReport{}, errors.New(textAdviceShape)
	}
	summary, err := checkText(object.Value("summary"), adviceSummaryMaxLength)
	if err != nil {
		return AdviceReport{}, errors.New(textAdviceSummary(err.Error()))
	}
	items, ok := dynvalue.AsArray(object.Value("items"))
	if !ok {
		return AdviceReport{}, errors.New(textAdviceShape)
	}
	if len(items) > adviceItemsMax {
		return AdviceReport{}, errors.New(textAdviceTooMany(len(items), adviceItemsMax))
	}
	report := AdviceReport{Summary: summary, Items: []AdviceItem{}}
	seen := map[string]bool{}
	for index, value := range items {
		item, err := parseAdviceItem(value, entities)
		if err == nil && item.Entity != "" && seen[item.Entity] {
			err = errors.New(textAdviceRepeated(item.Entity))
		}
		if err != nil {
			return AdviceReport{}, errors.New(textAdviceItem(index+1, err.Error()))
		}
		seen[item.Entity] = true
		report.Items = append(report.Items, item)
	}
	return report, nil
}

// parseAdviceItem — один пункт ответа.
func parseAdviceItem(value any, entities []string) (AdviceItem, error) {
	object, ok := dynvalue.AsObject(value)
	if !ok || !onlyKeys(object, adviceItemKeys) {
		return AdviceItem{}, errors.New(textCheckIssueShape)
	}
	item := AdviceItem{}
	entity, ok := object.Value("entity").(string)
	if !ok || (entity != "" && !slices.Contains(entities, entity)) {
		return AdviceItem{}, errors.New(textCheckIssueEntity(dynvalue.ToString(object.Value("entity"))))
	}
	item.Entity = entity
	var err error
	for _, field := range []struct {
		target *string
		key    string
	}{{&item.Name, "name"}, {&item.Need, "need"}, {&item.Why, "why"}} {
		if *field.target, err = checkText(object.Value(field.key), adviceTextMaxLength); err != nil {
			return AdviceItem{}, errors.New(textCheckIssueField(field.key, err.Error()))
		}
	}
	have, ok := object.Value("have").(string)
	if !ok || len([]rune(have)) > adviceTextMaxLength {
		return AdviceItem{}, errors.New(textCheckIssueField("have", textCheckLong(len([]rune(have)), adviceTextMaxLength)))
	}
	item.Have = dynvalue.Trim(have)
	for _, field := range []struct {
		target *[]string
		key    string
	}{{&item.Views, "views"}, {&item.States, "states"}} {
		if *field.target, err = adviceLabels(object.Value(field.key)); err != nil {
			return AdviceItem{}, errors.New(textCheckIssueField(field.key, err.Error()))
		}
	}
	count, ok := object.Value("count").(float64)
	if !ok || count != float64(int(count)) || count < 1 || count > adviceCountMax {
		return AdviceItem{}, errors.New(textAdviceCount(adviceCountMax))
	}
	item.Count = int(count)
	return item, nil
}

// adviceLabels — список коротких подписей (ракурсы, состояния): до adviceListMax непустых строк.
func adviceLabels(value any) ([]string, error) {
	items, ok := dynvalue.AsArray(value)
	if !ok || len(items) > adviceListMax {
		return nil, errors.New(textAdviceList(adviceListMax))
	}
	result := []string{}
	for _, item := range items {
		text, err := checkText(item, adviceLabelMaxLength)
		if err != nil {
			return nil, err
		}
		result = append(result, text)
	}
	return result, nil
}

// adviceTree — ответ в форме агента для записи.
func adviceTree(report AdviceReport) *dynvalue.Object {
	tree := dynvalue.NewObject()
	tree.Set("schemaVersion", 1.0)
	tree.Set("summary", report.Summary)
	items := make([]any, len(report.Items))
	for index, item := range report.Items {
		entry := dynvalue.NewObject()
		entry.Set("entity", item.Entity)
		entry.Set("name", item.Name)
		entry.Set("need", item.Need)
		entry.Set("views", stringArray(item.Views))
		entry.Set("count", float64(item.Count))
		entry.Set("states", stringArray(item.States))
		entry.Set("why", item.Why)
		entry.Set("have", item.Have)
		items[index] = entry
	}
	tree.Set("items", &dynvalue.Array{Items: items})
	return tree
}

// AdviceMarkdown — готовые рекомендации текстом Markdown для «Сохранить в файл»: итог и пункты
// по сущностям теми же словами, что на странице. Нет готовых рекомендаций — ошибка.
func (w *Workflow) AdviceMarkdown(project string) (string, error) {
	view, err := w.AdviceView(project)
	if err != nil {
		return "", err
	}
	if view.Report == nil {
		return "", errors.New(textAdviceNotReady)
	}
	var text strings.Builder
	text.WriteString("# " + textAdviceHeading + "\n\n")
	if view.Preliminary {
		text.WriteString(textAdvicePreliminaryNote + "\n\n")
	}
	text.WriteString(view.Report.Summary + "\n")
	for _, item := range view.Report.Items {
		text.WriteString("\n## " + item.Name + "\n\n")
		text.WriteString(item.Need + "\n\n")
		text.WriteString("- " + textAdviceCountLabel + ": " + strconv.Itoa(item.Count) + "\n")
		if len(item.Views) > 0 {
			text.WriteString("- " + textAdviceViewsLabel + ": " + strings.Join(item.Views, ", ") + "\n")
		}
		if len(item.States) > 0 {
			text.WriteString("- " + textAdviceStatesLabel + ": " + strings.Join(item.States, ", ") + "\n")
		}
		text.WriteString("- " + textAdviceWhyLabel + ": " + item.Why + "\n")
		if item.Have != "" {
			text.WriteString("- " + textAdviceHaveLabel + ": " + item.Have + "\n")
		}
	}
	return text.String(), nil
}
