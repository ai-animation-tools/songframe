package updates

// Сообщения обновления — дословно updatesTexts (frontend/src/shared/texts/updates.ts).
// Go отдаёт их в UpdateView.message; тест TestTextsMatchFrontend проверяет, что каждая строка
// есть в словаре renderer.
const (
	textCurrent        = "У вас актуальная версия приложения."
	textAvailable      = "Доступна версия %s."
	textReady          = "Версия %s скачана и проверена."
	textReadyManual    = "Закройте приложение и замените его скачанным файлом."
	textReadyPackage   = "Закройте приложение и установите скачанный пакет, например командой sudo apt install с путём к файлу."
	textCheckFailed    = "Не удалось проверить обновления. Проверьте подключение к интернету и повторите попытку."
	textPackageMissing = "В выпуске нет пакета для этой системы."
	textInvalidRelease = "Описание выпуска на GitHub не прошло проверку. Текущая версия сохранена."
	textDownloadFailed = "Не удалось скачать обновление. Повторите попытку."
	textHashMismatch   = "Скачанный пакет не совпал с контрольной суммой выпуска и удалён. Повторите скачивание."
	textCheckFirst     = "Сначала проверьте наличие обновлений."
	textInstallFailed  = "Не удалось установить обновление. Скачанный файл можно установить вручную."
)
