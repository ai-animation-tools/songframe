package videoreview

import (
	"fmt"
	"strconv"
	"strings"

	"songframe/internal/plural"
)

// Тексты, которые Go отдаёт renderer в состоянии проверки и ошибках. Они дословно совпадают со
// словарями frontend/src/shared/texts/video-review.ts (videoReviewTexts.main и heading) и
// production.ts (productionTexts.main.proposal: пути пакета); тест TestTextsMatchGolden сверяет
// каждую строку. textInvalidReport — повреждённый снимок latest.json: отказ ответа агента называет
// причину (textReport* ниже).
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

// Причины отказа ответа агента (ParseReport). Пользователь видит одну из них как ошибку проверки
// вместо отчёта; тексты зафиксированы эталоном video-review (parse). Числа пределов берутся из
// констант report.go, номера наблюдений и пунктов считаются с 1.

// rejected — общее начало отказа и причина.
func rejected(format string, args ...any) string {
	return "Ответ агента отклонён: " + fmt.Sprintf(format, args...)
}

// seconds — время в секундах с десятичной запятой и без лишних нулей (0,5; 12).
func seconds(value float64) string {
	return strings.Replace(strconv.FormatFloat(value, 'f', -1, 64), ".", ",", 1)
}

func textReportNotObject() string {
	return rejected("ответ не является JSON-объектом отчёта.")
}
func textReportExtraKeys() string {
	return rejected("в отчёте есть лишние поля, допускаются только schemaVersion, summary, findings и limitations.")
}
func textReportSchemaVersion() string {
	return rejected("schemaVersion должен быть равен 1.")
}

// textReportEmptyText и textReportLongText — текстовое поле where в предложном падеже без «в»:
// «summary», «description наблюдения 3», «пункте 2 limitations».
func textReportEmptyText(where string, limit int) string {
	return rejected("в %s нет текста, нужен текст до %d знаков.", where, limit)
}
func textReportLongText(where string, length, limit int) string {
	return rejected("в %s — %d %s, допускается до %d.", where, length, plural.Word(length, "знак", "знака", "знаков"), limit)
}
func textReportDescriptionPlace(finding int) string {
	return fmt.Sprintf("description наблюдения %d", finding)
}
func textReportLimitationPlace(item int) string {
	return fmt.Sprintf("пункте %d limitations", item)
}

func textReportFindingsList() string {
	return rejected("findings должен быть списком от %d до %d наблюдений.", findingsMin, findingsMax)
}
func textReportFindingsCount(count int) string {
	return rejected("в findings — %d %s, допускается от %d до %d.", count,
		plural.Word(count, "наблюдение", "наблюдения", "наблюдений"), findingsMin, findingsMax)
}
func textReportLimitationsList() string {
	return rejected("limitations должен быть списком от %d до %d пунктов.", limitationsMin, limitationsMax)
}
func textReportLimitationsCount(count int) string {
	return rejected("в limitations — %d %s, допускается от %d до %d.", count,
		plural.Word(count, "пункт", "пункта", "пунктов"), limitationsMin, limitationsMax)
}
func textReportFindingShape(finding int) string {
	return rejected("наблюдение %d должно быть объектом только с полями verdict, timeSeconds, description и frameIds.", finding)
}
func textReportVerdict(finding int) string {
	return rejected("в наблюдении %d verdict должен быть match, mismatch или uncertain.", finding)
}
func textReportTimeNumber(finding int) string {
	return rejected("в наблюдении %d timeSeconds не является числом.", finding)
}
func textReportTimeRange(finding int, time, duration float64) string {
	return rejected("в наблюдении %d время %s с вне видео длительностью %s с.", finding, seconds(time), seconds(duration))
}
func textReportFrameList(finding int) string {
	return rejected("в наблюдении %d frameIds должен быть списком ID кадров.", finding)
}
func textReportFrameCount(finding, count int) string {
	return rejected("в наблюдении %d %s %d %s, допускается от %d до %d.", finding, plural.Word(count, "указан", "указано", "указано"),
		count, plural.Word(count, "кадр", "кадра", "кадров"), frameIdsMin, frameIdsMax)
}
func textReportUnknownFrame(finding int) string {
	return rejected("в наблюдении %d указан кадр, которого нет в выборке.", finding)
}
func textReportDuplicateFrame(finding int) string {
	return rejected("в наблюдении %d один кадр указан дважды.", finding)
}
func textReportTimeWitness(finding int, time float64) string {
	return rejected("в наблюдении %d время %s с не совпадает со временем ни одного из его кадров.", finding, seconds(time))
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
