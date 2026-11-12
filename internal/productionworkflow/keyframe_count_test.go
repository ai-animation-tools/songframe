package productionworkflow

import (
	"testing"

	"songframe/internal/dynvalue"
)

// framesProposal — ответ описания с count опорами: K01 first на 0, K<count> last на 6, middle между.
func framesProposal(count int) string {
	frames := ""
	for index := 0; index < count; index++ {
		role, time := "middle", float64(index+1)
		switch {
		case index == 0:
			role, time = "first", 0
		case index == count-1:
			role, time = "last", 6
		}
		if index > 0 {
			frames += ","
		}
		frames += `{"id":"K` + twoDigits(index+1) + `","role":"` + role + `","timeSeconds":` + dynvalue.ToString(time) + `,"prompt":"Кадр.","referencePaths":[]}`
	}
	return `{"schemaVersion":1,"stage":"description","description":"Герой идёт.","requestSeconds":6,"keyframes":[` + frames + `]}`
}

// TestKeyframeCountRules — выбранное число опор соблюдается точно, одна опора допустима и в
// обычном плане, «авто» сохраняет прежние 2–20; выбор переживает запись правил.
func TestKeyframeCountRules(t *testing.T) {
	auto := Rules{Stage: "description", WindowSeconds: 5.5, DurationRule: "min_supported_strictly_greater_than_window"}
	three, single := auto, auto
	three.Keyframes, single.Keyframes = 3, 1
	if _, err := ParseProposal(framesProposal(3), three); err != nil {
		t.Fatalf("три опоры при выборе 3: %v", err)
	}
	if _, err := ParseProposal(framesProposal(2), three); err == nil || err.Error() != textKeyframeCountMismatch(3, 2) {
		t.Fatalf("две опоры при выборе 3: %v", err)
	}
	if _, err := ParseProposal(framesProposal(1), single); err != nil {
		t.Fatalf("одна опора при выборе 1: %v", err)
	}
	if _, err := ParseProposal(framesProposal(1), auto); err == nil || err.Error() != textDescriptionInvalid {
		t.Fatalf("одна опора в «авто»: %v", err)
	}
	if _, err := ParseProposal(framesProposal(4), auto); err != nil {
		t.Fatalf("четыре опоры в «авто»: %v", err)
	}
	if RulesFromTree(three.Tree()).Keyframes != 3 || auto.Tree().Has("keyframeCount") || RulesFromTree(auto.Tree()).Keyframes != 0 {
		t.Fatal("число опор в записи правил")
	}
}

// TestKeyframeChoice — предел провайдера видео, одна опора речевого плана ручной генерации и
// прежний выбор попытки при доработке описания.
func TestKeyframeChoice(t *testing.T) {
	settings := dynvalue.NewObject()
	settings.Set("provider", "kling")
	workflow := dynvalue.NewObject()
	workflow.Set("keyframe_count", float64(4))
	c := &Context{Settings: settings, Workflow: workflow}
	value := func(n int) *int { return &n }
	if got, err := keyframeChoice(c, "description", value(10), false); err != nil || got != 10 {
		t.Fatalf("10 опор у провайдера с пределом 10: %d %v", got, err)
	}
	if _, err := keyframeChoice(c, "description", value(11), false); err == nil || err.Error() != textKeyframeCountRange(10) {
		t.Fatalf("сверх предела: %v", err)
	}
	if _, err := keyframeChoice(c, "description", value(0), true); err != nil {
		t.Fatalf("явное «авто»: %v", err)
	}
	if got, _ := keyframeChoice(c, "description", nil, true); got != 4 {
		t.Fatalf("доработка без выбора сохраняет прежний: %d", got)
	}
	if got, _ := keyframeChoice(c, "description", nil, false); got != 0 {
		t.Fatalf("новая попытка без выбора — «авто»: %d", got)
	}
	if got, _ := keyframeChoice(c, "prompt", value(3), false); got != 0 {
		t.Fatalf("выбор относится только к описанию: %d", got)
	}
	c.Manual = true
	if _, err := keyframeChoice(c, "description", value(2), false); err == nil || err.Error() != textManualKeyframeCount {
		t.Fatalf("ручной план с двумя опорами: %v", err)
	}
	if got, err := keyframeChoice(c, "description", value(1), false); err != nil || got != 0 {
		t.Fatalf("ручной план с одной опорой: %d %v", got, err)
	}
}
