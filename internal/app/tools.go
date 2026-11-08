package app

import (
	"songframe-go/internal/tools"
	"songframe-go/internal/wire"
)

// ToolsService реализует window.api.tools: запуск инструмента комплекса по имени на папке проекта.
// В оригинале каждый вызов был процессом Python; здесь перенесённые инструменты выполняются в Go
// внутри приложения (internal/tools), а результат сохраняет код, stdout и stderr процесса
// оригинала, которые разбирает renderer. Состояния нет: инструмент читает файлы проекта заново,
// запись проходит шлюз projectfs.
type ToolsService struct{}

// NewToolsService создаёт сервис инструментов.
func NewToolsService() *ToolsService { return &ToolsService{} }

// Run — tools.run(project, name, args): ToolResult инструмента. Неверное или неизвестное
// имя — ошибка вызова; отказ самого инструмента — результат с ненулевым кодом.
func (s *ToolsService) Run(project, name string, args []string) (tools.Result, error) {
	return wire.Done(tools.Run(project, name, args))
}
