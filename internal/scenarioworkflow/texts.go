package scenarioworkflow

import (
	"strconv"
	"strings"
)

// Сообщения scenarioTexts.main и commonTexts.proposal (frontend/src/shared/texts/scenario.ts и
// common.ts). Пользователь видит их дословно на странице «Сценарий» (проблемы
// входов, отказ действия, сообщение предложения), поэтому меняются только вместе с эталонами
// testdata/golden/scenario-workflow.
const (
	textRegistryInvalidDocument    = "Реестр: неверная структура документа."
	textRegistryInvalidReferences  = "Реестр: неверная карта референсов."
	textRegistryInvalidParts       = "Реестр: неверные части песни."
	textTreatmentLoglineMissing    = "Трактовка: заполните логлайн."
	textRegistryDecodedDuration    = "Конец реестра расходится с decoded duration."
	textRegistryReferencesMismatch = "Карта референсов должна соответствовать кастингу."
	textRegistryDirectionMissing   = "Заполните общую визуальную постановку."
	textProposalInvalidDocument    = "Нужен один JSON-документ с schemaVersion 1 и ожидаемым pass."
	textProposalUnknownFields      = "В ответе есть поля вне контракта предложения."
	textProposalCastMissing        = "Нет кастинга для проверки реестра."
	textProposalScaffoldChanged    = "Ответ изменил исходный каркас реестра."
	textProposalPatchesMissing     = "Нужен непустой список patches выбранных планов."
	textProposalPatchesInvalid     = "patches может менять только постановку выбранных неповторяющихся ID."
	textSnapshotInvalidDocuments   = "Неверный снимок документов."
	textWorkflowInvalidState       = "Неверная запись утверждения сценария plan/scenario-workflow.json."
	textWorkflowInvalidProposal    = "Неверная запись предложения."
	textWorkflowInvalidMetadata    = "Неверные метаданные предложения."
	textSourcePathUnreadable       = "Не удалось прочитать путь исходного файла. Загрузите его заново на странице «Исходники»."
	textSourceOutsideProject       = "Исходный файл находится вне папки исходников проекта. Загрузите его заново на странице «Исходники»."
	textProjectSettingsUnreadable  = "Не удалось прочитать настройки проекта. Выберите папку проекта заново."
	textSourcesMissing             = "Сведения об исходниках отсутствуют или повреждены. Загрузите трек, текст песни и идею на странице «Исходники»."
	textScenarioSourcesRequired    = "Для сценария нужны трек, текст песни и идея. Загрузите недостающие файлы на странице «Исходники»."
	textSourceReferenceInvalid     = "Сведения об исходном референсе повреждены. Загрузите его заново на странице «Исходники»."
	textSourceImageInvalid         = "Сведения об исходном изображении повреждены. Загрузите его заново на странице «Исходники»."
	textScenarioTimingRequired     = "Для сценария нужна разметка строк и длительность трека. На странице «Тайминги» разметьте трек и сохраните результат."
	textTimingTrackMismatch        = "Разметка относится к другому треку."
	textTimingUnverified           = "Подтвердите на слух все строки разметки."
	textTimingIncomplete           = "Разметка должна покрывать все строки песни."
	textProposalInterrupted        = "Задание прервано; подготовьте новое предложение."
	textProposalCancelled          = "Подготовка остановлена; при необходимости подготовьте новое предложение."
	textProposalAgentFailed        = "Агент завершил задание без успешного результата."
	textWorkflowInvalidStart       = "Неверные параметры сценарного прохода."
	textWorkflowStartBlocked       = "Сначала утвердите актуальные кастинг и трактовку; дождитесь завершения текущего задания."
	textWorkflowReviseSelection    = "Для доработки выберите существующий план и заполните замечание."
	textInputsChanged              = "Входные файлы изменились при подготовке задания. Повторите запуск."
	textProposalNotApplicable      = "Применимо только завершённое актуальное предложение. Подготовьте новый запрос."
	textPairApprovalStale          = "Утверждение кастинга и трактовки устарело."
	textAgentResultMissing         = "Нет успешно завершённого результата агента."
	textStaleProjectFiles          = "Предложение устарело: изменились файлы проекта."
	textPairApprovalUnavailable    = "Нет корректной неутверждённой пары кастинга и трактовки."
	textScenesApprovalUnavailable  = "Сначала утвердите актуальную пару и заполните весь сценарий."
	textProposalMissing            = "Предложение больше не найдено."
	textCardsDirectoryRequired     = "plan/animatic/cards: нужна обычная папка."
	textShotsDirectoryRequired     = "assets/shots: нужна обычная папка."
	textSnapshotMissing            = "Нет исходного снимка файлов сценарного предложения. Повторите подготовку."
	textApplyPairRequired          = "Для применения нужны кастинг и трактовка."
	textProposedRegistryMissing    = "Нет предложенного реестра планов."
	textStaleMaterials             = "Предложение устарело: изменился состав материалов или производных файлов проекта. Подготовьте новое предложение."
	textRecoveryPending            = "Не завершено восстановление прошлого применения сценария. Перезапустите приложение."
)

func textRegistryInvalidShot(id *string) string {
	if id == nil {
		return "Реестр: неверная структура плана."
	}
	return "Реестр, " + *id + ": неверная структура плана."
}

func textRegistryInvalidStateFrom(id string) string {
	return "Реестр, " + id + ": неверный state_from."
}

func textRegistryInvalidStatePhases(id string, phases []string) string {
	text := "Реестр, " + id + ": в state_changes допустимы только фазы before и after"
	if phases != nil {
		text += ", получено: " + strings.Join(phases, ", ")
	}
	return text + ". Коды сущностей вкладываются в фазы."
}

func textRegistryInvalidStateChanges(id string) string {
	return "Реестр, " + id + ": изменения состояния должны быть объектом."
}

func textRegistryInvalidStateProperties(id string) string {
	return "Реестр, " + id + ": неверные свойства состояния."
}

func textPartDirectionMissing(id string) string {
	return "Часть " + id + ": заполните постановку."
}

func textPartUnknownEntity(part, entity string) string {
	return "Часть " + part + ": неизвестная сущность " + entity + "."
}

func textStateUnknownEntity(shot, entity string) string {
	return shot + ": неизвестная сущность состояния " + entity + "."
}

func textStateUnknownProperty(shot, entity, property string) string {
	return shot + ": неизвестное свойство " + entity + "." + property + "."
}

// textUnfilledShots — незаполненные планы: число планов со склонением countLabel и первые шесть кодов.
func textUnfilledShots(ids []string) string {
	count := len(ids)
	shown := ids
	if len(shown) > 6 {
		shown = shown[:6]
	}
	more := ""
	if count > 6 {
		more = " и другие"
	}
	return "Осталась незаполненная постановка: " + strconv.Itoa(count) + " " + plural(count, "план", "плана", "планов") +
		" (" + strings.Join(shown, ", ") + more + ")."
}

// plural — склонение по числу, как plural из frontend/src/shared/plural.ts: 1 план, 2 плана, 5 планов.
func plural(count int, one, few, many string) string {
	n := count % 100
	if n < 0 {
		n = -n
	}
	last := n % 10
	switch {
	case n >= 11 && n <= 14:
		return many
	case last == 1:
		return one
	case last >= 2 && last <= 4:
		return few
	}
	return many
}

func textProposalShotWindowChanged(shot string) string {
	return shot + ": нельзя менять ID, текст и кадровые окна каркаса."
}

func textSourceFileChanged(path string) string {
	return path + ": файл отсутствует или изменён после загрузки исходников."
}

func textSourceImageChanged(path string) string {
	return path + ": изображение отсутствует или изменено после загрузки."
}

func textCastImageMissing(name, path string) string {
	return name + ": отсутствует " + path + "."
}

func textProposalImageMissing(name, image string) string {
	return name + ": отсутствует изображение source/" + image + "."
}

func textProposalImageOutsideContext(name string) string {
	return name + ": изображение не входило в исходный контекст. Загрузите его в исходники и повторите запрос."
}

func textCastWithoutReferences(names string) string {
	return "Без референса в кастинге: " + names + ". Агент описывает их в опорах только текстом; если нужна узнаваемость, добавьте изображение на странице «Исходники» и обновите кастинг."
}

func textInvalidRelativePath(path string) string {
	return "Недопустимый относительный путь сценария: " + path
}

func textOrdinaryPathRequired(name string, directory bool) string {
	kind := "файл"
	if directory {
		kind = "каталог"
	}
	return name + ": для применения сценария нужен обычный " + kind + ", без ссылки."
}

func textStaleFile(path string) string {
	return "Предложение устарело: изменился " + path + ". Подготовьте новое предложение."
}

func textStagingDirectoryRequired(path string) string {
	return path + ": staging требует обычную папку без ссылки."
}

func textStagingSymlink(path string) string {
	return path + ": staging не копирует символические ссылки."
}

func textAcceptedVideoPathRequired(path string) string {
	return path + ": не задан относительный путь принятого видео."
}

func textAcceptedVideoMissing(path string) string {
	return "Нет принятого видео: " + path
}

func textStaleAddedFile(path string) string {
	return "Предложение устарело: появился производный файл " + path + ". Подготовьте новое предложение."
}

func textStaleStagingFile(path string) string {
	return "Предложение устарело: изменился " + path + " при подготовке проверки."
}

func textValidationFailed(name, details string) string {
	return "Не пройдена проверка " + name + ": " + details
}

func textValidationExitCode(code *int) string {
	if code == nil {
		return "код null"
	}
	return "код " + strconv.Itoa(*code)
}

// textScaffoldFailed — applicationTexts.scaffoldFailed: отказ подготовки каркаса для прохода сцен.
func textScaffoldFailed(details string) string {
	return "Не удалось подготовить каркас: " + details
}
