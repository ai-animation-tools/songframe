package repodocs

// Area — область кода с документами-владельцами. Карта кода docs/code-map.md строится из этой
// таблицы: агент находит по ней нужный участок, а после изменения — документы, которые обязан
// обновить в том же коммите.
//
// Инварианты проверяет TestCodeMap: каждый Go-пакет репозитория и каждая страница
// frontend/src/renderer/pages перечислены ровно в одной области, а все пути и документы существуют.
// Новый пакет или страница без строки здесь роняет тест — так карта не отстаёт от кода.
type Area struct {
	// Title — название области в карте.
	Title string
	// Docs — документы-владельцы: правила и процессы области. Пусто, если отдельного документа
	// нет и устройство описано только комментариями пакетов.
	Docs []string
	// Packages — каталоги Go-пакетов от корня репозитория («.» — пакет main).
	Packages []string
	// Pages — имена страниц из frontend/src/renderer/pages.
	Pages []string
	// Paths — прочие каталоги и файлы области (frontend, скрипты, ресурсы).
	Paths []string
}

// Areas — области в порядке карты. Порядок пакетов внутри области — порядок чтения: сначала
// владельцы данных, затем процессы и вспомогательные пакеты.
var Areas = []Area{
	{
		Title:    "Точка входа и граница Wails",
		Docs:     []string{"docs/development.md#точка-входа", "docs/development.md#wails-сервисы"},
		Packages: []string{".", "internal/app", "internal/wire"},
	},
	{
		Title: "Контракт window.api и каркас интерфейса",
		Docs: []string{
			"docs/development.md#контракт-windowapi", "docs/ui/README.md", "docs/ui/structure.md",
			"docs/ui/texts.md", "docs/ui/storybook.md",
		},
		Pages: []string{"HelpPage", "NativeCheckPage", "NativePreviewPage"},
		Paths: []string{
			"frontend/src/shared/api.ts", "frontend/src/platform", "frontend/src/shared/texts",
			"frontend/src/renderer/components", "frontend/src/renderer/hooks",
			"frontend/src/renderer/testing", "frontend/.storybook", "frontend/tests",
		},
	},
	{
		Title: "Инфраструктура приложения",
		Docs: []string{
			"docs/development.md#процессы-задания-и-запись-файлов", "docs/development.md#каталог-состояния",
			"docs/development.md#компоненты", "internal/components/README.md",
		},
		Packages: []string{
			"internal/store", "internal/diagnostics", "internal/process", "internal/jobs",
			"internal/projectfs", "internal/filedigest", "internal/media", "internal/desktop",
			"internal/trash", "internal/components", "internal/appversion", "internal/updates",
		},
		Pages: []string{"JobsPage", "ComponentsPage"},
	},
	{
		Title: "Проект и исходники",
		Docs:  []string{"dev-skills/songframe-go-project-contract/SKILL.md", "resources/templates/project/README.md"},
		Packages: []string{
			"internal/project", "internal/projectfile", "internal/newproject", "internal/status",
			"internal/sources", "internal/sourceedit", "internal/sourceinputs",
			"internal/referenceimage", "internal/cast", "internal/castregistry", "internal/covergen",
			"internal/projectviews",
		},
		Pages: []string{"ProjectsPage", "NewProjectPage", "ProjectPage", "SourcesPage", "CastPage"},
		Paths: []string{"resources/templates/project"},
	},
	{
		Title:    "Разметка песни",
		Docs:     []string{"docs/timing.md"},
		Packages: []string{"internal/timing", "internal/songtiming", "internal/songml", "internal/speech", "internal/cutspeech"},
		Pages:    []string{"TimingPage"},
	},
	{
		Title: "Сценарий",
		Docs:  []string{"docs/scenario-workflow.md"},
		Packages: []string{
			"internal/scenario", "internal/sceneregistry", "internal/scenesave",
			"internal/scenescaffold", "internal/sceneviews", "internal/scenarioworkflow",
			"internal/scenarioapply", "internal/continuitybrief", "internal/lintregistry",
		},
		Pages: []string{"ScenarioPage"},
		Paths: []string{"resources/skills/ai-clip-scenario"},
	},
	{
		Title: "Производство и приёмка",
		Docs:  []string{"docs/production-workflow.md", "docs/agent-image-limits.md"},
		Packages: []string{
			"internal/production", "internal/productionworkflow", "internal/shotworkflow",
			"internal/shotstatus", "internal/regenerateshot", "internal/requestsnapshot",
			"internal/costcheck", "internal/acceptance", "internal/acceptshot",
			"internal/assetpackage", "internal/verifyassetreplay", "internal/videoreview",
			"internal/contactsheet", "internal/dashboard", "internal/checks", "internal/checkassets",
			"internal/checkworkspace", "internal/tools",
		},
		Pages: []string{"ProductionPage", "ScenesPage", "ChecksPage"},
		Paths: []string{"resources/skills/ai-clip-scene", "resources/skills/ai-clip-video-review"},
	},
	{
		Title: "Аниматик и монтаж",
		Docs:  []string{"docs/montage.md"},
		Packages: []string{
			"internal/animatic", "internal/animaticcards", "internal/buildanimatic",
			"internal/buildreview", "internal/montage", "internal/applymontage",
			"internal/derivedshot", "internal/derivedworkflow", "internal/deriveshot",
			"internal/exportbundle", "internal/builtoutput",
		},
		Pages: []string{"AnimaticPage", "MontagePage", "MontagePlayerPage"},
	},
	{
		Title: "Агенты и провайдеры медиа",
		Docs: []string{
			"docs/agents.md", "docs/development.md#агенты-и-провайдеры-медиа",
			"resources/providers/README.md", "resources/skills/README.md",
		},
		Packages: []string{
			"internal/agents", "internal/providers", "internal/providers/agentexec",
			"internal/providers/codex", "internal/providers/kling", "internal/providers/kling/mcp",
			"internal/mediaproviders", "internal/mediaadapters", "internal/mediaapi",
			"internal/mediarequest", "internal/mediatest", "internal/mediatest/scenario",
			"internal/mediafile", "internal/mediacmd",
		},
		Pages: []string{"SettingsPage", "EnvironmentPage"},
		Paths: []string{
			"frontend/src/shared/agent-providers.ts", "frontend/src/shared/media-providers.ts",
			"resources/providers",
		},
	},
	{
		Title:    "Встроенные ресурсы",
		Docs:     []string{"resources/README.md", "resources/skills/README.md"},
		Packages: []string{"resources"},
		Paths:    []string{"resources/skills", "resources/fonts"},
	},
	{
		Title: "Семантика форматов и эталоны",
		Docs:  []string{"testdata/golden/README.md", "testdata/README.md"},
		Packages: []string{
			"internal/pycompat", "internal/pyre", "internal/pyargparse", "internal/pytool",
			"internal/jscompat", "internal/golden", "internal/repodocs",
		},
		Paths: []string{"testdata"},
	},
	{
		Title:    "Сборка и поставки",
		Docs:     []string{"packaging/README.md", "packaging/windows/README.md", "dev-skills/songframe-go-build/SKILL.md", "dev-skills/songframe-go-release/SKILL.md"},
		Packages: []string{"scripts/appimage-bootstrap"},
		Paths:    []string{"packaging", "scripts", "Taskfile.yml", ".github/workflows", "www"},
	},
}
