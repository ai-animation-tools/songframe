//go:build !linux || !cgo || gtk3 || android || server

package app

import "github.com/wailsapp/wails/v3/pkg/application"

// ConfigureWindowIcon вне сборки GTK4 ничего не делает: в Windows значок окна и ярлыков берётся
// из ресурса songframe.exe (resources/icon.ico, scripts/package-windows.sh).
func ConfigureWindowIcon(*application.App) {}
