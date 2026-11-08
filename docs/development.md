# Разработка SongFrame

Руководство для разработчика Go/Wails-версии: как устроено приложение, где проходят границы, как добавлять провайдеров, какими тестами доказывать сохранность результата и какие команды запускать. Правила работы в репозитории — в [AGENTS.md](../AGENTS.md), быстрый старт — в [README](../README.md).

Go-версия — преемник Electron-SongFrame. Главный критерий переноса — неизменный результат программы: записываемые файлы и форматы проекта, статусы, fingerprints, тайминги, промпты, согласования платных операций. Поведение оригинала зафиксировано эталонами на срезе `634fd94` (см. [«Эталоны оригинала»](#эталоны-оригинала)); исходники Electron-версии для сборки и тестов не нужны.

## Окружение разработчика

| Что | Зачем |
| --- | --- |
| Go 1.26+ (`go.mod`) | Сборка и тесты; Wails на Linux требует CGO и C-компилятор |
| Wails CLI 3.0.0 (`go install github.com/wailsapp/wails/v3/cmd/wails3@v3.0.0`) | Генерация bindings, встроенный исполнитель `Taskfile.yml` |
| GTK4 и WebKitGTK 6.0 development packages (Linux) | Компиляция пакетов, импортирующих Wails, в том числе для `go test` |
| Node.js и Yarn 4.18.1 (`frontend/package.json`, `packageManager`) | Frontend, Vitest, Storybook; скрипт bindings тоже вызывает `node` |
| Chromium для Playwright (`cd frontend && yarn playwright install chromium`) | Браузерная проверка витрины |

Python для работы приложения и его тестов не нужен (см. [«Python»](#python)). FFmpeg/ffprobe нужны только тестам медиаинструментов: без программы в `PATH` такие тесты пропускаются. Требования к сборке поставок перечислены в [packaging](../packaging/README.md).

## Устройство

```text
main.go                 точка входа: профиль, восстановление, сервисы, окно, флаги проверок
internal/app/           Wails-сервисы — граница между renderer и предметной логикой
internal/<область>/     логика областей без зависимости от Wails
frontend/src/shared/    контракт window.api, типы, реестры, словари текстов
frontend/src/platform/  единственная реализация window.api поверх bindings
frontend/src/renderer/  React/MUI-интерфейс: страницы, общие компоненты, тема
frontend/bindings/      TypeScript, сгенерированный из Go-сервисов (не править вручную)
resources/              встраиваемые шаблон проекта, промпты, документы провайдеров, шрифты
testdata/               эталоны оригинала, контракты, проект-образец
packaging/, scripts/    рецепты поставок и сборочные скрипты
dev-skills/             скиллы разработки (в поставку не входят)
```

### Точка входа

`main.go` при запуске:

1. определяет каталог состояния (`internal/store`) и запускает локальный медиасервер (`internal/media`);
2. до открытия окна восстанавливает прерванные многофайловые операции: публикацию сценария (`internal/scenarioapply`), применение предложения производства (`internal/productionworkflow`), применение монтажа (`internal/montage`), приёмку производного плана (`internal/derivedworkflow`). Сбой восстановления не мешает запуску, но снимает текущий проект: запись в него запрещена, пока восстановление при открытии не завершится;
3. создаёт менеджер компонентов, менеджер заданий, менеджер агентов и слой провайдеров медиа;
4. регистрирует Wails-сервисы `internal/app` и открывает окно 1320×860 (это же минимальный размер).

При закрытии менеджеры останавливают свои процессы вместе с потомками.

### Wails-сервисы

`internal/app` содержит только границу: методы сервисов принимают аргументы renderer, вызывают предметные пакеты и отдают DTO. Логика, проверяемая без Wails, живёт в `internal/<область>`. Ответы проходят через `wire.Fill` (`internal/wire`): все достижимые `nil`-срезы и `nil`-словари превращаются в `[]` и `{}`, nullable-указатели остаются `null`. Поэтому renderer не проверяет ответы вручную, а соответствие типов доказывает `typecheck`.

### Предметные пакеты

Сгруппированы по областям; назначение каждого пакета описано комментарием `// Package …` в его исходниках. Многие пакеты — переносы отдельных инструментов или модулей оригинала: комментарий называет исходный файл.

| Область | Пакеты |
| --- | --- |
| Инфраструктура приложения | `store` (каталог состояния, текущий проект и история), `diagnostics` (журнал и признак штатного завершения), `process` (запуск внешних программ), `jobs` (менеджер заданий), `projectfs` (атомарная запись и шлюз записи), `filedigest` (SHA-256 с кэшем), `media` (loopback HTTP для WebView), `desktop` (открытие файлов системой), `trash` (корзина ОС), `wire` (подготовка ответов к контракту), `components` (FFmpeg, ONNX Runtime и модели) |
| Проект и исходники | `project` (общие сведения о папке проекта и журналах), `projectfile` (маркер `plan/project.json`), `newproject` (создание из шаблона), `status` (состояние проекта), `sources`, `sourceedit`, `sourceinputs` (опись `source/manifest.json` и форма «Исходники»), `referenceimage`, `cast`, `castregistry` (кастинг), `covergen` (обложка и изображения референсов), `projectviews` |
| Разметка песни | `timing` (`plan/audio/timing.json`), `songtiming` (автоматическая разметка), `songml` (выделение вокала и выравнивание CTC), `speech` (речевые планы), `cutspeech` (WAV липсинка) |
| Сценарий | `scenario`, `sceneregistry`, `scenesave`, `scenescaffold`, `sceneviews` (реестр планов `plan/scenes.json` и его представления), `scenarioworkflow` (сценарный проход агента), `scenarioapply` (многофайловая публикация), `continuitybrief`, `lintregistry` |
| Производство и приёмка | `production`, `productionworkflow` (рабочие пакеты и проход агента), `shotworkflow`, `shotstatus`, `regenerateshot`, `requestsnapshot`, `costcheck`, `acceptance`, `acceptshot`, `assetpackage`, `verifyassetreplay`, `videoreview` (проверка видео агентом), `contactsheet`, `dashboard`, `checks`, `checkassets`, `checkworkspace`, `tools` (метод `tools.run`) |
| Аниматик и монтаж | `animatic`, `animaticcards`, `buildanimatic`, `buildreview` (пробы стыков), `montage`, `applymontage`, `derivedshot`, `derivedworkflow`, `deriveshot` (производные планы), `exportbundle` (экспорт для монтажёра), `builtoutput` |
| Агенты и провайдеры медиа | `agents` (внешние текстовые агенты), `providers` (слой провайдеров) и папки адаптеров `providers/<id>/`, `mediaproviders` (Go-часть реестра), `mediaadapters` (таблица платных адаптеров), `mediaapi` (контракт адаптера), `mediarequest` (жизненный цикл платной попытки), `mediatest` (тестовый провайдер `test`), `mediafile`, `mediacmd` (общий запуск FFmpeg/ffprobe) |
| Семантика оригинала | `pycompat`, `pyre`, `pyargparse`, `pytool` (значения, JSON-вывод, регулярные выражения, argparse и вывод CLI в семантике Python 3.12), `jscompat` (семантика JavaScript/Node.js, от которой зависит результат) |
| Тесты | `golden` (чтение и сравнение эталонов) |

Подробные процессы описаны отдельно: [производство](production-workflow.md), [сценарный проход](scenario-workflow.md), [монтаж и производные планы](montage.md), [агенты](agents.md) и [ограничения изображений агента](agent-image-limits.md).

## Контракт `window.api`

Renderer не читает файловую систему и не запускает процессы. Единственный путь к Go — контракт [`frontend/src/shared/api.ts`](../frontend/src/shared/api.ts):

- [`frontend/src/platform/api.ts`](../frontend/src/platform/api.ts) — единственная реализация: каждый метод вызывает сгенерированный binding Wails, а события Wails превращает в подписки.
- [`frontend/src/platform/api-skeleton.ts`](../frontend/src/platform/api-skeleton.ts) задаёт типизированную заготовку всех методов, которую `createApi` заполняет вызовами bindings. Тест адаптера проверяет, что ни один метод не остался заготовкой: новый метод контракта добавляется вместе с Go-реализацией.
- `frontend/bindings/` создаёт `wails3 task bindings` ([`scripts/bindings.sh`](../scripts/bindings.sh)): `wails3 generate bindings`, затем скрипт убирает хвостовые пробелы и сужает `T[] | null` до `T[]`, что честно благодаря `wire.Fill`. Файлы хранятся в Git и вручную не правятся; после изменения Go-сервиса bindings перегенерируются.

Новая возможность — это метод предметного пакета, метод Wails-сервиса в `internal/app`, перегенерированный binding, метод в `shared/api.ts` и его реализация в `platform/api.ts` с тестом рядом (`frontend/src/platform/*-api.test.ts` подменяют generated-вызовы). Контракты DTO и форматов проекта меняются по [songframe-go-project-contract](../dev-skills/songframe-go-project-contract/SKILL.md).

`frontend/dist` встраивается в бинарник через `go:embed`. В чистом checkout его ещё нет, поэтому `scripts/bindings.sh` создаёт временный `index.html` только для запуска генератора; Vite заменяет его настоящей сборкой. Бинарник, собранный вручную поверх временного index, — не приложение: штатный `wails3 task build` всегда собирает frontend.

## Процессы, задания и запись файлов

**Внешние программы** (FFmpeg/ffprobe, агенты, `git`, открытие файлов) запускаются только через [`internal/process`](../internal/process/process.go): без shell, с отменой через context, необязательным таймаутом, потоковым выводом и ограниченным хвостом stdout/stderr. Отмена завершает программу вместе с потомками: в Linux — группу процессов, в Windows — дерево через `taskkill`; в Windows дочерние консольные программы не получают окна консоли. Второй способ запуска не добавлять.

**Длительные операции** идут через [`internal/jobs`](../internal/jobs/types.go). Задание — последовательность шагов-функций с context отмены и журналом; программу шаг запускает через `StepContext.Exec`. Сведения задания хранятся в `<каталог состояния>/jobs/<id>.json` (атомарно), журнал — в `<id>.log`. После перезапуска задание, которое выполнялось, получает статус «прервано». Семантика `JobInfo`, статусов шагов и кодов совпадает с оригиналом.

**Запись файлов проекта и состояния** — через [`internal/projectfs`](../internal/projectfs/atomic.go): временный файл рядом, запись, `fsync`, переименование. JSON сериализуется как `JSON.stringify(value, null, 2)` + `\n`, поэтому файлы Go-версии байт в байт равны файлам Electron при тех же значениях. Перед записью в проект действует шлюз `CheckWrite` ([`gate.go`](../internal/projectfs/gate.go)): если в проекте есть незавершённый или нечитаемый журнал многофайловой операции, запись запрещается, чтобы не смешать версии файлов. Чтение проекта и распознавание журналов принадлежат `internal/project`.

**Медиа для WebView** отдаёт [`internal/media`](../internal/media): один HTTP-сервер на IPv4 loopback для всех окон, `GET`/`HEAD`/`Range`, только файлы под разрешёнными корнями (открытый проект, профиль) или выбранные пользователем по одному. Адрес вида `/file/<путь>` строит синхронно `shell.fileUrl` ([`file-url.ts`](../frontend/src/platform/file-url.ts)). Порт временный, поэтому такие URL не сохраняются в проект.

## Каталог состояния

| Что | Значение |
| --- | --- |
| App ID | `tools.songframe.desktop` (`internal/app/app.go`) |
| Каталог состояния | `songframe-desktop` внутри `os.UserConfigDir()` (`internal/store/profile.go`) |
| Подмена каталога | `SONGFRAME_GO_LOCAL_DIR`; относительный путь отсчитывается от текущего каталога запуска |
| Ключ темы renderer | `songframe-go.theme` в `localStorage` |

В каталоге состояния лежат текущий проект и история (`current-project.json`, `projects.json` — имена как у Electron), настройки агента (`settings.json`), задания (`jobs/`), журналы (`logs/app.log`, `logs/session.json`), вход и наблюдения цен провайдеров (`providers/<id>/`), управляемая установка компонентов (`components/` по умолчанию), журналы публикации сценария и применения предложений производства, а в Windows — данные WebView2 (`webview/`). Профиль Electron-версии, её токены и клипы автоматически не читаются: до переключения у Go-версии свои app ID и каталог. Для проверок задавайте отдельный `SONGFRAME_GO_LOCAL_DIR`.

## Встроенные ресурсы

Шаблон проекта, промпты агента, документы провайдеров медиа и шрифты карточек аниматика встраиваются в бинарник ([`resources/resources.go`](../resources/resources.go)). Происхождение, способ доступа и потребители описаны в [resources/README.md](../resources/README.md). Байты промптов, документов провайдеров и шрифтов закреплены SHA-256 в `resources/resources_test.go`: их правка меняет промпт агента или раскладку карточек и требует пересмотра эталонов. Изменение контракта хранения вносится в шаблон, код и эталоны одновременно.

## Компоненты

FFmpeg/ffprobe, ONNX Runtime CPU и модели (выделение вокала, русский CTC с vocab) в базовую поставку не входят. [`internal/components`](../internal/components/README.md) находит их в системе или в выбранной папке, проверяет функции и по кнопке на странице «Компоненты» скачивает или импортирует закреплённые офлайн-пакеты ([`manifest.json`](../internal/components/manifest.json): URL, размеры, SHA-256, лицензии, ABI). Без компонентов проект открывается и редактируется; недоступными становятся только зависящие от них операции. Медиаинструменты получают пути FFmpeg/ffprobe от менеджера компонентов, иначе ищут программы в `PATH` (`internal/mediacmd`). ONNX Runtime загружается лениво и только из найденной библиотеки.

## Агенты и провайдеры медиа

Текстовых агентов запускает менеджер [`internal/agents`](../internal/agents): реестр исполнителей сверяется с `frontend/src/shared/agent-providers.ts` тестом `TestRegistryMatchesFrontend`, выбор агента хранится в `settings.json` каталога состояния. Подробности — в [docs/agents.md](agents.md).

Провайдер медиа — сервис, генерирующий изображения и/или видео. Общий код и интерфейс узнают о нём только из реестра и таблиц адаптеров: не сравнивают имена и не пишут название сервиса в тексты.

| Часть | Где |
| --- | --- |
| Реестр для интерфейса | [`frontend/src/shared/media-providers.ts`](../frontend/src/shared/media-providers.ts): название, виды медиа, исполнитель, платность, `lipSync`, `learnsPriceFromCharges`, `generationHistory`, значения по умолчанию, подписи |
| Go-часть реестра | [`internal/mediaproviders`](../internal/mediaproviders/mediaproviders.go): только поля, нужные Go; совпадение с TS-реестром проверяет `TestRegistryMatchesFrontend` |
| Документ провайдера | `resources/providers/<вид>/<id>.md` на каждый вид медиа; раздел `## Указания агенту` слой провайдеров вкладывает в промпт задания |
| Адаптер | папка `internal/providers/<id>/`; платный провайдер дополнительно получает строку в таблице `adapters` пакета [`internal/mediaadapters`](../internal/mediaadapters/mediaadapters.go) и файл-связку там же, провайдер-исполнитель на агенте — строку в таблице `agentAdapters` пакета [`internal/providers`](../internal/providers/providers.go) |
| Контракт адаптера | [`internal/mediaapi`](../internal/mediaapi): необязательные возможности — отдельные интерфейсы с одним методом |
| Общий цикл платной попытки | [`internal/mediarequest`](../internal/mediarequest): заморозка запроса, замок, единственная отправка, получение, неизвестный исход, ручной результат |

### Добавить или удалить провайдера

1. Запись в `MEDIA_PROVIDERS` (`frontend/src/shared/media-providers.ts`) и соответствующая запись в `internal/mediaproviders`.
2. Папка адаптера `internal/providers/<id>/` и строка в таблице `internal/mediaadapters` (платный) или `agentAdapters` в `internal/providers` (исполнитель-агент). Тесты сервиса, его эталоны и живые проверки лежат только в папке адаптера.
3. Документ `resources/providers/<вид>/<id>.md` для каждого вида медиа с разделом `## Указания агенту` и его SHA-256 в `TestProviderDocs` (`resources/resources_test.go`).

Удаление — те же шаги в обратном порядке, вместе с эталонами домена запроса этого провайдера в `testdata/golden`. Общие тесты от этого не меняются: случаи эталонов, относящиеся к особенностям провайдера, пропускаются, если его адаптера нет в таблице. Сохранённые запросы и комплекты проектов хранят id провайдера как данные; повтор с удалённым провайдером останавливается с объяснением. Сводка для авторов провайдера — [`resources/providers/README.md`](../resources/providers/README.md).

Живые проверки платного провайдера выполняются только явно, переменными окружения из теста его адаптера, и только с согласия пользователя; без переменных тесты пропускаются.

### Тестовый провайдер `test`

Общая логика платной попытки, оценки цены, производства и проверок тестируется на вымышленном провайдере `test` из [`internal/mediatest`](../internal/mediatest/mediatest.go): без сети и платных запросов. Поведение задаёт `service.json` в рабочей папке теста, каждый вызов дописывается в `calls.jsonl`; в таблицу адаптеров провайдер попадает только через `Register`. В TS реестр дополняет `registerMediaProviderForTests`. Проект-образец использует `test` в `plan/project.json`.

## Python

Go-версия не запускает Python ни в работе, ни в тестах. Инструменты оригинала (`tools/<имя>/<имя>.py`) перенесены в Go-пакеты и выполняются в процессе приложения; метод `tools.run` (`internal/tools`) отдаёт тот же код завершения, stdout и stderr, что видел renderer у процесса Python. Чтобы вывод совпадал байт в байт, пакеты `pycompat`, `pyre`, `pyargparse` и `pytool` воспроизводят нужную семантику Python 3.12: JSON-вывод, различие `1`/`1.0`, регулярные выражения, сообщения argparse и исключений. Часть эталонов записана в нотации `json.dumps` Python и читается разбором `pycompat`.

Python 3 нужен только сборщику поставок и отдельным проверкам разработчика: `scripts/package-notices.py`, `scripts/package-metadata.py`, `scripts/linux_runtime_policy.py` (и его тест `scripts/test_linux_runtime_policy.py`), `scripts/check-windows-package.py`, а также `scripts/check-media-capabilities.sh`. В поставку Python не входит.

## Тестовые данные

Обзор — [testdata/README.md](../testdata/README.md). Все данные синтетические; настоящих клипов, профиля, Python и платных сервисов проверкам не нужно.

### Эталоны оригинала

[`testdata/golden/`](../testdata/golden/README.md) — входы и выходы функций и инструментов Electron-версии, снятые с оригинала на срезе `634fd94`. Каталог разделён на домены (`testdata/golden/<домен>/`), список доменов с числом случаев — [`index.json`](../testdata/golden/index.json) и таблица в README. Случай — каталог `<домен>/<случай>/` с `case.json` (описание, имя функции оригинала, доказываемые ветки), входным мини-проектом `project/` и ожидаемыми файлами; часть доменов хранит случаи одним `cases.json`. Загрузку, нормализацию абсолютных путей в `<project>` и сравнение JSON выполняет пакет [`internal/golden`](../internal/golden/golden.go); функцию домена вызывает тест соответствующего пакета. Сравнение игнорирует порядок ключей и пробелы, но различает `null`, отсутствующий ключ и `[]`.

Правила чтения:

- эталон снимается с оригинала, а не с Go-кода; не пересоздавать его из текущей реализации — расхождение означает изменение результата программы;
- осознанные отличия и исправленные ошибки оригинала записываются в README эталонов рядом с доменом;
- тесты выполняют записывающие сценарии на копии входа во временной папке (`Case.CopyProject`, `Case.BuildProject`), а не на каталоге эталона;
- скрипты съёмки хранятся вне репозитория, их рецепт описан в разделе «Пересъёмка» README эталонов;
- эталоны настоящих клипов в Git не входят и подключаются переменной `SONGFRAME_GOLDEN_REAL`; без неё такие тесты пропускаются.

### Контракты

[`testdata/contracts/`](../testdata/contracts/README.md) — синтетические JSON-fixtures границы Go и TypeScript: `api.json` читают и Go-сериализация, и настоящий TS-адаптер с подменёнными bindings; `recovery.json` проверяет распознавание незавершённых журналов без записи и отката. Адресная команда — `wails3 task check:contracts`.

### Проект-образец

`testdata/golden/checks-base/project` — «Пробный клип» на пять планов, байт в байт совпадающий с проектом-образцом Electron-версии на `634fd94`. Это общий вход многих эталонов; его правка меняет ожидаемые результаты. Устройство образца — в [testdata/README.md](../testdata/README.md#проект-образец). Маленькие медиафайлы для проверки возможностей WebView — в [`testdata/components/`](../testdata/components/README.md).

## Интерфейс

Перед изменением UI применять [songframe-go-ui](../dev-skills/songframe-go-ui/SKILL.md) и [правила UI](ui/README.md): [компоновка](ui/layout.md), [тема](ui/theme.md), [структура страниц](ui/structure.md).

- **Тексты.** Русские подписи renderer и адаптеров живут в чистых доменных словарях `frontend/src/shared/texts/` — [правила текстов](ui/texts.md). Тексты, которые Go отдаёт renderer, совпадают со словарями; пакеты агентов, провайдеров и обложки сверяют их тестами `TestTextsMatchFrontend`.
- **Storybook.** Истории `*.stories.tsx` показывают рабочие компоненты с моделями API из `frontend/src/renderer/testing/`, без Wails, профиля и клипа. Витрина обновляется в том же изменении, что и интерфейс или API — [порядок и критерий готовности](ui/storybook.md).
- **Playwright.** `frontend/tests/storybook/` проверяет статическую витрину в Chromium в окне 1320×860, в светлой и тёмной темах (`frontend/playwright.config.ts`). Playwright поднимает собственный сервер статической витрины и не переиспользует чужой.

## Команды

Из корня репозитория (`Taskfile.yml`; отдельная установка Task не нужна):

| Команда | Что делает |
| --- | --- |
| `wails3 task deps` | Установить frontend-зависимости по lock (`yarn install --immutable`) |
| `wails3 task bindings` | Перегенерировать `frontend/bindings` |
| `wails3 task build` | Bindings, frontend и бинарник `build/bin/songframe` |
| `wails3 task run` | Запустить собранный бинарник |
| `wails3 task check` | `check:go` и `check:frontend` |
| `wails3 task check:go` | Bindings, `go test ./...`, `go vet ./...` |
| `wails3 task check:frontend` | `yarn typecheck` и все Vitest-тесты |
| `wails3 task check:contracts` | Go-тесты `-run Contract` и `src/platform/contracts.test.ts` |
| `wails3 task check:components` | Тесты закреплённого manifest компонентов без загрузки и ML |
| `wails3 task check:race` | `go test -race ./internal/...` |
| `wails3 task check:format` | `gofmt` и Prettier без изменения файлов |
| `wails3 task storybook` | Собрать статическую витрину `frontend/storybook-static` |
| `wails3 task check:storybook` | Браузерные сценарии витрины |
| `wails3 task check:ui` | `storybook`, затем `check:storybook` |
| `wails3 task check:all` | Последовательно `check`, `check:race`, `check:format`, `check:ui` |

Из `frontend/` (`frontend/package.json`): `yarn typecheck`, `yarn test [файл]`, `yarn build-storybook`, `yarn test:storybook [--grep группа]`, `yarn storybook` (dev-сервер на порту 6106, в приёмку не входит), `yarn format` (переформатирование — только отдельным поручением).

### Как проверять

- Во время работы гонять тесты изменённой области: `go test ./internal/<пакет> -run Имя`, `yarn test src/platform/<файл>.test.ts`, `yarn test:storybook --grep "<группа>"` после `yarn build-storybook`. После сбоя исправить и перезапустить только упавшее.
- Перед коммитом — один полный `wails3 task check:all`. Чтобы не мешать остальной работе машины, запускать его с пониженным приоритетом:

  ```sh
  nice -n 19 ionice -c3 wails3 task check:all
  ```

- `go test ./...` в корне компилирует и `main.go`, которому нужен `frontend/dist`: в чистом checkout сначала `wails3 task bindings` или `build`. Пакеты `./internal/...` этого не требуют.
- На ограниченном окружении кэш Go можно задать явно, например `GOCACHE=/tmp/songframe-go-build-cache`; профиль приложения от этого не меняется.
- Тесты, которым нужны FFmpeg/ffprobe, ONNX Runtime или модели, без них пропускаются; необязательные inference-сверки включаются переменными окружения, описанными в самих тестах.

## Нативные проверки окна

Собранный бинарник поддерживает флаги проверки (`main.go`). Обычный запуск отчётов не пишет и сам не закрывается.

```sh
# Запуск интерфейса: успешный вызов State из frontend и монтирование страницы.
SONGFRAME_GO_LOCAL_DIR=/tmp/songframe-smoke-profile \
  ./build/bin/songframe --smoke \
  --smoke-report /tmp/songframe-smoke.json --smoke-timeout 30s

# Медиа WebView, HTTP-сервер и второе окно на синтетических файлах (FFmpeg нужен только для подготовки).
sh scripts/make-media-fixtures.sh /tmp/songframe-media-fixtures
SONGFRAME_GO_LOCAL_DIR=/tmp/songframe-native-profile ./build/bin/songframe \
  --native-check-dir /tmp/songframe-media-fixtures \
  --native-check-report /tmp/songframe-native-report.json --smoke-timeout 90s
```

`--native-check-project "<копия проекта>"` добавляет проверку чтения проекта; копия должна содержать трек и непустую разметку. Таймаут, преждевременное закрытие окна или невозможность записать отчёт означают ошибку. Автоматический успех не подтверждает физический звук, нажатие системного уведомления и платформы, на которых проверка не запускалась. Флаги `--component-smoke-input`/`--component-smoke-report` проверяют установку компонентов и короткий CPU inference без GUI — порядок в [packaging](../packaging/README.md).

## Поставки

Целевые поставки — Linux x86_64 AppImage и deb-пакет, Windows amd64 установщик NSIS. Все поставки собираются локально на Linux (`wails3 task package:linux`, `package:deb`, `package:windows`), CI их не собирает. Состав, prerequisites, проверки на хосте и в чистой системе — [packaging/README.md](../packaging/README.md) и [рецепт Windows](../packaging/windows/README.md); порядок сборки — скилл [songframe-go-build](../dev-skills/songframe-go-build/SKILL.md), выпуск — [songframe-go-release](../dev-skills/songframe-go-release/SKILL.md). Сборка установщика не доказывает работу в Windows: нативный прогон выполняется отдельно. Обновление из приложения (`internal/updates`, страница «Настройки») берёт выпуски публичного songframe; публикация выпусков описана в скилле выпуска.

## Скиллы разработки

Скиллы для агентов-разработчиков лежат в [`dev-skills/`](../dev-skills/README.md) и подключены относительными ссылками из `.agents/skills/` и `.claude/skills/`; в поставку они не входят.
