package app

import (
	"songframe-go/internal/jobs"
	"songframe-go/internal/wire"
)

// JobsService реализует группу window.api.jobs поверх общего менеджера заданий.
// Менеджер принадлежит main: доменные сервисы запускают задания через него же,
// а страница «Задания» только читает их снимки и журналы.
type JobsService struct{ manager *jobs.Manager }

// NewJobsService связывает группу с менеджером, уже восстановившим прошлые сеансы.
func NewJobsService(manager *jobs.Manager) *JobsService { return &JobsService{manager: manager} }

// List — задания этого и прошлых сеансов, новые сверху; у прошлых журнал пуст до Get.
func (s *JobsService) List() []jobs.Info { return wire.Fill(s.manager.List()) }

// Get возвращает задание с хвостом журнала или null, если такого нет.
func (s *JobsService) Get(id string) *jobs.Info {
	info, ok := s.manager.Get(id)
	if !ok {
		return nil
	}
	info = wire.Fill(info)
	return &info
}

// CopyText — сведения задания и журнал с диска одним текстом для копирования.
func (s *JobsService) CopyText(id string) (string, error) { return s.manager.CopyText(id) }
