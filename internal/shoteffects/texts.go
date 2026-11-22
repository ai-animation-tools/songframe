package shoteffects

import "fmt"

// Тексты ошибок и хода работы эффектов плана: их видит пользователь на странице «Эффекты» и в
// задании рендера.

const (
	textNoSteps       = "Не выбран ни один эффект."
	textNoViewpoint   = "У плана нет точки съёмки с направлением камеры: ветер не пересчитать в наклон дождя. Задайте наклон вручную или точку съёмки плана."
	textRecipeBroken  = "Рецепт эффекта повреждён: примените эффект заново или уберите его."
	textSourceChanged = "Принятое видео плана изменилось после применения эффекта: примените эффект заново."
	textOutputChanged = "Файл видео с эффектом изменён или удалён: примените эффект заново."
	textRemoveBusy    = "Файл эффекта занят (открыт в плеере или другой программе): закройте его и уберите эффект снова."
	textParamsChanged = "Параметры эффекта изменились (точка съёмки плана или версия эффекта): примените эффект заново."
)

func textShotInvalid(shot string) string {
	return fmt.Sprintf("Неверный идентификатор плана %q.", shot)
}

func textShotMissing(shot string) string {
	return fmt.Sprintf("План %s не найден в сценарии.", shot)
}

func textNoKit(shot string) string {
	return fmt.Sprintf("У плана %s нет принятого видео: эффект накладывается только на принятый план.", shot)
}

func textKitBroken(shot string) string {
	return fmt.Sprintf("Комплект плана %s повреждён: нет принятого монтажа accepted_edit с видео, частотой и числом кадров.", shot)
}

func textKitVideoChanged(shot string) string {
	return fmt.Sprintf("Принятое видео плана %s не совпадает с комплектом (SHA-256): проверьте комплект на странице «Проверки».", shot)
}

func textUnknownEffect(id string) string {
	return fmt.Sprintf("Неизвестный эффект %q.", id)
}

func textEffectFailed(title string, err error) string {
	return fmt.Sprintf("Эффект «%s»: %v", title, err)
}

func textWindNoEffect(title string) string {
	return fmt.Sprintf("Эффект «%s» не зависит от ветра.", title)
}

func textWindRange(title string) string {
	return fmt.Sprintf("Эффект «%s»: направление ветра — от 0 до 360 градусов, сила — от 0 до 3.", title)
}

func textProgress(done, total int) string {
	return fmt.Sprintf("Кадров готово: %d из %d", done, total)
}
