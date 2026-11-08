//go:build !linux || !cgo || gtk3 || android || server

package app

import "github.com/wailsapp/wails/v3/pkg/application"

// newMontageNativeWindow вне сборки GTK4 создаёт окно как есть. В Windows воспроизведение без
// жеста включает общий флаг WebView2 --autoplay-policy=no-user-gesture-required (main.go);
// поправки размера GTK4 (montage_window_linux.go) здесь не нужны. Windows не проверялся нативно.
func newMontageNativeWindow(desktop *application.App, options application.WebviewWindowOptions) *application.WebviewWindow {
	return desktop.Window.NewWithOptions(options)
}
