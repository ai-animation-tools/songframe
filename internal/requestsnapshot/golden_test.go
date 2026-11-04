package requestsnapshot

import (
	"testing"

	"songframe-go/internal/golden"
	"songframe-go/internal/pycompat"
)

// TestGolden сверяет validate_spec и SHA encoded() с tools/request_snapshot.py оригинала
// (testdata/golden/request-snapshot/cases.json): вход — JSON-текст, разобранный json.loads Python.
func TestGolden(t *testing.T) {
	cases, _ := golden.PyFile(t, "request-snapshot", "cases.json").([]any)
	if len(cases) == 0 {
		t.Fatal("нет случаев request-snapshot")
	}
	for _, entry := range cases {
		name := golden.PyString(t, entry, "name")
		call := golden.PyString(t, entry, "call")
		input := golden.PyParse(t, golden.PyString(t, entry, "input"))
		want := entry.(*pycompat.Dict).Value("expected")
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
