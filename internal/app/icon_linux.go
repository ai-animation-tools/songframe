//go:build linux && cgo && !gtk3 && !android && !server

package app

/*
#cgo linux pkg-config: gtk4
#include <stdlib.h>
#include <gtk/gtk.h>
*/
import "C"

import (
	"unsafe"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// IconName — имя значка приложения в теме значков: Icon= в songframe.desktop и файлы
// hicolor/<размер>/apps/songframe.png, которые ставят deb и AppImage (packtool icons).
const IconName = "songframe"

// ConfigureWindowIcon задаёт окнам значок по имени из темы. В GTK4 нет значка окна из байтов,
// поэтому окно без этого не публикует свой значок (_NET_WM_ICON в X11), и док показывает
// значок только при установленном .desktop с подходящим StartupWMClass; у AppImage без
// интеграции его нет вовсе. AppImage находит значок в своей теме: AppRun добавляет
// $APPDIR/usr/share в XDG_DATA_DIRS.
//
// Вызывать до desktop.Run: GTK берёт имя по умолчанию при реализации окна, а уже реализованные
// окна не обновляет. До запуска цикла GTK вызов только запоминает строку, поэтому поток не важен.
func ConfigureWindowIcon(*application.App) {
	name := C.CString(IconName)
	defer C.free(unsafe.Pointer(name))
	C.gtk_window_set_default_icon_name(name)
}
