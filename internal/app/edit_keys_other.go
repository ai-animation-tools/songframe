//go:build !linux || !cgo || gtk3 || android || server

package app

import "github.com/wailsapp/wails/v3/pkg/application"

// EditKeyBindings вне сборки GTK4 привязок не добавляет: отмену в полях выполняет сам webview.
func EditKeyBindings() map[string]func(application.Window) { return nil }
