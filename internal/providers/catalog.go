package providers

import (
	"context"
	"errors"
	"regexp"
	"sync"
	"time"

	"songframe/internal/dynvalue"
	"songframe/internal/tools"
)

// Тексты каталога.
func textInvalidCapabilities(title string) string {
	return title + " вернул неверное объявление возможностей."
}

func textInvalidCapabilityCommands(title string) string {
	return title + " вернул неверный состав команд возможностей."
}

func textCapabilitiesNotConfirmed(title string) string {
	return title + " не подтвердил возможности."
}

// catalogTimeout — предел запроса каталога: 30 с ожидания сервиса и 5 с на запуск инструмента
// (--timeout 30 и общий предел 35 с).
const catalogTimeout = 35 * time.Second

// Runner — запуск инструмента комплекса (tools.RunContext): тесты подменяют его.
type Runner func(ctx context.Context, project, name string, args []string) (tools.Result, error)

// defaultRunner — инструменты комплекса выполняются в процессе приложения.
var defaultRunner Runner = tools.RunContext

// CatalogReport — объявления моделей одной команды: models — объект «id модели → объявление»
// в порядке ответа сервиса.
type CatalogReport struct {
	Command string
	Models  *dynvalue.Object
}

// CatalogProblem — отказ одной команды каталога.
type CatalogProblem struct {
	Command string
	Message string
}

// Catalog — объявления и отказы по командам вида медиа.
type Catalog struct {
	Reports  []CatalogReport
	Problems []CatalogProblem
}

// catalogCall — текущий запрос каталога, который ждут все одновременные вызовы.
type catalogCall struct {
	done    chan struct{}
	catalog Catalog
	err     error
}

// Catalogs — единый свежий каталог моделей платного провайдера для настроек и производства. Две
// панели, StrictMode и возвращение на страницу ждут один текущий запрос к аккаунту; завершённые
// ответы не кэшируются: после успеха или ошибки следующий вызов получает новый каталог. Нулевое
// значение готово к работе и использует tools.RunContext.
type Catalogs struct {
	Run Runner

	mu      sync.Mutex
	pending map[string]*catalogCall
}

// Read возвращает каталог команд вида kind провайдера provider (media_request capabilities).
// Команды вида медиа знает адаптер провайдера; слой получает объявления и ошибки по командам.
// Отмена ctx прекращает ожидание этого вызова, но не общий запрос.
func (c *Catalogs) Read(ctx context.Context, project, provider, kind string) (Catalog, error) {
	key := dynvalue.Stringify(&dynvalue.Array{Items: []any{project, provider, kind}})
	c.mu.Lock()
	if c.pending == nil {
		c.pending = map[string]*catalogCall{}
	}
	call, found := c.pending[key]
	if !found {
		call = &catalogCall{done: make(chan struct{})}
		c.pending[key] = call
		go func() {
			call.catalog, call.err = c.fetch(project, provider, kind)
			c.mu.Lock()
			delete(c.pending, key)
			c.mu.Unlock()
			close(call.done)
		}()
	}
	c.mu.Unlock()
	select {
	case <-call.done:
		return call.catalog, call.err
	case <-ctx.Done():
		return Catalog{}, ctx.Err()
	}
}

// fetch выполняет один запрос каталога; общий запрос не зависит от отмены отдельного вызова.
func (c *Catalogs) fetch(project, provider, kind string) (Catalog, error) {
	run := c.Run
	if run == nil {
		run = defaultRunner
	}
	ctx, cancel := context.WithTimeout(context.Background(), catalogTimeout)
	defer cancel()
	title := Title(provider, provider)
	result, err := run(ctx, project, "media_request", []string{"capabilities", "--provider", provider, "--kind", kind, "--json", "--timeout", "30"})
	if err != nil {
		return Catalog{}, err
	}
	if result.Code == nil || *result.Code != 0 {
		if message := dynvalue.Trim(result.Stderr); message != "" {
			return Catalog{}, errors.New(message)
		}
		return Catalog{}, errors.New(textCapabilitiesNotConfirmed(title))
	}
	value, err := dynvalue.Parse([]byte(result.Stdout))
	if err != nil {
		return Catalog{}, err
	}
	return parseCatalog(value, title)
}

// parseCatalog проверяет состав ответа: команды непустые и не повторяются ни среди объявлений,
// ни среди отказов; у объявления — объект models, у отказа — непустое сообщение.
func parseCatalog(value any, title string) (Catalog, error) {
	_, ok := value.(*dynvalue.Object)
	reports, reportsOK := dynvalue.AsArray(dynvalue.Get(value, "reports"))
	problems, problemsOK := dynvalue.AsArray(dynvalue.Get(value, "problems"))
	if !ok || !reportsOK || !problemsOK {
		return Catalog{}, errors.New(textInvalidCapabilities(title))
	}
	catalog := Catalog{Reports: []CatalogReport{}, Problems: []CatalogProblem{}}
	seen := map[string]bool{}
	invalid := errors.New(textInvalidCapabilityCommands(title))
	for _, entry := range reports {
		_, ok := entry.(*dynvalue.Object)
		command, isString := dynvalue.Get(entry, "command").(string)
		models, modelsOK := dynvalue.Get(entry, "models").(*dynvalue.Object)
		if !ok || !isString || command == "" || seen[command] || !modelsOK {
			return Catalog{}, invalid
		}
		seen[command] = true
		catalog.Reports = append(catalog.Reports, CatalogReport{Command: command, Models: models})
	}
	for _, entry := range problems {
		_, ok := entry.(*dynvalue.Object)
		command, isString := dynvalue.Get(entry, "command").(string)
		message, messageOK := dynvalue.Get(entry, "message").(string)
		if !ok || !isString || command == "" || seen[command] || !messageOK || dynvalue.Trim(message) == "" {
			return Catalog{}, invalid
		}
		seen[command] = true
		catalog.Problems = append(catalog.Problems, CatalogProblem{Command: command, Message: message})
	}
	return catalog, nil
}

// audioSlot — имя слота звукового входа.
var audioSlot = regexp.MustCompile(`(?i)audio|voice|sound`)

// AcceptsAudioInput сообщает, есть ли у какой-нибудь модели каталога
// звуковой вход (слот с audio, voice или sound в имени). Без него точный липсинк по WAV невозможен.
func AcceptsAudioInput(reports []CatalogReport) bool {
	for _, report := range reports {
		if report.Models == nil {
			continue
		}
		for _, id := range report.Models.Keys() {
			slots, ok := dynvalue.Get(report.Models.Value(id), "slots").(*dynvalue.Object)
			if !ok {
				continue
			}
			for _, slot := range slots.Keys() {
				if audioSlot.MatchString(slot) {
					return true
				}
			}
		}
	}
	return false
}
