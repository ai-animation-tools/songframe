package checks

import "strings"

// Тексты проверок на стороне Go: подписи и описания проверок приходят в renderer списком
// checks.list, названия заданий видны на странице «Задания». Renderer хранит те же строки в
// frontend/src/shared/texts/checks.ts; при изменении текста правятся оба места.
const (
	textSceneDataLabel       = "Данные сцен"
	textSceneDataDescription = "Проверить формат реестра сцен, комплектов и рабочих пакетов. Постановка, исходники и результаты должны храниться в отведённых им файлах."
	textViewsLabel           = "Карточки и списки"
	textViewsDescription     = "Проверить, что монтажный список, раскадровка, карточки и список принятых материалов соответствуют реестру сцен."
	textAssetsLabel          = "Комплекты сцен"
	textAssetsDescription    = "Проверить сохранность файлов принятых сцен и совпадение длительности монтажа с данными о приёмке."
	textWorkspaceLabel       = "Порядок в папке проекта"
	textWorkspaceDescription = "Найти лишние рабочие пакеты, карточки и пустые папки, оставшиеся после приёмки сцен."
	textStatusLabel          = "Статусы планов"
	textStatusDescription    = "Показать готовые планы, текущие попытки и очередь согласования. Помогает выбрать следующий план для работы."
	textAllChecksJobTitle    = "Все проверки"
	textUpdateViewsJobTitle  = "Обновление карточек и списков"
	textReviewShotsRequired  = "Выберите хотя бы один план для пробы."
	textCheckReviewStep      = "Проверка пробы без видео"
	textBuildReviewStep      = "Сборка пробы стыков"
	textReviewStillBuilding  = "Проба ещё собирается. Дождитесь завершения задания."
	textReviewNotFound       = "Собранная проба не найдена. Обновите список."
	// textReviewPlanOnlySuffix — REVIEW_PLAN_ONLY_SUFFIX: по нему уведомления renderer узнают режим.
	textReviewPlanOnlySuffix = " (проверка без видео)"
)

// textUnknownCheck — checksTexts.unknownCheck.
func textUnknownCheck(id string) string { return "Неизвестная проверка: " + id }

// textCheckJobTitle — checksTexts.checkJobTitle.
func textCheckJobTitle(label string) string { return "Проверка: " + label }

// textInvalidReviewShots — checksTexts.invalidReviewShots.
func textInvalidReviewShots(shots []string) string {
	return "Коды планов вида M05 или M05.1: " + strings.Join(shots, ", ")
}

// textReviewJobTitle — checksTexts.reviewJobTitle: «Проба M01 M02» и суффикс режима без видео.
func textReviewJobTitle(shots []string, planOnly bool) string {
	suffix := ""
	if planOnly {
		suffix = textReviewPlanOnlySuffix
	}
	return "Проба " + strings.Join(shots, " ") + suffix
}
