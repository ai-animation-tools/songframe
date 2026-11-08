package videoreview

// Тексты, которые Go отдаёт renderer в состоянии проверки и ошибках. Они дословно совпадают со
// словарями frontend/src/shared/texts/video-review.ts (videoReviewTexts.main и heading) и
// production.ts (productionTexts.main.proposal: пути пакета); тест TestTextsMatchGolden сверяет
// каждую строку.
const (
	// textHeading — название задания агента (task) и заголовок панели.
	textHeading = "Проверка видео агентом"

	textInvalidPackage     = "Выбранный пакет не найден или не принадлежит текущему проекту."
	textVideoRequired      = "Для проверки нужен полностью скачанный оригинал видео на этапе просмотра результата."
	textReferencesRequired = "В пакете нет утверждённых опор для сравнения с видео."
	textBusy               = "Дождитесь завершения текущего задания проекта."
	textToolsMissing       = "Для подготовки кадров нужны FFmpeg и ffprobe. Проверьте их на странице «Среда»."
	textPreparationFailed  = "Не удалось подготовить кадры исходного видео. Повторите проверку."
	textInvalidFrames      = "Кадры проверки повреждены или отсутствуют. Запустите проверку заново."
	textInvalidReport      = "Ответ агента не соответствует формату отчёта проверки видео."
	textInterrupted        = "Проверка видео прервана при закрытии приложения. Запустите её заново."
	textCancelled          = "Проверка видео остановлена."
	textSourceChanged      = "Исходное видео или материалы пакета изменились во время проверки. Запустите проверку заново."

	// Отказы проверки путей внутри пакета (productionPath).
	textPathRequired  = "Нужен путь файла."
	textParentMissing = "Не найден родитель пути."
)

func textPathOutsideProject(path string) string {
	return "Путь выходит из проекта: " + path
}
func textLinkOutsideProject(path string) string {
	return "Ссылка ведёт за пределы проекта: " + path
}

// Сообщения подготовки кадров (Extract). Пользователь видит их в ошибке проверки:
// «Не удалось подготовить кадры: <причина>». Тексты зафиксированы эталоном video-review-frames.
const (
	textFramesPrefix      = "Не удалось подготовить кадры: "
	textMediaFailed       = "Ошибка обработки видео: "
	textNoVideoStream     = "В файле нет видеопотока."
	textProbeFailed       = "Не удалось определить длительность, частоту или размер видео."
	textDurationInvalid   = "Длительность видео должна быть больше нуля и не больше 600 секунд."
	textStreamInvalid     = "Недопустимые параметры видеопотока: нужны размер и частота до 120 кадров/с."
	textFrameCount        = "Нужно от 1 до 72000 декодированных кадров."
	textTimestampsMissing = "У кадров отсутствуют корректные временные метки."
	textTimestampsInvalid = "Некорректные временные метки кадров."
	textTimestampsOrder   = "Временные метки кадров должны возрастать и укладываться в 600 секунд."
	textBudgetRequired    = "Для изображений проверки нужен положительный лимит размера."
	textBudgetTooSmall    = "Лимит размера изображений проверки слишком мал."
	textBudgetMinimalJPEG = "Лимит размера изображений проверки слишком мал даже для минимального JPEG."
	textBudgetExceeded    = "Изображения проверки превышают лимит размера."
	textBudgetRange       = "Бюджет изображений должен быть целым числом от 1 до 16777216 байт."
	textPathsAbsolute     = "Пути --video и --out должны быть абсолютными."
	textVideoMissing      = "Локальный файл видео не найден."
	textOutputNotEmpty    = "Папка результата должна быть новой или пустой."
	textOutputParent      = "Родительская папка результата не найдена."
	textReferencesLimit   = "Допускается не больше 20 опорных изображений."
	textReferencesInvalid = "Опоры должны быть существующими изображениями с абсолютными путями."
	textExtractIncomplete = "Не удалось извлечь все выбранные кадры."
)
