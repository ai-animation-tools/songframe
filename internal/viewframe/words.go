package viewframe

import "math"

// Слова фактов кадра для агентов: место в кадре по третям и за его краями, направление взгляда по сторонам
// света. Числа x остаются рядом — слова лишь называют то же место так, как его пишут в описании кадра.

const (
	noteTop      = "Камера сверху: кадр — вид сверху на схему локации, отдельных фактов кадра нет."
	noteNoScheme = "У локации нет схемы: факты кадра не посчитаны."
	noteNoCamera = "Камера не поставлена на схему: факты кадра не посчитаны, направление взгляда — по стороне."

	placeAtCamera = "в точке камеры"
	placeAround   = "вокруг камеры"
	placeBehind   = "за спиной камеры"
	placeOffLeft  = "за левым краем"
	placeOffRight = "за правым краем"
	placeWhole    = "во всю ширину кадра"
	placeBelow    = "под нижним краем кадра"
	placeAbove    = "над верхним краем кадра"
)

// compassNames — направления взгляда по восьми сторонам света от востока против часовой стрелки.
var compassNames = [8]string{"на восток", "на северо-восток", "на север", "на северо-запад", "на запад", "на юго-запад", "на юг", "на юго-восток"}

// compass — направление взгляда heading словами: ближайшая из восьми сторон света.
func compass(heading float64) string {
	return compassNames[int(math.Round(normalize(heading)/45))%8]
}

// third — треть кадра по месту x: 0 — левая, 1 — центр, 2 — правая. Граница трети относится к центру.
func third(x float64) int {
	switch {
	case x < -1.0/3-epsilon:
		return 0
	case x <= 1.0/3+epsilon:
		return 1
	default:
		return 2
	}
}

var (
	thirdNames    = [3]string{"левая треть", "центр", "правая треть"}
	thirdGenitive = [3]string{"левой трети", "центра", "правой трети"}
)

// thirdName — треть кадра по месту x словами.
func thirdName(x float64) string {
	return thirdNames[third(x)]
}

// outsidePlace — где находится то, что не вошло в кадр, по углу от взгляда (положительный — влево).
func outsidePlace(angle float64) string {
	switch {
	case math.Abs(angle) > 90:
		return placeBehind
	case angle > 0:
		return placeOffLeft
	default:
		return placeOffRight
	}
}

// rangePlace — видимая часть протяжённого объекта от xLeft до xRight словами; cutLeft и cutRight — объект
// продолжается за левым или правым краем кадра.
func rangePlace(xLeft, xRight float64, cutLeft, cutRight bool) string {
	if cutLeft && cutRight {
		return placeWhole
	}
	if !cutLeft && !cutRight && third(xLeft) == third(xRight) {
		return thirdName(xLeft)
	}
	from, to := thirdGenitive[third(xLeft)], thirdGenitive[third(xRight)]
	if cutLeft {
		from = "левого края"
	}
	if cutRight {
		to = "правого края"
	}
	return "от " + from + " до " + to
}
