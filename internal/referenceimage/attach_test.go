package referenceimage

import (
	"fmt"
	"testing"
)

// TestAttachUnknownView — неизвестный вид изображения отклоняется до чтения проекта: в опись не
// попадает значение, которого нет среди видов референса.
func TestAttachUnknownView(t *testing.T) {
	err := Attach(t.TempDir(), "oleg", Result{}, "sideways")
	if err == nil || err.Error() != fmt.Sprintf(textUnknownView, "sideways") {
		t.Fatalf("неизвестный вид: %v", err)
	}
}
