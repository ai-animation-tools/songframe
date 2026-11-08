# Скиллы разработки SongFrame

Скиллы разработки SongFrame обнаруживаются через относительные ссылки в `.agents/skills/` и `.claude/skills/`. Каталог не входит в поставку и не копируется в клип-проекты. Промпты, которые приложение вкладывает в задания агента, лежат отдельно — в `resources/skills/`.

| Скилл | Когда применять |
| --- | --- |
| [songframe-go-build](songframe-go-build/SKILL.md) | Локальные Linux AppImage / Windows NSIS, prerequisites, GUI smoke и отдельный CPU smoke |
| [songframe-go-ui](songframe-go-ui/SKILL.md) | Страницы, компоненты, тексты, Wails API, влияющий на UI, и Storybook |
| [songframe-go-project-contract](songframe-go-project-contract/SKILL.md) | JSON проектов, доменные данные, DTO и общие Go/TS fixtures |
| [songframe-go-release](songframe-go-release/SKILL.md) | План и выпуск 1.0.0 и следующих версий в публичном songframe |

Скиллы описывают порядок работы и ссылаются на руководства `docs/`, `packaging/` и README; сами правила продукта и устройства в них не дублируются. Локальная сборка не означает выпуск; публикация — только по отдельному поручению. Приставка `go` в именах скиллов — скрытое имя (D-038 в spec): пока не меняется, как и модуль `songframe-go`.
