# Выбор проверок CI

`classify-changes.mjs` объединяет независимые наборы по изменённым путям. Настройка заданий и команд принадлежит [ci.yml](../../.github/workflows/ci.yml). Классификатор не строит граф импортов и не запускает проверки самостоятельно.

| Флаг | Проверки |
| --- | --- |
| `quality` | ESLint и Prettier без установки Electron |
| `types` | Типизация приложения и историй |
| `node` | Тесты приложения: все или явный список `node_tests` |
| `build` | Сборка приложения |
| `browser` | Сборка Storybook и браузерные истории |
| `python` | Наборы инструментов: все или явный список `python_tests` |
| `runtime` | Существующие Node/Python unit-тесты сценариев поставки; без сборки установщиков |
| `release` | Unit-тесты сценария выпуска; без GitHub и настоящей публикации |
| `workflow` | Actionlint для workflow и адресные ESLint/Prettier для инфраструктуры CI |

`node_tests` содержит пути `src/**/*.test.ts`, `python_tests` — имена модулей вида `test_align_lyrics`, принимаемые `tools/run_tests/run_tests.py --only`. Для выключенного флага список пуст. `null` означает весь соответствующий набор. Смешанный diff объединяет флаги и уникальные имена; `null` поглощает адресные списки. Поле `reason` объясняет выбор в журнале.

`node_media` — дополнительный вычисляемый признак подготовки, а не набор проверок. Он включён для полного Node-набора и выбранных интеграционных потребителей Python/FFmpeg. Чистые `provider-guides`, `timing-local`, `vocal-preparation`, `checks-instructions` этой подготовки не требуют. Признак вычисляется после объединения путей и повторно после проверки существования выбранных тестов: переход к полному Node-набору также включает `node_media`. Установка Electron и медиазависимостей нужна при `node_media || build || browser`, а не при любом `node=true`.

## Гранулярность

- `src/main/` включает quality, types, полный Node и build. `src/renderer/`, `src/shared/`, `src/preload/` дополнительно включают browser.
- `.storybook/`, `scripts/storybook/`, `tests/storybook/` включают quality, types и browser, без Node и сборки приложения.
- `scripts/release/` включает quality и release; `scripts/runtime/` — runtime, дополнительно quality для JavaScript, JSON и YAML. Python поставки не запускает тесты инструментов.
- Только `test_*.py` инструмента включает изменённый Python-модуль. Два явных исключения учитывают импорт тестовых фикстур: `test_shot_workflow_decisions` дополнительно включает `test_shot_workflow_images`, `test_export_edit_bundle` — `test_check_workspace`. Изменение реализации ASR включает предметную группу: `align_lyrics`, `transcribe_local` с quality/hardware, `song_timing`, `separate_vocals`, `download_song_models`. Это одна согласованная группа, а не вычисляемые зависимости каждого файла. Загрузчик Whisper имеет отдельный Python-набор. Приложение для этих Python-правок не запускается.
- Остальные инструменты и общие данные проверяются всеми Python-наборами и коротким явным списком Node integration-потребителей, включая `derived-workflow`, который читает реальный sample-project. Автономные `current_project` и `video_review` включают только собственные Python-наборы `test_current_project` / `test_video_review` и своих явных Node-потребителей (`main` + `portability` / `video-review`); правка только их теста по-прежнему запускает только этот Python-модуль. `fake_media_request` проверяется тремя производственными Node-наборами; `sample_project.py` требует только Python.
- `tools/song_timing/models.json` одновременно служит входом Python и приложения: ASR-группа, types/build и адресные Node-тесты разметки/вокала. Quality не включается: `tools/` исключён из ESLint/Prettier. Схемы `tools/lint_registry/schemas/` дополнительно проверяются `src/shared/video.test.ts`; `scene-fingerprints.json` читает только Node-набор `shot-acceptance.test.ts`, поэтому Python не требуется.
- Шаблоны проверяются Node-потребителями создания проекта, инструкций и переносимости (`main`, `checks-instructions`, `portability`); производственные `skills/` — workflow-потребителями. `docs/providers/` проверяется `provider-guides.test.ts`, поэтому не считается обычной документацией.
- Из sample-project браузер получает только три файла, перечисленные в `scripts/storybook/prepare-assets.mjs`: `assets/shots/M01/video.mp4`, `source/heroes/mira.png`, `source/track.mp3`. Остальной образец включает Python и Node integration, без browser. Весь `tools/testdata/sample-project/` обрабатывается до общего исключения Markdown: `source/text.md` — тестовая фикстура, а не обычное руководство.

## Консервативные исключения

Общие зависимости `package.json`, `yarn.lock`, `.yarnrc.yml`, `.nvmrc` включают все наборы. TypeScript-конфигурация включает quality/types/build/browser; Vitest — quality и полный Node; ESLint/Prettier/`.editorconfig` — только quality. `electron.vite.config.ts` входит в TypeScript-проект Node и включает quality/types/build без browser; `electron-builder.yml` включает quality/build/runtime.

`scripts/runtime/media-lock.json` служит также входом подготовки FFmpeg в CI: кроме quality/runtime включаются Python-набор `test_prepare_ci_ffmpeg` и явные Node integration-потребители настоящего FFmpeg. Types/build/browser этому lock-файлу не требуются.

`resources/` содержит иконки Electron, которых Storybook не читает: изменения включают только runtime. Это проверка существующих unit-тестов сценариев поставки; она не собирает установщик и не подтверждает фактический вид иконок установленного приложения. Такая приёмка относится к отдельной сборке поставки.

Изменения самого routing (`scripts/ci/`, кроме обычных Markdown) и любых `.github/workflows/` включают только `workflow`: Actionlint и адресные ESLint/Prettier. Это относится и к `pages.yml`, и к настройке TLS `node-openssl.cnf`. Контрольные тесты классификатора уже выполняются в задании выбора набора и повторно не запускаются. Изменение CI само по себе не включает приложение, Python, выпуск или браузер. Смешанный diff объединяет workflow с проверками фактически затронутых областей.

Обычные Markdown, включая README инструментов и сценариев, не включают проверки. Исключение — входы приложения `docs/providers/`, `skills/`, `templates/` и тестовый образец `tools/testdata/sample-project/`: их потребители выбираются до общего правила Markdown. `tools/testdata/README.md` остаётся обычным руководством. Остальные `docs/`, `dev-skills/`, `.agents/`, `.claude/`, `.vscode/`, `www/`, шаблоны GitHub issues/PR и корневой `.gitignore` также не включают проверки. Неизвестный путь включает всё, в том числе workflow: новый вид файлов сначала получает консервативное покрытие, а явное правило добавляется после определения потребителей.

Push сравнивается целиком от `before` до `after`, PR — от общей базы `base...head`, включая все коммиты ветки. Rename рассматривается как удаление и добавление: старый путь также влияет на выбор. Если выбранный тест удалён или переименован и прежнего имени больше нет в checkout, соответствующий список заменяется на `null`; старое имя не передаётся runner. Нулевой `before`, пустой diff, неизвестное событие и недоступные данные автоматического события включают всё.

## Ручной запуск

`workflow_dispatch` поддерживает три значения `inputs.mode`:

| Режим | Поведение |
| --- | --- |
| `Выбранные группы` | Режим по умолчанию: запускаются ровно отмеченные checkbox-группы; соседние наборы не добавляются |
| `По последнему коммиту` | Правила путей применяются только к `HEAD^→HEAD` выбранного в GitHub ref |
| `Полный набор` | Включаются все девять групп, значения checkbox игнорируются |

Checkbox-ключи совпадают с флагами `quality`, `types`, `node`, `build`, `browser`, `python`, `runtime`, `release`, `workflow`. Принимаются boolean `true`/`false` и строковые `'true'`/`'false'`, которые передаёт GitHub. Отсутствующий checkbox считается выключенным. Выбранный `node` задаёт `node_tests=null`, выбранный `python` — `python_tests=null`; `node_media` вычисляется как обычно. Пустой выбор, неизвестный режим и некорректный checkbox завершаются понятной ошибкой, без скрытого полного прогона. Ошибка чтения JSON события ручного запуска тоже останавливает команду.

Если `mode` отсутствует при вызове через API, выбираются переданные checkbox-группы; отсутствие включённых флагов приводит к ошибке пустого выбора. Все checkbox по умолчанию выключены. Режим `По последнему коммиту` нужно выбрать явно: его диапазон берётся из фактического checkout, а не из полей push/PR. Для merge-коммита `HEAD^` означает первого родителя. Причина результата начинается с `manual-changes-`; первый коммит без родителя, недоступная история или diff включают консервативный полный набор. Этот режим игнорирует checkbox. Причины выбора групп и полного запуска — `manual-selected` и `manual-full`.

## Запуск

Workflow передаёт стандартные `GITHUB_EVENT_NAME`, `GITHUB_EVENT_PATH`, `GITHUB_OUTPUT` и полную историю Git через `actions/checkout` с `fetch-depth: 0`:

```sh
node scripts/ci/classify-changes.mjs
```

В `GITHUB_OUTPUT` записываются девять boolean-флагов проверок, boolean `node_media` и JSON-значения `node_tests`/`python_tests`, по одному ключу на строку. В stdout выводится полный JSON с причиной. Локальные проверки используют временные Git-репозитории и проверяют существование явно перечисленных тестов:

```sh
node --test scripts/ci/classify-changes.test.mjs
```

`node-openssl.cnf` задаёт группы TLS для Node на домашних раннерах; его подключает workflow через `OPENSSL_CONF`.

### Примеры ручного запуска

В GitHub: **Actions → CI → Run workflow**, выберите ветку и режим. Флажки учитываются только для «Выбранные группы»; можно отметить несколько. Выбор без флажков завершится понятной ошибкой и не включит все проверки.

```sh
# Две группы, без тестов и сборки приложения.
gh workflow run CI --ref main -f workflow=true -f release=true

# Проверка по последнему коммиту выбранной ветки.
gh workflow run CI --ref main -f 'mode=По последнему коммиту'

# Полная ручная проверка, которая может подтвердить исходники выпуска.
gh workflow run CI --ref main -f 'mode=Полный набор'
```

Ручные запуски имеют отдельную concurrency-группу с run_id: они не отменяют автоматическую проверку или друг друга. Для инструмента публикации значим только полный ручной marker `CI · manual/all`; частичные проверки отмечены `manual/changes` и `manual/selected` и не подменяют qualification исходников.

Типы `choice` и `boolean`, а также передача значений в событие описаны в [официальном синтаксисе GitHub Actions](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#onworkflow_dispatchinputs).
