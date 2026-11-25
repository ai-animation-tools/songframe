package exportbundle

import (
	"math/big"
	"testing"

	"songframe/internal/toolcli"
	"songframe/internal/toolrt"
)

// TestSpeedPartsNote — части скорости для EDL монтажёра: множитель и секунды оригинала на сетке.
func TestSpeedPartsNote(t *testing.T) {
	part := func(start, end int64, factor float64) any {
		return toolcli.Record("source_frame_interval_exclusive", []any{toolrt.NewInt(start), toolrt.NewInt(end)}, "factor", factor, "ratio", "", "motion_frames", toolrt.NewInt(1))
	}
	got := speedPartsNote([]any{part(30, 75, 0.75), part(75, 150, 1.0)}, big.NewRat(30, 1))
	if want := "0.75 (1.00–2.50s), 1.0 (2.50–5.00s)"; got != want {
		t.Fatalf("%q, нужно %q", got, want)
	}
}
