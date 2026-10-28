# cast_registry

Кастинг клипа `plan/cast.json`: сущности (персонажи, транспорт, локации, предметы, мир и любые другие типы), их изображения в `source`, начальное состояние и словарь свойств состояния. Использовать на первом проходе сценария, после изменения референсов и перед проверкой реестра сцен. Реестр сцен хранит только изменения состояния; начальное состояние и подписи принадлежат кастингу.

## Контракт

```sh
python3 -B tools/cast_registry/cast_registry.py init
python3 -B tools/cast_registry/cast_registry.py check
python3 -B tools/cast_registry/cast_registry.py references
python3 -B tools/cast_registry/cast_registry.py sync
python3 -B tools/cast_registry/cast_registry.py vocab
```

- `init` создаёт кастинг по референсам `source/manifest.json` или дополняет существующий: новые референсы становятся сущностями, у прежних обновляются изображения, правки `role`, `appearance`, `initial_state` сохраняются, сущность `world` добавляется, если её нет. `--force` пишет кастинг заново.
- `check` проверяет структуру, наличие файлов изображений и совпадение `references` реестра сцен с кастингом; код выхода 1 при расхождениях.
- `references` печатает карту для `plan/scenes.json`: сущности с изображениями, первый файл основной, `short_name` только если отличается от имени. `sync` записывает её в реестр; ссылки сцен на сущности без изображения это ошибка.
- `vocab` печатает словарь свойств по типам. Общий для инструментов и приложения источник словаря по умолчанию: [default_properties.json](default_properties.json). Тип сущности открыт (код латиницей); для типа без словаря действует общий набор `generic`.
- Поля сущности: `id` (он же ключ в `references` и в `state_changes` реестра), `kind`, `name`, `short_name`, `role`, `appearance`, `images` (пути внутри `source`), `initial_state` (свойство → непустая строка). Схема: `tools/lint_registry/schemas/cast.schema.json`; `lint_registry` проверяет кастинг, если файл есть.
- `scene_registry` берёт начальное состояние из кастинга: сцены со `state_from: null` стартуют с него. Без кастинга начало пустое.

## Тесты

```sh
python3 -B tools/cast_registry/test_cast_registry.py
```
