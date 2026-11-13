# Скиллы разработки SongFrame

Скиллы разработки SongFrame обнаруживаются через относительные ссылки в `.agents/skills/` и `.claude/skills/`. Каталог не входит в поставку и не копируется в клип-проекты. Промпты, которые приложение вкладывает в задания агента, лежат отдельно — в `resources/skills/`.

| Скилл | Когда применять |
| --- | --- |
| [songframe-build](songframe-build/SKILL.md) | Локальные Linux AppImage и deb, Windows NSIS, prerequisites, GUI smoke и отдельный CPU smoke |
| [songframe-ui](songframe-ui/SKILL.md) | Страницы, компоненты, тексты, Wails API, влияющий на UI, и Storybook |
| [songframe-project-contract](songframe-project-contract/SKILL.md) | JSON проектов, доменные данные, DTO и общие Go/TS fixtures |
| [songframe-release](songframe-release/SKILL.md) | План и выпуск версий в публичном songframe |

Скиллы описывают порядок работы и ссылаются на руководства `docs/`, `packaging/` и README; сами правила продукта и устройства в них не дублируются. Локальная сборка не означает выпуск; публикация — только по отдельному поручению.
