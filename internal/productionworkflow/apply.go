package productionworkflow

import "errors"

// TextApplyNotMigrated — отказ Apply до этапа 45g.2: применение предложения к пакету
// (shot_workflow, журнал замены пакета, подготовка запроса) ещё не перенесено.
const TextApplyNotMigrated = "Действие ещё не перенесено в Go-версию SongFrame: применение предложения агента переносит этап 45g.2."

// Apply — apply оригинала: применить готовое актуальное предложение к пакету (новому attempt-NN
// для описания или к выбранному пакету для опор, промпта и запроса). Этап 45g.2 переносит его
// поверх Store, CheckStored, SameSnapshot, ParseProposal, CheckCapabilities, ReadContext и
// ImageRoots; до этого метод зарегистрирован в сервисе и отказывает понятным текстом, ничего не
// меняя в проекте и записи предложения.
func (w *Workflow) Apply(project, shot, packageDir, id string) (View, error) {
	return View{}, errors.New(TextApplyNotMigrated)
}
