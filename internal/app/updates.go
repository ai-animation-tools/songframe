package app

import (
	"context"

	"songframe-go/internal/updates"
)

// UpdatesService реализует группу window.api.updates: проверку, скачивание и установку новой
// версии приложения по кнопке на странице «Настройки». Состояние живёт в updates.Manager
// всего приложения, поэтому найденная версия и прогресс скачивания переживают переход
// между страницами; адреса пакетов и пути файлов в renderer не попадают.
type UpdatesService struct {
	manager *updates.Manager
}

// NewUpdatesService связывает группу с менеджером обновления точки сборки приложения.
func NewUpdatesService(manager *updates.Manager) *UpdatesService {
	return &UpdatesService{manager: manager}
}

// View возвращает текущее состояние; страница опрашивает его во время скачивания.
func (s *UpdatesService) View() updates.View { return s.manager.View() }

// Check читает последний выпуск публичного репозитория.
func (s *UpdatesService) Check(ctx context.Context) updates.View { return s.manager.Check(ctx) }

// Download скачивает и проверяет пакет найденного выпуска; длится до 30 минут.
func (s *UpdatesService) Download(ctx context.Context) updates.View { return s.manager.Download(ctx) }

// Install ставит скачанный пакет; при замене приложения оно закрывается после ответа.
func (s *UpdatesService) Install() updates.View { return s.manager.Install() }
