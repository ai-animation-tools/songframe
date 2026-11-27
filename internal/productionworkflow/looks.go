package productionworkflow

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"songframe/internal/dynvalue"
	"songframe/internal/mediaadapters"
	"songframe/internal/mediaapi"
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

// ShotEntity — сущность «В кадре» плана: код кастинга и имя.
type ShotEntity struct {
	Code string
	Name string
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
		entities = append(entities, ShotEntity{Code: id, Name: name})
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
	var appearance *mediaapi.Appearance
	for _, item := range caps.Models {
		if item.ID == draft.Model && item.Command == draft.Command {
			appearance = item.Appearance
		}
	}
	looks, supported := media.SavedLooks()
	if appearance == nil || appearance.Method != mediaapi.AppearanceSaved || !supported {
		draft.Prompt = savedlooks.Strip(draft.Prompt)
		return nil
	}
	if len(codes) > appearance.MaxItems {
		return errors.New(textLooksOverLimit(draft.Model, appearance.MaxItems, len(codes)))
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
	for index, code := range codes {
		state := states[code]
		switch state.Status {
		case savedlooks.StatusReady, savedlooks.StatusStale:
		case savedlooks.StatusMissing:
			return errors.New(textLookDeleted(names[code], state.Name))
		default:
			return errors.New(textLookMissing(names[code]))
		}
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
