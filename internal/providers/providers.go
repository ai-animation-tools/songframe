// Package providers — слой провайдеров медиа приложения: адаптеры, каталог моделей, вход и строки
// страницы «Среда». Его части:
//
//   - таблица адаптеров: платные провайдеры — строки internal/mediaadapters с правилами запроса
//     (mediaapi.RulesProvider), провайдеры-агенты — таблица agentAdapters этого пакета (codex);
//   - свежий каталог моделей платного провайдера (Catalog) и общий платный адаптер (PaidMedia:
//     возможности, выбор модели, подготовка, проверка, отправка через владельца согласования,
//     получение оригиналов);
//   - исполнители опор и обложек провайдеров-агентов (agentexec);
//   - вход к провайдеру и его проверка, строки страницы «Среда» (Layer);
//   - раздел «Указания агенту» документа выбранного провайдера (Guide).
//
// Общий код и интерфейс узнают о провайдере только из реестра internal/mediaproviders и этих
// таблиц: имена сервисов здесь не сравниваются, особенности сервиса живут в папке его адаптера
// (internal/providers/<id>). Пакет не знает, что такое Kling или Codex, кроме строки таблицы.
// Вход и проверка входа вызывают mediaapi.Loginer/AuthStatusReader адаптера напрямую.
package providers

import (
	"strings"
	"sync"

	"songframe-go/internal/agents"
	"songframe-go/internal/jscompat"
	"songframe-go/internal/mediaadapters"
	"songframe-go/internal/mediaapi"
	"songframe-go/internal/mediaproviders"
	"songframe-go/internal/providers/agentexec"
	"songframe-go/internal/providers/codex"
)

// Тексты (applicationTexts и providerTexts из frontend/src/shared/texts), которые слой
// отдаёт renderer ошибками и результатами. TestTextsMatchFrontend сверяет их со словарями.
const (
	textPaidExecutorMissing   = "Для провайдера не подключён исполнитель платного запроса."
	textProviderUnsupported   = "Провайдер не поддерживается. Сохранённое значение оставлено без изменений."
	textMediaKindUnknown      = "Неизвестный вид медиа."
	textImageAgentUnsupported = "Выбранный провайдер изображений не рисует опоры программой-агентом."
	textImageExecutorMissing  = "Нет исполнителя опор для программы-агента этого задания."
)

// textAuthCheckFailed — providerTexts.authCheckFailed(title).
func textAuthCheckFailed(title string) string {
	return "Не удалось проверить вход в " + title + ". Проверьте соединение и повторите проверку."
}

// textLoginIncomplete — providerTexts.loginIncomplete(title).
func textLoginIncomplete(title string) string {
	return "Вход в " + title + " не завершён. Подтвердите вход в браузере и повторите при необходимости."
}

// textLoginCancelled — providerTexts.loginCancelled(title).
func textLoginCancelled(title string) string { return "Вход в " + title + " отменён." }

// Title — mediaProviderTitle(value, fallback): название провайдера из реестра по id (регистр и
// пробелы по краям несущественны); неизвестное значение — fallback.
func Title(value any, fallback string) string {
	if id, ok := mediaproviders.Normalize(value); ok {
		info, _ := mediaproviders.Lookup(id)
		return info.Title
	}
	return fallback
}

// Paid — платный провайдер таблицы: id и правила нормализации запроса. Вход, проверка входа и
// строки «Среды» берутся из той же строки таблицы адаптеров.
type Paid struct {
	ID    string
	Rules mediaapi.RequestRules
	// adapter — строка internal/mediaadapters: необязательные возможности (вход, «Среда»).
	adapter mediaadapters.Adapter
}

// normalizedID — id провайдера без учёта регистра и пробелов по краям; не строка — "".
func normalizedID(provider any) string {
	text, ok := provider.(string)
	if !ok {
		return ""
	}
	return strings.ToLower(jscompat.Trim(text))
}

// PaidAdapter — платный адаптер по id (регистр и крайние пробелы
// несущественны). Платный — строка таблицы internal/mediaadapters с правилами запроса.
func PaidAdapter(provider any) (Paid, bool) {
	id := normalizedID(provider)
	if id == "" {
		return Paid{}, false
	}
	adapter, ok := mediaadapters.Get(id)
	if !ok {
		return Paid{}, false
	}
	rules, ok := adapter.(mediaapi.RulesProvider)
	if !ok {
		return Paid{}, false
	}
	return Paid{ID: id, Rules: rules.RequestRules(), adapter: adapter}, true
}

// PaidAdapters — все платные провайдеры в порядке реестра провайдеров медиа.
func PaidAdapters() []Paid {
	result := []Paid{}
	for _, id := range mediaproviders.IDs() {
		if paid, ok := PaidAdapter(id); ok {
			result = append(result, paid)
		}
	}
	return result
}

// AgentAdapter — провайдер, генерацию которого исполняет
// программа-агент из реестра. Images создаёт исполнителя опор, Cover — исполнителя обложки и
// референса с программой и моделью, закреплёнными при подготовке.
type AgentAdapter struct {
	ID     string
	Images func(deps agentexec.Deps) agentexec.Executor
	Cover  func(config agents.Settings) CoverRunner
}

// Контракт исполнителей провайдеров-агентов (internal/providers/agentexec) для потребителей слоя:
// производства (опоры) и генерации обложек и референсов.
type (
	CoverRunner        = agentexec.CoverRunner
	CoverInput         = agentexec.CoverInput
	KeyframeImages     = agentexec.Images
	AgentImagesRequest = agentexec.ImagesRequest
	AgentImageExecutor = agentexec.Executor
	AgentImagePrepared = agentexec.Prepared
	AgentImagePermit   = agentexec.Permit
)

var (
	agentMu sync.RWMutex
	// agentAdapters — строка на провайдера-агента; удаление провайдера — удаление строки и папки.
	agentAdapters = map[string]AgentAdapter{
		codex.ID: {
			ID:     codex.ID,
			Images: func(deps agentexec.Deps) agentexec.Executor { return codex.NewImages(deps) },
			Cover:  func(config agents.Settings) CoverRunner { return codex.CoverRunner{Config: config} },
		},
	}
)

// Agent — адаптер провайдера-агента по id (регистр и крайние пробелы
// несущественны).
func Agent(provider any) (AgentAdapter, bool) {
	agentMu.RLock()
	defer agentMu.RUnlock()
	adapter, ok := agentAdapters[normalizedID(provider)]
	return adapter, ok
}

// Agents — провайдеры-агенты в порядке реестра провайдеров медиа.
func Agents() []AgentAdapter {
	result := []AgentAdapter{}
	for _, id := range mediaproviders.IDs() {
		if adapter, ok := Agent(id); ok {
			result = append(result, adapter)
		}
	}
	return result
}

// RegisterAgent — тестовая регистрация провайдера-агента (например, test-agent); возвращает откат.
func RegisterAgent(adapter AgentAdapter) func() {
	agentMu.Lock()
	defer agentMu.Unlock()
	id := normalizedID(adapter.ID)
	previous, existed := agentAdapters[id]
	agentAdapters[id] = adapter
	return func() {
		agentMu.Lock()
		defer agentMu.Unlock()
		if existed {
			agentAdapters[id] = previous
		} else {
			delete(agentAdapters, id)
		}
	}
}
