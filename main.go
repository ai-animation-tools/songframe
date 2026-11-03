// SongFrame Go запускает изолированную Wails-оболочку со встроенным React frontend.
package main

import (
	"embed"
	"flag"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
	shell "songframe-go/internal/app"
	"songframe-go/internal/store"
)

// Собранный frontend входит в бинарник: Node/Yarn нужны только разработчику.
//
//go:embed all:frontend/dist
var assets embed.FS

// main возвращает ненулевой код при неготовом frontend или невозможности записать smoke-отчёт.
// Обычный запуск не создаёт отчёт и не завершает окно автоматически.
func main() {
	if err := run(); err != nil {
		log.Print(err)
		os.Exit(1)
	}
}

// run собирает профиль, сервис и окно; здесь нет ML runtime и внешних производственных процессов.
// Smoke подтверждает настоящий путь React → Wails binding → State и имеет ограниченный срок.
func run() error {
	smoke := flag.Bool("smoke", false, "Проверить запуск интерфейса и завершить приложение")
	report := flag.String("smoke-report", "", "Файл JSON-отчёта запуска оболочки")
	timeout := flag.Duration("smoke-timeout", 30*time.Second, "Предельное ожидание готовности интерфейса")
	flag.Parse()
	if *smoke && (*report == "" || *timeout <= 0) {
		return fmt.Errorf("для --smoke нужны --smoke-report и положительный --smoke-timeout")
	}
	profile := store.NewProfile(os.Getenv("SONGFRAME_GO_LOCAL_DIR"))
	profilePath, pathErr := profile.Path()
	if pathErr != nil {
		return pathErr
	}
	var desktop *application.App
	var result *shell.SmokeResult
	var ready func(shell.AppState) error
	if *smoke {
		result = shell.NewSmokeResult(*report)
		ready = func(state shell.AppState) error {
			err := result.Complete(&state, "")
			// Даём Wails отправить ответ binding до завершения цикла GUI.
			time.AfterFunc(150*time.Millisecond, desktop.Quit)
			return err
		}
	}
	service := shell.NewShellService(profile, true, ready)
	desktop = application.New(application.Options{
		Name:        "songframe-go-dev",
		Description: "SongFrame — разработка новой настольной версии",
		Linux:       application.LinuxOptions{ApplicationID: shell.AppID, ProgramName: shell.AppID},
		Windows:     application.WindowsOptions{WebviewUserDataPath: filepath.Join(profilePath, "webview")},
		Mac:         application.MacOptions{ApplicationShouldTerminateAfterLastWindowClosed: true},
		Services:    []application.Service{application.NewService(service)},
		Assets:      application.AssetOptions{Handler: application.AssetFileServerFS(assets)},
	})
	desktop.Window.NewWithOptions(application.WebviewWindowOptions{
		// Плотный рабочий интерфейс рассчитан на окно не меньше 1320×860; старт совпадает с нижней границей.
		Title: "SongFrame — Go", Width: 1320, Height: 860, MinWidth: 1320, MinHeight: 860,
		BackgroundColour: application.NewRGB(244, 246, 248), URL: "/",
	})
	if result != nil {
		timer := time.AfterFunc(*timeout, func() {
			if err := result.Complete(nil, "интерфейс не подтвердил готовность за отведённое время"); err != nil {
				log.Print(err)
			}
			desktop.Quit()
		})
		defer timer.Stop()
	}
	if err := desktop.Run(); err != nil {
		return err
	}
	if result != nil && !result.Passed() {
		if err := result.Complete(nil, "окно закрыто до готовности интерфейса"); err != nil {
			return err
		}
		return fmt.Errorf("проверка запуска оболочки не пройдена")
	}
	return nil
}
