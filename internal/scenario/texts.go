package scenario

import "songframe-go/internal/jscompat"

// Сообщения scenarioTexts.main оригинала для просмотра и сохранения сценария. Они показываются
// пользователю дословно и входят в отказ сохранения, поэтому меняются только вместе с эталонами.
const (
	textDamagedCast             = "plan/cast.json повреждён."
	textReferencesRefresh       = "Карта references реестра расходится с кастингом; при сохранении она будет обновлена."
	textTreatmentRequiresParts  = "Трактовка: нужны schema_version 1 и хотя бы одна часть."
	textTreatmentInvalidDoc     = "Трактовка: нужны schema_version 1, logline и sequences."
	textTreatmentInvalidPart    = "Трактовка: неверная структура части песни."
	textRegistryRequiresScenes  = "Реестр: нужны schema_version 1, fps 30 и хотя бы одна сцена."
	textBriefStateUnsetPrefix   = "Состояние не задано"
	textBriefTitleBefore        = "Состояние на первый кадр"
	textBriefTitleAfter         = "Состояние на последний кадр"
	textBriefChecklistTitle     = "Проверить по кадру:"
	textBriefStateUnsetSentence = ": в кастинге нет начального состояния, а в сценах нет изменений."
)

func textDamagedDocument(label string) string { return label + " повреждён." }
func textPartCodeLatin(title string) string {
	return "Часть «" + title + "»: код латиницей."
}
func textDuplicatePartCode(id string) string {
	return "Код части повторяется: " + id + "."
}
func textPartTitleMissing(id string) string { return "Часть " + id + ": нет названия." }
func textPartStartMismatch(id string, start float64, previousEnd string) string {
	return "Часть " + id + ": начало " + jscompat.NumberToString(start) + " не стыкуется с " + previousEnd + "."
}
func textPartEndsBeforeStart(id string) string {
	return "Часть " + id + ": конец раньше начала."
}
func textTreatmentDurationMismatch(end, duration string) string {
	return "Части заканчиваются на " + end + ", а трек длится " + duration + "."
}
func textShotCodeInvalid(shot string) string {
	return shot + ": код плана вида M01 или M23.5."
}
func textDuplicateShotCode(shot string) string { return shot + ": код повторяется." }
func textShotFramesInteger(shot string) string {
	return shot + ": границы в кадрах должны быть целыми."
}
func textShotEndsBeforeStart(shot string) string {
	return shot + ": конец раньше начала."
}
func textShotStartMismatch(shot, start, previousEnd string) string {
	return shot + ": начало " + start + " не совпадает с концом предыдущего плана " + previousEnd + "."
}
func textShotUnknownPart(shot, part string) string {
	return shot + ": неизвестная часть " + part + "."
}
func textShotCameraMissing(shot string) string {
	return shot + ": не заполнена камера."
}
func textShotActionMissing(shot string) string {
	return shot + ": не заполнено действие."
}
func textShotUnknownReference(shot, reference string) string {
	return shot + ": неизвестный референс " + reference + "."
}
func textShotPrimaryReferenceMissing(shot string) string {
	return shot + ": главный референс карточки не объявлен."
}
func textRegistryDurationMismatch(end, duration string) string {
	return "Монтажный конец " + end + " с расходится с концом песни " + duration + "."
}
func textDerivedInvalidShape(shot string) string {
	return shot + `: derived_from должен быть объектом {"shot": "Mxx"}.`
}
func textDerivedSelfReference(shot string) string {
	return shot + ": derived_from не может ссылаться на сам план."
}
func textDerivedUnknownSource(shot, source string) string {
	return shot + ": derived_from ссылается на неизвестный план " + source + "."
}
func textDerivedChainedSource(shot, source string) string {
	return shot + ": источник " + source + " сам собирается из другого плана; укажите исходный план."
}
func textBriefShotMissing(shot string) string {
	return shot + ": сцена отсутствует в реестре."
}
