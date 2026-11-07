# Тестовые данные

Все данные синтетические и принадлежат этому репозиторию. Проверкам не нужны соседние каталоги, настоящие клипы, профиль приложения, Python или платные сервисы.

| Каталог | Что внутри | Кто читает |
| --- | --- | --- |
| [golden/](golden/README.md) | Эталоны поведения Electron-версии SongFrame на срезе `634fd94`: входы и выходы функций по доменам | Go-тесты через `internal/golden`, часть TS-тестов |
| [golden/checks-base/project](golden/checks-base/project/README.md) | Проект-образец «Пробный клип» | Go-тесты эталонов, производства, монтажа и экспорта |
| [contracts/](contracts/README.md) | Общие JSON-fixtures границы Go и TypeScript | `wails3 task check:contracts` |
| [components/](components/README.md) | Маленькие медиафайлы для проверки возможностей WebView | Проверки компонентов и медиа |

## Проект-образец

`golden/checks-base/project` — маленький проект «Пробный клип» на пять планов, байт в байт совпадающий с `tools/testdata/sample-project` Electron-версии на `634fd94`. Он устроен по правилам шаблона `resources/templates/project`:

- `plan/project.json` с блоком `generation`, `source/manifest.json` с треком, текстом, идеей и четырьмя референсами;
- `plan/cast.json`, `plan/treatment.json`, `plan/scenes.json` с наследованием состояния (цепочка, явное `before`, повтор `same`), финальный M05 собирается из материала M02 (`derived_from`);
- два принятых комплекта в `assets/shots` (M01, M02), пакет M03 на согласовании опор, карточки M03–M05, производные представления и манифест аниматика.

Трек тихий на 30 секунд, референсы и видео однотонные, поэтому набор весит меньше мегабайта. `.gitignore` проекта лежит под именем `_gitignore`: иначе Git этого репозитория не взял бы пакет M03 из `plan/batches`.

Тесты не меняют образец: `internal/golden` копирует его во временную папку (`Case.CopyProject`, сборка проекта с наложениями случая — `Case.BuildProject` в `overlay.go`). Отпечатки постановки принятых планов M01 и M02 записаны в `plan/production-status.json` и сверяются эталоном `status/*/expected-acceptance.json`.

Образец — общий вход многих эталонов. Его правка меняет ожидаемые результаты, поэтому эталоны после неё пересматриваются вместе с объяснением в [golden/README.md](golden/README.md). Генератор образца из Electron-версии (`build_sample.py`) не переносится: он собирал проект Python-инструментами, которых в Go-версии нет, а пересборка дала бы новые байты медиа и сломала бы эталоны без изменения поведения.

## Инструменты разработчика Electron-версии

| Инструмент | Замена в Go-версии |
| --- | --- |
| `run_tests` | `wails3 task check:all` и адресные команды `Taskfile.yml` |
| `lint_registry`, `check_workspace` | Перенесены как инструменты приложения (`internal/lintregistry`, `internal/checkworkspace`), сверены эталонами |
| `update_scene_views --staged/--ref` | Не переносится: проверка снимков индекса Git нужна была только для разработки Python-инструментов; без них снимки не проверяются, а команда отвечает понятным отказом (`internal/sceneviews`) |
| `build_sample.py` | Не переносится, см. «Проект-образец» |
