// Package derivedshot определяет производный план по сценарию: план, материал
// которого собирается из принятого видео другого плана (derived_from.shot). Выбор источника
// принадлежит только актуальному сценарию; исторический generation.source_shot принятого комплекта
// описывает сохранённый материал и на выбор не влияет. Пакет ничего не читает с диска.
//
// Потребители: вид производства (повтор генерации для производного плана не нужен), дашборд и
// проход агента производства (описание, опоры и генерация производному плану не нужны).
package derivedshot

import (
	"regexp"

	"songframe/internal/dynvalue"
)

// shotID — код плана: Mxx или Mxx.N.
var shotID = regexp.MustCompile(`^M\d{2}(?:\.\d+)?$`)

// Source — ID плана-источника из scene.derived_from.shot или "".
// Источник должен быть строкой формата Mxx и не совпадать с самим планом; scene — значение плана
// реестра в представлении dynvalue (объект). Не объект или нестроковый id — "".
func Source(scene any) string {
	if !dynvalue.IsRecord(scene) {
		return ""
	}
	id, ok := dynvalue.Get(scene, "id").(string)
	derived := dynvalue.Get(scene, "derived_from")
	if !ok || !dynvalue.IsRecord(derived) {
		return ""
	}
	source, ok := dynvalue.Get(derived, "shot").(string)
	if !ok || !shotID.MatchString(source) || source == id {
		return ""
	}
	return source
}

// Reason — derivedShotReason(source): почему производному плану не нужны описание, опоры и
// генерация (productionTexts.workflow.derived). Эту же строку вид производства показывает как
// причину недоступности повтора.
func Reason(source string) string {
	return "План собирается из материала " + source + ": описание, опоры и генерация для него не нужны."
}
