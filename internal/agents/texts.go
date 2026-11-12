package agents

import (
	"strings"

	"songframe/internal/dynvalue"
)

// Тексты, которые Go отдаёт renderer через ошибки, результаты диагностики и задания.
// Источники — frontend/src/shared/texts/agents.ts (agentsTexts), settings.ts (settingsTexts.main),
// ai-access.ts (aiAccessTexts.main) и common.ts. Тест
// TestTextsMatchFrontend проверяет, что каждая постоянная строка присутствует в TS-словарях.
const (
	textAgentLabel  = "Агент"
	textChooseAgent = "Сначала выберите агента."

	textCheckTimeout          = "Агент не ответил вовремя. Проверьте его запуск в терминале и повторите проверку."
	textCheckOutputLimit      = "Агент превысил допустимый объём ответа. Проверьте его запуск в терминале."
	textCheckLaunchFailed     = "Не удалось запустить агента. Проверьте права файла и наличие зависимостей, например Node.js для npm-установки."
	textCheckConnectionFailed = "Агент сообщил об ошибке соединения. Проверьте сеть и повторите проверку."
	textAuthorizationUnknown  = "Не удалось определить вход по ответу агента. Проверьте статус в терминале; может потребоваться обновление агента."

	textInvalidInput             = "Неверные параметры задания."
	textInputRequired            = "Укажите проект, задачу и промпт."
	textInvalidInputSize         = "Неверный путь или слишком большой текст задания."
	textImageAttachmentsInvalid  = "Вложения должны быть существующими непустыми файлами PNG или JPEG с абсолютными путями."
	textImageAttachmentsTooLarge = "Допускается до 64 изображений, до 5 МиБ каждое и до 20 МиБ суммарно."
	textClaudeInputTooLarge      = "Ввод агента превышает выбранный SongFrame предел 10 000 000 байт с учётом JSON и base64. Он основан на документированном ограничении piped stdin и не утверждает подтверждённый предел stream-json. Уменьшите подготовленные вложения или текст задания."
	textImageAttachmentsReadOnly = "Вложения изображений доступны только в заданиях агента без записи файлов."
	textRestartInterrupted       = "Приложение завершилось до получения результата. Автоматический повтор не выполнялся; для нового запуска подготовьте запрос заново."
	textInvalidCandidateDir      = "Папка кандидатов не принадлежит заданиям изображений."
	textApplicationStopping      = "Приложение завершает работу."
	textProjectNotFound          = "Папка проекта не найдена. Выберите её заново."
	textProjectManifestMissing   = "В папке нет plan/project.json."
	textProjectBusy              = "Для этого проекта уже выполняется задание агента."
	textChooseAgentInSettings    = "Сначала выберите агента в настройках."
	textRetryUnavailable         = "Исходное задание для повтора недоступно."
	textCancelled                = "Задание остановлено пользователем."
	textJobNotFound              = "Задание не найдено."
	textShutdownInterrupted      = "Задание остановлено при закрытии приложения. Автоматический повтор не выполнялся."
	textJobTimeout               = "Превышено время задания. Автоматический повтор не выполнялся."
	textJobOutputLimit           = "Агент превысил допустимый объём вывода."
	textCompletionMissing        = "Агент завершился без подтверждения результата."
	textResultTooLarge           = "Ответ агента слишком велик."
	textJobSaveFailed            = "Не удалось обработать или сохранить задание агента. Проверьте каталог состояния."
	textUnsupportedWriteMode     = "Выбранный агент не поддерживает штатный режим создания кандидатов."
	textUnsupportedVersion       = "Эта версия агента не поддерживает подтверждённый контракт запуска. Обновите агента или выберите совместимую версию."
	textLineTooLarge             = "Строка ответа агента слишком велика."
	textInvalidJSONLines         = "Агент вернул некорректный JSONL."
	textEventObjectRequired      = "Ожидался объект события агента."

	phaseRestartInterrupted = "Прервано перезапуском"
	phaseChecking           = "Проверка агента"
	phaseWorking            = "Агент выполняет задачу"
	phaseReceiving          = "Получение ответа"
	phaseReading            = "Чтение проекта"

	// Тексты settingsTexts.main.
	textInvalidAgentSettings = "Неверный формат настроек агента."
	textSelectAgent          = "Выберите агента."
	textInvalidModel         = "Модель должна быть текстом без нулевых символов."
	textInvalidProfiles      = "Неверный формат профилей агентов."
	textUnknownAgent         = "Неизвестный агент."
	textProfileAgentMismatch = "Агент профиля не совпадает с его именем."
	textProfileRequired      = "Укажите профиль агента."
	textImageAgentRequired   = "Выбранный провайдер изображений не исполняется программой-агентом."
	textPartialAccount       = "Часть данных аккаунта недоступна в ответе агента. Проверьте подключение и актуальность его версии."
	textUnlimitedCredits     = "Без ограничений"
	textNoCredits            = "Нет кредитов"
	textAvailableCredits     = "Есть кредиты"
	textDiagnosticsFailed    = "Не удалось получить диагностику агента."
	textSessionClosed        = "Сессия диагностики закрыта."

	// Тексты aiAccessTexts.
	textMediaImageRequired     = "Сначала выберите провайдера изображений в настройках проекта."
	textMediaVideoRequired     = "Сначала выберите провайдера видео в настройках проекта."
	textAgentUnchecked         = "Доступность агента ещё не проверена."
	textProviderUnchecked      = "Доступность провайдера ещё не проверена."
	textManualVideoReady       = "Видео создаётся вручную вне приложения: вход не нужен."
	textProviderUnsupported    = "Выбранный провайдер не поддерживается."
	textSettingsReadFailed     = "Не удалось прочитать настройки ИИ."
	textAgentCheckFailed       = "Не удалось проверить доступность агента."
	textProviderCheckFailed    = "Не удалось проверить доступность провайдера."
	textSettingsChanged        = "Настройки ИИ изменились во время проверки. Повторите действие."
	textAgentRequired          = "Сначала выберите агента в настройках приложения."
	textAvailableAgentRequired = "Сначала выберите доступного агента в настройках приложения."
	textAvailableImageRequired = "Сначала выберите доступного провайдера изображений в настройках проекта."
	textAvailableVideoRequired = "Сначала выберите доступного провайдера видео в настройках проекта."
)

// statusPhase — agentsTexts.status: подпись итогового состояния задания (commonTexts.job).
var statusPhase = map[string]string{
	StatusCompleted:   "Завершено",
	StatusFailed:      "Ошибка",
	StatusCancelled:   "Остановлено",
	StatusInterrupted: "Прервано",
	StatusRunning:     "Выполняется",
}

// textNotFound — agentsTexts.notFound: где искали программу зависит от ОС.
func textNotFound(provider string, windows bool) string {
	places := "PATH, ~/.local/bin, /usr/local/bin и /usr/bin"
	if windows {
		places = `PATH, %USERPROFILE%\.local\bin и %APPDATA%\npm`
	}
	return provider + " не найден в " + places + ". Установите его по официальной инструкции и повторите проверку."
}

func textVersionCheckFailed(provider string) string {
	return "Команда версии завершилась с ошибкой. Проверьте " + provider + " и его зависимости в терминале."
}

func textCheckVersionUnknown(provider string) string {
	return provider + " запускается, но его версия не распознана. Обновите его до поддерживаемой версии."
}

func textVersionUnknown(provider string) string {
	return "Версия " + provider + " не распознана. Обновите его до поддерживаемой версии."
}

func textLaunchFailed(provider string) string {
	return "Не удалось запустить " + provider + ". Проверьте его установку и зависимости."
}

func textLogin(command string) string {
	return "Выполните " + command + " в терминале."
}

// withReason добавляет к общей фразе дословное сообщение агента, если оно есть.
func withReason(text, reason string) string {
	if reason == "" {
		return text
	}
	return text + " Сообщение агента: «" + reason + "»"
}

func textAuthorizationFailed(reason string) string {
	return withReason("Агент сообщил об ошибке входа. Проверьте авторизацию в настройках.", reason)
}

func textRateLimited(reason string) string {
	return withReason("Агент сообщил об ограничении использования. Проверьте лимиты аккаунта.", reason)
}

func textTaskFailed(reason string) string {
	return withReason("Агент сообщил об ошибке задания. Проверьте его настройки и доступность выбранной модели.", reason)
}

func textInvalidSettingsFile(file string) string {
	return "Неверный формат " + file + ". Настройки сохранены; исправьте файл или перенесите его в резервную папку."
}

func textInvalidAgentFile(file string) string {
	return "Неверный формат агента в " + file + ". Настройки сохранены; исправьте файл или перенесите его в резервную папку."
}

func textAccountVersionUnsupported(name string) string {
	return "Данные аккаунта недоступны для этой версии " + name + "."
}

func textAccountAuthorizationUnknown(name string) string {
	return "Не удалось подтвердить вход по ответу " + name + "."
}

func textUsageRestricted(name string) string {
	return name + " сообщает об ограничении использования."
}

// textLimitLabel — settingsTexts.main.limitLabel; windowMinutes nil — окно не сообщено.
func textLimitLabel(name, kind string, windowMinutes *float64) string {
	label := name + " · " + kind
	if windowMinutes != nil {
		label += " · " + dynvalue.NumberToString(*windowMinutes) + " мин"
	}
	return label
}

func textLimitWithWindow(name string, windowMinutes int) string {
	return name + " · " + dynvalue.NumberToString(float64(windowMinutes)) + " мин"
}

func textModelsEmpty(name string) string {
	return name + " не вернул доступные модели. Модель можно ввести вручную."
}

func textModelsUnavailable(name string) string {
	return "Каталог моделей " + name + " сейчас недоступен. Модель можно ввести вручную."
}

func textLoginConfirmed(title string) string {
	return "Вход в " + title + " подтверждён."
}

func textLoginRequired(title string) string {
	return "Выполните вход в " + title + " в настройках приложения."
}

// textCheckAuthenticated — подтверждения входа, которые принадлежат проверке конкретного CLI:
// Claude подтверждает вход, Codex — наличие учётных данных.
func textCheckAuthenticated(provider string) string {
	if provider == Codex {
		return Title(Codex) + " сообщает, что учётные данные для входа найдены."
	}
	return Title(Claude) + " сообщает, что вход выполнен."
}

// textCodexLoggedOut — явный ответ сервера Codex об отсутствии аккаунта.
var textCodexLoggedOut = "Codex сообщает, что вход не выполнен. Выполните " + strings.TrimSpace(Providers[Codex].LoginCommand) + " в терминале."
