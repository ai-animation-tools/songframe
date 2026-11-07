# Скиллы разработки SongFrame Go

Скиллы разработки SongFrame обнаруживаются через относительные ссылки в `.agents/skills/` и `.claude/skills/`. Каталог не входит в поставку и не копируется в клип-проекты. Промпты, которые приложение вкладывает в задания агента, лежат отдельно — в `resources/skills/`.

| Скилл | Когда применять |
| --- | --- |
| [songframe-go-build](songframe-go-build/SKILL.md) | Локальные Linux AppImage / Windows NSIS, prerequisites, GUI smoke и отдельный CPU smoke |
| [songframe-go-ui](songframe-go-ui/SKILL.md) | Страницы, компоненты, тексты, Wails API, влияющий на UI, и Storybook |
| [songframe-go-project-contract](songframe-go-project-contract/SKILL.md) | JSON проектов, доменные данные, DTO и общие Go/TS fixtures |
| [songframe-go-release](songframe-go-release/SKILL.md) | План и выпуск 1.0.0 и следующих версий в публичном songframe |

UI, контракт и выпуск продолжают одноимённые скиллы Electron-версии. В UI сохранены MUI-first, автоматическое вычисление состояний и простота обычного сценария; рабочий минимум — 1320×860 в обеих темах. Локальные [правила UI](../docs/ui/README.md) содержат Go-пути и настоящие команды.

Рецепты Electron-версии (Python-инструменты, `yarn release`, electron-builder) здесь не применяются. Локальная сборка не означает выпуск; публикация — только по отдельному поручению. Приставка `go` в именах скиллов сохраняется до переключения репозитория, чтобы не пересекаться со скиллами Electron-версии в общей рабочей области.
