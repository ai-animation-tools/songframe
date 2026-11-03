package app

import (
	"songframe-go/internal/timing"
	"songframe-go/internal/wire"
)

// TimingService реализует группу window.api.timing. В этапе 49 доступен только просмотр
// (timing.view, как viewTiming оригинала); сохранение и подготовка вокала — этапы 42–43.
type TimingService struct{}

// NewTimingService создаёт сервис без состояния: каждый просмотр читает файлы проекта заново.
func NewTimingService() *TimingService { return &TimingService{} }

// View возвращает разметку, строки текста и сведения трека без записи в проект.
func (s *TimingService) View(project string) (timing.View, error) {
	return wire.Done(timing.ViewProject(project))
}
