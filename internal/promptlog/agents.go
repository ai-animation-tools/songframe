package promptlog

import (
	"log"

	"songframe/internal/agents"
)

// AgentJournal — журнал отправок для менеджера агентов (agents.Options.Journal): задание
// записывается при запуске с полным промптом, контекстом и вложениями, итог — при завершении.
// Сбой записи журнала не останавливает задание агента: он пишется в лог процесса.
type AgentJournal struct{}

// Begin — запись running по заданию job.
func (AgentJournal) Begin(job agents.Job, prompt, context string, images []string, place *agents.Place) {
	kind := KindAgent
	if job.Permissions == agents.PermissionsWorkspaceWrite {
		kind = KindAgentImages
	}
	record := Record{
		ID: job.ID, Kind: kind, Title: job.Task, Executor: job.Provider, Model: job.Model, StartedAt: job.StartedAt,
		Prompt: prompt, Context: context, Attachments: Attach(job.Project, images),
	}
	if place != nil {
		record.Place = &Place{Page: place.Page, Shot: place.Shot}
	}
	if err := Begin(job.Project, record); err != nil {
		log.Printf("Не удалось записать отправку агента %s в журнал проекта: %v", job.ID, err)
	}
}

// End — итог задания job: статус, ответ агента (result) и причина сбоя.
func (AgentJournal) End(job agents.Job) {
	failure := job.Message
	if job.Diagnostic != "" && failure != "" {
		failure = "[" + job.Diagnostic + "] " + failure
	}
	if err := End(job.Project, job.ID, job.Status, job.Result, failure, nil); err != nil {
		log.Printf("Не удалось записать итог отправки агента %s в журнал проекта: %v", job.ID, err)
	}
}
