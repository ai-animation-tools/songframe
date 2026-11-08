package requestsnapshot

import (
	"testing"

	"songframe/internal/golden"
	"songframe/internal/toolrt"
)

// TestGolden сверяет ValidateSpec и SHA Encoded с эталоном
// (testdata/golden/request-snapshot/cases.json): вход — JSON-текст, разобранный в модель toolrt.
func TestGolden(t *testing.T) {
	cases, _ := golden.ValueFile(t, "request-snapshot", "cases.json").([]any)
	if len(cases) == 0 {
		t.Fatal("нет случаев request-snapshot")
	}
	for _, entry := range cases {
		name := golden.ValueString(t, entry, "name")
		call := golden.ValueString(t, entry, "call")
		input := golden.ParseValue(t, golden.ValueString(t, entry, "input"))
		want := entry.(*toolrt.Dict).Value("expected")
		t.Run(name, func(t *testing.T) {
			switch call {
			case "validate_spec":
				golden.AssertOutcome(t, name, want, nil, ValidateSpec(input), "")
			case "encoded":
				digest, err := Digest(input)
				golden.AssertOutcome(t, name, want, digest, err, "")
			default:
				t.Fatalf("неизвестный вызов %s", call)
			}
		})
	}
}
