package kling

import (
	"slices"
	"testing"
)

// Опоры видео по порядку плана: первая — начальный кадр, последняя — конечный, средние —
// промежуточные; одна опора — только начальный кадр.
func TestFrameSlots(t *testing.T) {
	cases := map[int][]string{
		1: {"first_image"},
		2: {"first_image", "tail_image"},
		4: {"first_image", "keyframe_1", "keyframe_2", "tail_image"},
	}
	for count, want := range cases {
		if got := RequestRules().Video.FrameSlots(count); !slices.Equal(got, want) {
			t.Fatalf("%d опор: %v, ожидалось %v", count, got, want)
		}
	}
}

// Режим по референсам: команда и единственная модель режима, слоты и обозначения картинок
// нумеруются с единицы, параметры режима выключают звук и исходный звук.
func TestReferenceRules(t *testing.T) {
	rules := RequestRules().Video.References
	if rules == nil {
		t.Fatal("режима по референсам нет")
	}
	if rules.Command != "omni_ref_video" || !slices.Equal(rules.Models, []string{"kling-video-v4_0"}) {
		t.Fatalf("команда и модели: %s %v", rules.Command, rules.Models)
	}
	for index, want := range map[int][2]string{0: {"image_1", "图片1"}, 8: {"image_9", "图片9"}, 9: {"image_10", "图片10"}} {
		if got := rules.ImageSlot(index); got != want[0] {
			t.Errorf("слот %d: %s, ожидалось %s", index, got, want[0])
		}
		if got := rules.Mention(index); got != want[1] {
			t.Errorf("обозначение %d: %s, ожидалось %s", index, got, want[1])
		}
	}
	names := []string{}
	for _, preference := range rules.Defaults {
		names = append(names, preference.Name)
	}
	if !slices.Equal(names, []string{"prefer_multi_shots", "enable_audio", "keepOriginalSound"}) {
		t.Fatalf("параметры режима: %v", names)
	}
}
