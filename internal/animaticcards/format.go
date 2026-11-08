package animaticcards

import (
	"math"
	"strconv"

	"songframe/internal/toolrt"
)

// formatG — время опоры для подписи в общем формате «g»: 6 значащих цифр без хвостовых нулей,
// экспонента при порядке < -4 или >= 6 («1e+06»), «nan», «inf» и «-inf» для особых значений.
// bool и целые форматируются как float (true → «1»); слишком большое целое — OverflowError,
// строка — ValueError, null/список/словарь — TypeError. Тексты ошибок зафиксированы эталоном.
func formatG(value any) (string, error) {
	var number float64
	switch typed := value.(type) {
	case bool:
		if typed {
			number = 1
		}
	case toolrt.Int:
		converted, err := typed.Float()
		if err != nil {
			return "", err
		}
		number = converted
	case float64:
		number = typed
	case string:
		return "", toolrt.New(toolrt.ValueError, "формат «g» неприменим к строке")
	default:
		return "", toolrt.Raise(toolrt.TypeError, "формат неприменим к значению: %s", toolrt.TypeName(value))
	}
	switch {
	case math.IsNaN(number):
		return "nan", nil
	case math.IsInf(number, 1):
		return "inf", nil
	case math.IsInf(number, -1):
		return "-inf", nil
	}
	return strconv.FormatFloat(number, 'g', 6, 64), nil
}
