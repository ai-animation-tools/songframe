package jscompat

import (
	"math"
	"testing"
)

// TestToFixed сверяет значения с Number.prototype.toFixed Node.js (сняты вручную).
func TestToFixed(t *testing.T) {
	cases := []struct {
		value  float64
		digits int
		want   string
	}{
		{0.125, 2, "0.13"}, {1.005, 2, "1.00"}, {2.5, 0, "3"}, {-2.5, 0, "-3"}, {-0.001, 2, "-0.00"},
		{math.Copysign(0, -1), 2, "0.00"}, {30, 2, "30.00"}, {8.033333333333333, 3, "8.033"}, {29.9999, 3, "30.000"},
		{0.0005, 3, "0.001"}, {1e21, 2, "1e+21"}, {math.NaN(), 2, "NaN"},
	}
	for _, item := range cases {
		if got := ToFixed(item.value, item.digits); got != item.want {
			t.Errorf("ToFixed(%v, %d) = %q, want %q", item.value, item.digits, got, item.want)
		}
	}
}

// TestDeepCloneIsIndependent — правка копии не меняет исходное дерево, порядок ключей сохраняется.
func TestDeepCloneIsIndependent(t *testing.T) {
	source, err := Parse([]byte(`{"b":{"x":[1,{"y":2}]},"a":"s"}`))
	if err != nil {
		t.Fatal(err)
	}
	copy := DeepClone(source).(*Object)
	copy.Value("b").(*Object).Value("x").(*Array).Items[1].(*Object).Set("y", 3.0)
	copy.Set("c", true)
	if Stringify(source) != `{"b":{"x":[1,{"y":2}]},"a":"s"}` || Stringify(copy) != `{"b":{"x":[1,{"y":3}]},"a":"s","c":true}` {
		t.Fatalf("%s / %s", Stringify(source), Stringify(copy))
	}
}
