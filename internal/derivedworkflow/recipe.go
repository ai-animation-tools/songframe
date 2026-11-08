package derivedworkflow

import (
	"errors"
	"sort"
	"strings"

	"songframe/internal/dynvalue"
)

// checkedKeys — допустимые ключи рецепта выбранного режима по возрастанию (сравниваются с
// отсортированными ключами рецепта).
func checkedKeys(mode any) []string {
	switch {
	case dynvalue.StrictEqual(mode, "trim"):
		return []string{"mode", "start_frame"}
	case dynvalue.StrictEqual(mode, "still"):
		return []string{"frame", "mode"}
	}
	return []string{"end_frame_exclusive", "mode", "start_frame"}
}

// frameNumber — поле кадра: только безопасное неотрицательное целое число JSON.
func frameNumber(value any) bool {
	return dynvalue.TypeOf(value) == "number" && dynvalue.IsSafeInteger(value) && dynvalue.ToNumber(value) >= 0
}

// CheckedRecipe — checkedDerivedRecipe: форма рецепта на границе API проверяется до доступа к
// полям; дробные кадры и лишние параметры не исполняются. Возвращает глубокую копию значения.
func CheckedRecipe(value any) (any, error) {
	recipe, ok := dynvalue.AsObject(value)
	if !ok || !dynvalue.IsRecord(value) {
		return nil, errors.New(textRecipeInvalid)
	}
	mode := recipe.Value("mode")
	known := false
	for _, name := range []string{"trim", "fit", "still", "repeat"} {
		known = known || dynvalue.ToString(mode) == name // Сравнение строковой записи: массив ["fit"] тоже проходит.
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
	if (dynvalue.StrictEqual(mode, "fit") || dynvalue.StrictEqual(mode, "repeat")) &&
		dynvalue.ToNumber(recipe.Value("end_frame_exclusive")) <= dynvalue.ToNumber(recipe.Value("start_frame")) {
		return nil, errors.New(textIntervalInvalid)
	}
	return dynvalue.DeepClone(value), nil
}

// RecipeProblem — derivedRecipeProblem: текст отказа или пустая строка. Длина цели задана
// сценарием, поэтому рецепт проверяется по ней и по длине принятого клипа источника.
func RecipeProblem(recipe any, targetFrames, sourceFrames float64) string {
	if _, err := CheckedRecipe(recipe); err != nil {
		return err.Error()
	}
	if !dynvalue.IsSafeInteger(targetFrames) || targetFrames <= 0 || !dynvalue.IsSafeInteger(sourceFrames) || sourceFrames <= 0 {
		return textFramesUnavailable
	}
	mode := dynvalue.Get(recipe, "mode")
	if dynvalue.StrictEqual(mode, "still") {
		if dynvalue.ToNumber(dynvalue.Get(recipe, "frame")) < sourceFrames {
			return ""
		}
		return textSourceBounds
	}
	end := dynvalue.ToNumber(dynvalue.Get(recipe, "end_frame_exclusive"))
	if dynvalue.StrictEqual(mode, "trim") {
		end = dynvalue.ToNumber(dynvalue.Get(recipe, "start_frame")) + targetFrames
	}
	if end <= sourceFrames {
		return ""
	}
	return textSourceBounds
}
