package mediaapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"
	"unicode/utf8"
)

// Облик сущности кастинга в запросе генерации. Модель может принимать облик героя, предмета или
// локации отдельно от опор: сохранённым образом в аккаунте провайдера (ID образа в запросе) или
// картинками сущности прямо в запросе. Способ объявляет адаптер по объявлению модели
// (AppearanceDescriber); работу с образами аккаунта — возможность SavedLooks. Общий код и
// интерфейс знают только эти понятия: название образа у провайдера, его теги и разметка промпта
// живут в адаптере и документе провайдера.

// Способы передачи облика (Appearance.Method).
const (
	// AppearanceSaved — сохранённый образ провайдера: запрос ссылается на образ аккаунта по ID.
	AppearanceSaved = "saved"
	// AppearanceImages — картинки сущности в самом запросе. Описан в контракте, но приложение
	// его пока не передаёт.
	AppearanceImages = "images"
)

// Общие виды сохранённого образа. Вид референса на «Исходниках» совпадает с видом образа, кроме
// костюма: одежду для переодевания сохраняют отдельным образом, а не вместе с обликом героя.
// Адаптер переводит вид в теги своего провайдера.
const (
	LookCharacter = "character"
	LookVehicle   = "vehicle"
	LookLocation  = "location"
	LookProp      = "prop"
	LookCostume   = "costume"
)

// Appearance — как модель принимает облик сущности кастинга. nil у модели — никак: облик
// передают только опоры и текст.
type Appearance struct {
	// Method — AppearanceSaved или AppearanceImages.
	Method string `json:"method"`
	// MaxItems — сколько образов (или картинок сущностей) принимает один запрос модели, ≥ 1.
	MaxItems int `json:"maxItems"`
	// Kinds — общие виды образов, которые модель принимает (для AppearanceSaved).
	Kinds []string `json:"kinds,omitempty"`
	// KeepsFirstFrame — для AppearanceImages: первая опора остаётся первым кадром видео, а не
	// перекомпонуется вместе с картинками.
	KeepsFirstFrame bool `json:"keepsFirstFrame,omitempty"`
}

// AppearanceDescriber — адаптер объявляет способ передачи облика модели по её объявлению:
// kind — вид медиа, command — команда, arguments — объект объявлений параметров модели
// (Model.Arguments, JSON как есть). nil — модель облик не принимает. Метод без сети: слой
// провайдеров вызывает его для каждой модели каталога.
type AppearanceDescriber interface {
	Appearance(kind, command string, arguments json.RawMessage) *Appearance
}

// SavedLook — сохранённый образ в аккаунте провайдера: ID действителен только в этом аккаунте.
type SavedLook struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// SavedLookDetails — образ аккаунта целиком (просмотр перед привязкой и проверка).
type SavedLookDetails struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	// Kind — общий вид образа по тегам провайдера; "" — тег без общего вида.
	Kind string `json:"kind"`
	// Images — число снимков образа (главный и дополнительные); 0 — образ из видео.
	Images int `json:"images"`
	// Video — образ сделан из видео, а не из снимков: его принимают не все модели.
	Video bool `json:"video"`
}

// SavedLookDraft — новый образ из снимков референса. Пути — локальные файлы изображений.
type SavedLookDraft struct {
	Name string
	// Description — описание облика, которое вводит пользователь; "" — без описания.
	Description string
	// Kind — общий вид образа из SavedLookRules.Kinds.
	Kind string
	// Cover — главный снимок: по нему провайдер узнаёт сущность.
	Cover string
	// Extra — дополнительные снимки (ракурсы, детали).
	Extra []string
}

// SavedLookRules — ограничения образа у провайдера, по которым интерфейс строит окно создания.
type SavedLookRules struct {
	// NameMaxChars — предел длины имени в символах; имя уникально в аккаунте.
	NameMaxChars int `json:"nameMaxChars"`
	// ExtraMin и ExtraMax — сколько дополнительных снимков нужно образу.
	ExtraMin int `json:"extraMin"`
	ExtraMax int `json:"extraMax"`
	// Kinds — общие виды образов, которые провайдер хранит.
	Kinds []string `json:"kinds"`
	// CoverFixed — главный снимок нельзя сменить без удаления и создания образа заново.
	CoverFixed bool `json:"coverFixed"`
}

// SavedLooks — необязательная возможность адаптера: сохранённые образы аккаунта провайдера.
// В отличие от возможностей платной попытки это набор действий, которые имеют смысл только
// вместе, поэтому он объявляется одним интерфейсом. Ни одно действие не тратит кредитов и не
// создаёт генераций. Образ создаёт и удаляет только пользователь: общий код вызывает
// CreateSavedLook по его кнопке, а DeleteSavedLook — после отдельного подтверждения, потому что
// удаление в аккаунте необратимо. Ошибки — с текстом для пользователя без секретов.
type SavedLooks interface {
	SavedLookRules() SavedLookRules
	// ListSavedLooks — все образы аккаунта; по нему строятся статусы привязок.
	ListSavedLooks(ctx context.Context, timeout time.Duration) ([]SavedLook, error)
	GetSavedLook(ctx context.Context, id string, timeout time.Duration) (SavedLookDetails, error)
	// CreateSavedLook загружает снимки и создаёт образ; занятое имя — ошибка до создания.
	CreateSavedLook(ctx context.Context, draft SavedLookDraft, timeout time.Duration) (SavedLook, error)
	DeleteSavedLook(ctx context.Context, id string, timeout time.Duration) error
}

// Тексты проверки нового образа.
const (
	textLookNameEmpty  = "Укажите имя образа."
	textLookCoverEmpty = "Выберите главный снимок образа."
)

func textLookNameLong(limit int) string {
	return fmt.Sprintf("Имя образа длиннее %d символов: сократите его.", limit)
}

func textLookKind(kind string) string {
	return "Провайдер не хранит образы вида «" + kind + "»."
}

func textLookExtra(low, high int) string {
	if low == high {
		return fmt.Sprintf("Образу нужно дополнительных снимков: %d.", low)
	}
	return fmt.Sprintf("Образу нужно от %d до %d дополнительных снимков.", low, high)
}

// TextLookNameTaken — имя образа уже занято в аккаунте: провайдер не принимает повтор.
func TextLookNameTaken(name string) string {
	return "Образ «" + name + "» уже есть в аккаунте: выберите другое имя или привяжите готовый образ."
}

// ValidateSavedLookDraft проверяет новый образ по ограничениям провайдера до загрузки снимков:
// имя (без пробелов по краям, в пределах длины), вид, главный снимок и число дополнительных.
// Уникальность имени проверяет адаптер по списку аккаунта.
func ValidateSavedLookDraft(rules SavedLookRules, draft SavedLookDraft) error {
	name := strings.TrimSpace(draft.Name)
	switch {
	case name == "":
		return errors.New(textLookNameEmpty)
	case rules.NameMaxChars > 0 && utf8.RuneCountInString(name) > rules.NameMaxChars:
		return errors.New(textLookNameLong(rules.NameMaxChars))
	case !slices.Contains(rules.Kinds, draft.Kind):
		return errors.New(textLookKind(draft.Kind))
	case strings.TrimSpace(draft.Cover) == "":
		return errors.New(textLookCoverEmpty)
	case len(draft.Extra) < rules.ExtraMin || (rules.ExtraMax > 0 && len(draft.Extra) > rules.ExtraMax):
		return errors.New(textLookExtra(rules.ExtraMin, rules.ExtraMax))
	}
	return nil
}
