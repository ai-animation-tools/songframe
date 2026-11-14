package projectgit

// Тексты ошибок и подписей точек. Ошибки показываются пользователю на странице «Проект» как есть;
// подписи автоматических точек попадают в историю Git проекта.
const (
	textGitMissing           = "Git не найден. Установите Git, чтобы сохранять точки проекта."
	textGitFailed            = "Git (%s): %s"
	textNotRepository        = "Папка проекта не является репозиторием Git."
	textMessageRequired      = "Укажите подпись точки."
	textAuthorMissing        = "Git не знает автора коммитов. Выполните в терминале git config --global user.name \"Имя\" и git config --global user.email \"почта\"."
	textLFSMissing           = "Проект хранит медиа через Git LFS, но программа git-lfs не найдена. Установите Git LFS."
	textUnknownOperation     = "Неизвестная операция автоматической точки: %s"
	textAutoMessage          = "Автоматическая точка перед "
	textAutoFailed           = "Автоматическая точка перед %s не создана: %s"
	textPointMissing         = "Точка %s не найдена в истории проекта."
	textSectionNotRestorable = "Раздел %s нельзя вернуть к точке."
	textPointScenesInvalid   = "plan/scenes.json в точке не читается: %s"
)
