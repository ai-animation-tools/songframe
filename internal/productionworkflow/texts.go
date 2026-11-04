package productionworkflow

import (
	"strings"

	"songframe-go/internal/jscompat"
	"songframe-go/internal/mediaproviders"
)

// Тексты прохода агента производства: productionTexts.main.workflow, main.proposal и main.apply
// оригинала (src/shared/texts/production.ts на 634fd94) дословно. Они уходят в ошибки Wails и в
// записи предложений, поэтому меняются только вместе с оригиналом поведения.
const (
	textSceneChangedReason          = "постановка плана изменилась после подготовки пакета: оставьте пакет для текущей постановки, доработайте описание или подготовьте новый пакет"
	textPackageFolderRequired       = "Выберите отдельный пакет в plan/batches или plan/awaiting."
	textShotIDRequired              = "Укажите один явный ID плана Mxx."
	textSceneRegistryInvalid        = "Нет корректного plan/scenes.json."
	textShotWindowInvalid           = "Неверное кадровое окно плана."
	textVideoSettingsIncomplete     = "Заполните настройки генерации видео"
	textPackageMissingOrWrongShot   = "Пакет отсутствует или относится к другому плану."
	textJobInterrupted              = "Задание прервано; подготовьте новое предложение."
	textJobCancelled                = "Подготовка остановлена; при необходимости подготовьте новое предложение."
	textProposalIncomplete          = "Агент не завершил подготовку предложения."
	textAgentRefused                = "Агент отказался подготовить предложение. Возможно, в сценарии есть противоречия."
	textOperationBusy               = "идёт задание агента или операция пакета"
	textResolveProposalFirst        = "сначала примените или отклоните текущее предложение"
	textResolvePackageQuestionFirst = "сначала ответьте на вопрос согласования в карточке пакета"
	textResolveImageFirst           = "сначала завершите согласование или получение изображения"
	textApproveScenarioFirst        = "сценарий не утверждён в приложении: утвердите кастинг, трактовку и сцены на странице «Сценарий»"
	textAcceptedDescriptionFrames   = "нужен выбранный пакет с принятым описанием и опорами"
	textSentAttemptNeedsRetry       = "попытка уже отправлена: дальше только повтор или возврат с замечанием"
	textSpeechRequiredHint          = "речевой план: сначала подготовьте WAV речи в блоке «Речь»"
	textFramesAcceptedPromptNext    = "опоры приняты, видеопромпт готовится этой кнопкой после принятия описания"
	textCreateAndAcceptFramesFirst  = "сначала создайте и примите опоры"
	textApplyAndAcceptDescription   = "сначала примените и примите описание плана"
	textAcceptedDescriptionRequired = "нужен выбранный пакет с принятым описанием"
	textAttemptAlreadySent          = "попытка уже отправлена"
	textFramesAlreadyAccepted       = "опоры уже приняты"
	textFramePlanMissing            = "в пакете нет плана опор: примените описание с промптами опор"
	textAcceptDescriptionFirst      = "сначала примите описание плана"
	textStartParametersInvalid      = "Неверные параметры подготовки производства."
	textCurrentImageUnresolved      = "Сначала завершите согласование или получение текущего изображения. Новая отправка автоматически не создаётся."
	textWaitForJob                  = "Дождитесь завершения текущего задания."
	textResolveProposalFirstError   = "Сначала примените или отклоните текущее предложение."
	textScenarioAndSettingsRequired = "Сначала утвердите актуальный сценарий и настройки генерации."
	textPackageUnavailable          = "Выберите доступный пакет приложения."
	textResolveQuestionFirst        = "Сначала ответьте на текущий вопрос согласования."
	textDescriptionOrFramesReview   = "На этом этапе требуется согласование описания или опор."
	textStageUnavailable            = "Запрошенный этап ещё не доступен."
	textContinuityFailed            = "Не удалось получить врезку непрерывности."
	textProviderCapabilitiesMissing = "Выбранный провайдер видео не объявляет возможности."
	textSpeechRequired              = "Речевой план: сначала подготовьте WAV речи в блоке «Речь»."
	textInputsChangedDuringPrep     = "Входные материалы изменились во время подготовки задания."
	textDiscardUnavailable          = "Предложение недоступно для отклонения; выполняющееся задание сначала отмените."
	textProposalDiscarded           = "Предложение отклонено пользователем."
	// TextDescriptionAndFramePlanRequired — messages.descriptionAndFramePlanRequired: generateFrames
	// и importFrames без утверждённого описания и плана опор (45g.3).
	TextDescriptionAndFramePlanRequired = "Сначала утвердите описание и план опор."
	// TextApplyUnavailable — applyUnavailable: Apply возможен только для завершённого актуального
	// предложения (45g.2).
	TextApplyUnavailable = "Применимо только завершённое актуальное предложение."
)

// Тексты проверки ответа агента (productionTexts.main.proposal).
const (
	textUnknownFields                = "Ответ содержит неизвестные поля."
	textPathRequired                 = "Нужен путь файла."
	textParentMissing                = "Не найден родитель пути."
	textDurationPositiveInteger      = "Длительность запроса должна быть положительным целым числом секунд."
	textFrameImageRequired           = "Добавьте изображение хотя бы для одной опоры."
	textFrameCandidateInvalid        = "Неверный кандидат опоры."
	textFrameCandidateOrderInvalid   = "Кандидаты должны относиться к неутверждённым опорам плана, без повторов и в порядке плана; нужен абсолютный путь изображения."
	textProposalVersionOrStage       = "Неверная версия или этап предложения."
	textDescriptionInvalid           = "Описание требует текст, длительность и минимум две опоры."
	textFrameStructureInvalid        = "Неверная структура опоры."
	textFramePlanInvalid             = "Неверные ID, роли, порядок, промпт или референсы опор."
	textFrameBoundariesInvalid       = "Первая опора должна быть на 0, последняя — на границе запроса."
	textVideoPromptRequired          = "Нужен непустой видеопромпт."
	textRequestSpecificationRequired = "Нужна спецификация запроса."
	textRequestStructureInvalid      = "Неверная модель, команда, параметры, входы или число результатов."
	textRequestReservedParameter     = "Недопустимое техническое поле параметров; файлы задаются только через inputs, промпт — сохранённым файлом."
	textRequestDurationMismatch      = "Длительность запроса отличается от согласованного плана опор."
	textRequestInputInvalid          = "Неверный вход запроса."
	textRequestInputPathInvalid      = "Вход запроса должен ссылаться на объявленный исходник или утверждённую опору."
	textProviderUnspecified          = "не указан"
	// textProposalNotJSON — осознанное отличие от оригинала: ответ, который не разбирается как JSON,
	// оригинал отклонял англоязычным SyntaxError V8 (зависит от версии движка). Go пишет русский
	// текст; распознанный отказ текстом по-прежнему заменяется на textAgentRefused.
	textProposalNotJSON = "Ответ агента не является JSON-документом предложения."
)

// Тексты истории image-попыток пакета (productionTexts.main.apply), нужные проверке оплаты.
const (
	textWorkflowCorrupt              = "Повреждён workflow рабочего пакета."
	textActiveImageHistoryMissing    = "Активная image-попытка отсутствует в истории."
	textImageHistoryCorrupt          = "Повреждена история запросов изображений."
	textImageHistoryEntryInvalid     = "Неверная запись истории image-попытки."
	textImageFolderUnavailable       = "Папка image-попытки недоступна внутри пакета."
	textImageFoldersOverlap          = "Папки image-попыток пересекаются."
	textImageReplacesVideoRequest    = "Image-попытка не должна заменять video request_dir."
	textImageHashOrKindMismatch      = "SHA или kind защищённой image-попытки не совпадает с историей."
	textImageContainsVideoOrPaidRequ = "Image-попытка содержит видео или вложенную неизвестную оплату."
)

// Подписи «Ждут вашего действия» для непринятого предложения (productionTexts.workflow).
const (
	textAttentionStale   = "предложение агента устарело: отклоните его или подготовьте заново"
	textAttentionReady   = "предложение агента ждёт применения или отклонения"
	textAttentionInvalid = "ответ агента не прошёл проверку: просмотрите и отклоните"
	textAttentionFailed  = "задание агента завершилось ошибкой: просмотрите и отклоните"
)

func textFileUnreadable(path string) string {
	return "Не удалось прочитать файл: " + path
}

func textPackageLink(path string) string { return "Пакет содержит ссылку: " + path }

func textShotMissing(shot string) string {
	return "План " + shot + " отсутствует в реестре."
}

// providerTitles — mediaProviderTitles(kind): названия провайдеров вида медиа в порядке реестра
// через « или ».
func providerTitles(kind string) string {
	titles := []string{}
	for _, id := range mediaproviders.IDs() {
		if mediaproviders.Supports(id, kind) {
			info, _ := mediaproviders.Lookup(id)
			titles = append(titles, info.Title)
		}
	}
	return strings.Join(titles, " или ")
}

func textVideoSettingsRequired() string {
	return textVideoSettingsIncomplete + " проекта: поддерживается провайдер " + providerTitles(mediaproviders.Video) + "."
}

func textProviderLipSyncUnsupported(provider string) string {
	return "Речевой план: " + provider + " не синхронизирует губы с заданным звуком. Снимите отметку «Липсинк» у плана на странице «Сценарий» или выберите другого провайдера видео."
}

func textSpeechWindowTooLong(seconds, provider string, max float64) string {
	return "Речевой план: окно плана " + seconds + " с длиннее, чем " + provider + " принимает звук (до " + jscompat.NumberToString(max) + " с). Разделите план на странице «Сценарий»."
}

func textSpeechLengthOutOfRange(seconds string, min, max float64) string {
	return "речевой план: WAV длится " + seconds + " с, а провайдер принимает звук от " + jscompat.NumberToString(min) + " до " + jscompat.NumberToString(max) + " с — обрежьте заново в блоке «Речь»"
}

func textAcceptFrameFirstHint(frame string) string {
	return "сначала утвердите опору " + frame + " или отправьте её на доработку"
}

func textResolveSceneChangedPackageFirst(reason string) string {
	return "Сначала решите судьбу пакета: " + reason + "."
}

// textProviderModelsFailed — providerModelsFailed: provider "" — undefined (провайдер не из реестра).
func textProviderModelsFailed(provider, problem string) string {
	if provider == "" {
		provider = "провайдера видео"
	}
	if problem == "" {
		problem = "нет объявлений аккаунта"
	}
	return "Не удалось получить актуальные модели " + provider + ": " + problem
}

func textProviderAudioUnsupported(provider string) string {
	if provider == "" {
		provider = "провайдера"
	}
	return "Модели " + provider + " в этом аккаунте не принимают звуковой вход: точный липсинк по WAV недоступен. Чтобы сделать план без синхронизации губ, снимите отметку «Липсинк» у плана на странице «Сценарий»."
}

func textPathOutsideProject(path string) string {
	return "Путь выходит из проекта: " + path
}

func textLinkOutsideProject(path string) string {
	return "Ссылка ведёт за пределы проекта: " + path
}

func textDurationRuleViolation(seconds float64, rule string, window float64) string {
	return "Длительность " + jscompat.NumberToString(seconds) + " с нарушает правило " + rule + " для окна " + jscompat.NumberToString(window) + " с."
}

func textFrameFileRequired(frame any) string {
	return jscompat.ToString(frame) + ": нужен обычный файл изображения."
}

func textFrameFormatRequired(frame any) string {
	return jscompat.ToString(frame) + ": требуется PNG, JPEG или WebP."
}

func textSpeechDurationRange(min, max float64) string {
	return "Речевой план: длительность запроса должна быть от " + jscompat.NumberToString(min) + " до " + jscompat.NumberToString(max) + " с — столько звука принимает провайдер видео."
}

func textVideoAdapterMissing(provider string) string {
	return "Для провайдера видео " + provider + " не подключён исполнитель запроса."
}

func textInputFlagUnknown(flag, flags string) string {
	return "Неизвестный флаг входа " + flag + "; допустимы input и " + flags + "."
}
