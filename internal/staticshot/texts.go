package staticshot

import "strconv"

// Тексты ошибок и записей сборки статичного кадра.
const (
	textPackageOutside    = "Попытка должна лежать в plan/batches проекта."
	textWorkflowInvalid   = "workflow.json попытки повреждён."
	textStatesRequired    = "Нужна базовая опора K01: подготовьте описание."
	textFramesNotApproved = "Сначала утвердите все опоры: сборка берёт только утверждённые."
	textBaseFromZero      = "Базовая опора K01 видна с первого кадра плана."
	textRecipeInvalid     = "static/recipe.json попытки повреждён: сохраните сборку заново."
	textRecipeFrames      = "Рецепт сборки относится к другим опорам: обновите страницу."
	textPreviewMissing    = "Сначала соберите предпросмотр."
	textPreviewStale      = "Предпросмотр устарел: моменты смены, параметры или опоры изменились после сборки. Соберите заново."
	textRebuildNote       = "Статичный кадр: опоры-состояния собраны локально (internal/effects); пересборка — по generation.static."
)

func textNotStatic(shot string) string {
	return shot + ": план не отмечен в сценарии как статичный кадр."
}

func textWindowInvalid(shot string) string {
	return shot + ": неверное окно плана в сценарии."
}

func textShotMissing(shot string) string { return shot + ": плана нет в сценарии." }

func textStateOrder(frame string, frames int) string {
	return frame + ": кадр смены должен быть позже предыдущего и раньше конца плана (" + strconv.Itoa(frames) + " кадров)."
}

func textProgress(done, total int) string {
	return "Собрано кадров: " + strconv.Itoa(done) + " из " + strconv.Itoa(total) + "."
}

func textReplaceRequired(shot string) string {
	return shot + ": комплект уже есть в assets; замена — отдельное решение."
}

func textSceneChanged(shot string) string {
	return shot + ": постановка плана изменилась после подготовки попытки; комплект принят по прежней постановке и требует нового производства."
}

func textStateRole(index int) string {
	if index == 0 {
		return "Базовая опора"
	}
	return "Состояние " + strconv.Itoa(index+1)
}

func textFrameUnreadable(frame string) string {
	return frame + ": файл опоры не читается как изображение PNG, JPEG или WebP: замените опору."
}

func textFrameSize(frame string, width, height int, base string, baseWidth, baseHeight int) string {
	return frame + ": размер опоры " + strconv.Itoa(width) + "×" + strconv.Itoa(height) + ", а у базовой " + base + " — " +
		strconv.Itoa(baseWidth) + "×" + strconv.Itoa(baseHeight) + ". Состояние собирается поверх базовой опоры: нужна картинка того же размера."
}
