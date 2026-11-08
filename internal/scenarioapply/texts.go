package scenarioapply

import "path/filepath"

// Тексты scenarioTexts.main (frontend/src/shared/texts/scenario.ts); textRecoveryConflict,
// textBackupDamaged и textDuplicateFile — тексты собственных проверок журнала.
const (
	textRecoveryPending       = "Не завершено восстановление прошлого применения сценария. Перезапустите приложение."
	textRecoveryFormatInvalid = "Неизвестный формат pending или недопустимые пути восстановления."
)

func textInvalidRelativePath(path string) string {
	return "Недопустимый относительный путь сценария: " + path
}

func textOrdinaryPathRequired(name string, directory bool) string {
	kind := "файл"
	if directory {
		kind = "каталог"
	}
	return name + ": для применения сценария нужен обычный " + kind + ", без ссылки."
}

func textUnsupportedFile(path string) string {
	return "Неподдерживаемый файл применения: " + path
}

func textDuplicateFile(path string) string {
	return "Файл применения указан дважды: " + path
}

func textRecoveryProjectUnavailable(project string) string {
	return "Проект недоступен по прежнему пути или отсутствует plan/project.json: " + project +
		". Восстановите доступ к папке проекта; резервные копии сохранены."
}

func textRecoveryIncomplete(err, restoreErr string) string {
	return "Применение сценария прервано: " + err + ". Восстановление не завершено: " + restoreErr + ". Резервы сохранены для следующего запуска."
}

func textRecoveryFailed(failures string) string {
	return "Не удалось восстановить применение сценария; резервы сохранены. " + failures
}

func textRecoveryConflict(path, directory string) string {
	return path + " изменён после прерванного применения сценария; восстановление не перезаписывает его. " +
		"Верните файл к прежнему или применённому содержимому либо удалите журнал " + filepath.Join(directory, "pending.json") +
		". До этого запись в проект запрещена."
}

func textBackupDamaged(path string) string {
	return "Резервная копия " + path + " повреждена: восстановление остановлено."
}
