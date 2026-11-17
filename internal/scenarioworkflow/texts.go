package scenarioworkflow

import (
	"strconv"
	"strings"

	"songframe/internal/plural"
)

// Сообщения scenarioTexts.main и commonTexts.proposal (frontend/src/shared/texts/scenario.ts и
// common.ts). Пользователь видит их дословно на странице «Сценарий» (проблемы
// входов, отказ действия, сообщение предложения), поэтому меняются только вместе с эталонами
// testdata/golden/scenario-workflow.
const (
	textRegistryInvalidDocument    = "Сценарий: неверная структура документа."
	textRegistryInvalidReferences  = "Сценарий: неверная карта референсов."
	textRegistryInvalidParts       = "Сценарий: неверные части песни."
	textTreatmentLoglineMissing    = "Сценарий: заполните логлайн."
	textRegistryDecodedDuration    = "Конец сценария расходится с длительностью декодированного звука."
	textRegistryReferencesMismatch = "Карта референсов должна соответствовать кастингу."
	textRegistryDirectionMissing   = "Заполните общую визуальную постановку."
	textProposalInvalidDocument    = "Нужен один JSON-документ с schemaVersion 1 и ожидаемым pass."
	textProposalUnknownFields      = "В ответе есть поля вне контракта предложения."
	textProposalCastMissing        = "Нет кастинга для проверки сценария."
	textProposalScaffoldChanged    = "Ответ изменил исходный каркас сценария."
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
	textWorkflowStartBlocked       = "Сначала утвердите актуальные кастинг и части; дождитесь завершения текущего задания."
	textWorkflowReviseSelection    = "Для доработки выберите существующий план и заполните замечание."
	textInputsChanged              = "Входные файлы изменились при подготовке задания. Повторите запуск."
	textProposalNotApplicable      = "Применимо только завершённое актуальное предложение. Подготовьте новый запрос."
	textPairApprovalStale          = "Утверждение кастинга и частей устарело."
	textAgentResultMissing         = "Нет успешно завершённого результата агента."
	textStaleProjectFiles          = "Предложение устарело: изменились файлы проекта."
	textPairApprovalUnavailable    = "Нет корректной неутверждённой пары кастинга и частей."
	textScenesApprovalUnavailable  = "Сначала утвердите актуальную пару и заполните весь сценарий."
	textProposalMissing            = "Предложение больше не найдено."
	textCardsDirectoryRequired     = "plan/animatic/cards: нужна обычная папка."
	textShotsDirectoryRequired     = "assets/shots: нужна обычная папка."
	textSnapshotMissing            = "Нет исходного снимка файлов сценарного предложения. Повторите подготовку."
	textApplyPairRequired          = "Для применения нужны кастинг и части."
	textProposedRegistryMissing    = "Нет предложенного сценария."
	textStaleMaterials             = "Предложение устарело: изменился состав материалов или производных файлов проекта. Подготовьте новое предложение."
	textRecoveryPending            = "Не завершено восстановление прошлого применения сценария. Перезапустите приложение."
)

func textRegistryInvalidShot(id *string) string {
	if id == nil {
		return "Сценарий: неверная структура плана."
	}
	return "Сценарий, " + *id + ": неверная структура плана."
}

func textRegistryInvalidStateFrom(id string) string {
	return "Сценарий, " + id + ": неверный state_from."
}

func textRegistryInvalidStatePhases(id string, phases []string) string {
	text := "Сценарий, " + id + ": в state_changes допустимы только фазы before и after"
	if phases != nil {
		text += ", получено: " + strings.Join(phases, ", ")
	}
	return text + ". Коды сущностей вкладываются в фазы."
}

func textRegistryInvalidStateChanges(id string) string {
	return "Сценарий, " + id + ": изменения состояния должны быть объектом."
}

func textRegistryInvalidStateProperties(id string) string {
	return "Сценарий, " + id + ": неверные свойства состояния."
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
	return "Осталась незаполненная постановка: " + strconv.Itoa(count) + " " + plural.Word(count, "план", "плана", "планов") +
		" (" + strings.Join(shown, ", ") + more + ")."
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

// Тексты проверки сценария (check.go, check_report.go, check_images.go).
const (
	textCheckBusy            = "Дождитесь окончания задания агента в этом проекте."
	textCheckNoScenario      = "Проверять пока нечего: нужны кастинг, части и планы сценария."
	textCheckScenarioInvalid = "Сначала исправьте ошибки сценария, которые показывает страница: агенту нужен читаемый сценарий."
	textCheckInterrupted     = "Проверка прервалась: задание агента не завершилось. Запустите её снова."
	textCheckCancelled       = "Проверка остановлена."
	textCheckAgentFailed     = "Агент не закончил проверку. Запустите её снова."
	textCheckNotObject       = "Агент вернул отчёт не в формате JSON. Запустите проверку снова."
	textCheckShape           = "Отчёт агента не того вида: нужны schemaVersion 1, summary и issues без других полей. Запустите проверку снова."
	textCheckEmpty           = "пустой текст"
	textCheckIssueShape      = "поля не того вида"
	textCheckIssueGroup      = "неизвестная группа"
	textCheckIssueSeverity   = "неизвестная важность"
)

func textCheckLong(length, limit int) string {
	return strconv.Itoa(length) + " знаков при пределе " + strconv.Itoa(limit)
}

func textCheckSummary(reason string) string {
	return "Итог отчёта агента не принят: " + reason + ". Запустите проверку снова."
}

func textCheckTooMany(count, limit int) string {
	return "Агент вернул " + strconv.Itoa(count) + " проблем при пределе " + strconv.Itoa(limit) + ". Запустите проверку снова."
}

func textCheckIssue(number int, reason string) string {
	return "Проблема " + strconv.Itoa(number) + " отчёта агента не принята: " + reason + ". Запустите проверку снова."
}

func textCheckIssueField(field, reason string) string { return field + ": " + reason }

func textCheckIssueShot(id string) string { return "неизвестный план " + id }

func textCheckIssueEntity(id string) string { return "неизвестная сущность " + id }

// textCheckImagesProblem — пояснение агенту, почему часть изображений кастинга не приложена; пусто,
// если приложены все.
func textCheckImagesProblem(unreadable []string, skipped int) string {
	parts := []string{}
	if len(unreadable) > 0 {
		parts = append(parts, "Не удалось прочитать изображения: "+strings.Join(unreadable, ", ")+".")
	}
	if skipped > 0 {
		parts = append(parts, "Не приложено изображений из-за предела вложений: "+strconv.Itoa(skipped)+".")
	}
	return strings.Join(parts, " ")
}

// textCheckTooLarge — контекст проверки больше предела задания агента: сценарий слишком велик для
// одной проверки.
func textCheckTooLarge(size, limit int) string {
	return "Сценарий слишком большой для одной проверки: " + strconv.Itoa(size/1024) + " КБ данных при пределе задания агента " + strconv.Itoa(limit/1024) + " КБ."
}

// Тексты структурных правок проверки (check_report.go, check_fixes.go).
const (
	textCheckChangeShape    = "поля правки не того вида"
	textCheckChangePhase    = "кадр правки — before или after"
	textCheckChangeRepeated = "то же место правится дважды"
	textCheckFixNoReport    = "Нет готового отчёта проверки: запустите проверку сценария."
	textCheckFixNone        = "Выберите проблемы, которые нужно исправить."
)

func textCheckChangesTooMany(count, limit int) string {
	return "changes: " + strconv.Itoa(count) + " правок при пределе " + strconv.Itoa(limit)
}

func textCheckChange(number int, reason string) string {
	return "правка " + strconv.Itoa(number) + ": " + reason
}

func textCheckChangeShot(id string) string {
	return "план " + id + " не указан в shots проблемы"
}

func textCheckChangeProperty(entity, property string) string {
	return "у сущности " + entity + " нет свойства " + property
}

// textCheckFixUnknown — номер проблемы не из отчёта: интерфейс показывал другой отчёт.
func textCheckFixUnknown(number int) string {
	return "Проблемы " + strconv.Itoa(number) + " нет в отчёте проверки. Обновите страницу."
}

func textCheckFixNoChanges(title string) string {
	return "«" + title + "»: приложение не может исправить это само. Доработайте план с агентом или исправьте вручную."
}

func textCheckFixDone(title string) string {
	return "«" + title + "»: правки уже внесены."
}

// textCheckFixConflict — две выбранные проблемы задают разные значения одному месту.
func textCheckFixConflict(shot, entity, property string) string {
	return "Выбранные проблемы задают разные значения одному свойству (" + shot + ", " + entity + ", «" + property + "»). Исправьте их по одной."
}

// textCheckFixMissing — план или сущность правки исчезли из сценария после проверки.
func textCheckFixMissing(shot, entity string) string {
	return "В сценарии больше нет плана " + shot + " или сущности " + entity + ". Запустите проверку снова."
}

// textCheckFixKeepInvalid — план из «оставить принятым» не принят или правка его не задевает.
func textCheckFixKeepInvalid(shot string) string {
	return "План " + shot + " не принят или не задет этими правками. Откройте исправление снова."
}
