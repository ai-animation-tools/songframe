package montage

// Тексты ошибок монтажа: Go возвращает готовые фразы, renderer показывает их как есть.
const (
	textRelativePathRequired = "Укажите относительный путь от корня проекта через /."
	textInvalidData          = "Некорректная структура данных."
	textInvalidDraftID       = "Некорректный идентификатор монтажного черновика."
	textEmptyScenario        = "В сценарии пока нет планов. Добавьте их на странице «Сценарий»."
	textInvalidScenario      = "Не удалось прочитать сценарий. Проверьте и исправьте его на странице «Сценарий»."
	textLyricTimingMissing   = "Разметка строк песни недоступна. Создайте её на странице «Тайминги»."
	textLyricTrackChanged    = "Разметка относится к другому треку. Проверьте её на странице «Тайминги»."
	textLyricTimingInvalid   = "Разметка не соответствует тексту или содержит неверные границы. Проверьте её на странице «Тайминги»."
	textLyricTimingEmpty     = "В разметке пока нет строк песни. Добавьте их на странице «Тайминги»."
	labelSceneMaterials      = "описание материалов плана"
	labelWorkflow            = "состояние рабочего пакета"
	labelRequest             = "запрос рабочего пакета"
	labelAttempt             = "результат попытки генерации"
	labelDraft               = "монтажный черновик"
	textSceneCard            = "Карточка плана"
	textInvalidDraft         = "Некорректная структура монтажного черновика."
	textSnapshotMissing      = "Черновик не содержит снимок реестра и манифестов."
	textInvalidAudioBounds   = "Некорректные кадровые границы музыки."
	textDuplicateClip        = "Коды планов и идентификаторы фрагментов должны быть неповторяющимися."
	textTotalLengthExceeded  = "Суммарная длина монтажа слишком велика."
	textLengthMismatch       = "Длина видеодорожки должна совпадать с выбранным участком музыки."
	textAudioChanged         = "Выбранная музыка не совпадает с текущим треком проекта."
	textAudioBoundsExceeded  = "Выбранный участок выходит за пределы музыки."
	textExportStep           = "Сборка ручной пробы"
	textRegistryChanged      = "Реестр планов изменился: заново откройте материалы перед применением."
	textManifestsChanged     = "Манифесты комплектов изменились: заново откройте материалы перед применением."
	textApplyStep            = "Применение ручного монтажа к планам"
	textExportVideoMissing   = "Готовая видеопроба не найдена. Дождитесь успешного экспорта."
	textExportRecipeMissing  = "Экспорт ещё не завершён: нет рецепта готовой пробы."
	textExportUnconfirmed    = "Нет подтверждения успешной сборки пробы."
	textExportDestination    = "Выберите папку для показа результата вне source, assets и plan: здесь хранятся рабочие материалы проекта."

	// textScenarioRequired — commonTexts.scenario.requiredForWork.
	textScenarioRequired = "Сначала нужен сценарий. Создайте его на странице «Сценарий»."
	// textOriginal и textAccepted — scenesTexts.mediaEdit.original/accepted.
	textOriginal = "Оригинал генерации"
	textAccepted = "Принятый монтаж"
	// objectExpected — причина ошибки ReadJournal, если в журнале восстановления не объект.
	objectExpected = "ожидался JSON-объект"
)

func textInvalidProjectPath(value string) string {
	return "Недопустимый путь проекта: " + value
}
func textProjectFileMissing(value string) string {
	return "Файл проекта не найден: " + value
}
func textReadFailed(label string) string {
	return "Не удалось прочитать " + label + ". Файл сохранён; исправьте его или перенесите в резервную папку."
}
func textAttemptSource(name string) string { return "Результат попытки: " + name }
func textSceneMediaMissing(scene, path string) string {
	return scene + ": нет видео и карточки " + path + "."
}
func textDraftReadFailed(file, reason string) string {
	return "Черновик " + file + ": " + reason
}
func textInvalidManifestSnapshot(scene string) string {
	return "Некорректный снимок манифеста: " + scene
}
func textUnknownClipKind(scene string) string {
	return scene + ": неизвестный вид материала."
}
func textInvalidClipBounds(scene string) string {
	return scene + ": задайте целые кадровые границы непустого участка."
}
func textInvalidSourceLength(scene string) string {
	return scene + ": некорректная длина исходника."
}
func textInvalidCardStart(scene string) string {
	return scene + ": карточка должна начинаться с кадра 0."
}
func textSourceBoundsExceeded(scene string) string {
	return scene + ": выбранный участок выходит за пределы исходника."
}
func textSceneMissing(scene string) string {
	return "В реестре больше нет плана " + scene + "."
}
func textExportTitle(name string) string { return "Ручная проба: " + name }
func textApplyTitle(name string) string  { return "Применение монтажа: " + name }
func textUnknownJournal(path string) string {
	return "Неизвестный журнал ручного монтажа: " + path + ". Резервы сохранены."
}
func textRecoveryFileChanged(path, directory string) string {
	return "После прерывания монтажа изменён " + path + ". Восстановление остановлено; резервы: " + directory + "."
}
func textRecoveryBackupCorrupt(path, directory string) string {
	return "Повреждён резерв " + path + ": " + directory + "."
}

// textLocalReadFailed — ошибка чтения локального JSON-файла с путём и причиной.
func textLocalReadFailed(path, reason string) string {
	return "Не удалось прочитать " + path + ": " + reason + ". Файл сохранён; исправьте его или перенесите в резервную папку."
}
