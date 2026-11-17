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
