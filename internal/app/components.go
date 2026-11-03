package app

import (
	"context"
	"songframe-go/internal/components"
	"sync"
)

// componentProbe оставляет единственный синхронный проверяющий механизм в Manager.
// Сервис управляет только сроком фонового запроса и объединением запросов после изменений.
type componentProbe func(context.Context, []string, bool) (components.Snapshot, error)

// ComponentsService владеет автоматическими проверками всего сеанса приложения.
// State остаётся лёгким, уход со страницы не отменяет работу, сеть запускается только явным скачиванием пользователя.
type ComponentsService struct {
	manager  *components.Manager
	probe    componentProbe
	mu       sync.Mutex
	lifetime context.Context
	shutdown context.CancelFunc
	cancel   context.CancelFunc
	running  bool
	pending  bool
	closed   bool
	done     chan struct{}
}

// NewComponentsService проверяет найденные инструменты и модели в фоне при запуске.
// Окно и просмотр проекта не ждут окончания проверок; отсутствующие файлы не скачиваются.
func NewComponentsService(manager *components.Manager) *ComponentsService {
	s := newComponentsService(manager, manager.Check)
	s.requestCheck()
	return s
}

// newComponentsService позволяет тестам задержать probe без процессов и нативного runtime.
func newComponentsService(manager *components.Manager, probe componentProbe) *ComponentsService {
	ctx, cancel := context.WithCancel(context.Background())
	return &ComponentsService{manager: manager, probe: probe, lifetime: ctx, shutdown: cancel}
}

// State объединяет лёгкое обнаружение с фазой запланированной фоновой проверки.
// Флаг выставлен до запуска goroutine, поэтому UI не предлагает конфликтующее изменение пути.
func (s *ComponentsService) State() components.Snapshot {
	state := s.manager.State()
	s.mu.Lock()
	state.Checking = state.Checking || s.running
	s.mu.Unlock()
	return state
}

// requestCheck запускается только при старте и после изменения подключения или установки.
// Открытие страницы и poll State не запускают проверок; конфликтующее изменение объединяется
// в один последующий проход, включая зазор между освобождением Manager.work и завершением worker.
func (s *ComponentsService) requestCheck() components.Snapshot {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return s.State()
	}
	if s.running {
		s.pending = true
		s.mu.Unlock()
		return s.State()
	}
	ctx, cancel := context.WithCancel(s.lifetime)
	s.cancel = cancel
	s.running = true
	s.done = make(chan struct{})
	done := s.done
	s.mu.Unlock()
	go s.refreshLoop(ctx, cancel, done)
	return s.State()
}

// refreshLoop принадлежит сервису, а не Wails-запросу или странице renderer.
// После успешного изменения во время завершения предыдущего прохода новый контекст
// проверяет текущие пути. Обычный missing остаётся состоянием карточки, без error toast.
func (s *ComponentsService) refreshLoop(ctx context.Context, cancel context.CancelFunc, done chan struct{}) {
	defer close(done)
	for {
		operations := []string{}
		for _, op := range s.manager.State().Operations {
			operations = append(operations, op.ID)
		}
		_, _ = s.probe(ctx, operations, false)
		cancel()
		s.mu.Lock()
		if !s.closed && s.pending {
			s.pending = false
			ctx, cancel = context.WithCancel(s.lifetime)
			s.cancel = cancel
			s.mu.Unlock()
			continue
		}
		s.running = false
		s.pending = false
		s.cancel = nil
		s.mu.Unlock()
		return
	}
}

// Configure сохраняет выбор и автоматически проверяет его после освобождения Manager.work.
// Неизменившиеся файлы используют подтверждения текущего сеанса по fingerprint.
func (s *ComponentsService) Configure(selection components.Selection) (components.Snapshot, error) {
	state, err := s.manager.Configure(selection)
	if err != nil {
		return state, err
	}
	return s.requestCheck(), nil
}

// Check оставлен для диагностики разработчика; обычный UI только читает состояние.
func (s *ComponentsService) Check(ctx context.Context, operations []string, force bool) (components.Snapshot, error) {
	return s.manager.Check(ctx, operations, force)
}

// Cancel останавливает текущую волну и отложенное расширение; poll State их не возобновляет.
func (s *ComponentsService) Cancel() {
	s.mu.Lock()
	s.pending = false
	// Отмена Manager выполняется до допуска следующей волны: иначе она могла бы
	// отменить уже новый Check, начатый после освобождения предыдущего worker.
	if s.cancel != nil {
		s.cancel()
	}
	s.manager.Cancel()
	s.mu.Unlock()
}

// Catalog показывает закреплённые варианты загрузки; готовая карточка не предлагает их скачивать.
func (s *ComponentsService) Catalog() []components.InstallPackage { return s.manager.Catalog() }

// Installation возвращает прогресс и журнал без ожидания длительного Install.
func (s *ComponentsService) Installation() components.InstallSnapshot {
	return s.manager.Installation()
}

// Install скачивает или импортирует явный набор и автоматически проверяет успешно опубликованные файлы.
// При отмене не запускает новую проверку вслед за остановленным пользователем действием.
func (s *ComponentsService) Install(ctx context.Context, request components.InstallRequest) (components.InstallSnapshot, error) {
	state, err := s.manager.Install(ctx, request)
	if err == nil {
		s.requestCheck()
	}
	return state, err
}

// CancelInstall останавливает только установку, сохраняя предыдущий набор компонентов.
func (s *ComponentsService) CancelInstall() { s.manager.CancelInstall() }

// ServiceShutdown отменяет lifetime и pending, не ожидая непрерываемого native CreateSession.
// При обычной работе завершение операций и освобождение sessions остаются у Manager.
func (s *ComponentsService) ServiceShutdown() error {
	s.mu.Lock()
	s.closed = true
	s.pending = false
	s.shutdown()
	s.mu.Unlock()
	s.manager.Cancel()
	s.manager.CancelInstall()
	return nil
}
