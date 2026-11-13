package production

import (
	"fmt"
	"strconv"
)

// Тексты производства, которые формирует Go: проблемы пакета, подписи попыток и этапов, причины
// устаревания и отказы. Сообщения ошибок и подписи — часть контракта полей API и эталонов, поэтому
// меняются только вместе с ними.

// stageLabels — подписи этапов (stage) workflow.json пакета для вида производства.
// textDescriptionAccepted — метка попытки с принятым описанием до первой опоры.
const textDescriptionAccepted = "описание принято"

// textPromptApproved — метка попытки с утверждённым видеопромптом до подготовки запроса.
const textPromptApproved = "видеопромпт утверждён"

var stageLabels = map[string]string{
	"description_review":   "описание на согласовании",
	"keyframes_review":     "опоры на согласовании",
	"prompt_review":        "видеопромпт на согласовании",
	"request_choice":       "запрос на подтверждении",
	"image_request_choice": "запрос изображения на подтверждении",
	"image_submitted":      "изображение отправлено, ждём результат",
	"image_downloaded":     "изображение получено, выберите вариант опоры",
	"ready":                "отложено в очередь",
	"needs_revision":       "требует исправления",
	"submitted":            "отправлено, ждём результат",
	"downloaded":           "результат получен, ждёт просмотра",
	"edit_review":          "генерация принята, участок не выбран",
	"accepted":             "принята, перенос в assets не завершён",
}

// attemptLabels — подписи состояний попытки attempt.json; те же, что ATTEMPT_LABELS интерфейса
// (frontend/src/shared/production-labels.ts).
var attemptLabels = map[string]string{
	"prepared":               "попытка подготовлена",
	"submitting":             "отправляется",
	"submission_unknown":     "исход отправки неизвестен",
	"submitted":              "отправлено",
	"running":                "генерируется",
	"watermark_free_pending": "ждём версию без логотипа",
	"outputs_pending":        "ждём результаты",
	"download_pending":       "ждём скачивания",
	"downloading":            "скачивается",
	"downloaded":             "скачано",
	"failed":                 "сервис сообщил об ошибке",
}

// staleReasons — derivedMainTexts.staleReasons: причины устаревания принятого комплекта.
var staleReasons = map[string]string{
	"scene_changed":          "Постановка плана изменилась: требуется новое производство.",
	"source_changed":         "Материал источника изменился: пересоберите и примите производный план.",
	"source_unavailable":     "Актуальный принятый источник недоступен: проверьте его перед пересборкой производного плана.",
	"source_receipt_missing": "Версия использованного источника не подтверждена: пересоберите производный план из актуального материала.",
	"derived_link_changed":   "Связь с источником в сценарии изменилась: сохранённый комплект требует нового производства.",
}

// textStaleReasonUnknown — причина устаревания для кода, которого нет в staleReasons: комплект
// показывается устаревшим с общим пояснением.
const textStaleReasonUnknown = "Принятый комплект устарел по неизвестной причине: требуется новое производство."

// SceneChanged — проблема пакета, подготовленного по прежней постановке плана; текст
// совпадает с SCENE_CHANGED интерфейса (frontend/src/shared/production-labels.ts).
const SceneChanged = "Постановка или унаследованное состояние плана изменились после подготовки попытки: описание, опоры и промпт могут не соответствовать сценарию."

// TextScenarioRequired — commonTexts.scenario.requiredForWork.
const TextScenarioRequired = "Сначала нужен сценарий. Создайте его на странице «Сценарий»."

const (
	textRequestProviderMissing       = "В сохранённом запросе не указан провайдер."
	textImageKindRequired            = "Активный запрос опоры должен иметь kind=image."
	textVideoReferencesImage         = "Видео-запрос не может ссылаться на попытку изображения."
	textImageHistoryMismatch         = "Активный запрос изображения не совпадает с историей пакета."
	textRequestFileMissing           = "В папке запроса нет request.json."
	textPackageMaterialsOutside      = "Материалы пакета ссылаются за пределы своей папки."
	textResultFileRequired           = "Результат должен быть обычным файлом в папке запроса."
	textPackageFolderRequired        = "Выберите обычную папку рабочего пакета в plan/batches или plan/awaiting."
	textBrokenWorkflowMissing        = "нет workflow.json: папка осталась после прерванной операции"
	textAcceptedOldScene             = "принят по прежней постановке: нужно новое производство"
	textAcceptedVideoSaved           = "принят, монтажное видео сохранено"
	textAcceptedVideoMissing         = "принят, файл монтажного видео отсутствует"
	textNotStarted                   = "постановка есть, работа не начата"
	textPackageBusy                  = "Для этого пакета уже выполняется операция. Дождитесь её завершения."
	textRequestChanged               = "Показанный запрос изменился. Откройте подтверждение заново."
	textAttemptNotPrepared           = "Эта попытка уже отправлялась или не готова к отправке."
	textQuestionOrMaterialsChanged   = "Вопрос или материалы изменились. Откройте подтверждение заново."
	textCostAndBalanceUnknown        = "Не удалось определить стоимость и остаток кредитов."
	textMaterialsChangedDuringQuote  = "Материалы изменились во время проверки стоимости."
	textDecisionMaterialsChanged     = "Вопрос или материалы изменились. Обновите пакет перед ответом."
	textRefreshQuestion              = "Обновите вопрос перед ответом."
	textSeparateCostConfirmation     = "Используйте отдельное подтверждение запроса со стоимостью."
	textReturnToImageFailed          = "Замечание сохранено; не удалось вернуться к подготовке изображения."
	textFrameUnknown                 = "Неизвестная опора."
	textFrameRevisionRequired        = "Опишите, что исправить в опоре."
	textPromptRevisionRequired       = "Опишите, что исправить в видеопромпте."
	textReopenFrameFailed            = "Не удалось вернуть опору на доработку."
	textReopenPromptFailed           = "Не удалось вернуть видеопромпт на доработку."
	textFrameInstructionRequired     = "Напишите указание к опоре."
	textSceneUnchanged               = "Постановка пакета не менялась."
	textSubmittedOldSceneNoRestamp   = "Попытка уже отправлялась: её материалы относятся к прежней постановке, оставить их для новой нельзя."
	textRestampFailed                = "Не удалось обновить отпечаток постановки в workflow.json пакета."
	textNoteUnknown                  = "Неизвестное замечание."
	textNoteChangeFailed             = "Не удалось изменить замечание."
	textAcceptedPackageCannotRemove  = "Принятый пакет не удаляется: комплект уже в assets."
	textSubmissionBlocksRemoval      = "Отправка ещё не завершена: сначала получите результат, иначе оплаченная генерация потеряется без файла."
	textPackageMissingRefresh        = "Пакет не найден. Обновите страницу производства."
	textQuestionAlreadyAsked         = "Вопрос уже задан."
	textResultQuestionOnly           = "Вернуть можно только вопрос о полученном результате."
	textPackageMissing               = "Пакет не найден."
	textSubmittedSpeechImmutable     = "Запрос этой попытки уже отправлен: её WAV менять нельзя. Подготовьте новую попытку."
	textSpeechBoundsInvalid          = "Конец среза должен быть позже начала, границы — неотрицательные секунды."
	textSpeechWavMissing             = "WAV речи не появился в пакете."
	textQuoteRequired                = "Сначала откройте запрос и подтвердите актуальную стоимость."
	textQuoteMaterialsChanged        = "Показанные материалы изменились: требуется новое подтверждение."
	textQuoteExpired                 = "Стоимость, остаток или материалы изменились. Откройте подтверждение заново; отправка не выполнялась."
	textUnparkFailed                 = "Не удалось возобновить отложенный пакет. Отправка не выполнялась."
	textQueuedQuestionFailed         = "Не удалось записать вопрос отложенного запроса. Отправка не выполнялась."
	textImageConfirmationFailed      = "Не удалось записать новое подтверждение изображения. Отправка не выполнялась."
	textSubmitConfirmationFailed     = "Не удалось записать подтверждение отправки."
	textVerifyMaterialsStep          = "проверка материалов"
	textSubmitStep                   = "отправка"
	textRecordChargeStep             = "запись расхода"
	textSubmittedStep                = "задание отправлено"
	textJobNotCreated                = "Исполнитель не создал задание."
	textRetryBusy                    = "Повтор уже подготавливается."
	textUnknownSubmissionBlocksRetry = "Сначала выясните исход существующей отправки; новая оплата запрещена."
	textPrepareRetryStep             = "новая попытка без отправки"
	textRetrievePreviousStep         = "получение прежнего задания"
	textResultDownloadedStep         = "результат скачан"
	textResultIncomplete             = "Результат не получен полностью. Проверьте состояние задания; вопрос приёмки не создан."
	textReviewResultStep             = "просмотр результата"
	textTechnicalSummaryStep         = "техническая сводка"
	textAttemptMissing               = "В пакете нет попытки."
	textRequestNotSubmitted          = "Запрос ещё не отправлен."
	textGenerationIDUnknown          = "ID задания неизвестен. Проверьте историю генераций сервиса: загрузите найденный результат вручную или отметьте, что задание не создано."
	textRestoreSubmissionStep        = "восстановление этапа отправки"
	textUnknownSubmissionOnly        = "Действие доступно только попытке с неизвестным исходом отправки и без ID задания. Обновите пакет."
	textResultFileMissing            = "Выберите файл результата."
	textAttachResultStep             = "загрузка результата вручную"
	textMarkNotCreatedFailed         = "Не удалось отметить, что задание не создано."
	textReturnToRequestFailed        = "Не удалось вернуть пакет к подтверждению запроса."
	textRequestQuestionFailed        = "Не удалось записать вопрос о запросе."
	textCandidateChanged             = "Кандидат изменился или недоступен. Обновите пакет и просмотрите результат."
	textSelectFrameFailed            = "Не удалось выбрать опору."
	textImageAcceptedSeparately      = "Изображение выбирается как кандидат опоры и утверждается отдельно."
	textPackageShotMismatch          = "Пакет относится к другому плану."
	textAcceptResultChanged          = "Результат изменился. Обновите пакет и просмотрите его перед приёмкой."
	textCompleteResultRequired       = "Сначала получите полный результат задания."
	textReplacementConsentRequired   = "У плана уже есть принятый комплект. Подтвердите замену в диалоге приёмки."
	textAcceptBoundsInvalid          = "Границы участка должны быть конечными неотрицательными секундами на сетке 30 кадров/с."
	textAcceptEndInvalid             = "Конец участка должен быть позже начала."
	textAcceptSpeechRequired         = "Речевой план: сначала подготовьте WAV речи в блоке «Речь» этой попытки."
	textReplaceAssetsStep            = "замена комплекта в assets"
	textMoveAssetsStep               = "перенос в assets"
	textBundleAbsolutePathRequired   = "Укажите абсолютный путь папки пакета."
	textBundlePathInvalid            = "Внутри проекта пакет можно собирать только в plan/batches; иначе выберите папку вне проекта."
	textBundleExportStep             = "Сборка пакета для монтажёра"
	textBundleViewsStep              = "карточки и представления"
	textBundleBusy                   = "Пакет ещё собирается. Дождитесь завершения задания."
	textBundleMissing                = "Собранный пакет не найден. Обновите список."
	textScenePackageNotBundle        = "Нельзя удалить рабочий пакет сцены как пакет для монтажёра."
	textContactSheetStep             = "контактный лист"
	// textSavedRequestRequired и textMediaProviderChanged — productionTexts.main.access.
	textSavedRequestRequired = "В пакете нет сохранённого запроса."
	textMediaProviderChanged = "Провайдер медиа изменился. Подготовьте новый запрос для выбранного провайдера."
)

// textBundleFolderNotEmpty — productionTexts.main.bundleFolderNotEmpty.
func textBundleFolderNotEmpty(path string) string { return "Папка не пуста: " + path }

// textBundleJob — название задания пакета для монтажёра.
func textBundleJob(copyMedia bool) string {
	if copyMedia {
		return "Пакет для монтажёра с медиа"
	}
	return "Пакет для монтажёра"
}

func textAttentionQuestion(name, question string) string {
	if question == "" {
		question = "вопрос ждёт ответа"
	}
	return name + ": " + question
}
func textAttentionRevision(name string) string {
	return name + ": замечание записано, доработка с агентом не запущена"
}
func textAttentionPrepared(name string) string {
	return name + ": запрос подготовлен, ждёт отправки, очереди или отказа"
}
func textAttentionUnknownSubmission(name string) string {
	return name + ": исход отправки неизвестен: проверьте историю генераций сервиса"
}
func textAttentionResult(name string) string {
	return name + ": результат получен, ждёт просмотра"
}
func textAttentionImage(name string) string {
	return name + ": изображение получено, выберите опору"
}
func textRetryProviderRequired(shot string) string {
	return shot + ": сначала выберите провайдера видео в настройках проекта."
}
func textRetryOriginalProviderMissing(shot string) string {
	return shot + ": провайдер сцены не указан. Подготовьте новый пакет."
}
func textRetryProviderMismatch(shot, provider, selected string) string {
	return shot + ": провайдер сцены — " + provider + ", текущий выбранный — " + selected + ". Для подготовки повтора провайдеры должны совпадать."
}
func textRetryManual(shot string) string {
	return shot + ": видео речевого плана создаётся вне приложения, повтор запроса недоступен. Начните новую попытку."
}
func textRetryManualAttempt(shot string) string {
	return shot + ": видео последней попытки создано вне приложения, повтор запроса недоступен. Начните новую попытку."
}
func textRetryRequestMissing(shot string) string {
	return shot + ": нет сохранённого запроса для повтора. Подготовьте новый пакет."
}
func textRetrySnapshotUnreadable(shot string) string {
	return shot + ": не удалось прочитать снимок сохранённого запроса."
}
func textAcceptedDecisionPending(question string) string {
	return "принят; новая попытка ждёт решения: " + question
}
func textDecisionPending(question string) string {
	return "ждёт вашего решения: " + question
}
func textOrphanPackages(packages string) string {
	return "Пакеты планов, которых нет в реестре: " + packages + "."
}
func textBrokenPackageBlocksQueue(path, reason string) string {
	return path + ": " + reason + ". Папка мешает сохранению в очередь; удалите её в очереди или у плана."
}

// providerText — имя провайдера или «не указан».
func providerText(provider *string) string {
	if provider == nil {
		return "не указан"
	}
	return *provider
}
func textAdapterMissing(provider *string) string {
	return "Для провайдера " + providerText(provider) + " не подключён исполнитель."
}
func textSceneChangedBeforeSubmit(reason string) string {
	return reason + " Оставьте пакет для текущей постановки или подготовьте новый."
}
func textSubmitAdapterMissing(provider *string) string {
	return "Для провайдера " + providerText(provider) + " не подключён исполнитель отправки."
}
func textRetrieveAdapterMissing(provider *string) string {
	return "Для провайдера " + providerText(provider) + " не подключён исполнитель получения результата."
}
func textFrameQuestionWriteFailed(frame string) string {
	return "Кандидат сохранён; не удалось записать вопрос об опоре " + frame + "."
}

// codeText — код завершения процесса в тексте ошибки: число или «null», если процесс
// остановлен сигналом.
func codeText(code *int) string {
	if code == nil {
		return "null"
	}
	return strconv.Itoa(*code)
}
func textDecideFailed(code *int) string {
	return "shot_workflow decide завершился с кодом " + codeText(code)
}
func textAskFailed(code *int) string {
	return "shot_workflow ask завершился с кодом " + codeText(code)
}
func textParkFailed(code *int) string {
	return "shot_workflow park завершился с кодом " + codeText(code)
}
func textCutSpeechFailed(code *int) string {
	return "cut_speech завершился с кодом " + codeText(code)
}
func textUnfinishedAttemptBlocksRemoval(status string) string {
	return "В папке есть попытка в состоянии «" + status + "»: удалять её без результата нельзя."
}
func textFolderUsedByMontageDraft(draft string) string {
	return "Папка используется сохранённым черновиком монтажа «" + draft + "». Сначала удалите черновик."
}
func textPackageUsedByMontageDraft(draft string) string {
	return "Пакет используется сохранённым черновиком монтажа «" + draft + "». Сначала удалите черновик."
}
func textSubmitJob(shot string) string       { return "Отправка " + shot }
func textSubmitImageJob(frame string) string { return "Отправка опоры " + frame }
func textShotMissingRefresh(shot string) string {
	return "План " + shot + " не найден. Обновите страницу производства."
}
func textRetryJob(shot string) string        { return "Подготовка повтора " + shot }
func textRetrieveJob(shot string) string     { return "Получение " + shot }
func textManualResultJob(shot string) string { return "Ручной результат " + shot }
func textAcceptJob(shot string) string       { return "Приёмка " + shot }
func textContactSheetJob(name string) string { return "Сводка " + name }

// TextSpeechDuration — отказ, когда длина среза речи выходит за пределы lipSync провайдера видео.
func TextSpeechDuration(min, max float64) string {
	return fmt.Sprintf("Провайдер видео принимает звук длиной от %s до %s с: поправьте границы среза.", number(min), number(max))
}

// Ручная генерация: видео создаётся вне приложения по пакету попытки.
const (
	textManualPackageOnly   = "Загрузить видео можно только в собранный пакет ручной генерации, ещё не получивший видео."
	textManualReplaceOnly   = "Заменить можно только видео, загруженное вручную и ещё не принятое."
	textManualSourceMissing = "Укажите источник видео."
	textManualCostInvalid   = "Стоимость — целое неотрицательное число."
	textManualVideoFormat   = "Нужно видео в формате MP4, а выбранный файл в другом формате. Перекодируйте его в MP4 и загрузите снова."
	textAttachManualStep    = "Загрузка видео ручной генерации"
)

// number — число в кратчайшей десятичной записи без экспоненты и лишних нулей.
func number(value float64) string { return strconv.FormatFloat(value, 'f', -1, 64) }

// textNoAcceptedKit — цену принятого плана указывают только у плана с комплектом.
const textNoAcceptedKit = "План ещё не принят: цену указывают у видео его попытки."
