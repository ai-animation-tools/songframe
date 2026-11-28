package production

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"songframe/internal/dynvalue"
	"songframe/internal/mediaadapters"
	"songframe/internal/mediaapi"
	"songframe/internal/mediaproviders"
	"songframe/internal/savedlooks"
)

// Сохранённые образы замороженного запроса перед отправкой. Запрос несёт ID образов, которые
// были в аккаунте при сборке; до оплаты их наличие сверяется одним бесплатным списком
// библиотеки: образ, которого больше нет, блокирует отправку, сменённый или устаревший —
// предупреждение в вопросе «Отправить». Пересозданный образ получает новый ID, поэтому такой
// запрос собирается заново («Изменить») с новым подтверждением.

// looksCheckTimeout — срок списка образов аккаунта при оценке и отправке.
const looksCheckTimeout = 90 * time.Second

// Тексты проверки образов.
const (
	textLooksAdapterMissing = "Провайдер запроса не хранит сохранённые образы: соберите запрос заново кнопкой «Изменить»."
	textLooksCheckFailed    = "Не удалось проверить сохранённые образы запроса в аккаунте провайдера видео: %s Повторите, когда сервис ответит."
)

func textLooksBlocked(entities []string) string {
	return fmt.Sprintf("Образов запроса больше нет в аккаунте провайдера видео (%s): отправка невозможна. Создайте или привяжите образ у референса на «Исходниках» и соберите запрос заново кнопкой «Изменить».", strings.Join(entities, ", "))
}

// checkLooks — образы замороженного запроса request, требующие внимания (savedlooks.Verify);
// у запроса без образов — пустой список без обращения к аккаунту.
func checkLooks(project string, request *Request) ([]savedlooks.UseCheck, error) {
	if request == nil || len(request.SavedLooks) == 0 {
		return []savedlooks.UseCheck{}, nil
	}
	provider := ""
	if request.Provider != nil {
		provider, _ = mediaproviders.Normalize(*request.Provider)
	}
	adapter, found := mediaadapters.Get(provider)
	looks, supported := adapter.(mediaapi.SavedLooks)
	if !found || !supported {
		return nil, errors.New(textLooksAdapterMissing)
	}
	dir, err := mediaadapters.StateDir()
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), looksCheckTimeout)
	defer cancel()
	report, err := savedlooks.Store{Dir: dir}.Check(ctx, looks, provider, project, looksCheckTimeout)
	if err != nil {
		return nil, fmt.Errorf(textLooksCheckFailed, strings.TrimRight(err.Error(), ".")+".")
	}
	return savedlooks.Verify(report, request.SavedLooks), nil
}

// looksBlocked — ошибка отправки, если среди проверок есть образ, которого нет в аккаунте.
func looksBlocked(checks []savedlooks.UseCheck) error {
	if !savedlooks.Blocking(checks) {
		return nil
	}
	entities := []string{}
	for _, check := range checks {
		if check.Status == savedlooks.UseMissing {
			entities = append(entities, check.Entity)
		}
	}
	return errors.New(textLooksBlocked(entities))
}

// lostLooks — сущности с меткой [@код] в видеопромпте попытки prompt, чьих образов нет в
// замороженном запросе: выбранная модель образы не принимает, и при сборке метки убраны. Имена —
// из кастинга проекта, без имени — код. Пустой список — облик никто не теряет.
func lostLooks(project, prompt string, uses []mediaapi.SavedLookUse) []string {
	lost := []string{}
	codes := savedlooks.Codes(prompt)
	if len(codes) == 0 {
		return lost
	}
	names := map[string]string{}
	cast := readJSON(filepath.Join(project, "plan", "cast.json"))
	if entities, ok := dynvalue.AsArray(dynvalue.Get(cast, "entities")); ok {
		for _, entity := range entities {
			id, _ := dynvalue.Get(entity, "id").(string)
			if name := dynvalue.Trim(dynvalue.ToString(dynvalue.Get(entity, "name"))); id != "" && name != "" {
				names[id] = name
			}
		}
	}
	for _, code := range codes {
		if slices.ContainsFunc(uses, func(use mediaapi.SavedLookUse) bool { return use.Code == code }) {
			continue
		}
		name := names[code]
		if name == "" {
			name = code
		}
		lost = append(lost, name)
	}
	return lost
}
