package productionworkflow

import (
	"fmt"
	"strings"

	"songframe/internal/dynvalue"
	"songframe/internal/mediaproviders"
)

// Тексты прохода агента производства: подготовка, проверка предложения и его применение. Они
// уходят в ошибки Wails и в записи предложений и зафиксированы эталонами
// testdata/golden/production-workflow*, поэтому меняются только вместе с поведением.
const (
	textSceneChangedReason          = "постановка плана изменилась после подготовки попытки: оставьте попытку для текущей постановки, доработайте описание или подготовьте новую попытку"
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
	textOperationBusy               = "идёт задание агента или операция попытки"
	textResolveProposalFirst        = "сначала примените или отклоните текущее предложение"
	textResolvePackageQuestionFirst = "сначала ответьте на вопрос согласования на шаге плана"
	textResolveImageFirst           = "сначала завершите согласование или получение изображения"
	textApproveScenarioFirst        = "сценарий не утверждён в приложении: утвердите кастинг, трактовку и сцены на странице «Сценарий»"
	textAcceptedDescriptionFrames   = "нужна выбранная попытка с принятым описанием и опорами"
	textSentAttemptNeedsRetry       = "попытка уже отправлена: дальше только повтор или возврат с замечанием"
	textSpeechRequiredHint          = "речевой план: сначала подготовьте WAV речи в блоке «Речь»"
	textFramesAcceptedPromptNext    = "опоры приняты, видеопромпт готовится этой кнопкой после принятия описания"
	textCreateAndAcceptFramesFirst  = "сначала создайте и примите опоры"
	textApplyAndAcceptDescription   = "сначала примените и примите описание плана"
	textAcceptedDescriptionRequired = "нужна выбранная попытка с принятым описанием"
	textAttemptAlreadySent          = "попытка уже отправлена"
	textFramesAlreadyAccepted       = "опоры уже приняты"
	textFramePlanMissing            = "в попытке нет плана опор: примените описание с промптами опор"
	textAcceptDescriptionFirst      = "сначала примите описание плана"
	textStartParametersInvalid      = "Неверные параметры подготовки производства."
	textCurrentImageUnresolved      = "Сначала завершите согласование или получение текущего изображения. Новая отправка автоматически не создаётся."
	textWaitForJob                  = "Дождитесь завершения текущего задания."
	textResolveProposalFirstError   = "Сначала примените или отклоните текущее предложение."
	textOwnVideoNoAgent             = "У попытки своего видео нет описания, опор и промпта: начните новую попытку."
	textOwnVideoUnavailable         = "В реестре нет способа «вручную вне приложения»: своё видео поставить нельзя."
	textScenarioAndSettingsRequired = "Сначала утвердите актуальный сценарий и настройки генерации."
	textPackageUnavailable          = "Выберите доступную попытку."
	textResolveQuestionFirst        = "Сначала ответьте на текущий вопрос согласования."
	textDescriptionOrFramesReview   = "На этом этапе требуется согласование описания или опор."
	textStageUnavailable            = "Запрошенный этап ещё не доступен."
	textContinuityFailed            = "Не удалось получить врезку непрерывности."
	textProviderCapabilitiesMissing = "Выбранный провайдер видео не объявляет возможности."
	textSpeechRequired              = "Речевой план: сначала подготовьте WAV речи в блоке «Речь»."
	textInputsChangedDuringPrep     = "Входные материалы изменились во время подготовки задания."
	textDiscardUnavailable          = "Предложение недоступно для отклонения; выполняющееся задание сначала отмените."
	textProposalDiscarded           = "Предложение отклонено пользователем."
	// TextDescriptionAndFramePlanRequired — messages.descriptionAndFramePlanRequired: GenerateFrames
	// и ImportFrames без утверждённого описания и плана опор.
	TextDescriptionAndFramePlanRequired = "Сначала утвердите описание и план опор."
	// TextApplyUnavailable — applyUnavailable: Apply возможен только для завершённого актуального
	// предложения.
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
	textManualNoRequest              = "Видео этого плана создаётся вне приложения: вместо запроса соберите пакет для ручной генерации."
	textManualPackageReady           = "Пакет для ручной генерации уже собран."
	textManualPromptRequired         = "Сначала утвердите видеопромпт."
	textManualSpeechRequired         = "Сначала подготовьте WAV в блоке «Речь»."
	textManualUnavailable            = "Пакет для ручной генерации сейчас собрать нельзя."
	textManualSpeechRole             = "Срез речи"
	textMethodSingleFrame            = "Речевой план у провайдера без липсинка всегда создаётся вручную вне приложения."
	textMethodProjectManual          = "Видео всех планов проекта создаётся вручную вне приложения: так выбрано в настройках проекта."
	textMethodRequestReady           = "Запрос или пакет уже подготовлен: чтобы сменить способ, верните видеопромпт на доработку."
	textManualKeyframeCount          = "Видео этого плана создаётся вне приложения по одной опоре: другое число опор выбрать нельзя."
	textManualSingleFrame            = "Видео этого плана создаётся вне приложения: в описании должна быть ровно одна опора K01 на начале плана."
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
	// textProposalNotJSON — ответ, который не разбирается как JSON: русский текст вместо сообщения
	// разборщика (осознанное отличие, записанное в README эталонов); распознанный отказ текстом
	// заменяется на textAgentRefused.
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

// Тексты применения предложения (productionTexts.main.workflow) и журнала замены пакета
// (productionTexts.main.apply).
const (
	textScenarioApprovalStale          = "Утверждение сценария устарело."
	textAgentResultMissing             = "Нет успешного результата агента."
	textProposalImagesChanged          = "Изображения предложения изменились."
	textProposalStale                  = "Предложение устарело: изменились материалы или пакет."
	textWorkflowNotCreated             = "Инструмент не создал workflow.json."
	textWorkflowFrameInvalid           = "Неверная опора в workflow."
	textAcceptedFramesChanged          = "Утверждённые опоры изменились."
	textWorkflowMissing                = "Отсутствует workflow.json."
	textFrameOrPromptApprovalStale     = "Утверждение опор или промпта устарело."
	textSpeechInputRequired            = "Речевой план: запрос должен передавать подготовленный WAV из блока «Речь» звуковым входом модели."
	textApplyPackageFolderRequired     = "Нужен отдельный рабочий пакет внутри plan/batches или plan/awaiting."
	textImageContainsLink              = "Защищённая image-попытка содержит ссылку вместо локального файла."
	textImageFileTypeUnknown           = "Защищённая image-попытка содержит неизвестный тип файла."
	textProtectedImageHistoryChanged   = "История защищённых image-попыток изменилась."
	textProtectedImageChanged          = "Защищённая image-попытка или её оригиналы изменились; автоматическое восстановление остановлено."
	textPackageContainsPaidRequest     = "Пакет содержит видео или неизвестную платную попытку; резерв сохранён."
	textApplyProjectUnavailable        = "Проект недоступен по прежнему пути; резерв сохранён."
	textApplyBackupMissing             = "Отсутствует резерв рабочего пакета."
	textApplyPaidBackupBlocksRecovery  = "Резерв содержит платную попытку; автоматическое восстановление остановлено."
	textApplyPaidVideoRequiresRetry    = "После платной отправки видео или неизвестного запроса нужна новая попытка с retry_of."
	textApplyResolveImageAttemptFirst  = "Сначала завершите image-попытку и выберите опору."
	textApplyPreviousUnrecovered       = "Предыдущее применение не восстановлено. Перезапустите приложение."
	textRecoveryRecordInvalid          = "Неверная запись восстановления."
	textProtectedImagesSnapshotInvalid = "Неверный снимок защищённых image-попыток."
	textRecoveryPathMismatch           = "Путь восстановления не совпадает с журналом."
)

// textToolExitCode — toolExitCode: инструмент завершился без текста ошибки; code nil — null.
// textKeyframeCountMismatch — агент вернул не то число опор, которое выбрал пользователь.
func textKeyframeCountMismatch(want, got int) string {
	return fmt.Sprintf("Выбрано опор: %d, а в описании %d. Доработайте описание или выберите другое число опор.", want, got)
}

// textKeyframeCountRange — выбранное число опор вне предела провайдера видео.
// textOwnPromptOverLimit — отказ сохранить свой видеопромпт длиннее предела провайдера: тот же
// предел, что у утверждения промпта (shot_workflow approve-prompt).
func textOwnPromptOverLimit(chars, limit int) string {
	return fmt.Sprintf("Промпт длиннее предела провайдера: символов %d при пределе %d. Сократите его.", chars, limit)
}

func textKeyframeCountRange(limit int) string {
	return fmt.Sprintf("Число опор — от 1 до %d: столько кадров принимает провайдер видео проекта.", limit)
}

func textToolExitCode(tool string, code *int) string {
	text := "null"
	if code != nil {
		text = dynvalue.NumberToString(float64(*code))
	}
	return tool + ": код " + text
}

func textRequestShorterThanSpeech(seconds string) string {
	return "Речевой план: длительность запроса должна быть не меньше длины WAV (" + seconds + " с)."
}

// textChooseVideoProvider — у проекта не выбран платный
// провайдер видео.
func textChooseVideoProvider() string {
	return "Выберите поддерживаемого провайдера видео: " + providerTitles(mediaproviders.Video) + "."
}

func textApplyRecoveryFailed(cause, restoreError string) string {
	return "Применение прервано: " + cause + ". Восстановление не завершено: " + restoreError + ". Резерв сохранён."
}

func textApplyRecoveryAllFailed(errors string) string {
	return "Не удалось восстановить применение производства: " + errors
}

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

// providerTitles — названия провайдеров вида медиа в порядке реестра
// через « или ».
func providerTitles(kind string) string {
	titles := []string{}
	for _, id := range mediaproviders.IDs() {
		// Способ без сервиса — не провайдер: в перечне сервисов его нет.
		if info, _ := mediaproviders.Lookup(id); mediaproviders.Supports(id, kind) && !info.Manual {
			titles = append(titles, info.Title)
		}
	}
	return strings.Join(titles, " или ")
}

func textVideoSettingsRequired() string {
	return textVideoSettingsIncomplete + " проекта: поддерживается провайдер " + providerTitles(mediaproviders.Video) + "."
}

func textSpeechWindowTooLong(seconds, provider string, max float64) string {
	return "Речевой план: окно плана " + seconds + " с длиннее, чем " + provider + " принимает звук (до " + dynvalue.NumberToString(max) + " с). Разделите план на странице «Сценарий»."
}

func textSpeechLengthOutOfRange(seconds string, min, max float64) string {
	return "речевой план: WAV длится " + seconds + " с, а провайдер принимает звук от " + dynvalue.NumberToString(min) + " до " + dynvalue.NumberToString(max) + " с — обрежьте заново в блоке «Речь»"
}

func textAcceptFrameFirstHint(frame string) string {
	return "сначала утвердите опору " + frame + " или отправьте её на доработку"
}

func textResolveSceneChangedPackageFirst(reason string) string {
	return "Сначала решите судьбу попытки: " + reason + "."
}

// textProviderModelsFailed — providerModelsFailed (frontend/src/shared/texts/production.ts):
// provider "" — провайдер не из реестра, тогда подставляется общее «провайдера видео».
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
	return "Длительность " + dynvalue.NumberToString(seconds) + " с нарушает правило " + rule + " для окна " + dynvalue.NumberToString(window) + " с."
}

func textFrameFileRequired(frame any) string {
	return dynvalue.ToString(frame) + ": нужен обычный файл изображения."
}

func textFrameFormatRequired(frame any) string {
	return dynvalue.ToString(frame) + ": требуется PNG, JPEG или WebP."
}

func textSpeechDurationRange(min, max float64) string {
	return "Речевой план: длительность запроса должна быть от " + dynvalue.NumberToString(min) + " до " + dynvalue.NumberToString(max) + " с — столько звука принимает провайдер видео."
}

func textVideoAdapterMissing(provider string) string {
	return "Для провайдера видео " + provider + " не подключён исполнитель запроса."
}

func textInputFlagUnknown(flag, flags string) string {
	return "Неизвестный флаг входа " + flag + "; допустимы input и " + flags + "."
}

func textManualFrameRole(id string) string { return "Опора " + id }

// textMethodPromptOverLimit — утверждённый промпт длиннее предела провайдера: перевести попытку на
// провайдера можно только после сокращения.
func textMethodPromptOverLimit(chars, limit int) string {
	return fmt.Sprintf("Видеопромпт длиннее предела провайдера (длина %d, предел %d): чтобы выбрать провайдера, верните промпт на доработку и сократите его.", chars, limit)
}
