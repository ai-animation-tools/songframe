package shotstatus

// WaitReasons — причины ожидания отложенного пакета (ключи waitLabels) в фиксированном порядке.
// Порядок виден пользователю: shot_workflow перечисляет причины в тексте ошибки через «, », а
// разбор аргументов (toolrt.ArgParser) — в choices (по алфавиту).
var WaitReasons = []string{"user_saved", "insufficient_balance", "cost_or_balance_unknown"}

// StageLabel — подпись этапа workflow.json для таблиц shot_workflow
// и shot_status; false — этап без подписи.
func StageLabel(stage string) (string, bool) {
	label, ok := stageLabels[stage]
	return label, ok
}

// WaitLabel — подпись причины ожидания отложенного пакета.
func WaitLabel(reason string) (string, bool) {
	label, ok := waitLabels[reason]
	return label, ok
}
