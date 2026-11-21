//go:build linux && cgo && !gtk3 && !android && !server

package app

import "github.com/wailsapp/wails/v3/pkg/application"

// EditKeyBindings — пустые привязки Ctrl+Z и Ctrl+Shift+Z для сборки GTK4. Без своей привязки
// Wails на GTK4 сам вызывает document.execCommand('undo'/'redo'), причём обработчик нажатий
// получает одно нажатие дважды: отмена выполняется два раза и снимает больше, чем нужно.
// Привязка без действия выключает этот запасной путь, а клавиша по-прежнему доходит до страницы:
// отмену в полях выполняет фронтенд (frontend/src/renderer/components/TextUndoKeys.tsx) по
// физической клавише, поэтому она работает и в русской раскладке.
func EditKeyBindings() map[string]func(application.Window) {
	none := func(application.Window) {}
	return map[string]func(application.Window){"Ctrl+Z": none, "Ctrl+Shift+Z": none}
}
