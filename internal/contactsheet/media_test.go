package contactsheet

import (
	"testing"

	"songframe-go/internal/pycompat"
)

// TestRoundedProduct — int((duration * rate).to_integral_value()) Decimal Python: 28 значащих
// цифр произведения, затем округление половины к чётному (значения сверены с CPython 3.12).
func TestRoundedProduct(t *testing.T) {
	decimal := func(text string) pycompat.Decimal {
		value, err := pycompat.NewDecimal(text)
		if err != nil {
			t.Fatal(err)
		}
		return value
	}
	ntsc, err := decimal("30000").Div(decimal("1001"))
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range []struct {
		duration string
		rate     pycompat.Decimal
		want     string
	}{
		{"2.5", decimal("1"), "2"},
		{"3.5", decimal("1"), "4"},
		{"-2.5", decimal("1"), "-2"},
		{"0.333", ntsc, "10"},
		{"2.041667", decimal("24"), "49"},
		{"0", ntsc, "0"},
		// 0.5005 × 30000/1001 = 14.99999…985 до округления до 28 цифр и 15 после него.
		{"0.5005", ntsc, "15"},
	} {
		got, err := roundedProduct(decimal(item.duration), item.rate)
		if err != nil || got.String() != item.want {
			t.Errorf("%s × %s: %v %v, ожидалось %s", item.duration, item.rate, got, err, item.want)
		}
	}
	if _, err := roundedProduct(decimal("NaN"), decimal("1")); err == nil || err.Error() != "cannot convert NaN to integer" {
		t.Errorf("NaN: %v", err)
	}
	if _, err := roundedProduct(decimal("Infinity"), decimal("0")); !pycompat.Is(err, pycompat.InvalidOperation) {
		t.Errorf("inf × 0: %v", err)
	}
	if _, err := roundedProduct(decimal("Infinity"), decimal("2")); !pycompat.Is(err, pycompat.OverflowError) {
		t.Errorf("inf: %v", err)
	}
}

// TestToInt — int() значений JSON ffprobe.
func TestToInt(t *testing.T) {
	for _, item := range []struct {
		value any
		want  string
		fails bool
	}{
		{"640", "640", false}, {" 1_000 ", "1000", false}, {"-7", "-7", false}, {pycompat.NewInt(5), "5", false},
		{12.9, "12", false}, {true, "1", false}, {"1__0", "", true}, {"_1", "", true}, {"", "", true}, {"N/A", "", true}, {nil, "", true},
	} {
		got, err := toInt(item.value)
		if item.fails != (err != nil) || (!item.fails && got.String() != item.want) {
			t.Errorf("%#v: %v %v", item.value, got, err)
		}
	}
}
