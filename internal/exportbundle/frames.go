package exportbundle

import (
	"math"
	"math/big"
	"strconv"
	"strings"

	"songframe-go/internal/pycompat"
	"songframe-go/internal/pyre"
)

// fps — частота шкалы аниматика (FPS оригинала).
const fps = 30

// Числа и форматы Python, от которых зависят байты пакета: fractions.Fraction, Decimal с контекстом
// по умолчанию (28 значащих цифр) и форматные спецификации.

// rationalFormat — _RATIONAL_FORMAT модуля fractions CPython 3.12 с нумерованными группами: знак (1),
// числитель (2), знаменатель (4), дробная часть (6), порядок (8).
var rationalFormat = pyre.MustCompile(`\A\s*([-+]?)(?=\d|\.\d)(\d*|\d+(_\d+)*)(?:(?:\s*/\s*(\d+(_\d+)*))?|(?:\.(\d*|\d+(_\d+)*))?(?:E([-+]?\d+(_\d+)*))?)\s*\Z`, pyre.IgnoreCase)

// parseInteger — int(text) для группы цифр регулярного выражения: подчёркивания убираются,
// цифры Unicode читаются своим значением.
func parseInteger(text string) *big.Int {
	result := new(big.Int)
	ten := big.NewInt(10)
	for _, r := range text {
		if r == '_' {
			continue
		}
		result.Mul(result, ten).Add(result, big.NewInt(int64(pycompat.DigitValue(r))))
	}
	return result
}

// power10 — 10**n.
func power10(n int64) *big.Int {
	return new(big.Int).Exp(big.NewInt(10), big.NewInt(n), nil)
}

// parseFraction — Fraction(text): целое, «a/b» или десятичная запись с порядком.
// Неверная строка — ValueError, нулевой знаменатель — ZeroDivisionError с текстом Python.
func parseFraction(text string) (*big.Rat, error) {
	match, ok := rationalFormat.MatchString(text)
	if !ok {
		return nil, pycompat.Raise(pycompat.ValueError, "Invalid literal for Fraction: %s", pycompat.Repr(text))
	}
	whole, _ := match.Group(2)
	numerator := parseInteger(whole)
	denominator := big.NewInt(1)
	if denom, found := match.Group(4); found && denom != "" {
		denominator = parseInteger(denom)
	} else {
		if decimal, found := match.Group(6); found && decimal != "" {
			digits := strings.ReplaceAll(decimal, "_", "")
			scale := power10(int64(len(pycompat.Runes(digits))))
			numerator.Mul(numerator, scale).Add(numerator, parseInteger(digits))
			denominator.Mul(denominator, scale)
		}
		if exponent, found := match.Group(8); found && exponent != "" {
			negative := strings.HasPrefix(exponent, "-")
			size := parseInteger(strings.TrimLeft(exponent, "+-")).Int64()
			if negative {
				denominator.Mul(denominator, power10(size))
			} else {
				numerator.Mul(numerator, power10(size))
			}
		}
	}
	if sign, _ := match.Group(1); sign == "-" {
		numerator.Neg(numerator)
	}
	if denominator.Sign() == 0 {
		return nil, pycompat.Raise(pycompat.ZeroDivisionError, "Fraction(%s, 0)", numerator.String())
	}
	return new(big.Rat).SetFrac(numerator, denominator), nil
}

// fractionOf — Fraction(value) для значения из JSON: bool и int — целые, float — точное двоичное
// значение, строка разбирается parseFraction, прочее — TypeError.
func fractionOf(value any) (*big.Rat, error) {
	switch item := value.(type) {
	case bool:
		if item {
			return big.NewRat(1, 1), nil
		}
		return new(big.Rat), nil
	case pycompat.Int:
		return new(big.Rat).SetInt(item.Big()), nil
	case float64:
		if math.IsNaN(item) {
			return nil, pycompat.New(pycompat.ValueError, "cannot convert NaN to integer ratio")
		}
		if math.IsInf(item, 0) {
			return nil, pycompat.New(pycompat.OverflowError, "cannot convert Infinity to integer ratio")
		}
		return new(big.Rat).SetFloat64(item), nil
	case string:
		return parseFraction(item)
	}
	return nil, pycompat.New(pycompat.TypeError, "argument should be a string or a Rational instance")
}

// decimalPrecision — точность контекста Decimal по умолчанию.
const decimalPrecision = 28

// divideDecimal — Decimal(numerator) / Decimal(denominator) контекста по умолчанию для модуля
// дроби value: значащие цифры coefficient и степень десяти exponent, округление половины к чётному.
func divideDecimal(value *big.Rat) (coefficient *big.Int, exponent int) {
	numerator := new(big.Int).Abs(value.Num())
	denominator := value.Denom()
	// Сдвиг даёт частное заведомо длиннее нужной точности; остаток учитывается при округлении.
	shift := decimalPrecision + 2 + len(denominator.String()) - len(numerator.String())
	if shift > 0 {
		numerator = new(big.Int).Mul(numerator, power10(int64(shift)))
	} else {
		shift = 0
	}
	quotient, remainder := new(big.Int).QuoRem(numerator, denominator, new(big.Int))
	drop := len(quotient.String()) - decimalPrecision
	unit := power10(int64(drop))
	kept, rest := new(big.Int).QuoRem(quotient, unit, new(big.Int))
	half := new(big.Int).Rsh(unit, 1)
	switch order := rest.Cmp(half); {
	case order > 0, order == 0 && (remainder.Sign() != 0 || kept.Bit(0) == 1):
		kept.Add(kept, big.NewInt(1))
	}
	return kept, drop - shift
}

// framesAt — frames_at(seconds, rate): Fraction(str(seconds)) * rate делится как Decimal
// (28 значащих цифр) и затем округляется до целого половиной от нуля (ROUND_HALF_UP).
// Двойное округление принадлежит результату оригинала и сохраняется.
func framesAt(seconds any, rate *big.Rat) (*big.Int, error) {
	value, err := parseFraction(pycompat.Str(seconds))
	if err != nil {
		return nil, err
	}
	value.Mul(value, rate)
	if value.Sign() == 0 {
		return new(big.Int), nil
	}
	coefficient, exponent := divideDecimal(value)
	var result *big.Int
	if exponent >= 0 {
		result = new(big.Int).Mul(coefficient, power10(int64(exponent)))
	} else {
		unit := power10(int64(-exponent))
		kept, rest := new(big.Int).QuoRem(coefficient, unit, new(big.Int))
		if new(big.Int).Lsh(rest, 1).Cmp(unit) >= 0 {
			kept.Add(kept, big.NewInt(1))
		}
		result = kept
	}
	if value.Sign() < 0 {
		result.Neg(result)
	}
	return result, nil
}

// frameGrid — Fraction(FPS).
var frameGrid = big.NewRat(fps, 1)

// pad — f"{value:0{width}}" целого: нули между знаком и цифрами.
func pad(value *big.Int, width int) string {
	text := value.String()
	sign := ""
	if strings.HasPrefix(text, "-") {
		sign, text = "-", text[1:]
	}
	return sign + strings.Repeat("0", max(width-len(sign)-len(text), 0)) + text
}

// timecode — timecode(seconds): ЧЧ:ММ:СС:КК non-drop на 30 кадров/с. Деление с остатком — вниз,
// как // и % Python (big.Int.DivMod евклидов, при положительном делителе это то же самое).
func timecode(seconds any) (string, error) {
	total, err := framesAt(seconds, frameGrid)
	if err != nil {
		return "", err
	}
	divide := func(value *big.Int, by int64) (*big.Int, *big.Int) {
		return new(big.Int).DivMod(value, big.NewInt(by), new(big.Int))
	}
	whole, frames := divide(total, fps)
	hours, rest := divide(whole, 3600)
	minutes, _ := divide(rest, 60)
	_, secondsPart := divide(whole, 60)
	return pad(hours, 2) + ":" + pad(minutes, 2) + ":" + pad(secondsPart, 2) + ":" + pad(frames, 2), nil
}

// rational — rational(seconds): время FCPXML «кадры/30s».
func rational(seconds any) (string, error) {
	frames, err := framesAt(seconds, frameGrid)
	if err != nil {
		return "", err
	}
	return frames.String() + "/30s", nil
}

// ratFloat — float(Fraction): корректно округлённое деление; слишком большое значение — OverflowError.
func ratFloat(value *big.Rat) (float64, error) {
	result, _ := value.Float64()
	if math.IsInf(result, 0) {
		return 0, pycompat.New(pycompat.OverflowError, "integer division result too large for a float")
	}
	return result, nil
}

// round6 — round(value, 6) для float: точное двоичное значение округляется до шести знаков.
func round6(value float64) float64 {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return value
	}
	rounded, _ := strconv.ParseFloat(strconv.FormatFloat(value, 'f', 6, 64), 64)
	return rounded
}

// formatG — f"{value:g}" для float.
func formatG(value float64) string {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return pycompat.FloatRepr(value)
	}
	return strconv.FormatFloat(value, 'g', 6, 64)
}

// speedField — f"{value:05.1f}" для поля M2: нули между знаком и цифрами, в том числе у nan и inf.
func speedField(value float64) string {
	text := pycompat.FormatFixed(value, 1)
	sign := ""
	if strings.HasPrefix(text, "-") {
		sign, text = "-", text[1:]
	}
	return sign + strings.Repeat("0", max(5-len(sign)-len(text), 0)) + text
}
