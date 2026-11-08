package app

import (
	"context"
	"io/fs"

	"songframe/internal/dynvalue"
	"songframe/internal/newproject"
	"songframe/internal/projectfile"
	"songframe/internal/status"
	"songframe/internal/wire"
	"songframe/resources"
)

// Методы ProjectService, которые пишут проект: создание из встроенного шаблона,
// переименование и редактируемые настройки plan/project.json. Логика и тексты ошибок — в
// internal/newproject и internal/projectfile; сервис связывает их с историей и статусом.

// projectTemplate — встроенный шаблон проекта; тест может подменить поле template сервиса.
func (s *ProjectService) projectTemplate() fs.FS {
	if s.template != nil {
		return s.template
	}
	return resources.ProjectTemplate()
}

// ValidateNew — projects.validateNew: проблемы формы «Новый проект» без записи.
func (s *ProjectService) ValidateNew(input newproject.Input) []string {
	return wire.Fill(newproject.Validate(input))
}

// Create — projects.create: новая папка из встроенного шаблона, git init при наличии git, затем
// открытие как текущего проекта. Ошибка открытия (например, кавычка в названии ломает JSON
// маркера) возвращается, созданная папка при этом остаётся.
func (s *ProjectService) Create(input newproject.Input) (status.ProjectStatus, error) {
	target, err := newproject.Create(context.Background(), s.projectTemplate(), input)
	if err != nil {
		return status.ProjectStatus{}, err
	}
	return wire.Done(s.Open(target))
}

// Rename — projects.rename: меняется только название в plan/project.json и в истории; папка,
// MP4 и настройки генерации не переносятся. Нечитаемая история отказывает до записи маркера.
func (s *ProjectService) Rename(path, name string) (status.ProjectStatus, error) {
	target := dynvalue.Resolve("", path)
	next, err := projectfile.Rename(target, name, func() error {
		_, err := s.state.History()
		return err
	})
	if err != nil {
		return status.ProjectStatus{}, err
	}
	if err := s.state.Rename(target, next); err != nil {
		return status.ProjectStatus{}, err
	}
	return wire.Done(status.Compute(target))
}

// Settings — projects.settings: название, имя MP4, инструкции агенту и блок generation.
func (s *ProjectService) Settings(project string) (projectfile.Settings, error) {
	return wire.Done(projectfile.ReadSettings(project))
}

// SaveSettings — projects.saveSettings: проверка, слияние с сохранённым generation и атомарная запись.
func (s *ProjectService) SaveSettings(project string, settings projectfile.SettingsInput) (projectfile.Settings, error) {
	return wire.Done(projectfile.WriteSettings(project, settings))
}
