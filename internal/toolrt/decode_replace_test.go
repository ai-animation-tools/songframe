package toolrt

import (
	"encoding/hex"
	"testing"
)

// TestDecodeReplace — декодирование с заменой: один U+FFFD на максимальный неверный участок
// (обрезанная последовательность — один знак, суррогат и избыточная запись — по знаку на байт).
func TestDecodeReplace(t *testing.T) {
	for _, item := range []struct{ input, want string }{
		{"6f6b", "ok"},
		{"ff", "�"},
		{"61e282", "a�"},
		{"e28258", "�X"},
		{"f09f98", "�"},
		{"eda080", "���"},
		{"c0af", "��"},
		{"f49080807a", "����z"},
		{"d09fd1", "П�"},
	} {
		data, _ := hex.DecodeString(item.input)
		if got := DecodeReplace(data); got != item.want {
			t.Errorf("%s: %q, ожидалось %q", item.input, got, item.want)
		}
	}
}
