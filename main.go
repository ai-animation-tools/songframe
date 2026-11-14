// SongFrame запускает Wails-приложение со встроенным React frontend.
package main

import (
	"context"
	"embed"
	"flag"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"time"

	"songframe/internal/agents"
	shell "songframe/internal/app"
	"songframe/internal/appversion"
	"songframe/internal/components"
	"songframe/internal/derivedworkflow"
	"songframe/internal/jobs"
	"songframe/internal/media"
	"songframe/internal/mediaadapters"
	"songframe/internal/mediacmd"
	"songframe/internal/mediafile"
	"songframe/internal/montage"
	"songframe/internal/production"
	"songframe/internal/productionworkflow"
	"songframe/internal/project"
	"songframe/internal/promptlog"
	"songframe/internal/providers"
	"songframe/internal/providers/agentexec"
	"songframe/internal/scenarioapply"
	"songframe/internal/scenarioworkflow"
	"songframe/internal/store"
	"songframe/internal/updates"
	"songframe/internal/videoreview"

	"github.com/wailsapp/wails/v3/pkg/application"
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
	report := flag.String("smoke-report", "", "Файл JSON-отчёта проверки запуска интерфейса")
	timeout := flag.Duration("smoke-timeout", 30*time.Second, "Предельное ожидание готовности интерфейса")
	checkDir := flag.String("native-check-dir", "", "Каталог синтетических WAV/MP3/MP4/WebM для проверки WebView")
	checkProject := flag.String("native-check-project", "", "Копия проекта для нативной проверки чтения")
	checkReport := flag.String("native-check-report", "", "JSON-отчёт нативной проверки медиа и bridge")
	componentInput := flag.String("component-smoke-input", "", "JSON с отдельным каталогом состояния и четырьмя офлайн-компонентами")
	componentReport := flag.String("component-smoke-report", "", "JSON-отчёт установки и короткого CPU inference")
	updateInput := flag.String("update-smoke-input", "", "JSON с пакетом подставного выпуска для проверки обновления AppImage")
	updateReport := flag.String("update-smoke-report", "", "JSON-отчёт проверки обновления до перезапуска")
	flag.Parse()
	// Проверка поставки использует тот же менеджер, но не создаёт WebView и не читает профиль GUI.
	// Это позволяет проверить CGO/ORT именно из AppImage, без инструментов сборки (Go, Node)
	// на целевой машине.
	if *componentInput != "" || *componentReport != "" {
		if *componentInput == "" || *componentReport == "" || *timeout <= 0 || *smoke || *checkDir != "" || *checkProject != "" || *checkReport != "" || *report != "" {
			return fmt.Errorf("component-smoke требует input, report, положительный timeout и отдельный запуск без GUI smoke")
		}
		ctx, cancel := context.WithTimeout(context.Background(), *timeout)
		defer cancel()
		return runComponentSmoke(ctx, *componentInput, *componentReport)
	}
	// Проверка обновления поставки: замена запущенного AppImage и перезапуск с GUI smoke.
	// WebView не создаётся; перезапущенная версия проходит обычную подготовку и окно.
	if *updateInput != "" || *updateReport != "" {
		if *updateInput == "" || *updateReport == "" || *smoke || *checkDir != "" || *report != "" {
			return fmt.Errorf("update-smoke требует input и report и отдельный запуск без GUI smoke")
		}
		ctx, cancel := context.WithTimeout(context.Background(), *timeout)
		defer cancel()
		return runUpdateSmoke(ctx, *updateInput, *updateReport)
	}
	if *checkDir != "" && (*smoke || *checkReport == "" || *timeout <= 0) {
		return fmt.Errorf("native-check требует отдельный отчёт, положительный timeout и не совмещается с --smoke")
	}
	if *smoke && (*report == "" || *timeout <= 0) {
		return fmt.Errorf("для --smoke нужны --smoke-report и положительный --smoke-timeout")
	}
	profile := store.NewProfile(os.Getenv("SONGFRAME_LOCAL_DIR"))
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
	defer native.ServiceShutdown()
	// Профиль содержит временные изображения и компоненты, которые страницы показывают по URL.
	if err := mediaServer.AllowRoot(profilePath); err != nil {
		return err
	}
	projects := shell.NewProjectService(mediaServer, profilePath)
	// Публикации сценария: шлюз записи видит их журнал в каталоге состояния, а прерванные
	// публикации восстанавливаются до открытия окна. Сбой не мешает запуску: текущий проект
	// снимается, запись в него запрещена, пока восстановление при открытии не завершится.
	scenarioJournal := scenarioapply.NewStore(profilePath)
	scenarioJournal.RegisterWriteCheck()
	if err := scenarioJournal.RecoverAll(); err != nil {
		log.Print(err)
		if closeErr := projects.Close(); closeErr != nil {
			log.Print(closeErr)
		}
	}
	// Прерванное применение предложения производства (замена рабочего пакета) возвращается к
	// резерву до открытия окна: сбой снимает текущий проект, а журнал остаётся для разбора.
	if err := productionworkflow.RecoverInterrupted(profilePath); err != nil {
		log.Print(err)
		if closeErr := projects.Close(); closeErr != nil {
			log.Print(closeErr)
		}
	}
	// Прерванное применение монтажа (журналы apply_montage) откатывается в текущем проекте и в
	// проектах истории до открытия окна.
	if err := montage.RecoverProjects(profilePath); err != nil {
		log.Print(err)
		if closeErr := projects.Close(); closeErr != nil {
			log.Print(closeErr)
		}
	}
	// Прерванная приёмка производного плана (журналы derive_shot) откатывается так же.
	if err := derivedworkflow.RecoverProjects(profilePath); err != nil {
		log.Print(err)
		if closeErr := projects.Close(); closeErr != nil {
			log.Print(closeErr)
		}
	}
	componentManager, err := components.NewManager(profilePath)
	if err != nil {
		return err
	}
	defer componentManager.Cancel()
	// Менеджер заданий восстанавливает прошлые сеансы (выполнявшиеся — interrupted) и при закрытии
	// останавливает свои процессы вместе с потомками.
	jobManager := jobs.New(profilePath, jobs.Options{})
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = jobManager.Shutdown(ctx, "")
	}()
	componentService := shell.NewComponentsService(componentManager)
	defer componentService.ServiceShutdown()
	// Задания агента: история в каталоге состояния, при закрытии CLI останавливаются вместе с потомками.
	agentSettings := agents.NewSettingsStore(profilePath)
	// Каждое задание агента попадает в журнал отправок своего проекта (страница «Отправки»).
	agentManager := agents.NewManager(agentSettings, agents.Options{Journal: promptlog.AgentJournal{}})
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = agentManager.ShutdownAndWait(ctx)
	}()
	// Слой провайдеров медиа: вход к платному провайдеру хранится в каталоге состояния этого
	// профиля, адрес авторизации открывает браузер ОС (OpenURL задаётся после создания GUI).
	mediaadapters.StateDir = func() (string, error) { return profilePath, nil }
	var openURL func(url string) error
	// Опоры провайдера-агента: рабочие папки заданий в каталоге состояния, запуск программы
	// провайдера менеджером агентов, сбор кандидатов — проходом производства.
	keyframeImages := &productionworkflow.KeyframeImages{LocalDir: profilePath, Agents: agentManager, ValidateImage: mediafile.Decodes}
	providerLayer := providers.NewLayer(providers.Options{
		Paid:   providers.PaidOptions{ValidateImage: mediafile.Decodes},
		Agents: agentexec.Deps{Images: keyframeImages},
		OpenURL: func(url string) error {
			if openURL == nil {
				return nil
			}
			return openURL(url)
		},
	})
	environmentService := shell.NewEnvironmentService(providerLayer)
	aiAccess := &agents.AccessChecker{Settings: agentSettings, ProviderAuth: providerLayer.CheckAuth}
	coverGenerators := shell.NewCoverGenerators(aiAccess, providerLayer, mediaServer)
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
	scenarioWorkflow := scenarioworkflow.New(scenarioworkflow.Options{
		LocalDir: profilePath, Agents: agentManager,
		RequireAgentAccess: func(project string) error {
			return aiAccess.RequireAccess(context.Background(), &project, agents.KindAgent)
		},
	})
	shell.ConnectScenarioReview(projects, scenarioWorkflow)
	productionService := production.New(production.Options{Jobs: jobManager, Layer: providerLayer})
	// Проход агента производства: записи предложений в каталоге состояния, тот же каталог моделей,
	// что у настроек, и занятость пакета производственной операцией. Сценарий утверждён, когда
	// утверждена трактовка и сцены не требуют проверки.
	productionWorkflow := productionworkflow.New(productionworkflow.Options{
		LocalDir: profilePath, Agents: agentManager, Catalog: providerLayer.Catalogs(), Media: providerLayer,
		IsScenarioApproved: func(project string) bool {
			view, err := scenarioWorkflow.View(project)
			return err == nil && view.TreatmentApproved && !view.ScenesNeedReview
		},
		IsPackageBusy: productionService.IsBusy,
		// Apply запроса готовит request-NN платным адаптером видео слоя провайдеров после
		// проверки доступа к провайдеру видео.
		VideoMedia: func(provider string) (*providers.PaidMedia, bool) {
			return providerLayer.PaidMedia(provider, agents.KindVideo)
		},
		RequireVideoAccess: func(ctx context.Context, project string) error {
			return aiAccess.RequireAccess(ctx, &project, agents.KindVideo)
		},
	})
	// Медиаинструменты (accept_shot, apply_montage, build_animatic, build_review, cut_speech, contact_sheet) берут
	// FFmpeg/ffprobe из менеджера компонентов, иначе ищут их в PATH.
	mediacmd.Programs = func() (string, string) {
		for _, component := range componentManager.State().Components {
			if component.ID == "ffmpeg" {
				return component.Paths["ffmpeg"], component.Paths["ffprobe"]
			}
		}
		return "", ""
	}
	service := shell.NewAppService(profile, mediaServer, true, ready)
	montageWindow := shell.NewMontageWindowService(profilePath)
	montageService := shell.NewMontageService(jobManager, scenarioWorkflow)
	files := shell.NewShellService(mediaServer, func(path string) error { return desktop.Browser.OpenFile(path) },
		func(address string) error { return desktop.Browser.OpenURL(address) },
		func() (string, bool) { return desktop.Clipboard.Text() })
	// Обновление приложения по кнопке: пакет своей поставки скачивается в каталог состояния.
	// Установка закрывает окно после ответа binding; задания останавливаются штатными defer.
	executable, _ := os.Executable()
	updateManager := updates.New(updates.Options{
		CurrentVersion: appversion.Version,
		Kind:           updates.DetectKind(runtime.GOOS, os.Getenv("APPIMAGE"), executable),
		Directory:      filepath.Join(profilePath, "updates"),
		AppImage:       os.Getenv("APPIMAGE"),
		Launch:         updates.LaunchInstaller,
		Relaunch:       func(path string) error { return updates.RelaunchAppImage(path) },
		Quit:           func() { time.AfterFunc(300*time.Millisecond, desktop.Quit) },
		Reveal:         func(file string) error { return files.OpenPath(filepath.Dir(file)) },
	})
	services := []application.Service{
		application.NewService(service), application.NewService(files), application.NewService(projects),
		application.NewService(shell.NewUpdatesService(updateManager)),
		application.NewService(native), application.NewService(componentService), application.NewService(shell.NewJobsService(jobManager)),
		application.NewService(shell.NewTimingService(jobManager, componentManager, componentService, profilePath)),
		application.NewService(shell.NewSourcesService(ffprobePath(componentManager))),
		application.NewService(shell.NewCastService()), application.NewService(shell.NewScenarioService()),
		application.NewService(shell.NewToolsService()), application.NewService(shell.NewChecksService(jobManager)),
		application.NewService(shell.NewAgentsService(agentSettings, agentManager, aiAccess)), application.NewService(shell.NewAIService(aiAccess)),
		application.NewService(environmentService), application.NewService(shell.NewMediaService(providerLayer)),
		// Сценарный проход агента: журнал публикаций тот же каталог состояния, что у scenarioJournal;
		// перед запуском проверяется доступ к агенту.
		application.NewService(shell.NewScenarioWorkflowService(scenarioWorkflow)),
		// Проверка видео агентом не запускается, пока над пакетом идёт производственная операция.
		application.NewService(shell.NewVideoReviewService(videoreview.New(videoreview.Options{
			Agents: agentManager, Tools: shell.VideoReviewTools(componentManager), Brief: shell.ContinuityBrief,
			ImageBudgetBytes: shell.VideoReviewBudget(agentSettings), IsPackageBusy: productionService.IsBusy,
		}), aiAccess)),
		// Генерация обложки и изображений референсов провайдером изображений проекта; сессии
		// окна закрываются вместе с ним, при выходе — все.
		application.NewService(shell.NewCoverService(coverGenerators.Cover, aiAccess)),
		application.NewService(shell.NewReferenceImagesService(coverGenerators.Reference, aiAccess)),
		// Производство: отправка через платный адаптер слоя провайдеров, проблема «проверьте
		// сценарий» — из того же сценарного прохода, занятость и предложения — из прохода агента
		// производства.
		application.NewService(shell.NewProductionService(productionService, aiAccess, scenarioWorkflow, shell.NewProductionFlow(productionWorkflow))),
		application.NewService(shell.NewProductionWorkflowService(productionWorkflow, aiAccess)),
		application.NewService(shell.NewDashboardService(scenarioWorkflow)),
		application.NewService(shell.NewAnimaticService(jobManager, scenarioWorkflow)),
		application.NewService(shell.NewPromptLogService()),
		application.NewService(shell.NewProjectHistoryService()),
		application.NewService(shell.NewDerivedShotService(jobManager)),
		// Второе окно плеера монтажа: одно окно у одного владельца, положение — в каталоге состояния.
		application.NewService(montageWindow),
		// Ручной монтаж: черновики, экспорт пробы и применение через apply_montage менеджером заданий.
		application.NewService(montageService),
	}
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
		Name:        "SongFrame",
		Description: "SongFrame — производство музыкальных клипов с помощью ИИ",
		Linux:       application.LinuxOptions{ApplicationID: shell.AppID, ProgramName: shell.AppID},
		// Воспроизведение без жеста пользователя нужно окну плеера монтажа: плеер второго окна
		// запускают кнопкой или клавишей в основном окне. WebView2 делит одно окружение на все окна, поэтому
		// флаг общий; в WebKitGTK политику получает только окно плеера (internal/app/montage_window_linux.go).
		Windows: application.WindowsOptions{
			WebviewUserDataPath:   filepath.Join(profilePath, "webview"),
			AdditionalBrowserArgs: []string{"--autoplay-policy=no-user-gesture-required"},
		},
		Mac:      application.MacOptions{ApplicationShouldTerminateAfterLastWindowClosed: true},
		Services: services,
		Assets:   application.AssetOptions{Handler: application.AssetFileServerFS(assets)},
	})
	shell.ConfigureNativeDesktop(native, desktop)
	shell.ConfigureWindowIcon(desktop)
	shell.ConfigureNativeMedia(native, mediaServer.ContainsURL, mediaServer.AllowFile)
	shell.ConfigureMontageWindow(montageWindow, desktop)
	shell.ConfigureMontageDesktop(montageService, desktop)
	defer shell.ConfigureAgentEvents(agentManager, desktop)()
	shell.ConfigureEnvironmentEvents(environmentService, desktop)
	openURL = func(url string) error { return desktop.Browser.OpenURL(url) }
	window := desktop.Window.NewWithOptions(application.WebviewWindowOptions{
		// Плотный рабочий интерфейс рассчитан на окно не меньше 1320×860; старт совпадает с нижней границей.
		Title: "SongFrame", Width: 1320, Height: 860, MinWidth: 1320, MinHeight: 860,
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
		return fmt.Errorf("проверка запуска интерфейса не пройдена")
	}
	return nil
}

// ffprobePath отдаёт сервису исходников найденный ffprobe (выбранный, управляемый или из PATH)
// для длительности нового трека. Обнаружение — только stat/LookPath; без FFmpeg длительность null.
func ffprobePath(manager *components.Manager) func() string {
	return func() string {
		for _, component := range manager.State().Components {
			if component.ID == "ffmpeg" {
				return component.Paths["ffprobe"]
			}
		}
		return ""
	}
}
