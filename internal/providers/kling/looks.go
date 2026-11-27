package kling

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"

	"songframe/internal/mediaapi"
	"songframe/internal/providers/kling/mcp"
	"songframe/internal/toolrt"
)

// Сохранённые образы Kling — элементы библиотеки аккаунта (element_list, element_get,
// element_create, element_delete). Создание и удаление кредитов не тратят. Запрос видео
// ссылается на элемент аргументом elements, а промпт — разметкой <<<id>>> у упоминания героя;
// это собирает запрос, а здесь — только библиотека и объявление моделей.

// lookTags — тег каталога Kling для общего вида образа. Транспорт у Kling — предмет: отдельного
// тега для него нет.
var lookTags = map[string]string{
	mediaapi.LookCharacter: "Characters",
	mediaapi.LookVehicle:   "Items",
	mediaapi.LookLocation:  "Scenes",
	mediaapi.LookProp:      "Items",
	mediaapi.LookCostume:   "Costumes",
}

// lookKinds — общие виды образов Kling в порядке показа.
var lookKinds = []string{mediaapi.LookCharacter, mediaapi.LookVehicle, mediaapi.LookLocation, mediaapi.LookProp, mediaapi.LookCostume}

// tagKinds — обратный перевод тега в общий вид: Items — предмет (транспорт неотличим).
var tagKinds = map[string]string{
	"Characters": mediaapi.LookCharacter,
	"Scenes":     mediaapi.LookLocation,
	"Items":      mediaapi.LookProp,
	"Costumes":   mediaapi.LookCostume,
}

// Ограничения элемента Kling: имя до 20 символов и уникально в библиотеке, у элемента из
// снимков — главный снимок и 1–3 дополнительных; главный снимок после создания не меняется
// (element_update принимает только прежний адрес обложки).
const (
	lookNameMaxChars = 20
	lookExtraMin     = 1
	lookExtraMax     = 3
)

// LookRules — ограничения элемента Kling для окна создания образа.
func LookRules() mediaapi.SavedLookRules {
	return mediaapi.SavedLookRules{
		NameMaxChars: lookNameMaxChars, ExtraMin: lookExtraMin, ExtraMax: lookExtraMax,
		Kinds: append([]string(nil), lookKinds...), CoverFixed: true,
	}
}

// ModelAppearance — способ передачи облика модели Kling по объявлению who_am_i: модель видео с
// аргументом elements принимает элементы, не больше его max_items. Модели изображений
// объявляются без образов: через MCP сервис принимает elements в image_to_image, но результат
// их не учитывает (на сайте Kling те же модели работают). Неразборчивое объявление — nil.
func ModelAppearance(kind, command string, arguments json.RawMessage) *mediaapi.Appearance {
	if kind != "video" {
		return nil
	}
	var declared map[string]struct {
		MaxItems int `json:"max_items"`
	}
	if json.Unmarshal(arguments, &declared) != nil {
		return nil
	}
	elements, ok := declared["elements"]
	if !ok || elements.MaxItems < 1 {
		return nil
	}
	return &mediaapi.Appearance{
		Method: mediaapi.AppearanceSaved, MaxItems: elements.MaxItems, Kinds: append([]string(nil), lookKinds...),
	}
}

// Тексты библиотеки элементов.
var (
	textLookListFailed   = mcp.Title + " не вернул список образов аккаунта."
	textLookAnswer       = mcp.Title + " вернул неверный ответ об образе."
	textLookIDEmpty      = "Не указан ID образа."
	textLookCreateFailed = mcp.Title + " не создал образ"
	textLookDeleteFailed = mcp.Title + " не удалил образ"
	textLookGetFailed    = mcp.Title + " не вернул образ"
)

// lookError — ошибка вызова библиотеки с текстом для пользователя: нет входа — текст входа как
// есть, сбой сервиса или соединения — action и причина клиента (без секретов и сырого ответа).
func lookError(action string, err error) error {
	if err == nil {
		return nil
	}
	if mcp.IsAuthRequired(err) {
		return err
	}
	if mcp.IsKlingError(err) || toolrt.IsAny(err, toolrt.OSError, toolrt.ValueError) {
		return errors.New(action + ": " + strings.TrimSuffix(err.Error(), ".") + ".")
	}
	return err
}

// lookID — ID элемента из ответа: строка или целое число JSON; иное — "".
func lookID(value any) string {
	switch id := value.(type) {
	case string:
		return strings.TrimSpace(id)
	case toolrt.Int:
		return id.String()
	case float64:
		if id == float64(int64(id)) {
			return strconv.FormatInt(int64(id), 10)
		}
	}
	return ""
}

// listLooks — элементы аккаунта в открытом сеансе.
func listLooks(ctx context.Context, call session) ([]mediaapi.SavedLook, error) {
	body, err := call.Call(ctx, "element_list", nil, 0, nil)
	if err != nil {
		return nil, lookError(strings.TrimSuffix(textLookListFailed, "."), err)
	}
	values, ok := body.(*toolrt.Dict)
	items, isList := values.Value("elements").([]any)
	if !ok || !isList {
		return nil, errors.New(textLookListFailed)
	}
	looks := make([]mediaapi.SavedLook, 0, len(items))
	for _, item := range items {
		entry, ok := item.(*toolrt.Dict)
		name, _ := entry.Value("name").(string)
		id := lookID(entry.Value("id"))
		if !ok || id == "" {
			return nil, errors.New(textLookAnswer)
		}
		looks = append(looks, mediaapi.SavedLook{ID: id, Name: name})
	}
	return looks, nil
}

// textLookAccount — who_am_i не сообщил ID пользователя.
var textLookAccount = mcp.Title + " не сообщил аккаунт."

// lookAccount — ID пользователя Kling (who_am_i user.userId) в открытом сеансе. who_am_i
// спрашивается об одной команде: объявления моделей здесь не нужны, а полный каталог тяжелее.
func lookAccount(ctx context.Context, call session) (string, error) {
	arguments := toolrt.NewDict()
	arguments.Set("tools", []any{"text_to_image"})
	body, err := call.Call(ctx, "who_am_i", arguments, 0, nil)
	if err != nil {
		return "", lookError(strings.TrimSuffix(textLookAccount, "."), err)
	}
	user, _ := body.(*toolrt.Dict).Value("user").(*toolrt.Dict)
	account := lookID(user.Value("userId"))
	if account == "" {
		return "", errors.New(textLookAccount)
	}
	return account, nil
}

// ListLooks — аккаунт и все его элементы одним сеансом (бесплатно).
func (a *Adapter) ListLooks(ctx context.Context, timeout time.Duration) (mediaapi.SavedLookLibrary, error) {
	call := a.open(timeout, nil)
	account, err := lookAccount(ctx, call)
	if err != nil {
		return mediaapi.SavedLookLibrary{}, err
	}
	looks, err := listLooks(ctx, call)
	if err != nil {
		return mediaapi.SavedLookLibrary{}, err
	}
	return mediaapi.SavedLookLibrary{Account: account, Looks: looks}, nil
}

// GetLook — элемент целиком: описание, вид по первому известному тегу, число снимков, признак
// элемента из видео.
func (a *Adapter) GetLook(ctx context.Context, id string, timeout time.Duration) (mediaapi.SavedLookDetails, error) {
	id = strings.TrimSpace(id)
	if id == "" {
		return mediaapi.SavedLookDetails{}, errors.New(textLookIDEmpty)
	}
	arguments := toolrt.NewDict()
	arguments.Set("id", id)
	body, err := a.open(timeout, nil).Call(ctx, "element_get", arguments, 0, nil)
	if err != nil {
		return mediaapi.SavedLookDetails{}, lookError(textLookGetFailed, err)
	}
	values, ok := body.(*toolrt.Dict)
	if !ok || lookID(values.Value("id")) == "" {
		return mediaapi.SavedLookDetails{}, errors.New(textLookAnswer)
	}
	details := mediaapi.SavedLookDetails{ID: lookID(values.Value("id"))}
	details.Name, _ = values.Value("name").(string)
	details.Description, _ = values.Value("description").(string)
	if tags, ok := values.Value("tags").([]any); ok {
		for _, tag := range tags {
			if name, ok := tag.(string); ok && tagKinds[name] != "" {
				details.Kind = tagKinds[name]
				break
			}
		}
	}
	resource, _ := values.Value("resource").(*toolrt.Dict)
	video, _ := resource.Value("video").(string)
	details.Video = toolrt.Equal(values.Value("type"), "video") || strings.TrimSpace(video) != ""
	if !details.Video {
		if cover, _ := resource.Value("cover").(string); strings.TrimSpace(cover) != "" {
			details.Images = 1
		}
		if extra, ok := resource.Value("secondary").([]any); ok {
			details.Images += len(extra)
		}
	}
	return details, nil
}

// CreateLook — новый элемент из снимков: проверка черновика, проверка имени по библиотеке
// (повтор имени сервис отклоняет непонятным «temporarily unavailable»), загрузка снимков и
// element_create в одном сеансе. Загруженные файлы без созданного элемента остаются у сервиса
// временными адресами и ничего не стоят.
func (a *Adapter) CreateLook(ctx context.Context, draft mediaapi.SavedLookDraft, timeout time.Duration) (mediaapi.SavedLook, error) {
	if err := mediaapi.ValidateSavedLookDraft(LookRules(), draft); err != nil {
		return mediaapi.SavedLook{}, err
	}
	name := strings.TrimSpace(draft.Name)
	call := a.open(timeout, nil)
	existing, err := listLooks(ctx, call)
	if err != nil {
		return mediaapi.SavedLook{}, err
	}
	for _, look := range existing {
		if strings.EqualFold(strings.TrimSpace(look.Name), name) {
			return mediaapi.SavedLook{}, errors.New(mediaapi.TextLookNameTaken(name))
		}
	}
	cover, err := call.Upload(ctx, draft.Cover, nil)
	if err != nil {
		return mediaapi.SavedLook{}, lookError(textLookCreateFailed, err)
	}
	secondary := make([]any, 0, len(draft.Extra))
	for index, path := range draft.Extra {
		url, err := call.Upload(ctx, path, nil)
		if err != nil {
			return mediaapi.SavedLook{}, lookError(textLookCreateFailed, err)
		}
		item := toolrt.NewDict()
		item.Set("name", "view "+strconv.Itoa(index+1))
		item.Set("inputType", "URL")
		item.Set("url", url)
		secondary = append(secondary, item)
	}
	resource := toolrt.NewDict()
	resource.Set("cover", cover)
	resource.Set("secondary", secondary)
	arguments := toolrt.NewDict()
	arguments.Set("name", name)
	if description := strings.TrimSpace(draft.Description); description != "" {
		arguments.Set("description", description)
	}
	arguments.Set("resource", resource)
	arguments.Set("tags", []any{lookTags[draft.Kind]})
	body, err := call.Call(ctx, "element_create", arguments, 0, nil)
	if err != nil {
		return mediaapi.SavedLook{}, lookError(textLookCreateFailed, err)
	}
	values, _ := body.(*toolrt.Dict)
	id := lookID(values.Value("id"))
	if id == "" {
		return mediaapi.SavedLook{}, errors.New(textLookAnswer)
	}
	return mediaapi.SavedLook{ID: id, Name: name}, nil
}

// DeleteLook — удаление элемента из библиотеки аккаунта. Необратимо: вызывается только после
// отдельного подтверждения пользователя.
func (a *Adapter) DeleteLook(ctx context.Context, id string, timeout time.Duration) error {
	id = strings.TrimSpace(id)
	if id == "" {
		return errors.New(textLookIDEmpty)
	}
	arguments := toolrt.NewDict()
	arguments.Set("id", id)
	_, err := a.open(timeout, nil).Call(ctx, "element_delete", arguments, 0, nil)
	return lookError(textLookDeleteFailed, err)
}
