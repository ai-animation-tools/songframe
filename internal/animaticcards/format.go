package animaticcards

import (
	"math"
	"strconv"

	"songframe-go/internal/pycompat"
)

// formatG — format(value, "g") Python для подписи времени опоры (f"{k['time_seconds']:g}"):
// 6 значащих цифр без хвостовых нулей, экспонента при порядке < -4 или >= 6 («1e+06»). bool и
// int форматируются как float (True → «1»); слишком большое целое — OverflowError, строка —
// ValueError, None/список/словарь — TypeError с текстами CPython 3.12.
func formatG(value any) (string, error) {
	var number float64
	switch typed := value.(type) {
	case bool:
		if typed {
			number = 1
		}
	case pycompat.Int:
		converted, err := typed.Float()
		if err != nil {
			return "", err
		}
		number = converted
	case float64:
		number = typed
	case string:
		return "", pycompat.New(pycompat.ValueError, "Unknown format code 'g' for object of type 'str'")
	default:
		return "", pycompat.Raise(pycompat.TypeError, "unsupported format string passed to %s.__format__", pycompat.TypeName(value))
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
