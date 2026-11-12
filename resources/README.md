# Ресурсы оболочки

`icon.png` и `icon.ico` — значок приложения. Исходное изображение предоставлено пользователем; это его производные для приложения. Корневая лицензия MIT — в `LICENSE`.

Linux AppImage включает PNG как значок desktop entry; исходники и рецепт упаковки находятся в `packaging/`. Исходный JPEG, модели, медиа клипов и экспериментальные отчёты в поставку не копируются.

## Шаблон проекта

`templates/project/` — шаблон новой папки клипа вместе с `.gitignore` и `.gitkeep`. Правки шаблона вносятся только здесь и вместе с эталонами `testdata/golden/project-create`: шаблон меняет результат программы.

Шаблон встраивается в бинарник (`resources.go`, `//go:embed all:templates/project`; префикс `all:` нужен для скрытых файлов) и доступен через `resources.ProjectTemplate()` как `fs.FS` с корнем шаблона. Копирует его с подстановкой `{{project_name}}`, `{{animatic_video}}` и `{{fps}}` (частота кадров числом) пакет `internal/newproject`; плейсхолдеры подставляются только в текстовые файлы (`.md`, `.json`, `.txt`, `.yml`, `.yaml`, `.gitignore`, `.gitkeep`) и без экранирования JSON.

## Шрифты карточек аниматика

`fonts/DejaVuSans.ttf`, `fonts/DejaVuSans-Bold.ttf` и `fonts/LICENSE` — DejaVu fonts 2.37 из пакета Debian `fonts-dejavu-core` 2.37-8; условия распространения — в `fonts/LICENSE`. Шрифты встраиваются в бинарник (`resources.go`, `//go:embed fonts`) и доступны через `resources.Font(name)`; их читает рендер карточек `internal/animaticcards`. Системные шрифты ОС не используются: переносы строк и выбор кегля карточки зависят от метрик именно этих файлов. Контрольные SHA-256 проверяет `resources_test.go`; замена шрифта меняет раскладку карточек и эталон `testdata/golden/animatic-cards`.

## Промпты агента

`skills/` — тексты промптов, которые приложение вкладывает в задания агента в режиме предложения: `ai-clip-scenario`, `ai-clip-scene` с `references/`, `ai-clip-video-review`, и сводка `README.md`. Каталог встраивается в бинарник (`resources.go`, `//go:embed skills`); `resources.Skill(name)` возвращает `skills/<name>/SKILL.md`. Сценарный проход (`internal/scenarioworkflow`) собирает промпт задания из `ai-clip-scenario` и правил режима предложения: байты промпта сверяют эталоны `testdata/golden/scenario-workflow/prompt-*.txt`, контрольную SHA-256 каталога проверяет `resources_test.go`. Правка текста скилла меняет промпт агента — только по решению пользователя, вместе с эталоном.

## Документы провайдеров медиа

`providers/` — документы провайдеров медиа, по одному на вид медиа и провайдера (`image/codex.md`, `image/kling.md`, `video/kling.md`), и сводка `README.md`. Каталог встраивается в бинарник (`resources.go`, `//go:embed providers`); `resources.ProviderDoc(kind, id)` возвращает `providers/<вид>/<id>.md`. Раздел «Указания агенту» выбранного провайдера слой `internal/providers` (`providers.Guide`) вкладывает в промпт задания, поэтому его правка меняет промпт; контрольные SHA-256 проверяет `resources_test.go`. Добавление провайдера — документ здесь вместе со строкой реестра и папкой адаптера.
