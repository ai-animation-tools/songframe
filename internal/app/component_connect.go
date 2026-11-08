package app

import (
	"context"
	"errors"

	"songframe/internal/components"
	"songframe/internal/wire"
)

// Connect подключает выбранный файл или устанавливает распознанный архив одним пользовательским действием.
// Сервис сам планирует проверку готовности; renderer не выбирает технический режим и не запускает Check.
func (s *ComponentsService) Connect(ctx context.Context, componentID, path string) (components.Snapshot, error) {
	state, err := s.manager.Connect(ctx, componentID, path)
	if err != nil {
		return wire.Fill(state), err
	}
	return wire.Fill(s.requestCheck()), nil
}

// Download явно получает закреплённый пакет и подключает его вместо неисправного внешнего пути.
// При частичном успешном publish проверяются уже доступные компоненты; отмена не возобновляет остановленную работу.
func (s *ComponentsService) Download(ctx context.Context, componentIDs []string) (components.InstallSnapshot, error) {
	state, err := s.manager.Download(ctx, componentIDs)
	if ctx.Err() == nil && !errors.Is(err, context.Canceled) {
		s.requestCheck()
	}
	return wire.Fill(state), err
}
