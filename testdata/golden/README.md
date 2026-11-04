# Эталоны поведения оригинала

Входы и выходы функций главного процесса замороженного Electron-оригинала `../songframe/` на commit `634fd94` (HEAD `434ff3d` отличается только документацией). Go- и TS-тесты сверяют перенос с этими файлами; загрузку, нормализацию путей и сравнение JSON для Go выполняет пакет [`internal/golden`](../../internal/golden/golden.go).

Эталон снимается с оригинала, а не с Go-кода. Не пересоздавать его из текущей реализации: расхождение с эталоном означает изменение результата программы.

## Домены

| Каталог | Функция оригинала | Случаев |
| --- | --- | --- |
| `status/` | `computeStatus(path)` из `src/main/status.ts`, плюс `Projects.open(path)` и `shotAcceptance(project, scenes)` | 38 |
| `timing-view/` | `viewTiming(project)` из `src/main/timing.ts` | 18 |
| `timing-save/` | `saveTiming(project, timing)` из `src/main/timing.ts` | 7 |
| `timing-validation/cases.json` | `validateTiming(timing, lyrics, duration)` из `src/shared/timing-validation.ts` | 33 |
| `project-create/` | `Projects.create(input)` из `src/main/projects.ts` (копирование шаблона, `git init`, открытие) | 5 |
| `project-validate-new/cases.json` | `validateNewProject(input)` из `src/main/projects.ts` | 16 |
| `project-rename/` | `Projects.rename(path, name)` с историей проектов | 8 |
| `project-settings/` | `readProjectSettings(project)` и `writeProjectSettings(project, settings)` из `src/main/project-settings.ts` | 21 |
| `sources-view/` | `viewSources(project)` из `src/main/sources.ts` | 6 |
| `sources-validate/` | `validateSources(project, input)` | 7 |
| `sources-save/` | `saveSourcesWithCastImages(project, input)` без `plan/cast.json` | 6 |
| `sources-save-cast/` | `saveSourcesWithCastImages(project, input, toolsRoot)` при существующем `plan/cast.json` | 12 |
| `cast-view/` | `viewCast(project)` из `src/main/cast.ts` | 11 |
| `cast-write/` | `initCast(project)` и `writeCast(project, cast)` из `src/main/cast.ts` | 16 |
| `scenario-view/` | `viewScenario(project)` (с `validateScenes` в `problems`) из `src/main/scenario.ts` и `readScenarioRegistry(project).status` | 14 |
| `scenario-treatment/` | `saveTreatment(project, treatment)` из `src/main/scenario.ts` | 7 |
| `scenario-scenes/` | `scenesSaveImpact`, `validateScenes` и `saveScenesWithMode(project, scenes, mode)` из `src/main/scenario-save.ts` | 19 |
| `scenario-brief/` | `buildBrief(scenes, cast, shot, phase)` из `src/main/scenario.ts` | 6 |
| `timing-draft/cases.json` | `build_timing(text, recognition, duration, previous)` из `tools/align_lyrics/align_lyrics.py` (CTC-распознавание) | 9 |

`index.json` перечисляет все случаи с описанием и покрытыми ветками.

### Случай `<домен>/<случай>/`

- `case.json` — `description`, `call` (имя функции оригинала), `project` (`"project"` или `null`, если оригинал вызывался на несуществующем пути), `covers` (доказываемые ветки), `stubbedMedia` (медиа, заменённые заглушками).
- `project/` — входной мини-проект. Сюда скопированы только файлы и каталоги, к которым функция обращалась при съёмке (трассировка `fs`); каталоги, которые в Git были бы пустыми, сохранены файлом `.gitkeep`. Медиа крупнее 256 байт заменены текстом `stub <путь>`; съёмка повторно запускает оригинал на минимальном входе и принимает его только при побайтно совпавшем результате. Если функция Go читает файл, которого нет во входе, она зависит от того, от чего оригинал не зависел.
- `status/*/expected.json` — `ProjectStatus`. Исключение оригинала записано как `{"throws": "<сообщение>"}`: Go должен вернуть ошибку, текст сообщения Node не сравнивается.
- `status/*/expected-open.json` — `{"error": <сообщение|null>, "sameAsStatus": <bool|null>}`. `Projects.open` = проверка маркера (`readProjectMarker`), запись истории/текущего проекта и `computeStatus`; состояние приложения при съёмке подменено заглушкой, поэтому фиксируются только ошибка и совпадение со статусом.
- `status/*/expected-acceptance.json` — внутренний итог `shotAcceptance`, если `plan/scenes.json` разбирается и содержит планы: `fingerprints` (или `null`), `accepted` (`completed`/`stale`), `reasons`, `problem`. Статус сворачивает причины в два сообщения, а Go-переносу нужны сами причины. Отпечатки образца совпадают с `../songframe/tools/testdata/scene-fingerprints.json`.
- `timing-view/*/expected.json` — `TimingView`.
- `timing-save/*/timing-input.json` — второй аргумент `saveTiming`, уже прошедший через JSON (поля `undefined` отсутствуют). Вызов выполнять на копии `Case.CopyProject`, а не на каталоге эталона.
- `timing-save/*/expected.json` — `{"error", "result", "resave"}` либо `{"error", "result": null, "fileUnchanged"}`. `resave` — повторное сохранение `result`: `sameResult` и `sameBytes` (стабильность).
- `timing-save/*/expected-timing.json` — точные байты записанного `plan/audio/timing.json` (сравнивать побайтно: порядок ключей, отступ 2 пробела, `\n` в конце).

### Домены проекта и исходников

- `project-create/*/` — `input.json` (`CreateProjectInput`, путь через маркер `<base>` — временная родительская папка), `setup.json` (`dirs`: каталоги внутри `<base>`, созданные до вызова), `expected.json` (`error`, `status` открытого проекта, `state` — текущий проект и история), `expected-tree.json` (`exists`, `git` — появилась ли `.git`, `dirs` и SHA-256 каждого файла без `.git`). Съёмка выполнялась с git; без git Go проверяет то же дерево без `.git`.
- `project-validate-new/cases.json` — массив `{name, description, setup, input, expected: string[]}` с тем же маркером `<base>`.
- `project-rename/*/` — `input.json` (`{name}`; случай `not-in-history` вызывается для проекта вне истории), `expected.json` (`error`, `status`, `history` после вызова, `fileUnchanged` при ошибке), `expected-project.json` — точные байты `plan/project.json` после успешного переименования. Чужая запись истории `/elsewhere/…` — синтетическая и на диске не существует.
- `project-settings/*/` — `read-*` вызывают `readProjectSettings`, `save-*` — `writeProjectSettings` с `input.json`. `expected.json` — `{error, errorPrefix?, result, fileUnchanged?}`, `expected-project.json` — точные байты файла после записи. `input.json` содержит `unset`: пути полей, которые при съёмке имели значение `undefined` и через IPC удаляли поле (JSON их не передаёт; Go-сторона получает тот же список от адаптера `frontend/src/platform/api.ts`).
- `sources-view/*/expected.json` — `SourcesView`; `sources-validate/*/` — `input.json` и `expected.json` (массив проблем). Пути входных файлов — `<inputs>/…`.
- `sources-save/*/` — `inputs/` (файлы, которые пользователь выбирает вне проекта; в `input.json` — `<inputs>/имя`), `expected.json` (`{error, result, treeUnchanged?}`), `expected-manifest.json` (точные байты `source/manifest.json`), `expected-source.json` (`dirs` и SHA-256 файлов в `source/`). Время `updated_at` заменено маркером `<updated_at>`; Go проверяет формат `YYYY-MM-DDTHH:MM:SS.sssZ`. Съёмка шла с несуществующим ffprobe: у нового трека `duration_seconds: null`, у сохранённого — прежнее значение. Ветку с ffprobe Go проверяет отдельным тестом на `../components/fixtures/tiny.mp3`.
- `sources-save-cast/*/` — тот же формат, что `sources-save`, плюс `expected.json.castUnchanged` (байты `plan/cast.json` после вызова равны входным) и `expected-cast.json` — точные байты `plan/cast.json` после вызова (нет, если файла нет). `toolsRoot` при съёмке — корень `songframe`, словарь свойств совпадает со встроенным `internal/cast/default_properties.json`. При отказе и откате (`rollback`, `invalid-input`) `treeUnchanged` охватывает весь проект, включая `plan/cast.json`.
- `errorPrefix` вместо `error`: сообщение Node содержит текст системной ошибки или разбора JSON, который у Go отличается; сравнивается только префикс, сформированный самим SongFrame.

### Домены кастинга и сценария

- `cast-view/*/expected.json` — `CastView`; `scenario-view/*/expected.json` — `ScenarioView`, `expected-status.json` — `ScenarioStatus` строкой JSON. Исключение — `{"throws"}`, как у статуса.
- Записывающие домены (`cast-write`, `scenario-treatment`, `scenario-scenes`): вход — `cast-input.json`, `treatment-input.json` или `scenes-input.json` (у `cast-write` с `call: "init"` входа нет); `expected.json` — `{"error", "result", "files": {путь: created|changed|removed}, "resave"?}`, где `resave` — повторный вызов на `result` (`error`, `sameResult`, `files`); `files/<путь>` — точные байты каждого созданного или изменённого файла. Вызов — на копии `Case.CopyProject`.
- `scenario-treatment/*/expected.json` может содержать `originalError` — отказ `saveTreatment` оригинала, снятый при съёмке. Отличие от 634fd94 (сознательное, по просьбе пользователя): Go сохраняет трактовку черновиком, если структура верна, а содержательные проблемы `validateTreatment` (коды, повтор, название, стык, конец раньше начала, длительность, нет частей) отдаёт отдельный `scenario.validateTreatment`. У случаев `validation-problems` и `no-parts` поэтому `error: null`, а `result`, `files` и `resave` описывают запись нормализованного черновика (байты `files/plan/treatment.json` получены той же нормализацией оригинала: сортировка, trim, округление, `JSON.stringify(…, null, 2)` + `\n`); проблемы `validateTreatment` через пробел обязаны совпасть с `originalError`, а строгая `NormalizeTreatment` (ответ агента) — по-прежнему отказывать этим текстом. Отказы неверной структуры (`invalid-document`, `invalid-part`) сохранены как сняты. Пересъёмка (`capture-scenario.sh --install`) вернёт эти два случая к отказу оригинала: после неё их нужно снова привести к этому формату.
- `scenario-scenes/*/case.json` дополнительно содержит `mode` (`production`, `keep` или неверный); `expected-impact.json` — `ScenarioSaveImpact` черновика до записи, `expected-validate.json` — проблемы `validateScenes` с кастингом проекта.
- `scenario-brief/*/case.json` может содержать `briefs` — пары `[план, фаза]`; без него — все планы реестра в обеих фазах. Черновик — `scenes-input.json` или `project/plan/scenes.json`. `expected.json` — массив `{shot, phase, result|error}`.

### `timing-draft/cases.json`

Массив `{name, description, input, expected}`. `input` — исходный текст, длительности контейнера и декодированного вокала, SHA трека, принятые CTC-сегменты и кандидаты (`source_line`, границы, причина, `acoustic_score`) и прежний `timing.json` строкой (`null` — нет файла); `expected` — `{error, timing}`, где `timing` — точные байты записи Python (`json.dumps(indent=2, ensure_ascii=False)` + `\n`), а `error` — текст `ValueError`. Строка сохраняет различие `7` и `7.0` и ключи `true`/`2.0` как ключи dict Python. Эталон снят вызовом `build_timing` оригинала разовым скриптом вне репозитория.

### `timing-validation/cases.json`

Массив `{name, description, tags?, input: {timing, lyrics, duration}, expected: string[]}`. `lyrics` — результат `analyzeLyrics(text).rows` для текста `[Куплет] / Первая строка / Вторая строка / пусто / [Припев] / Огни над водой`. Тег `null-number` помечает `start: null`: в TS `Number.isFinite(null)` ложно и даёт «границы не числа», в Go такое значение нужно отличать от нуля при разборе.

TS-тест будет читать тот же файл без копии: из `frontend/` — `readFileSync(new URL('../../testdata/golden/timing-validation/cases.json', import.meta.url))` (или `import cases from '…/cases.json'` с `resolveJsonModule`), затем для каждого случая `expect(validateTiming(input.timing, input.lyrics, input.duration)).toEqual(expected)`. Тот же способ подходит для `timing-view/*/expected.json`, если TS-сторона будет сверять разбор текста (`analyzeLyrics`) по полю `lyrics`.

## Нормализация

- Корень входного проекта в строках заменён на `<project>` (пакет Go: `golden.NormalizePaths`, хвост пути приводится к `/`). Маркер отличается от `<PROJECT>` в `testdata/contracts`, потому что это отдельные fixtures оригинала.
- Каталог входа всегда называется `project`: для не-проекта оригинал выводит `name = basename(path)`, поэтому копия для записи создаётся под тем же именем.
- Дат и времени в снятых выходах нет, кроме `updated_at` описаний в `source/manifest.json` у `cast-write`: съёмка замораживает `Date` на `2026-11-04T12:00:00.000Z`, Go-тест подставляет то же время. `viewAnimatic().built.builtAt` (mtime манифеста) в `computeStatus` не попадает; `saveTiming` время не пишет. Права файлов не фиксируются (см. наблюдения).
- Сравнение JSON (`golden.Diff`) игнорирует порядок ключей и пробелы, числа сравнивает по значению (`8` = `8.0`), а `null`, отсутствующий ключ и `[]` различает.

## Входные проекты

- Случаи без префикса — копия `tools/testdata/sample-project` из `git archive 634fd94` (игнорируемый локальный `sample-animatic.mp4` в Git не входит, поэтому аниматик образца собран, но не свежий) с точечной порчей файлов.
- `mini-*` доменов сценария — отдельный мини-проект `capture-scenario.ts`: три плана (M02 наследует состояние M01, M03 — `state_from` фазы same и `derived_from` M01), принятые M01/M02, пакет `plan/batches/M02-attempt-01` с нестандартным форматированием `workflow.json` (проверка точечной замены отпечатка) и пакет `plan/awaiting/M03-attempt-01`, кастинг из мира, героини и лодки.
- `mini-*` — синтетический мини-проект «Мини-клип», построенный скриптом съёмки: три плана, M03 производный от M01 (`derived_from`), все комплекты приняты по отпечаткам, вычисленным самим оригиналом, аниматик из видеопланов с согласованными хешами заглушек, принят. Это единственный способ получить `state=complete` и свежий аниматик без настоящего медиа.

## Покрытие

`computeStatus`: все состояния (`invalid` для несуществующего пути, папки без маркера, пустого имени и битого маркера; `empty`, `sourced`, `timed`, `scripted`, `in_production`, `complete`); все проблемы статуса (`damagedSources`, `incompleteSources`, `timingLinesMissing`, `damagedCast`, `damagedTreatment`, `damagedScenes`, `staleShots`, `derivedShotsNeedReview`, `orphanKits`, `sceneComparisonFailed`, `animaticNotBuilt`, `staleAnimatic`, `animaticNotApproved`); все причины `shotAcceptance` (`scene_changed`, `source_changed`, `source_unavailable`, `source_receipt_missing`, `derived_link_changed`) через `generation` и через `source_review`; свежесть аниматика по хешу входа, `project_inputs`, SHA байтов `scenes.json`, отсутствию MP4 и битому манифесту; исключение на не-объекте в `scenes`.

`viewTiming`: отсутствие текста и не-проект; проблемы разбора текста (Markdown, ошибочный заголовок, части без скобок, нет строк, CRLF/CR); отсутствующий, битый и структурно неверный `timing.json` (`lines`, `candidates`, `line_order`, `sections` с неверным `origin` и строковой границей); `trackChanged`, `lyricsChanged`; нет трека и манифеста, манифест чужой версии.

`saveTiming`: пересохранение образца; сортировка и перенумерация, округление до миллисекунд, `trim` и служебная фраза заметки, частичное и полное подтверждение в `status`, `sha256` и длительности из манифеста или входа, отбор кандидатов, `line_order`, ручная, смешанная и полностью автоматическая музыкальная карта (`Вступление`, `Проигрыш после «…»`, `Финал без вокала`, `Не размечено`), создание нового файла, отказ с неизменным файлом.

`validateTiming`: каждое сообщение, допуски (0.3 с с погрешностью вычитания, 0.5 с за треком, 1 мс пересечения), длительность `null`/`0`, порядок нескольких сообщений.

Сохранение исходников с кастингом: новые виды в `images` сущности (по вводу `sourcePath`, а не только по пути — новый вид с именем удалённого невыбранного), прежний невыбранный вид не добавляется, проекция описания в `appearance`, референс без сущности, кастинг без описи, нормализация компактного кастинга, `null` в `plan/cast.json`; отказы `castInvalid` (раньше проверки формы), `normalizeCast`, `imageInUse`, проверки формы; откат `source/` и `plan/cast.json` после отказа `writeCast` (изменённый текст, новая обложка, новый тип и виды). Неудачный откат (`restoreFailed`) снять с оригинала нельзя: Go проверяет его отдельным тестом `internal/referenceimage`.

Кастинг и сценарий: просмотр кастинга с описаниями из описи и расхождениями; создание из референсов и дополнение, отказ без описи и без изображения, перенос описаний в `source/manifest.json`; все проблемы `validateScenes` и `viewScenario` (повреждённые документы, continuity, `derived_from`, `source_review`); нормализация и отказы трактовки; оценка сохранения со всеми причинами (новый план, постановка, границы, унаследованное и начальное состояние, общие правила, производный план) и состояниями производства (`completed`, `stale`, `progress`, `unknown`, `planned`); косметическая правка без затронутых планов; режим keep с файлом принятия и без него, с повреждённым файлом, ранее устаревшим планом и точечной заменой отпечатка в пакетах; неверный режим; врезка непрерывности по фазам и ошибки неизвестного плана.

Не покрыто здесь:

- свежесть аниматика с карточками и ключевыми кадрами (`media: card|keyframes`, квитанция `plan/animatic/cards/manifest.json`, выбор кадров из `plan/awaiting` и `plan/batches`) при существующем MP4 — в образце MP4 нет, поэтому эти ветки не влияют на снятый статус; их нужно снимать в домене `viewAnimatic`;
- производный план от производного источника, `source_review` при несвежем источнике;
- `computeStatus` на пути-файле и при ошибках чтения каталогов (права), `realpath` за пределы комплекта;
- исключения JS оригинала на повреждённых пакетах в `scenesSaveImpact` (полный `viewProduction` — этап 45): Go-срез `internal/production` повторяет состояние планов и проблемы пакетов, но не все TypeError нестандартных `workflow.json`;
- `viewTiming`/`saveTiming` с нестрочным `note`, NaN/Infinity (не представимы в JSON) и гонки записи.

## Пересъёмка

Скрипт хранится вне репозиториев (последняя копия — `test-projects/golden/capture/` рабочей области, рядом с эталонами настоящих клипов; пути ниже отсчитываются от корня songframe-go). Рецепт:

1. Проверить, что `git -C ../songframe status --short` пуст.
2. Распаковать образец из Git: `git -C ../songframe archive 634fd94 tools/testdata/sample-project | tar -x -C <work>`.
3. Собрать скрипт esbuild из `../songframe/node_modules` в CommonJS с алиасами `@sf=../songframe/src` и `@shared=../songframe/src/shared`: `esbuild capture.ts --bundle --platform=node --format=cjs --alias:@sf=… --alias:@shared=…`. Модули этих функций не импортируют `electron` и не требуют заглушек. Выход сборки — во временной папке, не в `songframe/`.
4. Скрипт подменяет функции объекта `require('node:fs')` (обёртки esbuild читают его свойства при каждом вызове), строит случаи во временной папке, вызывает функции оригинала, проверяет отсутствие записей и неизменность дерева у читающих функций, минимизирует вход и повторно сверяет результат.
5. `capture.sh <корень рабочей области> [--real] [--install]` выполняет шаги 1–4; `--install` раскладывает результат сюда (`rsync --delete`, кроме этого README) и в `../test-projects/golden/`.
6. Домены проекта и исходников (включая `sources-save-cast`) снимает отдельный `capture-projects.sh <корень рабочей области> [--install]` (шаблон берётся из `git archive 634fd94 templates/project`, `toolsRoot` кастинга — рабочее дерево `songframe`, проверенное чистым). `--install` синхронизирует только свои каталоги и заменяет только свои записи `index.json`; `GOLDEN_TARGET` указывает другой checkout. `capture.sh --install` выполняет `rsync --delete` по всему каталогу и удалит чужие домены, поэтому после него повторить `--install` отдельных скриптов съёмки.
7. Домены кастинга и сценария снимает отдельный `capture-scenario.ts` (тот же каталог): `capture-scenario.sh <корень рабочей области> [--install <папка songframe-go>]`. `--install` заменяет только свои шесть доменов и их строки в `index.json`; `capture.sh --install` удаляет чужие каталоги (`rsync --delete`), поэтому после него `capture-scenario.sh --install` запускается повторно.
8. После пересъёмки: `git diff --stat testdata/golden`, `go test ./internal/golden/...`, повторная проверка `git -C ../songframe status --short`. Съёмка детерминирована: два прогона подряд дают одинаковые файлы.

## Настоящие клипы

Эталоны `ogorod` и готового клипа пользователя в Git не входят: они лежат в `../test-projects/golden/<имя>/` (`manifest.json` с относительным путём клипа, HEAD и дайджестом дерева, `expected-status.json`, `expected-open.json`, `expected-timing-view.json`, `expected-timing-save.json`, `expected-timing-save-file.json`, `reads.json`). Go-тесты подключают их переменной `SONGFRAME_GOLDEN_REAL=../test-projects/golden` (относительно корня модуля) через `golden.RealProjects`; без переменной тесты пропускаются. Готовый клип открывается только на чтение, сохранение разметки — только на копии нужных файлов.
