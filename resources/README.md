# Ресурсы оболочки

`icon.png` и `icon.ico` перенесены из SongFrame, срез `634fd9429ba0b0cfcb984a52ce95adf8e1674635`. Исходное изображение предоставлено пользователем; это его производные для приложения. Корневая лицензия MIT сохранена в `LICENSE`.

Ранний Linux AppImage включает PNG как значок desktop entry; исходники и рецепт упаковки находятся в `packaging/`. Исходный JPEG, модели, медиа клипов и экспериментальные отчёты в поставку не копируются.

## Шаблон проекта

`templates/project/` — шаблон новой папки клипа, перенесённый из `templates/project` SongFrame на том же срезе `634fd94` (`git archive`, байт в байт, вместе с `.gitignore` и `.gitkeep`). Владелец содержимого — этот каталог: оригинал заморожен, правки шаблона вносятся только здесь и вместе с эталонами `testdata/golden/project-create`.

Шаблон встраивается в бинарник (`resources.go`, `//go:embed all:templates/project`; префикс `all:` нужен для скрытых файлов) и доступен через `resources.ProjectTemplate()` как `fs.FS` с корнем шаблона. Копирует его с подстановкой `{{project_name}}` и `{{animatic_video}}` пакет `internal/newproject`; плейсхолдеры подставляются только в текстовые файлы (`.md`, `.json`, `.txt`, `.yml`, `.yaml`, `.gitignore`, `.gitkeep`) и без экранирования JSON, как в оригинале. Промпты агента и руководства провайдеров переносятся отдельно (этапы 44/45).

## Шрифты карточек аниматика

`fonts/DejaVuSans.ttf`, `fonts/DejaVuSans-Bold.ttf` и `fonts/LICENSE` перенесены байт в байт из `tools/render_animatic_cards/fonts` SongFrame на срезе `634fd94` (DejaVu fonts 2.37 из пакета Debian `fonts-dejavu-core` 2.37-8; условия распространения — в `fonts/LICENSE`). Шрифты встраиваются в бинарник (`resources.go`, `//go:embed fonts`) и доступны через `resources.Font(name)`; их читает рендер карточек `internal/animaticcards`. Системные шрифты ОС не используются: переносы строк и выбор кегля карточки зависят от метрик именно этих файлов. Контрольные SHA-256 проверяет `resources_test.go`; замена шрифта меняет раскладку карточек и требует пересъёмки эталона `testdata/golden/animatic-cards`.

## Промпты агента

`skills/` — тексты промптов, которые приложение вкладывает в задания агента в режиме предложения, перенесены байт в байт из `skills/` SongFrame на срезе `634fd94` (`git archive`): `ai-clip-scenario`, `ai-clip-scene` с `references/`, `ai-clip-video-review` и `README.md`. Каталог встраивается в бинарник (`resources.go`, `//go:embed skills`); `resources.Skill(name)` возвращает `skills/<name>/SKILL.md`. Сценарный проход (`internal/scenarioworkflow`) собирает промпт задания из `ai-clip-scenario` и правил режима предложения так же, как оригинал: байты промпта сверяют эталоны `testdata/golden/scenario-workflow/prompt-*.txt`, контрольную SHA-256 каталога проверяет `resources_test.go`. Правка текста скилла меняет промпт агента и требует пересъёмки эталона.
