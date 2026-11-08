package derivedworkflow

import (
	"errors"
	"sort"
	"strings"

	"songframe-go/internal/jscompat"
)

// checkedKeys — ключи рецепта выбранного режима в порядке сортировки строк JS (`keys.sort()`).
func checkedKeys(mode any) []string {
	switch {
	case jscompat.StrictEqual(mode, "trim"):
		return []string{"mode", "start_frame"}
	case jscompat.StrictEqual(mode, "still"):
		return []string{"frame", "mode"}
	}
	return []string{"end_frame_exclusive", "mode", "start_frame"}
}

// frameNumber — поле кадра: только безопасное неотрицательное целое число JSON.
func frameNumber(value any) bool {
	return jscompat.TypeOf(value) == "number" && jscompat.IsSafeInteger(value) && jscompat.ToNumber(value) >= 0
}

// CheckedRecipe — checkedDerivedRecipe: форма рецепта на границе API проверяется до доступа к
// полям; дробные кадры и лишние параметры не исполняются. Возвращает глубокую копию значения.
func CheckedRecipe(value any) (any, error) {
	recipe, ok := jscompat.AsObject(value)
	if !ok || !jscompat.IsRecord(value) {
		return nil, errors.New(textRecipeInvalid)
	}
	mode := recipe.Value("mode")
	known := false
	for _, name := range []string{"trim", "fit", "still", "repeat"} {
		known = known || jscompat.ToString(mode) == name // String(mode): массив ["fit"] тоже проходит.
	}
	keys := checkedKeys(mode)
	actual := recipe.Keys()
	sort.Strings(actual)
	if !known || strings.Join(actual, "|") != strings.Join(keys, "|") {
		return nil, errors.New(textRecipeInvalid)
	}
	for _, key := range keys {
		if key != "mode" && !frameNumber(recipe.Value(key)) {
			return nil, errors.New(textFrameInvalid)
		}
	}
	if (jscompat.StrictEqual(mode, "fit") || jscompat.StrictEqual(mode, "repeat")) &&
		jscompat.ToNumber(recipe.Value("end_frame_exclusive")) <= jscompat.ToNumber(recipe.Value("start_frame")) {
		return nil, errors.New(textIntervalInvalid)
	}
	return jscompat.DeepClone(value), nil
}

// RecipeProblem — derivedRecipeProblem: текст отказа или пустая строка. Длина цели задана
// сценарием, поэтому рецепт проверяется по ней и по длине принятого клипа источника.
func RecipeProblem(recipe any, targetFrames, sourceFrames float64) string {
	if _, err := CheckedRecipe(recipe); err != nil {
		return err.Error()
	}
	if !jscompat.IsSafeInteger(targetFrames) || targetFrames <= 0 || !jscompat.IsSafeInteger(sourceFrames) || sourceFrames <= 0 {
		return textFramesUnavailable
	}
	mode := jscompat.Get(recipe, "mode")
	if jscompat.StrictEqual(mode, "still") {
		if jscompat.ToNumber(jscompat.Get(recipe, "frame")) < sourceFrames {
			return ""
		}
		return textSourceBounds
	}
	end := jscompat.ToNumber(jscompat.Get(recipe, "end_frame_exclusive"))
	if jscompat.StrictEqual(mode, "trim") {
		end = jscompat.ToNumber(jscompat.Get(recipe, "start_frame")) + targetFrames
	}
	if end <= sourceFrames {
		return ""
	}
	return textSourceBounds
}
