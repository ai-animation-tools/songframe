package dynvalue

import (
	"math"
	"math/big"
	"strings"
)

// ToFixed — запись числа с digits знаками после точки (digits 0…100). Сообщения проверок выводят
// так секунды, и округление зафиксировано эталонами: берётся целое n, ближайшее к x·10^digits по
// точному двоичному значению, а при равенстве — большее (strconv округляет такие точные середины
// к чётному, например 0.125 → «0.12» вместо «0.13»). Отрицательное число форматируется как модуль
// со знаком «-», -0 — без знака; NaN — «NaN», |x| ≥ 1e21 и бесконечности — как NumberToString.
func ToFixed(value float64, digits int) string {
	if math.IsNaN(value) {
		return "NaN"
	}
	if math.Abs(value) >= 1e21 || math.IsInf(value, 0) {
		return NumberToString(value)
	}
	sign := ""
	if value < 0 {
		sign = "-"
		value = -value
	}
	scaled := new(big.Rat).SetFloat64(value)
	scaled.Mul(scaled, new(big.Rat).SetInt(new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(digits)), nil)))
	scaled.Add(scaled, big.NewRat(1, 2))
	// Floor неотрицательной дроби — целочисленное деление числителя на знаменатель.
	n := new(big.Int).Quo(scaled.Num(), scaled.Denom())
	text := n.String()
	if digits == 0 {
		return sign + text
	}
	if len(text) <= digits {
		text = strings.Repeat("0", digits-len(text)+1) + text
	}
	return sign + text[:len(text)-digits] + "." + text[len(text)-digits:]
}
