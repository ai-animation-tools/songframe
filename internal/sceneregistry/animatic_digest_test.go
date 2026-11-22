package sceneregistry

import (
	"strings"
	"testing"
)

// Отпечаток аниматика не замечает полей, которые не входят в сборку и карточки, и меняется от
// любого поля плана, частоты, песни, референсов и названия части. Перевод строк CRLF и
// форматирование JSON его не меняют.
func TestAnimaticDigest(t *testing.T) {
	const base = `{
  "schema_version": 2,
  "fps": 30,
  "logline": "Логлайн",
  "visual_direction": "Тёплый свет",
  "audio": {"end_seconds": 10},
  "references": {"hero": {"name": "Герой", "short_name": "Г", "path": "source/hero.png"}},
  "sequences": [{"id": "S1", "title": "Начало", "direction": "Спокойно", "start": 0, "end": 10}],
  "scenes": [{"id": "M01", "sequence": "S1", "start_frame": 0, "end_frame_exclusive": 300,
    "camera": "Средний план", "action": "Герой идёт", "continuity": "Сухо", "references": ["hero"],
    "lipsync": false, "state_from": null, "state_changes": {"hero": {"плащ": "мокрый"}}}]
}`
	digest := AnimaticDigest([]byte(base))
	if digest != AnimaticDigest([]byte(strings.ReplaceAll(base, "\n", "\r\n"))) {
		t.Fatal("CRLF изменил отпечаток")
	}
	same := map[string][2]string{
		"логлайн": {`"logline": "Логлайн"`, `"logline": "Другой"`},
		"визуальное направление": {`"visual_direction": "Тёплый свет"`, `"visual_direction": "Холодный"`},
		"направление части":      {`"direction": "Спокойно"`, `"direction": "Тревожно"`},
		"границы части":          {`"start": 0, "end": 10}`, `"start": 0, "end": 12}`},
		"версия формата":         {`"schema_version": 2`, `"schema_version": 3`},
		"изменения состояния":    {`"плащ": "мокрый"`, `"плащ": "сухой"`},
		"наследование состояния": {`"state_from": null`, `"state_from": {"scene": "M00", "phase": "after"}`},
		"оформление JSON":        {`"fps": 30,`, `"fps":   30,`},
	}
	for name, change := range same {
		if got := AnimaticDigest([]byte(strings.Replace(base, change[0], change[1], 1))); got != digest {
			t.Errorf("%s: отпечаток изменился", name)
		}
	}
	changed := map[string][2]string{
		"частота":        {`"fps": 30`, `"fps": 25`},
		"конец песни":    {`"end_seconds": 10`, `"end_seconds": 11`},
		"референс":       {`"short_name": "Г"`, `"short_name": "Х"`},
		"название части": {`"title": "Начало"`, `"title": "Пролог"`},
		"граница плана":  {`"end_frame_exclusive": 300`, `"end_frame_exclusive": 290`},
		"камера":         {`"camera": "Средний план"`, `"camera": "Крупный план"`},
		"действие":       {`"action": "Герой идёт"`, `"action": "Герой стоит"`},
		"непрерывность":  {`"continuity": "Сухо"`, `"continuity": "Мокро"`},
		"речь":           {`"lipsync": false`, `"lipsync": true`},
		"новое поле":     {`"lipsync": false`, `"lipsync": false, "original": "строка"`},
	}
	for name, change := range changed {
		if got := AnimaticDigest([]byte(strings.Replace(base, change[0], change[1], 1))); got == digest {
			t.Errorf("%s: отпечаток не изменился", name)
		}
	}
	if broken := AnimaticDigest([]byte("{")); broken == digest || broken != AnimaticDigest([]byte("{")) {
		t.Error("неразбираемый сценарий должен давать устойчивый отдельный отпечаток")
	}
}
