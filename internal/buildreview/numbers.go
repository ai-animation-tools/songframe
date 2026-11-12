package buildreview

import (
	"math/big"
	"strconv"
	"strings"

	"songframe/internal/toolrt"
)

// Числовые помощники build_review. Кадры — целые произвольной длины (*big.Int), секунды —
// точные десятичные числа toolrt.Decimal с явными правилами округления и записи: от записи
// скорости и секунд зависят фильтры FFmpeg и байты рецепта, зафиксированные эталоном build-review.

// bigInt — значение toolrt.Int как *big.Int.
func bigInt(value toolrt.Int) *big.Int { return value.Big() }

// newInt — *big.Int как toolrt.Int для JSON.
func newInt(value *big.Int) toolrt.Int { return toolrt.IntFromBig(value) }

// mulInt — value * factor.
func mulInt(value *big.Int, factor int64) *big.Int {
	return new(big.Int).Mul(value, big.NewInt(factor))
}

// addInt — a + b.
func addInt(a, b *big.Int) *big.Int { return new(big.Int).Add(a, b) }

// subInt — a - b.
func subInt(a, b *big.Int) *big.Int { return new(big.Int).Sub(a, b) }

// isFinite — конечно ли десятичное значение (не NaN и не бесконечность).
func isFinite(value toolrt.Decimal) bool {
	return !value.IsNaN() && !strings.HasSuffix(value.FormatF(), "Infinity")
}

// rational — точное рациональное значение конечного десятичного числа.
func rational(value toolrt.Decimal) *big.Rat {
	result, _ := new(big.Rat).SetString(value.FormatF())
	return result
}

// roundHalfUp — округление рационального числа до целого, половина — от нуля.
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

// frames — секунды в кадры с округлением половины от нуля. У NaN и бесконечности — ошибки
// toolrt.Decimal.ToInt: ValueError «cannot convert NaN to integer» и OverflowError.
func frames(value toolrt.Decimal) (*big.Int, error) {
	if !isFinite(value) {
		_, err := value.ToInt()
		return nil, err
	}
	return roundHalfUp(rational(value)), nil
}

// framesTimesFPS — frames(value * fps): произведение с длительностью ffprobe или песни точное
// (значения короче 28 значащих цифр), поэтому считается рационально без потери.
func framesTimesFPS(value toolrt.Decimal, fps int64) (*big.Int, error) {
	if !isFinite(value) {
		_, err := value.ToInt()
		return nil, err
	}
	product := new(big.Rat).Mul(rational(value), new(big.Rat).SetInt64(fps))
	return roundHalfUp(product), nil
}

// seconds — кадры в секунды: точное частное на частоту проекта fps, квантованное до 9 знаков
// после точки, в записи без экспоненты.
func seconds(value *big.Int, fps int64) (string, error) {
	divided, err := decimalOf(value).Div(toolrt.DecimalInt(fps))
	if err != nil {
		return "", err
	}
	quantized, err := divided.Quantize(-9)
	if err != nil {
		return "", err
	}
	return quantized.FormatF(), nil
}

// secondsFloat — строка seconds(value, fps), разобранная как float64.
func secondsFloat(value *big.Int, fps int64) (float64, error) {
	text, err := seconds(value, fps)
	if err != nil {
		return 0, err
	}
	return strconv.ParseFloat(text, 64)
}

// samples — отсчёт звука 44,1 кГц на границе кадра frames при частоте fps, с округлением
// половины вверх (при 24 к/с кадр длится 1837,5 отсчёта).
func samples(frames *big.Int, fps int64) *big.Int {
	return roundHalfUp(new(big.Rat).SetFrac(new(big.Int).Mul(frames, big.NewInt(44100)), big.NewInt(fps)))
}

// decimalOf — целое произвольной длины как toolrt.Decimal.
func decimalOf(value *big.Int) toolrt.Decimal {
	result, _ := toolrt.NewDecimal(toolrt.IntFromBig(value))
	return result
}

// DecimalText — каноническая запись конечного десятичного числа text: значащие цифры и нули
// дробной части сохраняются, запись без экспоненты — при неположительном показателе и порядке
// не ниже −6, иначе научная с одной цифрой до точки и «E±n» («1E+1» → «1E+1», «0.50» → «0.50»,
// «5E-1» → «0.5», «1e-7» → «1E-7»). Разбор допускает пробелы по краям, подчёркивания между
// цифрами и десятичные цифры Unicode; ok=false — не конечное число. Нужна для строки скорости в
// фильтре setpts и в рецепте пробы.
func DecimalText(text string) (string, bool) {
	var builder strings.Builder
	for _, r := range toolrt.Runes(text) {
		switch {
		case r == '_':
		case toolrt.IsSpace(r):
			builder.WriteByte(' ')
		case toolrt.DigitValue(r) >= 0:
			builder.WriteByte(byte('0' + toolrt.DigitValue(r)))
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
