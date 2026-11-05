package buildreview

import (
	"math/big"
	"strconv"
	"strings"

	"songframe-go/internal/pycompat"
)

// Числовые помощники build_review. Оригинал считает кадры целыми Python произвольной длины и
// Decimal; здесь кадры — *big.Int, а округления и строки повторяют decimal.Decimal: от записи
// скорости и секунд зависят фильтры FFmpeg и байты рецепта.

// bigInt — значение pycompat.Int как *big.Int.
func bigInt(value pycompat.Int) *big.Int { return value.Big() }

// newInt — *big.Int как pycompat.Int для JSON.
func newInt(value *big.Int) pycompat.Int { return pycompat.IntFromBig(value) }

// mulInt — value * factor.
func mulInt(value *big.Int, factor int64) *big.Int {
	return new(big.Int).Mul(value, big.NewInt(factor))
}

// addInt — a + b.
func addInt(a, b *big.Int) *big.Int { return new(big.Int).Add(a, b) }

// subInt — a - b.
func subInt(a, b *big.Int) *big.Int { return new(big.Int).Sub(a, b) }

// isFinite — Decimal.is_finite().
func isFinite(value pycompat.Decimal) bool {
	return !value.IsNaN() && !strings.HasSuffix(value.FormatF(), "Infinity")
}

// rational — точное значение конечного Decimal.
func rational(value pycompat.Decimal) *big.Rat {
	result, _ := new(big.Rat).SetString(value.FormatF())
	return result
}

// roundHalfUp — округление рационального числа до целого, половина — от нуля (ROUND_HALF_UP).
func roundHalfUp(value *big.Rat) *big.Int {
	numerator := new(big.Int).Abs(value.Num())
	// floor(|x| + 1/2) = (2·|num| + den) div (2·den).
	twice := new(big.Int).Mul(numerator, big.NewInt(2))
	twice.Add(twice, value.Denom())
	result := twice.Quo(twice, new(big.Int).Mul(value.Denom(), big.NewInt(2)))
	if value.Sign() < 0 {
		result.Neg(result)
	}
	return result
}

// frames — frames(value) оригинала: int(value.to_integral_value(ROUND_HALF_UP)). У NaN и
// бесконечности — ошибки int(): ValueError «cannot convert NaN to integer» и OverflowError.
func frames(value pycompat.Decimal) (*big.Int, error) {
	if !isFinite(value) {
		_, err := value.ToInt()
		return nil, err
	}
	return roundHalfUp(rational(value)), nil
}

// framesTimesFPS — frames(value * FPS): произведение с длительностью ffprobe или песни точное
// (значения короче 28 значащих цифр), поэтому считается рационально без потери.
func framesTimesFPS(value pycompat.Decimal) (*big.Int, error) {
	if !isFinite(value) {
		_, err := value.ToInt()
		return nil, err
	}
	product := new(big.Rat).Mul(rational(value), new(big.Rat).SetInt64(FPS))
	return roundHalfUp(product), nil
}

// seconds — seconds(value) оригинала: кадры в секунды строкой format(Decimal/30, "f") с 9 знаками.
func seconds(value *big.Int) (string, error) {
	divided, err := decimalOf(value).Div(pycompat.DecimalInt(FPS))
	if err != nil {
		return "", err
	}
	quantized, err := divided.Quantize(-9)
	if err != nil {
		return "", err
	}
	return quantized.FormatF(), nil
}

// secondsFloat — float(seconds(value)).
func secondsFloat(value *big.Int) (float64, error) {
	text, err := seconds(value)
	if err != nil {
		return 0, err
	}
	return strconv.ParseFloat(text, 64)
}

// decimalOf — Decimal(int) для целого произвольной длины.
func decimalOf(value *big.Int) pycompat.Decimal {
	result, _ := pycompat.NewDecimal(pycompat.IntFromBig(value))
	return result
}

// DecimalText — str(Decimal(text)) для конечного значения: to_sci_string, как печатает Python
// (Decimal("1E+1") → «1E+1», Decimal("0.50") → «0.50», Decimal("5E-1") → «0.5»). Разбор строки
// повторяет конструктор Decimal (пробелы по краям, подчёркивания, цифры Unicode); ok=false — не
// конечное число. Нужна для строки скорости в фильтре setpts и в рецепте пробы.
func DecimalText(text string) (string, bool) {
	var builder strings.Builder
	for _, r := range pycompat.Runes(text) {
		switch {
		case r == '_':
		case pycompat.IsSpace(r):
			builder.WriteByte(' ')
		case pycompat.DigitValue(r) >= 0:
			builder.WriteByte(byte('0' + pycompat.DigitValue(r)))
		case r < 0x80:
			builder.WriteRune(r)
		default:
			return "", false
		}
	}
	body := strings.ToLower(strings.Trim(builder.String(), " "))
	sign := ""
	if strings.HasPrefix(body, "-") || strings.HasPrefix(body, "+") {
		if body[0] == '-' {
			sign = "-"
		}
		body = body[1:]
	}
	mantissa, exponentText, hasExponent := strings.Cut(body, "e")
	whole, fraction, _ := strings.Cut(mantissa, ".")
	digits := whole + fraction
	if digits == "" || strings.Count(mantissa, ".") > 1 || strings.Trim(digits, "0123456789") != "" {
		return "", false
	}
	exponent := 0
	if hasExponent {
		value, err := strconv.Atoi(exponentText)
		if err != nil {
			return "", false
		}
		exponent = value
	}
	exponent -= len(fraction)
	digits = strings.TrimLeft(digits, "0")
	if digits == "" {
		digits = "0"
	}
	left := exponent + len(digits)
	dot := 1
	if exponent <= 0 && left > -6 {
		dot = left
	}
	var integer, rest string
	switch {
	case dot <= 0:
		integer, rest = "0", "."+strings.Repeat("0", -dot)+digits
	case dot >= len(digits):
		integer = digits + strings.Repeat("0", dot-len(digits))
	default:
		integer, rest = digits[:dot], "."+digits[dot:]
	}
	suffix := ""
	if left != dot {
		suffix = "E" + strconv.FormatInt(int64(left-dot), 10)
		if left-dot > 0 {
			suffix = "E+" + strconv.FormatInt(int64(left-dot), 10)
		}
	}
	return sign + integer + rest + suffix, true
}
