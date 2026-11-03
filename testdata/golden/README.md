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

### `timing-validation/cases.json`

Массив `{name, description, tags?, input: {timing, lyrics, duration}, expected: string[]}`. `lyrics` — результат `analyzeLyrics(text).rows` для текста `[Куплет] / Первая строка / Вторая строка / пусто / [Припев] / Огни над водой`. Тег `null-number` помечает `start: null`: в TS `Number.isFinite(null)` ложно и даёт «границы не числа», в Go такое значение нужно отличать от нуля при разборе.

TS-тест будет читать тот же файл без копии: из `frontend/` — `readFileSync(new URL('../../testdata/golden/timing-validation/cases.json', import.meta.url))` (или `import cases from '…/cases.json'` с `resolveJsonModule`), затем для каждого случая `expect(validateTiming(input.timing, input.lyrics, input.duration)).toEqual(expected)`. Тот же способ подходит для `timing-view/*/expected.json`, если TS-сторона будет сверять разбор текста (`analyzeLyrics`) по полю `lyrics`.

## Нормализация

- Корень входного проекта в строках заменён на `<project>` (пакет Go: `golden.NormalizePaths`, хвост пути приводится к `/`). Маркер отличается от `<PROJECT>` в `testdata/contracts`, потому что это отдельные fixtures оригинала.
- Каталог входа всегда называется `project`: для не-проекта оригинал выводит `name = basename(path)`, поэтому копия для записи создаётся под тем же именем.
- Дат и времени в снятых выходах нет. `viewAnimatic().built.builtAt` (mtime манифеста) в `computeStatus` не попадает; `saveTiming` время не пишет. Права файлов не фиксируются (см. наблюдения).
- Сравнение JSON (`golden.Diff`) игнорирует порядок ключей и пробелы, числа сравнивает по значению (`8` = `8.0`), а `null`, отсутствующий ключ и `[]` различает.

## Входные проекты

- Случаи без префикса — копия `tools/testdata/sample-project` из `git archive 634fd94` (игнорируемый локальный `sample-animatic.mp4` в Git не входит, поэтому аниматик образца собран, но не свежий) с точечной порчей файлов.
- `mini-*` — синтетический мини-проект «Мини-клип», построенный скриптом съёмки: три плана, M03 производный от M01 (`derived_from`), все комплекты приняты по отпечаткам, вычисленным самим оригиналом, аниматик из видеопланов с согласованными хешами заглушек, принят. Это единственный способ получить `state=complete` и свежий аниматик без настоящего медиа.

## Покрытие

`computeStatus`: все состояния (`invalid` для несуществующего пути, папки без маркера, пустого имени и битого маркера; `empty`, `sourced`, `timed`, `scripted`, `in_production`, `complete`); все проблемы статуса (`damagedSources`, `incompleteSources`, `timingLinesMissing`, `damagedCast`, `damagedTreatment`, `damagedScenes`, `staleShots`, `derivedShotsNeedReview`, `orphanKits`, `sceneComparisonFailed`, `animaticNotBuilt`, `staleAnimatic`, `animaticNotApproved`); все причины `shotAcceptance` (`scene_changed`, `source_changed`, `source_unavailable`, `source_receipt_missing`, `derived_link_changed`) через `generation` и через `source_review`; свежесть аниматика по хешу входа, `project_inputs`, SHA байтов `scenes.json`, отсутствию MP4 и битому манифесту; исключение на не-объекте в `scenes`.

`viewTiming`: отсутствие текста и не-проект; проблемы разбора текста (Markdown, ошибочный заголовок, части без скобок, нет строк, CRLF/CR); отсутствующий, битый и структурно неверный `timing.json` (`lines`, `candidates`, `line_order`, `sections` с неверным `origin` и строковой границей); `trackChanged`, `lyricsChanged`; нет трека и манифеста, манифест чужой версии.

`saveTiming`: пересохранение образца; сортировка и перенумерация, округление до миллисекунд, `trim` и служебная фраза заметки, частичное и полное подтверждение в `status`, `sha256` и длительности из манифеста или входа, отбор кандидатов, `line_order`, ручная, смешанная и полностью автоматическая музыкальная карта (`Вступление`, `Проигрыш после «…»`, `Финал без вокала`, `Не размечено`), создание нового файла, отказ с неизменным файлом.

`validateTiming`: каждое сообщение, допуски (0.3 с с погрешностью вычитания, 0.5 с за треком, 1 мс пересечения), длительность `null`/`0`, порядок нескольких сообщений.

Не покрыто здесь:

- свежесть аниматика с карточками и ключевыми кадрами (`media: card|keyframes`, квитанция `plan/animatic/cards/manifest.json`, выбор кадров из `plan/awaiting` и `plan/batches`) при существующем MP4 — в образце MP4 нет, поэтому эти ветки не влияют на снятый статус; их нужно снимать в домене `viewAnimatic`;
- производный план от производного источника, `source_review` при несвежем источнике;
- `computeStatus` на пути-файле и при ошибках чтения каталогов (права), `realpath` за пределы комплекта;
- `viewTiming`/`saveTiming` с нестрочным `note`, NaN/Infinity (не представимы в JSON) и гонки записи.

## Пересъёмка

Скрипт хранится вне репозиториев (последняя копия — `test-projects/golden/capture/` рабочей области, рядом с эталонами настоящих клипов; пути ниже отсчитываются от корня songframe-go). Рецепт:

1. Проверить, что `git -C ../songframe status --short` пуст.
2. Распаковать образец из Git: `git -C ../songframe archive 634fd94 tools/testdata/sample-project | tar -x -C <work>`.
3. Собрать скрипт esbuild из `../songframe/node_modules` в CommonJS с алиасами `@sf=../songframe/src` и `@shared=../songframe/src/shared`: `esbuild capture.ts --bundle --platform=node --format=cjs --alias:@sf=… --alias:@shared=…`. Модули этих функций не импортируют `electron` и не требуют заглушек. Выход сборки — во временной папке, не в `songframe/`.
4. Скрипт подменяет функции объекта `require('node:fs')` (обёртки esbuild читают его свойства при каждом вызове), строит случаи во временной папке, вызывает функции оригинала, проверяет отсутствие записей и неизменность дерева у читающих функций, минимизирует вход и повторно сверяет результат.
5. `capture.sh <корень рабочей области> [--real] [--install]` выполняет шаги 1–4; `--install` раскладывает результат сюда (`rsync --delete`, кроме этого README) и в `../test-projects/golden/`.
6. После пересъёмки: `git diff --stat testdata/golden`, `go test ./internal/golden/...`, повторная проверка `git -C ../songframe status --short`. Съёмка детерминирована: два прогона подряд дают одинаковые файлы.

## Настоящие клипы

Эталоны `ogorod` и готового клипа пользователя в Git не входят: они лежат в `../test-projects/golden/<имя>/` (`manifest.json` с относительным путём клипа, HEAD и дайджестом дерева, `expected-status.json`, `expected-open.json`, `expected-timing-view.json`, `expected-timing-save.json`, `expected-timing-save-file.json`, `reads.json`). Go-тесты подключают их переменной `SONGFRAME_GOLDEN_REAL=../test-projects/golden` (относительно корня модуля) через `golden.RealProjects`; без переменной тесты пропускаются. Готовый клип открывается только на чтение, сохранение разметки — только на копии нужных файлов.
