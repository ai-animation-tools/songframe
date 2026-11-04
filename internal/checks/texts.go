package checks

// Тексты главного процесса оригинала (checksTexts из src/shared/texts/checks.ts на 634fd94):
// подписи и описания проверок приходят в renderer списком checks.list, названия заданий видны на
// странице «Задания». Renderer хранит те же строки в frontend/src/shared/texts/checks.ts; при
// изменении текста правятся оба места.
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
)

// textUnknownCheck — checksTexts.unknownCheck.
func textUnknownCheck(id string) string { return "Неизвестная проверка: " + id }

// textCheckJobTitle — checksTexts.checkJobTitle.
func textCheckJobTitle(label string) string { return "Проверка: " + label }

// textCheckNotMigrated — отказ запуска проверки, инструмент которой ещё не перенесён в Go.
func textCheckNotMigrated(label string) string {
	return "Проверка «" + label + "» ещё не перенесена в Go-версию SongFrame."
}
