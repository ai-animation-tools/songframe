// SongFrame Go запускает изолированную Wails-оболочку со встроенным React frontend.
package main

import (
	"context"
	"embed"
	"flag"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
	shell "songframe-go/internal/app"
	"songframe-go/internal/components"
	"songframe-go/internal/media"
	"songframe-go/internal/project"
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

// run собирает профиль, сервисы и окно; найденные компоненты проверяются сервисом в фоне.
// Smoke подтверждает настоящий путь React → Wails binding → State и имеет ограниченный срок.
func run() error {
	smoke := flag.Bool("smoke", false, "Проверить запуск интерфейса и завершить приложение")
	report := flag.String("smoke-report", "", "Файл JSON-отчёта запуска оболочки")
	timeout := flag.Duration("smoke-timeout", 30*time.Second, "Предельное ожидание готовности интерфейса")
	checkDir := flag.String("native-check-dir", "", "Каталог синтетических WAV/MP3/MP4/WebM для проверки WebView")
	checkProject := flag.String("native-check-project", "", "Копия проекта для нативной проверки чтения")
	checkReport := flag.String("native-check-report", "", "JSON-отчёт нативной проверки медиа и bridge")
	componentInput := flag.String("component-smoke-input", "", "JSON с новым профилем и четырьмя офлайн-компонентами")
	componentReport := flag.String("component-smoke-report", "", "JSON-отчёт установки и короткого CPU inference")
	flag.Parse()
	// Проверка поставки использует тот же менеджер, но не создаёт WebView и не читает профиль GUI.
	// Это позволяет проверить CGO/ORT именно из AppImage, без Go, Node и Python на целевой машине.
	if *componentInput != "" || *componentReport != "" {
		if *componentInput == "" || *componentReport == "" || *timeout <= 0 || *smoke || *checkDir != "" || *checkProject != "" || *checkReport != "" || *report != "" {
			return fmt.Errorf("component-smoke требует input, report, положительный timeout и отдельный запуск без GUI smoke")
		}
		ctx, cancel := context.WithTimeout(context.Background(), *timeout)
		defer cancel()
		return runComponentSmoke(ctx, *componentInput, *componentReport)
	}
	if *checkDir != "" && (*smoke || *checkReport == "" || *timeout <= 0) {
		return fmt.Errorf("native-check требует отдельный отчёт, положительный timeout и не совмещается с --smoke")
	}
	if *smoke && (*report == "" || *timeout <= 0) {
		return fmt.Errorf("для --smoke нужны --smoke-report и положительный --smoke-timeout")
	}
	profile := store.NewProfile(os.Getenv("SONGFRAME_GO_LOCAL_DIR"))
	profilePath, pathErr := profile.Path()
	if pathErr != nil {
		return pathErr
	}
	// Сервер и диагностика принадлежат всему приложению, включая второе окно.
	// Закрытие GUI останавливает listener; проектные файлы сервисы только читают.
	mediaServer, err := media.Start()
	if err != nil {
		return fmt.Errorf("локальный медиасервер: %w", err)
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = mediaServer.Close(ctx)
	}()
	native, err := shell.NewNativeService(profilePath)
	if err != nil {
		return err
	}
	defer native.Close()
	projects := shell.NewProjectService(mediaServer)
	componentManager, err := components.NewManager(profilePath)
	if err != nil {
		return err
	}
	defer componentManager.Cancel()
	componentService := shell.NewComponentsService(componentManager)
	defer componentService.ServiceShutdown()
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
	services := []application.Service{application.NewService(service), application.NewService(projects), application.NewService(native), application.NewService(componentService)}
	var nativeCheck *shell.NativeCheckService
	windowURL := "/"
	if *checkDir != "" {
		// Никаких поисков настоящих клипов: набор явных тестовых файлов задаётся флагом.
		config := shell.NativeCheckConfig{Files: []project.MediaFile{}, Project: *checkProject}
		for _, name := range []string{"Тон с пробелом.wav", "Тон с пробелом.mp3", "Цвета и тон.mp4", "Цвета и тон.webm"} {
			file, err := projects.Media(filepath.Join(*checkDir, name))
			if err != nil {
				return err
			}
			config.Files = append(config.Files, file)
		}
		nativeCheck = shell.NewNativeCheckService(config, *checkReport, func() { time.AfterFunc(150*time.Millisecond, desktop.Quit) })
		services = append(services, application.NewService(nativeCheck))
		windowURL = "/#/native-check"
	}
	desktop = application.New(application.Options{
		Name:        "songframe-go-dev",
		Description: "SongFrame — разработка новой настольной версии",
		Linux:       application.LinuxOptions{ApplicationID: shell.AppID, ProgramName: shell.AppID},
		Windows:     application.WindowsOptions{WebviewUserDataPath: filepath.Join(profilePath, "webview")},
		Mac:         application.MacOptions{ApplicationShouldTerminateAfterLastWindowClosed: true},
		Services:    services,
		Assets:      application.AssetOptions{Handler: application.AssetFileServerFS(assets)},
	})
	shell.ConfigureNativeDesktop(native, desktop)
	shell.ConfigureNativeMedia(native, mediaServer.ContainsURL)
	window := desktop.Window.NewWithOptions(application.WebviewWindowOptions{
		// Плотный рабочий интерфейс рассчитан на окно не меньше 1320×860; старт совпадает с нижней границей.
		Title: "SongFrame — Go", Width: 1320, Height: 860, MinWidth: 1320, MinHeight: 860,
		BackgroundColour: application.NewRGB(244, 246, 248), URL: windowURL, EnableFileDrop: true,
	})
	defer shell.AttachNativeWindow(native, window)()
	if nativeCheck != nil {
		timer := time.AfterFunc(*timeout, func() {
			_ = nativeCheck.Complete(shell.NativeCheckResult{Error: "истёк срок нативной проверки", Checks: []shell.NativeCheckItem{}})
		})
		defer timer.Stop()
	}
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
	if nativeCheck != nil && !nativeCheck.Passed() {
		_ = nativeCheck.Complete(shell.NativeCheckResult{Error: "окно закрыто до завершения нативной проверки", Checks: []shell.NativeCheckItem{}})
		return fmt.Errorf("нативная проверка медиа/bridge не пройдена")
	}
	if result != nil && !result.Passed() {
		if err := result.Complete(nil, "окно закрыто до готовности интерфейса"); err != nil {
			return err
		}
		return fmt.Errorf("проверка запуска оболочки не пройдена")
	}
	return nil
}
