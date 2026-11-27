package regenerateshot

import (
	"testing"

	"songframe/internal/toolrt"
)

// Повтор переносит образы сущностей запроса, если они есть, и не добавляет поле запросу без них.
func TestSavedSpecSavedLooks(t *testing.T) {
	base := `{"provider": "test", "command": "image_to_video", "model": "m", "parameters": {"looks": ["7"]}, "outputs": 1`
	for extra, want := range map[string]bool{``: false, `, "saved_looks": [{"code": "hero", "entity": "Герой", "look": "7", "name": "Герой"}]`: true} {
		value, err := toolrt.LoadsJSON(base + extra + "}")
		if err != nil {
			t.Fatal(err)
		}
		spec, err := savedSpec(value.(*toolrt.Dict), "M01", "video", []any{}, "prompt.txt")
		if err != nil {
			t.Fatal(err)
		}
		if spec.Has("saved_looks") != want {
			t.Fatalf("%q: saved_looks %v", extra, spec.Has("saved_looks"))
		}
	}
}
