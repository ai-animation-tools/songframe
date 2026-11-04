// Package mediaadapters — таблица Go-адаптеров провайдеров генерации: id провайдера → адаптер.
// Перенос tools/media_adapters.py оригинала для общих проверок (lint_registry): общий код узнаёт
// сервисы только отсюда, не сравнивает имена и не знает их особенностей. Добавление провайдера —
// строка в adapters и папка internal/providers/<id>; удаление — обратное действие.
//
// Отличие от оригинала: тестовая переменная SONGFRAME_MEDIA_ADAPTERS (подмена таблицы модулями
// Python) не переносится — Go-тесты подключают адаптер через Register.
package mediaadapters

import (
	"strings"
	"sync"

	"songframe-go/internal/providers/kling"
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

// klingAdapter связывает таблицу с пакетом провайдера, не давая ему зависеть от таблицы.
type klingAdapter struct{}

func (klingAdapter) SnapshotWarnings(snapshot *pycompat.Dict) ([]Warning, error) {
	items, err := kling.SnapshotWarnings(snapshot)
	if err != nil {
		return nil, err
	}
	result := make([]Warning, len(items))
	for index, item := range items {
		result[index] = Warning{Where: item[0], Message: item[1]}
	}
	return result, nil
}
