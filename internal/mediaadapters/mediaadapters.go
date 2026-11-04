// Package mediaadapters — таблица Go-адаптеров провайдеров генерации: id провайдера → адаптер.
// Перенос tools/media_adapters.py оригинала: общий код (lint_registry, media_request, cost_check,
// shot_workflow, regenerate_shot) узнаёт сервисы только отсюда, не сравнивает имена и не знает их
// особенностей. Добавление провайдера — строка в adapters и папка internal/providers/<id>;
// удаление — обратное действие.
//
// Возможности адаптера — необязательные интерфейсы с одним методом. SnapshotWarner объявлен
// здесь; возможности платной попытки (ValidateSpec, ValidatePrompt, FrozenFields, TaskTraceID,
// Submit, Poll, Fetch, Capabilities, Account, PricingFile, NormalizeInputs, PromptWarningChars,
// Login, AuthStatus) — в листовом пакете internal/mediaapi, чтобы пакет провайдера мог
// возвращать его ошибки (NotSubmitted, RejectedRequest), не импортируя эту таблицу.
//
// Отличие от оригинала: тестовая переменная SONGFRAME_MEDIA_ADAPTERS (подмена таблицы модулями
// Python) не переносится — Go-тесты подключают адаптер через Register.
package mediaadapters

import (
	"strings"
	"sync"

	"songframe-go/internal/pycompat"
)

// Warning — предупреждение адаптера о снимке запроса: поле и текст.
type Warning struct {
	Where   string
	Message string
}

// Adapter — адаптер провайдера. Необязательные возможности объявляются отдельными интерфейсами
// (SnapshotWarner), как hasattr(service, …) оригинала.
type Adapter interface{}

// SnapshotWarner — адаптер, который знает модельные предупреждения снимка принятого комплекта
// (snapshot_warnings оригинала). Ошибка — исключение Python на данных неожиданной формы.
type SnapshotWarner interface {
	SnapshotWarnings(snapshot *pycompat.Dict) ([]Warning, error)
}

var (
	mu sync.RWMutex
	// adapters — строка на провайдера; ключ — нормализованный id.
	adapters = map[string]Adapter{
		"kling": klingAdapter{},
	}
)

// normalized — id провайдера без учёта регистра и пробелов по краям (strip().casefold());
// не строка — пустой id. Свёртка регистра — Unicode lower, для латинских id совпадает с casefold.
func normalized(provider any) string {
	text, ok := provider.(string)
	if !ok {
		return ""
	}
	return strings.ToLower(pycompat.Strip(text))
}

// Known — known(provider): у провайдера есть адаптер.
func Known(provider any) bool {
	id := normalized(provider)
	if id == "" {
		return false
	}
	mu.RLock()
	defer mu.RUnlock()
	_, ok := adapters[id]
	return ok
}

// Lookup — adapter(provider) оригинала: адаптер провайдера либо ValueError с текстом оригинала
// (repr id — как f"{provider!r}" Python: строка в кавычках, None, число).
func Lookup(provider any) (Adapter, error) {
	adapter, ok := Get(provider)
	if !ok {
		return nil, pycompat.New(pycompat.ValueError, "Для провайдера генерации "+pycompat.Repr(provider)+
			" нет адаптера: укажите provider подключённого сервиса.")
	}
	return adapter, nil
}

// Get — адаптер провайдера; false — адаптера нет.
func Get(provider any) (Adapter, bool) {
	mu.RLock()
	defer mu.RUnlock()
	adapter, ok := adapters[normalized(provider)]
	return adapter, ok
}

// Register подключает адаптер под id (для тестов общей логики на провайдере test) и возвращает
// отмену регистрации.
func Register(id string, adapter Adapter) func() {
	key := normalized(id)
	mu.Lock()
	previous, existed := adapters[key]
	adapters[key] = adapter
	mu.Unlock()
	return func() {
		mu.Lock()
		defer mu.Unlock()
		if existed {
			adapters[key] = previous
		} else {
			delete(adapters, key)
		}
	}
}
