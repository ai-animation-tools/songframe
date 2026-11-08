package shotstatus

// WaitReasons — ключи WAIT_LABELS shot_status.py в порядке словаря оригинала. Порядок виден
// пользователю: shot_workflow перечисляет причины в тексте ошибки (", ".join(WAIT_LABELS)),
// а argparse — в choices (sorted(WAIT_LABELS)).
var WaitReasons = []string{"user_saved", "insufficient_balance", "cost_or_balance_unknown"}

// StageLabel — STAGE_LABELS.get(stage): подпись этапа workflow.json для таблиц shot_workflow
// и shot_status; false — этап без подписи.
func StageLabel(stage string) (string, bool) {
	label, ok := stageLabels[stage]
	return label, ok
}

// WaitLabel — WAIT_LABELS.get(reason): подпись причины ожидания отложенного пакета.
func WaitLabel(reason string) (string, bool) {
	label, ok := waitLabels[reason]
	return label, ok
}
