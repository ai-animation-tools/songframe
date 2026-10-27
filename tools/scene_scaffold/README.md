# scene_scaffold

Каркас реестра сцен `plan/scenes.json` из трактовки `plan/treatment.json`, разметки трека и кастинга. Использовать на втором проходе скилла `ai-clip-scenario`; постановку (камера, действие, непрерывность, состояние) после каркаса пишет агент или редактор сценария приложения.

## Контракт

```sh
python3 -B tools/scene_scaffold/scene_scaffold.py --dry-run
python3 -B tools/scene_scaffold/scene_scaffold.py --dry-run --json
python3 -B tools/scene_scaffold/scene_scaffold.py
python3 -B tools/scene_scaffold/scene_scaffold.py --force
```

- Трактовка: `{"schema_version": 1, "logline": "...", "sequences": [{"id", "title", "direction", "start", "end", "entities": [...], "lipsync": false, "max_shot_seconds": 6}]}`. Части идут подряд от 0 до конца трека (допуск 0,06 с), границы обычно берутся из `sections` разметки.
- Планы: внутри части по одному плану на строку песни (граница по началу строки); пауза перед первой строкой или после последней длиннее 2,5 с становится отдельным планом; часть без строк и длинные куски без вокала делятся на равные планы не длиннее `max_shot_seconds` (по умолчанию 6 с). Минимальная длина плана 15 кадров, сетка 30 кадров/с, шкала сплошная, конец совпадает с декодированной длительностью трека (`duration_decoded` разметки: именно с ней сверяет звук сборка аниматика, длительность контейнера MP3 чуть больше).
- Поля: `original` это строки песни плана или «Инструментал: часть»; `camera` и `action` получают `ЗАПОЛНИТЬ`; `references` берутся из `entities` части (только сущности с изображениями), `card.primary_reference` первая из них; `lipsync` из части и только у планов со строкой; `state_from` предыдущий план, у первого `null`; `state_changes` пустые. `references` реестра выводятся из кастинга, `visual_direction` сохраняется из прежнего реестра либо получает заготовку.
- `--dry-run --json` выводит в stdout один полный документ `ScenesFile` (`schema_version`, `fps`, `audio`, `references`, `visual_direction`, `sequences`, `scenes`) без оболочки и без записи любых файлов. Существующий реестр можно использовать как источник `visual_direction`; он остаётся прежним. Ошибки идут в stderr с ненулевым кодом. Обычный `--json` без `--dry-run` сохраняет запись и краткий JSON-отчёт.
- Существующий `plan/scenes.json` не перезаписывается без `--force`; `--dry-run` печатает планы без записи. Результат проходит `scene_registry.validate`.

## Тесты

```sh
python3 -B tools/scene_scaffold/test_scene_scaffold.py
```
