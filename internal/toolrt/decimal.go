package toolrt

import (
	"math"
	"math/big"
	"strings"
)

// Decimal — десятичное число с точностью 28 значащих цифр и округлением половины к чётному в
// объёме, нужном инструментам: построение из целого, дробного и строки, деление, вычитание,
// остаток, модуль, квантование, сравнение, приведение к целому и позиционная запись. Показатель
// сохраняется при операциях, поэтому число из «12.50» печатается «12.50»: от этого зависят строки
// времени в выводе инструментов.
type Decimal struct {
	negative bool
	coef     *big.Int // неотрицательный коэффициент конечного значения
	exp      int
	special  decimalSpecial
	payload  string // диагностические цифры NaN
}

type decimalSpecial int

const (
	finite decimalSpecial = iota
	infinite
	quietNaN
	signalingNaN
)

// precision — число значащих цифр результата арифметики.
const precision = 28

var (
	bigTen = big.NewInt(10)
	bigOne = big.NewInt(1)
)

// conversionSyntax — исключение для строки, которая не является десятичным числом.
func conversionSyntax() error {
	return Raise(InvalidOperation, "[<class 'decimal.ConversionSyntax'>]")
}

// invalidOperation — исключение недопустимой операции (NaN в сравнении, inf - inf, quantize inf).
func invalidOperation() error {
	return Raise(InvalidOperation, "[<class 'decimal.InvalidOperation'>]")
}

// DecimalInt — десятичное число из целого.
func DecimalInt(value int64) Decimal {
	return Decimal{negative: value < 0, coef: new(big.Int).Abs(big.NewInt(value))}
}

// NewDecimal — десятичное число из значения модели: Int и bool точно, float64 — точным двоичным
// значением, строка — по parseDecimal (пробелы по краям, подчёркивания, цифры Unicode).
func NewDecimal(value any) (Decimal, error) {
	switch item := value.(type) {
	case bool, Int:
		number, _ := asNumeric(item)
		return Decimal{negative: number.integer.Sign() < 0, coef: new(big.Int).Abs(number.integer)}, nil
	case float64:
		return decimalFromFloat(item), nil
	case string:
		return parseDecimal(item)
	case []any:
		return Decimal{}, Raise(ValueError, "argument must be a sequence of length 3")
	}
	return Decimal{}, Raise(TypeError, "conversion from %s to Decimal is not supported", TypeName(value))
}

// decimalFromFloat — точная десятичная запись двоичного значения.
func decimalFromFloat(value float64) Decimal {
	switch {
	case math.IsNaN(value):
		return Decimal{special: quietNaN, coef: new(big.Int)}
	case math.IsInf(value, 0):
		return Decimal{special: infinite, negative: value < 0, coef: new(big.Int)}
	}
	negative := math.Signbit(value)
	fraction, exponent := math.Frexp(math.Abs(value))
	mantissa := int64(fraction * (1 << 53))
	exponent -= 53
	for mantissa != 0 && mantissa%2 == 0 {
		mantissa /= 2
		exponent++
	}
	coef := big.NewInt(mantissa)
	if exponent >= 0 {
		coef.Lsh(coef, uint(exponent))
		return Decimal{negative: negative, coef: coef}
	}
	five := new(big.Int).Exp(big.NewInt(5), big.NewInt(int64(-exponent)), nil)
	return Decimal{negative: negative, coef: coef.Mul(coef, five), exp: exponent}
}

// parseDecimal — разбор строки десятичного числа: подчёркивания отбрасываются, пробельные символы
// Unicode по краям снимаются, цифры Unicode становятся ASCII; допустимы знак, точка, экспонента,
// Infinity/Inf, NaN и sNaN с необязательной нагрузкой без учёта регистра.
func parseDecimal(text string) (Decimal, error) {
	var builder strings.Builder
	for _, r := range Runes(text) {
		switch {
		case r == '_':
		case IsSpace(r):
			builder.WriteByte(' ')
		case DigitValue(r) >= 0:
			builder.WriteByte(byte('0' + DigitValue(r)))
		case r < 0x80:
			builder.WriteRune(r)
		default:
			return Decimal{}, conversionSyntax()
		}
	}
	body := strings.Trim(builder.String(), " ")
	result := Decimal{coef: new(big.Int)}
	if strings.HasPrefix(body, "-") || strings.HasPrefix(body, "+") {
		result.negative = body[0] == '-'
		body = body[1:]
	}
	lower := strings.ToLower(body)
	switch {
	case lower == "inf" || lower == "infinity":
		result.special = infinite
		return result, nil
	case strings.HasPrefix(lower, "nan") || strings.HasPrefix(lower, "snan"):
		result.special = quietNaN
		payload := strings.TrimPrefix(lower, "nan")
		if strings.HasPrefix(lower, "snan") {
			result.special = signalingNaN
			payload = strings.TrimPrefix(lower, "snan")
		}
		for _, r := range payload {
			if !isDigit(r) {
				return Decimal{}, conversionSyntax()
			}
		}
		result.payload = strings.TrimLeft(payload, "0")
		return result, nil
	}
	mantissa, exponentText, hasExponent := strings.Cut(lower, "e")
	whole, fraction, _ := strings.Cut(mantissa, ".")
	digits := whole + fraction
	if digits == "" || strings.Count(mantissa, ".") > 1 {
		return Decimal{}, conversionSyntax()
	}
	for _, r := range digits {
		if !isDigit(r) {
			return Decimal{}, conversionSyntax()
		}
	}
	exponent := 0
	if hasExponent {
		unsigned := strings.TrimLeft(exponentText, "+-")
		if unsigned == "" || len(exponentText)-len(unsigned) > 1 {
			return Decimal{}, conversionSyntax()
		}
		value, ok := new(big.Int).SetString(exponentText, 10)
		if !ok || !value.IsInt64() || value.Int64() > 999999999999999999 || value.Int64() < -999999999999999999 {
			return Decimal{}, conversionSyntax()
		}
		exponent = int(value.Int64())
	}
	result.coef.SetString(digits, 10)
	result.exp = exponent - len(fraction)
	return result, nil
}

// IsNaN — значение NaN (тихое или сигнальное).
func (d Decimal) IsNaN() bool { return d.special == quietNaN || d.special == signalingNaN }

// digits — число цифр коэффициента (у нуля — 1).
func digits(value *big.Int) int {
	if value.Sign() == 0 {
		return 1
	}
	return len(value.String())
}

// pow10 — 10 в степени n.
func pow10(n int) *big.Int { return new(big.Int).Exp(bigTen, big.NewInt(int64(n)), nil) }

// roundHalfEven — value / 10^drop с округлением половины к чётному.
func roundHalfEven(value *big.Int, drop int) *big.Int {
	if drop <= 0 {
		return new(big.Int).Mul(value, pow10(-drop))
	}
	divisor := pow10(drop)
	quotient, remainder := new(big.Int).QuoRem(value, divisor, new(big.Int))
	twice := new(big.Int).Lsh(remainder, 1)
	switch twice.Cmp(divisor) {
	case 1:
		quotient.Add(quotient, bigOne)
	case 0:
		if quotient.Bit(0) == 1 {
			quotient.Add(quotient, bigOne)
		}
	}
	return quotient
}

// fix — приведение к точности: коэффициент длиннее 28 цифр округляется половиной к чётному.
func (d Decimal) fix() Decimal {
	if d.special != finite {
		return d
	}
	if count := digits(d.coef); count > precision {
		drop := count - precision
		d.coef = roundHalfEven(d.coef, drop)
		d.exp += drop
		if digits(d.coef) > precision {
			d.coef = roundHalfEven(d.coef, 1)
			d.exp++
		}
	}
	return d
}

// signedCoef — коэффициент со знаком, приведённый к показателю exp (exp ≤ d.exp).
func (d Decimal) signedCoef(exp int) *big.Int {
	value := new(big.Int).Mul(d.coef, pow10(d.exp-exp))
	if d.negative {
		value.Neg(value)
	}
	return value
}

// Neg — -d.
func (d Decimal) Neg() Decimal {
	d.negative = !d.negative
	return d
}

// Abs — модуль d.
func (d Decimal) Abs() Decimal {
	d.negative = false
	return d
}

// Add — d + other.
func (d Decimal) Add(other Decimal) (Decimal, error) {
	if d.IsNaN() || other.IsNaN() {
		if d.special == signalingNaN || other.special == signalingNaN {
			return Decimal{}, invalidOperation()
		}
		if d.IsNaN() {
			return d, nil
		}
		return other, nil
	}
	if d.special == infinite || other.special == infinite {
		if d.special == infinite && other.special == infinite && d.negative != other.negative {
			return Decimal{}, invalidOperation()
		}
		if d.special == infinite {
			return d, nil
		}
		return other, nil
	}
	exp := min(d.exp, other.exp)
	sum := new(big.Int).Add(d.signedCoef(exp), other.signedCoef(exp))
	result := Decimal{negative: sum.Sign() < 0, coef: new(big.Int).Abs(sum), exp: exp}
	if sum.Sign() == 0 {
		// Точный ноль положителен, кроме суммы двух отрицательных нулей (ROUND_HALF_EVEN).
		result.negative = d.negative && other.negative
	}
	return result.fix(), nil
}

// Sub — d - other.
func (d Decimal) Sub(other Decimal) (Decimal, error) { return d.Add(other.Neg()) }

// Div — d / other: точный результат приводится к идеальному показателю, иначе 28 значащих цифр.
func (d Decimal) Div(other Decimal) (Decimal, error) {
	if d.special != finite || other.special != finite {
		if d.IsNaN() {
			return d, nil
		}
		if other.IsNaN() {
			return other, nil
		}
		if d.special == infinite && other.special == infinite {
			return Decimal{}, invalidOperation()
		}
		if d.special == infinite {
			return Decimal{special: infinite, negative: d.negative != other.negative, coef: new(big.Int)}, nil
		}
		return Decimal{negative: d.negative != other.negative, coef: new(big.Int), exp: -1 << 30}, nil
	}
	negative := d.negative != other.negative
	if other.coef.Sign() == 0 {
		if d.coef.Sign() == 0 {
			return Decimal{}, Raise(InvalidOperation, "[<class 'decimal.DivisionUndefined'>]")
		}
		return Decimal{}, Raise(ZeroDivisionError, "[<class 'decimal.DivisionByZero'>]")
	}
	if d.coef.Sign() == 0 {
		return Decimal{negative: negative, coef: new(big.Int), exp: d.exp - other.exp}, nil
	}
	shift := digits(other.coef) - digits(d.coef) + precision + 1
	exp := d.exp - other.exp - shift
	var quotient, remainder *big.Int
	if shift >= 0 {
		quotient, remainder = new(big.Int).QuoRem(new(big.Int).Mul(d.coef, pow10(shift)), other.coef, new(big.Int))
	} else {
		quotient, remainder = new(big.Int).QuoRem(d.coef, new(big.Int).Mul(other.coef, pow10(-shift)), new(big.Int))
	}
	if remainder.Sign() != 0 {
		// Неточный результат: лишняя единица в последней цифре сохраняет правильное округление.
		if new(big.Int).Mod(quotient, big.NewInt(5)).Sign() == 0 {
			quotient.Add(quotient, bigOne)
		}
	} else {
		ideal := d.exp - other.exp
		for exp < ideal && new(big.Int).Mod(quotient, bigTen).Sign() == 0 {
			quotient.Quo(quotient, bigTen)
			exp++
		}
	}
	return Decimal{negative: negative, coef: quotient, exp: exp}.fix(), nil
}

// Mod — d % other: остаток со знаком делимого и показателем min(d.exp, other.exp).
func (d Decimal) Mod(other Decimal) (Decimal, error) {
	if d.IsNaN() {
		return d, nil
	}
	if other.IsNaN() {
		return other, nil
	}
	if d.special == infinite || other.coef.Sign() == 0 && other.special == finite {
		return Decimal{}, invalidOperation()
	}
	if other.special == infinite {
		return d, nil
	}
	exp := min(d.exp, other.exp)
	a := new(big.Int).Mul(d.coef, pow10(d.exp-exp))
	b := new(big.Int).Mul(other.coef, pow10(other.exp-exp))
	quotient, remainder := new(big.Int).QuoRem(a, b, new(big.Int))
	if digits(quotient) > precision {
		return Decimal{}, Raise(InvalidOperation, "[<class 'decimal.DivisionImpossible'>]")
	}
	return Decimal{negative: d.negative, coef: remainder, exp: exp}.fix(), nil
}

// Quantize — d с показателем exp (шаг 10^exp), округление половины к чётному. Бесконечность
// и результат длиннее precision — InvalidOperation, NaN остаётся NaN.
func (d Decimal) Quantize(exp int) (Decimal, error) {
	if d.IsNaN() {
		return d, nil
	}
	if d.special == infinite {
		return Decimal{}, invalidOperation()
	}
	coef := roundHalfEven(d.coef, exp-d.exp)
	if digits(coef) > precision {
		return Decimal{}, invalidOperation()
	}
	return Decimal{negative: d.negative, coef: coef, exp: exp}, nil
}

// Cmp — сравнение для <, <=, >, >=: NaN с любой стороны — InvalidOperation.
func (d Decimal) Cmp(other Decimal) (int, error) {
	if d.IsNaN() || other.IsNaN() {
		return 0, invalidOperation()
	}
	value := func(x Decimal) int {
		if x.special == infinite {
			if x.negative {
				return -1
			}
			return 1
		}
		return 0
	}
	if d.special == infinite || other.special == infinite {
		a, b := value(d), value(other)
		switch {
		case a < b:
			return -1, nil
		case a > b:
			return 1, nil
		}
		return 0, nil
	}
	exp := min(d.exp, other.exp)
	return d.signedCoef(exp).Cmp(other.signedCoef(exp)), nil
}

// ToInt — приведение к целому отбрасыванием дробной части к нулю.
func (d Decimal) ToInt() (Int, error) {
	switch d.special {
	case infinite:
		return Int{}, Raise(OverflowError, "cannot convert Infinity to integer")
	case quietNaN, signalingNaN:
		return Int{}, Raise(ValueError, "cannot convert NaN to integer")
	}
	var value *big.Int
	if d.exp >= 0 {
		value = new(big.Int).Mul(d.coef, pow10(d.exp))
	} else {
		value = new(big.Int).Quo(d.coef, pow10(-d.exp))
	}
	if d.negative {
		value.Neg(value)
	}
	return IntFromBig(value), nil
}

// FormatF — позиционная запись: все цифры коэффициента в позиционной записи без экспоненты.
func (d Decimal) FormatF() string {
	sign := ""
	if d.negative {
		sign = "-"
	}
	switch d.special {
	case infinite:
		return sign + "Infinity"
	case quietNaN:
		return sign + "NaN" + d.payload
	case signalingNaN:
		return sign + "sNaN" + d.payload
	}
	coef, exp := d.coef.String(), d.exp
	if d.coef.Sign() == 0 && exp > 0 {
		exp = 0
	}
	dot := exp + len(coef)
	switch {
	case dot <= 0:
		return sign + "0." + strings.Repeat("0", -dot) + coef
	case dot >= len(coef):
		return sign + coef + strings.Repeat("0", dot-len(coef))
	}
	return sign + coef[:dot] + "." + coef[dot:]
}

// String — запись для отладки: та же, что FormatF.
func (d Decimal) String() string { return d.FormatF() }

// DecimalOperand — правый операнд арифметики с Decimal: Int, bool и Decimal допустимы, остальное —
// TypeError «unsupported operand type(s) for /: 'decimal.Decimal' and 'float'».
func DecimalOperand(value any, operator string) (Decimal, error) {
	if IsInt(value) {
		return NewDecimal(value)
	}
	if decimal, ok := value.(Decimal); ok {
		return decimal, nil
	}
	return Decimal{}, Raise(TypeError, "unsupported operand type(s) for %s: 'decimal.Decimal' and '%s'", operator, TypeName(value))
}
