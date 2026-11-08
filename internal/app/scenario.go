package app

import (
	"encoding/json"

	"songframe/internal/cast"
	"songframe/internal/dynvalue"
	"songframe/internal/scenario"
	"songframe/internal/scenesave"
	"songframe/internal/wire"
)

// Документы сценария (кастинг, трактовка, реестр) передаются как json.RawMessage: Go разбирает
// их в упорядоченное дерево dynvalue, чтобы проверки и записанные байты совпадали с эталонами
// (порядок ключей, лишние поля, числа), и возвращает записанный документ тем же JSON.

// parseDocument — документ из renderer; пустое тело — null, как отсутствующий аргумент.
func parseDocument(raw json.RawMessage) (any, error) {
	if len(raw) == 0 {
		return nil, nil
	}
	return dynvalue.Parse(raw)
}

// document — записанный документ для ответа. Срез json.RawMessage всегда непустой («null» при
// ошибке): wire.Fill превратил бы nil в пустой срез, а это не JSON.
func document(value any, err error) (json.RawMessage, error) {
	if err != nil {
		return json.RawMessage("null"), err
	}
	return dynvalue.Raw(value), nil
}

// CastService реализует группу window.api.cast: просмотр, создание из исходников и сохранение
// plan/cast.json вместе с каноническими описаниями в source/manifest.json. Состояния нет:
// каждый вызов читает файлы проекта заново; запись проходит шлюз projectfs.
type CastService struct{}

// NewCastService создаёт сервис кастинга.
func NewCastService() *CastService { return &CastService{} }

// View — cast.view: кастинг, опись исходников, пути изображений и проблемы без записи.
func (s *CastService) View(project string) (cast.View, error) {
	return wire.Done(cast.ViewProject(project))
}

// Init — cast.init: кастинг из референсов исходников или дополнение существующего.
func (s *CastService) Init(project string) (json.RawMessage, error) {
	return wire.Done(document(cast.Init(project)))
}

// Save — cast.save: нормализация, проверка изображений и запись кастинга с описаниями.
func (s *CastService) Save(project string, input json.RawMessage) (json.RawMessage, error) {
	value, err := parseDocument(input)
	if err != nil {
		return json.RawMessage("null"), err
	}
	return wire.Done(document(cast.Save(project, value)))
}

// ScenarioService реализует группу window.api.scenario: просмотр и готовность реестра,
// сохранение трактовки и реестра (с режимом production/keep и оценкой затронутых планов),
// проверку черновика и врезку непрерывности. Без состояния; запись — через шлюз projectfs.
type ScenarioService struct{}

// NewScenarioService создаёт сервис сценария.
func NewScenarioService() *ScenarioService { return &ScenarioService{} }

// Status — scenario.status: missing, empty, invalid или ready.
func (s *ScenarioService) Status(project string) string {
	return string(scenario.RegistryStatus(project))
}

// View — scenario.view: документы сценария, разметка, строки текста и проблемы без записи.
func (s *ScenarioService) View(project string) (scenario.View, error) {
	return wire.Done(scenario.ViewProject(project))
}

// SaveTreatment — scenario.saveTreatment: структурная нормализация и запись plan/treatment.json
// черновиком; содержательные проблемы запись не блокируют (их отдаёт ValidateTreatment).
func (s *ScenarioService) SaveTreatment(project string, input json.RawMessage) (json.RawMessage, error) {
	value, err := parseDocument(input)
	if err != nil {
		return json.RawMessage("null"), err
	}
	return wire.Done(document(scenario.SaveTreatment(project, value)))
}

// ValidateTreatment — scenario.validateTreatment: проблемы черновика трактовки (стык частей,
// длительность трека, коды, названия) без записи, чтобы их можно было показать до сохранения.
func (s *ScenarioService) ValidateTreatment(project string, input json.RawMessage) ([]string, error) {
	value, err := parseDocument(input)
	if err != nil {
		return []string{}, err
	}
	return wire.Done(scenario.ValidateProjectTreatment(project, value))
}

// SaveScenes — scenario.saveScenes: запись реестра; mode=keep переносит новые отпечатки в
// принятые комплекты и пакеты затронутых планов.
func (s *ScenarioService) SaveScenes(project string, input json.RawMessage, mode string) (json.RawMessage, error) {
	value, err := parseDocument(input)
	if err != nil {
		return json.RawMessage("null"), err
	}
	return wire.Done(document(scenesave.SaveScenesWithMode(project, value, mode)))
}

// SaveImpact — scenario.saveImpact: какие планы затронет сохранение черновика, без записи.
func (s *ScenarioService) SaveImpact(project string, input json.RawMessage) (scenesave.Impact, error) {
	value, err := parseDocument(input)
	if err != nil {
		return wire.Fill(scenesave.Impact{}), err
	}
	return wire.Done(scenesave.SaveImpact(project, value))
}

// ValidateScenes — scenario.validateScenes: проблемы черновика с кастингом проекта, без записи.
func (s *ScenarioService) ValidateScenes(project string, input json.RawMessage) ([]string, error) {
	value, err := parseDocument(input)
	if err != nil {
		return []string{}, err
	}
	return wire.Done(scenario.ValidateProjectScenes(project, value))
}

// Brief — scenario.brief: врезка непрерывности плана в фазе before или after.
func (s *ScenarioService) Brief(project string, input json.RawMessage, shot, phase string) (scenario.Brief, error) {
	value, err := parseDocument(input)
	if err != nil {
		return scenario.Brief{}, err
	}
	brief, err := scenario.ProjectBrief(project, value, shot, phase)
	if err != nil {
		return scenario.Brief{}, err
	}
	return wire.Fill(brief), nil
}
