package productionworkflow

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"songframe/internal/dynvalue"
	"songframe/internal/mediaadapters"
	"songframe/internal/mediaapi"
	"songframe/internal/mediaproviders"
	"songframe/internal/providers"
	"songframe/internal/savedlooks"
)

// Сохранённые образы сущностей в запросе видео. Видеопромпт попытки хранит метки [@код] у
// упоминаний героев; после выбора модели запрос получает текст без меток. Модель с
// сохранёнными образами получает разметку провайдера у каждого упоминания и аргумент образов,
// модель без образов — текст без меток. Привязки образов берутся по одному бесплатному списку
// аккаунта: ID образа действителен только в нём.

// looksTimeout — срок списка образов аккаунта при сборке запроса.
const looksTimeout = 90 * time.Second

// Тексты ошибок меток.
const textLooksUnavailable = "Не удалось проверить образы аккаунта провайдера видео: %s Повторите сборку запроса, когда сервис ответит."

func textLookMarkUnknown(code string, known []string) string {
	hint := "в кадре плана нет сущностей кастинга"
	if len(known) > 0 {
		hint = "коды сущностей в кадре: " + strings.Join(known, ", ")
	}
	return fmt.Sprintf("В видеопромпте метка [@%s], но такой сущности нет в кадре плана (%s). Исправьте метку в промпте.", code, hint)
}

func textLookMarkBroken(fragment string) string {
	return fmt.Sprintf("В видеопромпте метка записана с ошибкой: «%s». Метка — [@код] без пробелов внутри, сразу после упоминания героя.", fragment)
}

func textLookPromptLong(chars, limit int) string {
	return fmt.Sprintf("После подстановки образов промпт занимает %d символов при пределе %d: сократите промпт.", chars, limit)
}

func textLookMissing(entity string) string {
	return fmt.Sprintf("У «%s» нет сохранённого образа в аккаунте провайдера видео: создайте или привяжите образ у референса на «Исходниках» либо уберите метку из промпта.", entity)
}

func textLookDeleted(entity, name string) string {
	return fmt.Sprintf("Образа «%s» у «%s» больше нет в аккаунте провайдера видео: создайте или привяжите другой образ на «Исходниках» либо уберите метку из промпта.", name, entity)
}

func textLooksOverLimit(model string, limit, count int) string {
	return fmt.Sprintf("Модель %s принимает не больше %d образов в запросе, а в промпте отмечено %d: уберите лишние метки или выберите другую модель.", model, limit, count)
}

func textLookShared(first, second, name string) string {
	return fmt.Sprintf("У «%s» и «%s» один и тот же образ «%s»: в запросе образ передаёт облик одного героя. Привяжите другому герою свой образ на «Исходниках» либо уберите одну из меток.", first, second, name)
}

// textModelWithoutLooks — причина пропуска модели при выборе модели с образами; селектор вставляет
// её в «Предпочтительная модель … не подходит: <причина> Выбрана совместимая модель …».
func textModelWithoutLooks(entities []string) string {
	return fmt.Sprintf("не примет сохранённые образы героев с меткой в видеопромпте (%s), и они потеряли бы облик.", strings.Join(entities, ", "))
}

func textLooksDropped(model string, entities []string) string {
	return fmt.Sprintf("Модель %s не принимает сохранённые образы: облик по образу не получат %s.", model, strings.Join(entities, ", "))
}

// ShotEntity — сущность «В кадре» плана: код кастинга, имя и вид (character, prop, …).
type ShotEntity struct {
	Code string
	Name string
	Kind string
}

// ShotEntities — сущности «В кадре» плана shot, кроме мира, в порядке кастинга. Им интерфейс
// предлагает метки героев в своём видеопромпте.
func ShotEntities(project, shot string) ([]ShotEntity, error) {
	c, err := ReadContext(project, shot, "")
	if err != nil {
		return nil, err
	}
	return shotEntities(c), nil
}

// shotEntities — сущности «В кадре» контекста, кроме мира; пустое имя заменяется кодом.
func shotEntities(c *Context) []ShotEntity {
	entities := []ShotEntity{}
	for _, entity := range c.Cast.Items {
		id, _ := dynvalue.Get(entity, "id").(string)
		if id == "" || dynvalue.Get(entity, "kind") == "world" {
			continue
		}
		name := dynvalue.Trim(dynvalue.ToString(dynvalue.Get(entity, "name")))
		if name == "" {
			name = id
		}
		kind, _ := dynvalue.Get(entity, "kind").(string)
		entities = append(entities, ShotEntity{Code: id, Name: name, Kind: kind})
	}
	return entities
}

// checkMarks проверяет, что меток с ошибкой записи нет, а каждая метка промпта называет
// сущность «В кадре» плана, и возвращает имена сущностей по коду.
func checkMarks(c *Context, prompt string) (map[string]string, error) {
	if fragment := savedlooks.Broken(prompt); fragment != "" {
		return nil, errors.New(textLookMarkBroken(fragment))
	}
	entities := shotEntities(c)
	codes := make([]string, len(entities))
	names := map[string]string{}
	for index, entity := range entities {
		codes[index] = entity.Code
		names[entity.Code] = entity.Name
	}
	for _, code := range savedlooks.Codes(prompt) {
		if _, ok := names[code]; !ok || !savedlooks.ValidCode(code) {
			return nil, errors.New(textLookMarkUnknown(code, codes))
		}
	}
	return names, nil
}

// applySavedLooks — подстановка меток видеопромпта в черновик выбранной модели: разметка и
// аргумент образов у модели с сохранёнными образами, удаление меток у остальных. Промпт без
// меток не меняется и аккаунт не запрашивается, поэтому запросы без образов прежние.
func applySavedLooks(ctx context.Context, c *Context, media *providers.PaidMedia, caps mediaapi.Capabilities, draft *providers.PaidInput) error {
	codes := savedlooks.Codes(draft.Prompt)
	if len(codes) == 0 {
		// Без распознанных меток текст не меняется; опечатка в метке — ошибка, а не простой текст.
		if fragment := savedlooks.Broken(draft.Prompt); fragment != "" {
			return errors.New(textLookMarkBroken(fragment))
		}
		return nil
	}
	names, err := checkMarks(c, draft.Prompt)
	if err != nil {
		return err
	}
	looks, supported := media.SavedLooks()
	limit := looksLimit(modelAppearance(caps, draft.Command, draft.Model), supported)
	if limit == 0 {
		// Герои потеряют облик: об этом говорят шаг «Запрос» и вопрос «Отправить» (метки
		// видеопромпта попытки без образов замороженного запроса).
		draft.Prompt = savedlooks.Strip(draft.Prompt)
		return nil
	}
	if len(codes) > limit {
		return errors.New(textLooksOverLimit(draft.Model, limit, len(codes)))
	}
	dir, err := mediaadapters.StateDir()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, looksTimeout)
	defer cancel()
	report, err := savedlooks.Store{Dir: dir}.Check(ctx, looks, media.Paid.ID, c.Project, looksTimeout)
	if err != nil {
		return fmt.Errorf(textLooksUnavailable, strings.TrimRight(err.Error(), ".")+".")
	}
	states := map[string]savedlooks.State{}
	for _, state := range report.States {
		states[state.Reference] = state
	}
	uses := make([]mediaapi.SavedLookUse, len(codes))
	mentions := map[string]string{}
	owners := map[string]string{}
	for index, code := range codes {
		state := states[code]
		switch state.Status {
		case savedlooks.StatusReady, savedlooks.StatusStale:
		case savedlooks.StatusMissing:
			return errors.New(textLookDeleted(names[code], state.Name))
		default:
			return errors.New(textLookMissing(names[code]))
		}
		// Один образ — один облик: два героя с одним образом — ошибка привязки, а не два облика.
		if owner, taken := owners[state.Look]; taken {
			return errors.New(textLookShared(names[owner], names[code], state.Name))
		}
		owners[state.Look] = code
		uses[index] = mediaapi.SavedLookUse{Code: code, Entity: names[code], Look: state.Look, Name: state.Name}
		mentions[code] = looks.SavedLookMention(state.Look)
	}
	name, value := looks.SavedLookArgument(uses)
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	parameter, err := dynvalue.Parse(data)
	if err != nil {
		return err
	}
	parameters := dynvalue.NewObject()
	if draft.Parameters != nil {
		for _, key := range draft.Parameters.Keys() {
			parameters.Set(key, draft.Parameters.Value(key))
		}
	}
	parameters.Set(name, parameter)
	prompt := savedlooks.Replace(draft.Prompt, func(code string) string { return mentions[code] })
	// Предел провайдера проверялся по тексту с метками; разметка длиннее метки.
	if limit, chars := c.PromptLimit(), utf8.RuneCountInString(strings.TrimSpace(prompt)); limit > 0 && chars > limit {
		return errors.New(textLookPromptLong(chars, limit))
	}
	draft.Prompt = prompt
	draft.Parameters = parameters
	draft.SavedLooks = uses
	return nil
}

// lookModelDraft — черновик запроса моделью, которая примет все метки образов видеопромпта:
// модель проекта без образов (например, модель промежуточных опор) пропускается с причиной, и
// выбор достаётся первой совместимой модели с образами. found=false — правило не применяется:
// выбор пользователя в «Изменить» (change), речевой план, промпт без меток или с ошибочными метками
// (о них скажет applySavedLooks), адаптер без образов, или ни одна модель с образами запрос не примет
// (например, опор больше, чем она берёт). Тогда модель выбирается как раньше, а о потерянном облике
// говорят шаг «Запрос» и вопрос «Отправить».
func lookModelDraft(c *Context, paid providers.Paid, input providers.PaidInput, caps mediaapi.Capabilities, candidate providers.CandidateParameters, change *RequestChange, looksSupported bool) (providers.PaidInput, bool) {
	if change != nil || !looksSupported || dynvalue.Truthy(c.Scene.Value("lipsync")) {
		return providers.PaidInput{}, false
	}
	codes := savedlooks.Codes(input.Prompt)
	if len(codes) == 0 {
		return providers.PaidInput{}, false
	}
	names, err := checkMarks(c, input.Prompt)
	if err != nil {
		return providers.PaidInput{}, false
	}
	entities := make([]string, len(codes))
	for index, code := range codes {
		entities[index] = names[code]
	}
	checked := func(item mediaapi.Model) (*dynvalue.Object, error) {
		if looksLimit(item.Appearance, true) < len(codes) {
			return nil, errors.New(textModelWithoutLooks(entities))
		}
		return candidate(item), nil
	}
	draft, err := providers.SelectCheckedPaidRequest(paid, input, caps, checked)
	if err != nil {
		return providers.PaidInput{}, false
	}
	return draft, true
}

// modelAppearance — способ передачи облика модели id команды command в снимке caps; nil — модель
// его не объявляет.
func modelAppearance(caps mediaapi.Capabilities, command, id string) *mediaapi.Appearance {
	for _, item := range caps.Models {
		if item.ID == id && item.Command == command {
			return item.Appearance
		}
	}
	return nil
}

// looksLimit — сколько сохранённых образов модель получит в запросе: 0 — модель их не принимает
// или адаптер не работает с образами (тогда метки убираются).
func looksLimit(appearance *mediaapi.Appearance, supported bool) int {
	if appearance == nil || appearance.Method != mediaapi.AppearanceSaved || !supported {
		return 0
	}
	return appearance.MaxItems
}

// looksWarning — что случится с метками промпта prompt у модели item: облик потеряют герои, если
// модель образов не принимает, или сборка остановится, если меток больше её предела; "" — меток
// нет, они записаны с ошибкой (о ней скажет сборка) или модель примет все.
func looksWarning(c *Context, prompt string, item mediaapi.Model, supported bool) string {
	codes := savedlooks.Codes(prompt)
	if len(codes) == 0 {
		return ""
	}
	names, err := checkMarks(c, prompt)
	if err != nil {
		return ""
	}
	limit := looksLimit(item.Appearance, supported)
	if limit == 0 {
		entities := make([]string, len(codes))
		for index, code := range codes {
			entities[index] = names[code]
		}
		return textLooksDropped(item.ID, entities)
	}
	if len(codes) > limit {
		return textLooksOverLimit(item.ID, limit, len(codes))
	}
	return ""
}

// LookModel — модель видео, которая получит образы героев плана (предпочтение проекта, иначе первая
// модель адаптера; если она образы не принимает — первая модель адаптера с образами: на неё сборка
// перейдёт по меткам), и сколько сохранённых образов она примет: по ней проверка перед
// описанием плана спрашивает о героях без образа. Limit 0 — модель образы не принимает; Kinds —
// виды сущностей, чей образ она принимает. Число опор выбирается позже, поэтому модель здесь —
// ожидаемая: если сборка выберет другую, о потерянном облике скажет сама сборка.
type LookModel struct {
	Model string   `json:"model"`
	Limit int      `json:"limit"`
	Kinds []string `json:"kinds"`
}

// ExpectedLookModel — LookModel проекта project по свежим объявлениям моделей провайдера видео.
// Без выбранного провайдера видео или его моделей — пустая модель с Limit 0.
func (w *Workflow) ExpectedLookModel(ctx context.Context, project string) (LookModel, error) {
	model, _, err := w.expectedLookModel(ctx, project)
	return model, err
}

// expectedLookModel — ExpectedLookModel и провайдер видео, по которому она выбрана; провайдер
// nil, если модель образы не примет.
func (w *Workflow) expectedLookModel(ctx context.Context, project string) (LookModel, *providers.PaidMedia, error) {
	empty := LookModel{Kinds: []string{}}
	settings, err := videoSettings(project)
	if err != nil {
		return LookModel{}, nil, err
	}
	provider, _ := settings.Value("provider").(string)
	if !mediaproviders.Supports(provider, mediaproviders.Video) || w.options.VideoMedia == nil {
		return empty, nil, nil
	}
	media, ok := w.options.VideoMedia(provider)
	if !ok || media == nil || media.Paid.Rules.Video == nil {
		return empty, nil, nil
	}
	rules := media.Paid.Rules.Video
	caps := media.Capabilities(ctx, project)
	preferred, _ := settings.Value("model").(string)
	preferred = dynvalue.Trim(preferred)
	candidates := []mediaapi.Model{}
	for _, item := range caps.Models {
		if item.Command == rules.Command {
			candidates = append(candidates, item)
		}
	}
	if len(candidates) == 0 {
		return empty, nil, nil
	}
	slices.SortStableFunc(candidates, func(a, b mediaapi.Model) int { return modelRank(rules.Models, a.ID) - modelRank(rules.Models, b.ID) })
	chosen := candidates[0]
	if index := slices.IndexFunc(candidates, func(item mediaapi.Model) bool { return item.ID == preferred }); index >= 0 {
		chosen = candidates[index]
	}
	_, supported := media.SavedLooks()
	// Модель проекта без образов не лишает героев облика: метки в видеопромпте переведут сборку
	// запроса на модель с образами (lookModelDraft), поэтому ожидается первая такая модель.
	if looksLimit(chosen.Appearance, supported) == 0 {
		if index := slices.IndexFunc(candidates, func(item mediaapi.Model) bool { return looksLimit(item.Appearance, supported) > 0 }); index >= 0 {
			chosen = candidates[index]
		}
	}
	model := LookModel{Model: chosen.ID, Limit: looksLimit(chosen.Appearance, supported), Kinds: []string{}}
	if model.Limit == 0 {
		return model, nil, nil
	}
	model.Kinds = append(model.Kinds, chosen.Appearance.Kinds...)
	return model, media, nil
}
