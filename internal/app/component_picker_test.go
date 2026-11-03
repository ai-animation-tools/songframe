package app

import (
	"strings"
	"testing"
)

// TestComponentPickerMatchesPlatform исключает обещанный mixed picker и инструкции
// для чужой платформы: фактически выбирается файл, фильтр соответствует текущей ОС.
func TestComponentPickerMatchesPlatform(t *testing.T) {
	for _, component := range []string{"ffmpeg", "ort-cpu", "voc-ft", "ctc-ru", "ctc-vocab"} {
		for _, platform := range []string{"linux", "windows"} {
			t.Run(component+"/"+platform, func(t *testing.T) {
				options, err := componentFileOptions(component, platform)
				if err != nil {
					t.Fatal(err)
				}
				if !options.CanChooseFiles || options.CanChooseDirectories || options.AllowsMultipleSelection {
					t.Fatal("диалог должен выбирать один файл")
				}
				if len(options.Filters) < 1 {
					t.Fatal("нет фильтра компонента")
				}
				pattern := options.Filters[0].Pattern
				if platform == "linux" && (strings.Contains(pattern, ".exe") || strings.Contains(pattern, ".dll")) {
					t.Fatal("чужая ОС в фильтре", pattern)
				}
				if platform == "windows" && (strings.Contains(pattern, ".so") || strings.Contains(pattern, ".dylib")) {
					t.Fatal("чужая ОС в фильтре", pattern)
				}
			})
		}
	}
	if _, err := componentFileOptions("неизвестный", "linux"); err == nil {
		t.Fatal("неизвестный компонент принят")
	}
}
