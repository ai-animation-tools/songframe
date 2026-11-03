# Скиллы разработки SongFrame Go

Скиллы принадлежат приватному Go/Wails-репозиторию и обнаруживаются через ссылки в `.agents/skills/` и `.claude/skills/`. Ссылки с теми же Go-именами в корне рабочей области ведут сюда. Каталог не входит в поставку и не копируется в клип-проекты.

| Скилл | Когда применять |
| --- | --- |
| [songframe-go-build](songframe-go-build/SKILL.md) | Локальные Linux AppImage / Windows NSIS, prerequisites, GUI smoke и отдельный CPU smoke |
| [songframe-go-ui](songframe-go-ui/SKILL.md) | Страницы, компоненты, тексты, Wails API, влияющий на UI, и Storybook |
| [songframe-go-project-contract](songframe-go-project-contract/SKILL.md) | JSON проектов, доменные данные, DTO и общие Go/TS fixtures |
| [songframe-go-release](songframe-go-release/SKILL.md) | Планирование Go-выпуска и проверка фактической готовности release pipeline |

UI, контракт и выпуск адаптированы из одноимённых скиллов прежнего SongFrame. В локальном UI сохранены MUI-first, автоматическое вычисление состояний и простота обычного сценария из изменения `434ff3d`; рабочий минимум Go/Wails — 1320×860 в обеих темах. Локальные [правила UI](../docs/ui/README.md) содержат Go-пути и настоящие команды.

`../songframe/` остаётся источником только для чтения. Его Electron/Python-рецепты, шаблон и релизный pipeline не являются реализацией Go-версии. Публикация и updater здесь ещё не реализованы; локальный build не означает release. Новые инструкции и изменения миграции сохраняются здесь; приватные документы соседнего `spec/` сюда не копируются.
