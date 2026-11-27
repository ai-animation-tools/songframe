package requestsnapshot

import (
	"strings"
	"testing"

	"songframe/internal/toolrt"
)

// Форма saved_looks: непустой список образов ровно с полями code, entity, look и name (строки,
// code и look непустые). Запрос без поля проверяется как раньше.
func TestValidateSpecSavedLooks(t *testing.T) {
	base := `{"schema_version": 1, "provider": "test", "kind": "video", "command": "image_to_video", "model": "m", "prompt_file": "prompt.txt"`
	cases := map[string]bool{
		``: true,
		`, "saved_looks": [{"code": "hero", "entity": "Герой", "look": "7", "name": "Герой"}]`: true,
		`, "saved_looks": []`: false,
		`, "saved_looks": [{"code": "hero", "entity": "Герой", "look": "7"}]`:                      false,
		`, "saved_looks": [{"code": "", "entity": "Герой", "look": "7", "name": "Герой"}]`:         false,
		`, "saved_looks": [{"code": "hero", "entity": "Герой", "look": 7, "name": "Герой"}]`:       false,
		`, "saved_looks": [{"code": "hero", "entity": "Герой", "look": "7", "name": "", "x": ""}]`: false,
	}
	for extra, valid := range cases {
		spec, err := toolrt.LoadsJSON(base + extra + "}")
		if err != nil {
			t.Fatal(err)
		}
		err = ValidateSpec(spec)
		if valid && err != nil {
			t.Errorf("%s: %v", extra, err)
		}
		if !valid && (err == nil || !strings.Contains(err.Error(), "saved_looks")) {
			t.Errorf("%s: нужна ошибка saved_looks, получено %v", extra, err)
		}
	}
}
