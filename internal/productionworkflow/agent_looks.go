package productionworkflow

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"

	"songframe/internal/dynvalue"
	"songframe/internal/mediaadapters"
	"songframe/internal/mediaproviders"
	"songframe/internal/savedlooks"
)

// Герои с сохранёнными образами в задании агента. Постановка плана зависит от того, держит ли
// облик героя сохранённый образ: такой герой может стоять спиной, быть срезан краем кадра или
// войти в кадр позже. Задания описания и видеопромпта получают ключ savedLooks: ожидаемую модель
// видео, её предел и героев «В кадре» с действующим образом (готовым или устаревшим) тех видов,
// что модель принимает. Если таких героев больше предела, их выбирает пользователь в окне перед
// описанием; выбор записывается в попытку (saved_looks в workflow.json), и видеопромпт той же
// попытки получает только выбранных. Метки [@код] у упоминаний ставит агент видеопромпта, их
// подстановку делает сборка запроса (applySavedLooks).
//
// Без привязок образов у проекта список аккаунта не запрашивается: задания проектов без образов
// собираются без сети и не меняются.

// textLooksAgentUnavailable — список аккаунта не получен: без него неизвестно, у кого образ.
const textLooksAgentUnavailable = "Не удалось проверить сохранённые образы героев в аккаунте провайдера видео: %s Повторите, когда сервис ответит."

func textLooksChoiceRequired(model string, limit, count int) string {
	return fmt.Sprintf("Образы есть у %d героев плана, а модель %s примет не больше %d: выберите героев в окне «Образы героев плана» и повторите.", count, model, limit)
}

func textLooksChoiceUnknown(code string) string {
	return fmt.Sprintf("Выбранного героя «%s» нет среди героев плана с действующим образом: начните описание заново.", code)
}

func textLooksChoiceOver(model string, limit, count int) string {
	return fmt.Sprintf("Выбрано героев: %d, а модель %s примет не больше %d образов: снимите лишних.", count, model, limit)
}

// agentLooks — герои с образами для задания агента: модель и предел, герои в порядке выбора
// (персонажи первыми) и выбор для записи в попытку.
type agentLooks struct {
	model    string
	limit    int
	entities []ShotEntity
	// chosen — коды для saved_looks попытки этапа description; nil — выбор не записывается:
	// этап prompt или героев не больше предела и выбирать было не из чего.
	chosen []string
}

// tree — значение ключа savedLooks контекста задания.
func (a *agentLooks) tree() *dynvalue.Object {
	value := dynvalue.NewObject()
	value.Set("model", a.model)
	value.Set("limit", float64(a.limit))
	items := make([]any, len(a.entities))
	for index, entity := range a.entities {
		item := dynvalue.NewObject()
		item.Set("code", entity.Code)
		item.Set("name", entity.Name)
		item.Set("kind", entity.Kind)
		items[index] = item
	}
	value.Set("entities", &dynvalue.Array{Items: items})
	return value
}

// lookCandidates — сущности «В кадре» с действующим образом вида из kinds: персонажи первыми,
// остальные в порядке кастинга. Тем же порядком окно перед описанием предлагает выбор.
func lookCandidates(c *Context, kinds []string, report savedlooks.Report) []ShotEntity {
	states := map[string]string{}
	for _, state := range report.States {
		states[state.Reference] = state.Status
	}
	result := []ShotEntity{}
	for _, entity := range shotEntities(c) {
		status := states[entity.Code]
		if slices.Contains(kinds, entity.Kind) && (status == savedlooks.StatusReady || status == savedlooks.StatusStale) {
			result = append(result, entity)
		}
	}
	slices.SortStableFunc(result, func(a, b ShotEntity) int {
		return lookPriority(a.Kind) - lookPriority(b.Kind)
	})
	return result
}

// lookPriority — порядок видов при избытке образов: персонажи первыми.
func lookPriority(kind string) int {
	if kind == "character" {
		return 0
	}
	return 1
}

// recordedLooks — выбор героев, записанный в попытке (saved_looks); nil — записи нет.
func recordedLooks(c *Context) []string {
	items, ok := dynvalue.AsArray(c.workflowValue("saved_looks"))
	if !ok {
		return nil
	}
	codes := []string{}
	for _, item := range items {
		if code, isString := item.(string); isString {
			codes = append(codes, code)
		}
	}
	return codes
}

// pick — кандидаты candidates с кодами из codes в порядке кандидатов; коды без действующего
// образа пропускаются.
func pick(candidates []ShotEntity, codes []string) []ShotEntity {
	result := []ShotEntity{}
	for _, entity := range candidates {
		if slices.Contains(codes, entity.Code) {
			result = append(result, entity)
		}
	}
	return result
}

// lookHeroes — герои с образами для задания этапа stage; nil — ключ savedLooks не нужен: этап не
// пишет текст для модели видео (план из опор, ручная генерация), модель проекта образов не
// принимает или у героев плана их нет.
//
// chosen — выбор пользователя в окне перед описанием (nil — не выбирал), inherit — доработка
// той же попытки: без нового выбора действует записанный. Если героев больше предела, описание
// без выбора не начинается: приложение не выбирает молча. Видеопромпт берёт выбор попытки;
// без записи (описание написано самим пользователем) — всех героев с образами, а предел агент
// соблюдает сам.
func (w *Workflow) lookHeroes(ctx context.Context, c *Context, stage string, chosen []string, inherit bool) (*agentLooks, error) {
	if (stage != "description" && stage != "prompt") || c.StaticShot || c.Manual {
		return nil, nil
	}
	// Сначала локальные привязки: без них ни объявления моделей, ни список аккаунта не нужны.
	provider, _ := c.Settings.Value("provider").(string)
	if !mediaproviders.Supports(provider, mediaproviders.Video) || w.options.VideoMedia == nil {
		return nil, nil
	}
	media, ok := w.options.VideoMedia(provider)
	if !ok || media == nil {
		return nil, nil
	}
	if _, supported := media.SavedLooks(); !supported {
		return nil, nil
	}
	dir, err := mediaadapters.StateDir()
	if err != nil {
		return nil, err
	}
	store := savedlooks.Store{Dir: dir}
	if bound, err := store.Bound(media.Paid.ID, c.Project); err != nil || !bound {
		return nil, err
	}
	model, accepting, err := w.expectedLookModel(ctx, c.Project)
	if err != nil || accepting == nil {
		return nil, err
	}
	looks, _ := media.SavedLooks()
	ctx, cancel := context.WithTimeout(ctx, looksTimeout)
	defer cancel()
	report, err := store.Check(ctx, looks, media.Paid.ID, c.Project, looksTimeout)
	if err != nil {
		return nil, fmt.Errorf(textLooksAgentUnavailable, strings.TrimRight(err.Error(), ".")+".")
	}
	candidates := lookCandidates(c, model.Kinds, report)
	result := &agentLooks{model: model.Model, limit: model.Limit}
	if stage == "prompt" {
		result.entities = candidates
		if recorded := recordedLooks(c); recorded != nil {
			result.entities = pick(candidates, recorded)
		}
	} else {
		switch {
		case chosen != nil:
			for _, code := range chosen {
				if !slices.ContainsFunc(candidates, func(entity ShotEntity) bool { return entity.Code == code }) {
					return nil, errors.New(textLooksChoiceUnknown(code))
				}
			}
			result.entities = pick(candidates, chosen)
			if len(result.entities) > model.Limit {
				return nil, errors.New(textLooksChoiceOver(model.Model, model.Limit, len(result.entities)))
			}
		case len(candidates) <= model.Limit:
			// Выбирать не из чего: агент получает всех, выбор в попытку не пишется.
			result.entities = candidates
		case inherit && recordedLooks(c) != nil && len(pick(candidates, recordedLooks(c))) <= model.Limit:
			result.entities = pick(candidates, recordedLooks(c))
		default:
			return nil, errors.New(textLooksChoiceRequired(model.Model, model.Limit, len(candidates)))
		}
		if len(candidates) > model.Limit || chosen != nil {
			result.chosen = []string{}
			for _, entity := range result.entities {
				result.chosen = append(result.chosen, entity.Code)
			}
		}
	}
	if len(result.entities) == 0 && result.chosen == nil {
		return nil, nil
	}
	return result, nil
}
