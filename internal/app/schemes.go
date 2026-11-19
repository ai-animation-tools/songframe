package app

import (
	"songframe/internal/schemes"
	"songframe/internal/wire"
)

// SchemesService реализует группу window.api.schemes: просмотр и сохранение схем локаций
// plan/schemes.json для страницы «Схемы». Состояния нет: каждый вызов читает файлы проекта заново,
// запись атомарна и проходит шлюз projectfs.
type SchemesService struct{}

// NewSchemesService создаёт сервис схем.
func NewSchemesService() *SchemesService { return &SchemesService{} }

// View — schemes.view: схемы, локации кастинга, проблемы и локации без вида сверху; ничего не пишет.
func (s *SchemesService) View(project string) (schemes.View, error) {
	return wire.Done(schemes.ViewProject(project))
}

// Save — schemes.save: проверка по кастингу и атомарная запись; отказ оставляет прежний файл.
func (s *SchemesService) Save(project string, document schemes.Document) (schemes.Document, error) {
	return wire.Done(schemes.Save(project, document))
}
