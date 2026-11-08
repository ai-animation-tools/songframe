package exportbundle

import (
	"math"
	"math/big"
	"strconv"
	"strings"

	"songframe/internal/toolregex"
	"songframe/internal/toolrt"
)

// fps — частота шкалы аниматика.
const fps = 30

// Точная арифметика и форматы чисел, от которых зависят байты пакета (эталон
// testdata/golden/export-edit-bundle): дроби big.Rat, десятичное деление с точностью 28 значащих
// цифр и записи чисел в строках пакета.

// rationalFormat — грамматика строковой записи дроби с нумерованными группами: знак (1), целая
// часть или числитель (2), знаменатель после «/» (4), дробная часть (6), десятичный порядок после
// «e» (8). Между цифрами допускаются одиночные «_», по краям — пробельные символы.
var rationalFormat = toolregex.MustCompile(`\A\s*([-+]?)(?=\d|\.\d)(\d*|\d+(_\d+)*)(?:(?:\s*/\s*(\d+(_\d+)*))?|(?:\.(\d*|\d+(_\d+)*))?(?:E([-+]?\d+(_\d+)*))?)\s*\Z`, toolregex.IgnoreCase)

// parseInteger — целое из группы цифр регулярного выражения: подчёркивания пропускаются, цифра
// любой письменности Unicode читается своим значением (toolrt.DigitValue).
func parseInteger(text string) *big.Int {
	result := new(big.Int)
	ten := big.NewInt(10)
	for _, r := range text {
		if r == '_' {
			continue
		}
		result.Mul(result, ten).Add(result, big.NewInt(int64(toolrt.DigitValue(r))))
	}
	return result
}

// power10 — десять в степени n.
func power10(n int64) *big.Int {
	return new(big.Int).Exp(big.NewInt(10), big.NewInt(n), nil)
}

// parseFraction — точная дробь из строки: целое, «a/b» или десятичная запись с порядком.
// Неверная строка — исключение toolrt ValueError, нулевой знаменатель — ZeroDivisionError;
// их тексты зафиксированы эталоном.
func parseFraction(text string) (*big.Rat, error) {
	match, ok := rationalFormat.MatchString(text)
	if !ok {
		return nil, toolrt.Raise(toolrt.ValueError, "неверная запись дроби: %s", toolrt.Repr(text))
	}
	whole, _ := match.Group(2)
	numerator := parseInteger(whole)
	denominator := big.NewInt(1)
	if denom, found := match.Group(4); found && denom != "" {
		denominator = parseInteger(denom)
	} else {
		if decimal, found := match.Group(6); found && decimal != "" {
			digits := strings.ReplaceAll(decimal, "_", "")
			scale := power10(int64(len(toolrt.Runes(digits))))
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
		return nil, toolrt.Raise(toolrt.ZeroDivisionError, "дробь с нулевым знаменателем: %s/0", numerator.String())
	}
	return new(big.Rat).SetFrac(numerator, denominator), nil
}

// fractionOf — точная дробь значения из JSON: bool и целое toolrt.Int — целые, float — его точное
// двоичное значение (NaN — ValueError, бесконечность — OverflowError), строка разбирается
// parseFraction, прочее — TypeError.
func fractionOf(value any) (*big.Rat, error) {
	switch item := value.(type) {
	case bool:
		if item {
			return big.NewRat(1, 1), nil
		}
		return new(big.Rat), nil
	case toolrt.Int:
		return new(big.Rat).SetInt(item.Big()), nil
	case float64:
		if math.IsNaN(item) {
			return nil, toolrt.New(toolrt.ValueError, "NaN нельзя представить дробью")
		}
		if math.IsInf(item, 0) {
			return nil, toolrt.New(toolrt.OverflowError, "бесконечность нельзя представить дробью")
		}
		return new(big.Rat).SetFloat64(item), nil
	case string:
		return parseFraction(item)
	}
	return nil, toolrt.New(toolrt.TypeError, "ожидается строка или дробь")
}

// decimalPrecision — число значащих цифр десятичного деления.
const decimalPrecision = 28

// divideDecimal — модуль дроби value десятичным числом из decimalPrecision значащих цифр:
// коэффициент coefficient и степень десяти exponent, половина округляется к чётному.
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

// framesAt — секунды в кадры: строковая запись seconds (toolrt.Str) читается точной дробью и
// умножается на rate, произведение приводится к 28 значащим цифрам (половина к чётному) и затем
// округляется до целого, половина — от нуля. Двойное округление входит в формат пакета,
// зафиксированный эталоном.
func framesAt(seconds any, rate *big.Rat) (*big.Int, error) {
	value, err := parseFraction(toolrt.Str(seconds))
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

// frameGrid — частота шкалы аниматика дробью.
var frameGrid = big.NewRat(fps, 1)

// pad — целое, дополненное нулями до ширины width; нули стоят между знаком и цифрами.
func pad(value *big.Int, width int) string {
	text := value.String()
	sign := ""
	if strings.HasPrefix(text, "-") {
		sign, text = "-", text[1:]
	}
	return sign + strings.Repeat("0", max(width-len(sign)-len(text), 0)) + text
}

// timecode — таймкод ЧЧ:ММ:СС:КК non-drop на 30 кадров/с. Частное округляется вниз, остаток
// неотрицателен (big.Int.DivMod евклидов, при положительном делителе это то же самое): у
// отрицательного времени отрицательны только часы.
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

// rational — время FCPXML «кадры/30s» на шкале 30 кадров/с.
func rational(seconds any) (string, error) {
	frames, err := framesAt(seconds, frameGrid)
	if err != nil {
		return "", err
	}
	return frames.String() + "/30s", nil
}

// ratFloat — дробь в ближайший float64; значение вне диапазона float — исключение toolrt OverflowError.
func ratFloat(value *big.Rat) (float64, error) {
	result, _ := value.Float64()
	if math.IsInf(result, 0) {
		return 0, toolrt.New(toolrt.OverflowError, "слишком большое число")
	}
	return result, nil
}

// round6 — float, округлённый до шести знаков после точки по точному двоичному значению;
// NaN и бесконечности не меняются.
func round6(value float64) float64 {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return value
	}
	rounded, _ := strconv.ParseFloat(strconv.FormatFloat(value, 'f', 6, 64), 64)
	return rounded
}

// formatG — краткая запись float: шесть значащих цифр без хвостовых нулей, экспонента при
// больших и малых порядках; NaN и бесконечности — как toolrt.FloatRepr.
func formatG(value float64) string {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return toolrt.FloatRepr(value)
	}
	return strconv.FormatFloat(value, 'g', 6, 64)
}

// speedField — скорость для поля M2: одна цифра после точки, ширина 5 с нулями между знаком и
// цифрами, в том числе у nan и inf.
func speedField(value float64) string {
	text := toolrt.FormatFixed(value, 1)
	sign := ""
	if strings.HasPrefix(text, "-") {
		sign, text = "-", text[1:]
	}
	return sign + strings.Repeat("0", max(5-len(sign)-len(text), 0)) + text
}
