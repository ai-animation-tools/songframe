package main

import (
	"os"
	"strings"
)

// snapOriginalSuffix — суффикс, под которым snap VS Code сохраняет исходное значение каждой переменной, подменённой
// для его собственных GTK-библиотек (GIO_MODULE_DIR, GTK_PATH, GTK_EXE_PREFIX, LOCPATH, XDG_DATA_DIRS…).
const snapOriginalSuffix = "_VSCODE_SNAP_ORIG"

// restoreSnapEnvironment возвращает исходные значения переменных, подменённых snap VS Code, если приложение запущено
// из его встроенного терминала. Иначе WebKitGTK наследует модули GIO из snap: сетевой процесс WebView грузит их TLS-
// модуль, падает при старте на несовместимой libpthread из core20 и каждая загрузка окна (вызовы Go, медиа) обрывается
// с WebLoaderStrategy::internallyFailedLoadTimerFired. Пустое сохранённое значение означает, что переменной не было.
// Вызывается первым делом в main, до инициализации GTK и запуска внешних программ: они наследуют уже исправленное
// окружение. Вне такого терминала переменных с суффиксом нет, и окружение не меняется.
func restoreSnapEnvironment() {
	for name, value := range snapOriginals(os.Environ()) {
		if value == "" {
			_ = os.Unsetenv(name)
		} else {
			_ = os.Setenv(name, value)
		}
	}
}

// snapOriginals выбирает из окружения вида «ИМЯ=значение» исходные значения подменённых переменных: имя без
// суффикса → сохранённое значение.
func snapOriginals(environ []string) map[string]string {
	result := map[string]string{}
	for _, entry := range environ {
		key, value, found := strings.Cut(entry, "=")
		if !found {
			continue
		}
		if name, ok := strings.CutSuffix(key, snapOriginalSuffix); ok && name != "" {
			result[name] = value
		}
	}
	return result
}
