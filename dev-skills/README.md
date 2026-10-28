# Скиллы разработки комплекса

Скиллы агента для работы над самим SongFrame, а не над клипом. Папка намеренно лежит вне `skills/`: приложение упаковывает `skills/` в ресурсы и копирует его справочники в каждый проект, а эти памятки нужны только в checkout комплекса.

| Скилл | Назначение |
| --- | --- |
| [songframe-build](songframe-build/SKILL.md) | Локальная сборка и проверка Linux AppImage или Windows ZIP |
| [songframe-release](songframe-release/SKILL.md) | Подготовка и выпуск релиза через GitHub Actions |
| [songframe-ui](songframe-ui/SKILL.md) | Изменение и проверка интерфейса по правилам UI |
| [songframe-project-contract](songframe-project-contract/SKILL.md) | Изменение форматов проектов, шаблона, интеграции и управляемых навыков |

Источники редактируются только здесь. В checkout комплекса `.agents/skills` (Codex) и `.claude/skills` (Claude Code) содержат ссылки `../../dev-skills/<имя>`; рабочее пространство AI Animation Tools ссылается на те же папки через `songframe/dev-skills/<имя>`.
