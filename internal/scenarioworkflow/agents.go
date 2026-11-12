package scenarioworkflow

import "songframe/internal/agents"

// AgentStartInput — задание агенту в режиме предложения (StartInput менеджера internal/agents).
// Сценарный проход заполняет Project (реальный путь проекта), Task («ai-clip-scenario:<pass>»),
// Prompt и Context; Images и RetryOf не использует.
type AgentStartInput = agents.StartInput

// AgentPlace — место задания в проекте для журнала отправок.
type AgentPlace = agents.Place

// AgentInputHashes — хеши входа задания агента: SHA-256 промпта и контекста.
type AgentInputHashes = agents.InputHashes

// AgentJob — снимок задания внешнего агента (Job менеджера internal/agents, ключи TS AgentJob),
// который вид сценария отдаёт renderer как view.job. Сценарий читает только Project, Status,
// ExitCode, Message и Result: в Result итоговый текст агента — JSON предложения.
type AgentJob = agents.Job

// Agents — узкая часть менеджера внешних агентов, нужная сценарию (запуск, чтение и список
// заданий). Реализация — менеджер internal/agents: он проверяет вход, выбранного
// агента и занятость проекта, добавляет постоянные инструкции проекта к промпту и запускает CLI
// через internal/process. Методы вызываются из сервисного потока Wails и должны быть безопасны
// для конкурентного вызова.
type Agents interface {
	// Start запускает задание и возвращает его снимок в состоянии running. Ошибка — отказ до
	// запуска (неверный вход, проект занят, агент не выбран); задания тогда нет.
	Start(input AgentStartInput) (AgentJob, error)
	// Get — копия задания по ID; false, если задания нет (в том числе после перезапуска без
	// истории).
	Get(id string) (AgentJob, bool)
	// List — копии заданий проекта (project — реальный путь, как Project задания).
	List(project string) []AgentJob
}
