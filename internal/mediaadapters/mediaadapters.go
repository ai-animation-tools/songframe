// Package mediaadapters ведёт таблицу адаптеров провайдеров генерации: id провайдера → адаптер.
// Общий код (lint_registry, media_request, cost_check, shot_workflow, regenerate_shot) узнаёт
// сервисы только отсюда, не сравнивает имена и не знает их особенностей. Добавление провайдера —
// строка в adapters и папка internal/providers/<id>; удаление — обратное действие.
//
// Возможности адаптера — необязательные интерфейсы с одним методом. SnapshotWarner объявлен
// здесь; возможности платной попытки (ValidateSpec, ValidatePrompt, FrozenFields, TaskTraceID,
// Submit, Poll, Fetch, Capabilities, Account, PricingFile, NormalizeInputs, PromptWarningChars,
// Login, AuthStatus) — в листовом пакете internal/mediaapi, чтобы пакет провайдера мог
// возвращать его ошибки (NotSubmitted, RejectedRequest), не импортируя эту таблицу. Тесты
// подключают адаптер через Register.
package mediaadapters

import (
	"strings"
	"sync"

	"songframe/internal/toolrt"
)

// Warning — предупреждение адаптера о снимке запроса: поле и текст.
type Warning struct {
	Where   string
	Message string
}

// Adapter — адаптер провайдера. Необязательные возможности объявляются отдельными интерфейсами
// (SnapshotWarner) и проверяются утверждением типа.
type Adapter interface{}

// SnapshotWarner — адаптер, который знает модельные предупреждения снимка принятого комплекта.
// Ошибка — исключение toolrt на данных неожиданной формы.
type SnapshotWarner interface {
	SnapshotWarnings(snapshot *toolrt.Dict) ([]Warning, error)
}

var (
	mu sync.RWMutex
	// adapters — строка на провайдера; ключ — нормализованный id.
	adapters = map[string]Adapter{
		"kling": klingAdapter{},
	}
)

// normalized — id провайдера без учёта регистра и пробельных символов по краям (toolrt.Strip,
// затем Unicode lower); не строка — пустой id. Для латинских id lower равносилен полной свёртке
// регистра.
func normalized(provider any) string {
	text, ok := provider.(string)
	if !ok {
		return ""
	}
	return strings.ToLower(toolrt.Strip(text))
}

// Known — у провайдера есть адаптер.
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

// Lookup — адаптер провайдера либо исключение toolrt ValueError с текстом, зафиксированным
// эталонами (id печатается через toolrt.Repr: строка в кавычках, None, число).
func Lookup(provider any) (Adapter, error) {
	adapter, ok := Get(provider)
	if !ok {
		return nil, toolrt.New(toolrt.ValueError, "Для провайдера генерации "+toolrt.Repr(provider)+
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
