# Эталоны поведения

Зафиксированные входы и ожидаемые выходы SongFrame по доменам. Go-тесты пакетов вызывают функцию домена на входе случая и сверяют результат с эталоном; загрузку случаев, сборку входа, нормализацию путей и сравнение JSON выполняет пакет [`internal/golden`](../../internal/golden/golden.go). Все данные синтетические и лежат в Git: тестам не нужны файлы вне репозитория, сеть, настоящие агенты и платные сервисы.

## Изменение эталона

Эталон — ожидаемый результат программы, а не снимок текущей реализации. Не пересоздавать его из кода: расхождение теста с эталоном означает изменение результата. Эталон меняется только по решению пользователя, вместе с кодом в том же изменении; причина записывается в сообщении коммита. Этот README меняется вместе с форматом файлов, правилами сравнения и покрытием.

## Домены

`index.json` перечисляет все случаи с описанием и покрытыми ветками (`domain`, `name`, `description`, `covers`); тесты его не читают.

| Каталог | Что проверяет (Go) | Случаев |
| --- | --- | --- |
| `status/` | `status.Compute` (статус проекта), открытие `app.ProjectService.Open`, принятие планов `acceptance.Compute` | 38 |
| `timing-view/` | `timing.ViewProject` | 18 |
| `timing-save/` | `timing.SaveProject`, `timing.Prepare`, сохранение через `app` | 7 |
| `timing-validation/cases.json` | `timing.Validate` | 33 |
| `timing-draft/cases.json` | `timing.BuildDraft`: черновик разметки по CTC-распознаванию | 11 |
| `project-create/` | `app.ProjectService.Create` (копирование шаблона, `git init` с Git LFS, открытие) | 5 |
| `project-validate-new/cases.json` | `newproject.Validate` | 16 |
| `project-rename/` | переименование проекта в `app.ProjectService` с историей проектов | 8 |
| `project-settings/` | чтение и запись настроек `internal/projectfile` | 21 |
| `sources-view/` | `sourceedit.ViewProject` | 6 |
| `sources-validate/` | `sourceedit.Validate` | 7 |
| `sources-save/` | `sourceedit.Save` и `referenceimage.SaveSources` без `plan/cast.json` | 6 |
| `sources-save-cast/` | `referenceimage.SaveSources` при существующем `plan/cast.json` | 12 |
| `cast-view/` | `cast.ViewProject` | 11 |
| `cast-write/` | `cast.Init`, `cast.Save` | 17 |
| `scenario-view/` | `scenario.ViewProject` (с проблемами сцен), `scenario.RegistryStatus` | 14 |
| `scenario-treatment/` | `scenario.SaveTreatment`, `scenario.ValidateProjectTreatment`, `scenario.NormalizeTreatment` | 7 |
| `scenario-scenes/` | `scenesave.SaveImpact`, `scenario.ValidateProjectScenes`, `scenesave.SaveScenesWithMode` | 19 |
| `scenario-brief/` | `scenario.BuildBrief` | 6 |
| `tool-json/cases.json` | модель значений `internal/toolrt`: разбор, запись, `repr`, UTF-8, `float` | 78 |
| `tool-regex/cases.json` | регулярные выражения `internal/toolregex` на шаблонах проверок и схем | 754 |
| `scene-registry/cases.json` | чистые функции `internal/sceneregistry`: схема, отпечатки, состояния, настройки генерации, принятие | 134 |
| `scene-registry/` | функции `internal/sceneregistry`, читающие проект, и запись принятых отпечатков | 21 |
| `scene-scaffold/` | инструмент `scene_scaffold` через `tools.Run` (код, stdout, stderr, байты `plan/scenes.json`) | 56 |
| `checks-base/project/` | общий вход проверок проекта — проект-образец (не домен, случаев нет) | — |
| `lint-registry/` | инструмент `lint_registry` (`internal/lintregistry`) | 50 |
| `check-assets/` | инструмент `check_assets` (`internal/checkassets`) | 33 |
| `check-workspace/` | инструмент `check_workspace` (`internal/checkworkspace`) | 33 |
| `shot-status/` | инструмент `shot_status` | 41 |
| `continuity-brief/` | инструмент `continuity_brief` | 41 |
| `scene-views/` | инструмент `update_scene_views` | 53 |
| `animatic-cards/` | `internal/animaticcards`: раскладка карточек и опор, ширины строк DejaVu Sans | 43 + 1416 |
| `agents-protocol/cases.json` | чистые функции `internal/agents`: аргументы, stdin, разбор потока, маскировка, диагностика | 206 |
| `agents-settings/cases.json` | настройки агентов в `settings.json` каталога состояния | 15 |
| `agents-cli/cases.json` | `agents.CheckAgent`, аккаунт, модели и `agents.Manager` на поддельных CLI | 67 |
| `ai-access-paid/cases.json` | платная часть `agents.AccessChecker`: выбор провайдера, вход, `GetAccess`, `RequireAccess` | 14 |
| `scenario-workflow/` | `scenarioworkflow.Workflow` с поддельным менеджером агентов | 16 |
| `video-review-frames/cases.json` | `videoreview.Extract`: кадры, опоры, бюджет изображений | 18 |
| `contact-sheet/cases.json` | инструмент `contact_sheet` | 30 |
| `video-review/cases.json` | `videoreview.ParseReport` и `videoreview.Service` (`View`, `Start`, `Cancel`) | 61 |
| `request-snapshot/cases.json` | `internal/requestsnapshot`: проверка спецификации и SHA-256 её записи | 40 |
| `media-request/cases.json` | инструмент `media_request` на провайдере `test` | 65 |
| `cost-check/cases.json` | инструмент `cost_check` (`check`, `learn`) на провайдере `test` | 20 |
| `kling-request/` | `internal/providers/kling` и `internal/providers/kling/mcp` | 225 + 90 + 32 + 9 |
| `media-providers/cases.json` | слой `internal/providers` и `internal/providers/codex` | 53 + 10 + 18 + 1 + 7 + 9 |
| `cover-generation/cases.json` | `covergen.Generator`, проверка и чтение референсов | 21 + 8 + 11 |
| `shot-workflow/` | инструмент `shot_workflow` (все 15 команд) | 263 |
| `verify-asset-replay/` | инструмент `verify_asset_replay` | 9 |
| `cut-speech/` | инструмент `cut_speech` (`cut`, `verify`) и подготовка речи `production.Service` | 38 + 12 шагов |
| `production-view/` | `production.ViewProduction` и `dashboard.ViewDashboard` | 5 |
| `production-tools/` | сквозной сценарий `regenerate_shot` и `accept_shot` на провайдере `test` | 17 шагов |
| `production-tools/accept-edit/cases.json` | режимы `--review` и `--cut` инструмента `accept_shot` | 17 |
| `build-review/cases.json` | инструмент `build_review` | 59 |
| `build-review/checks/cases.json` | `checks.Service.BuildReview`, `ListReviews`, `RemoveReview` | 48 шагов |
| `production-workflow/cases.json` | `productionworkflow.Workflow`: вид, запуск, отказ, ожидающие предложения | 12 сценариев |
| `production-frames/cases.json` | `productionworkflow.Workflow`: `GenerateFrames`, `ImportFrames` | 7 сценариев |
| `production-workflow-apply/cases.json` | `productionworkflow.Workflow.Apply`, журнал и восстановление применений | 9 сценариев |
| `build-animatic/` | инструмент `build_animatic` | 44 |
| `animatic-view/cases.json` | `animatic.ViewAnimatic`, `animatic.SetStatus`, `animatic.Service.Build` | 41 |
| `montage-window-bounds/cases.json` | положение окна плеера монтажа (`internal/app`) | 31 |
| `apply-montage/cases.json` | инструмент `apply_montage` | 53 |
| `montage/cases.json` | `montage.Service`, `montage.VideoPath`, `montage.CopyVideo`, `montage.RecoverApplications` | 17 сценариев |
| `export-edit-bundle/` | инструмент `export_edit_bundle` (`cases.json`), числа и форматы модуля (`numbers.json`) | 144 + 617 значений |
| `export-bundle-job/steps.json` | `production.Service` `ExportBundle` и `RemoveBundle` | 27 шагов |
| `derive-shot/cases.json` | инструмент `derive_shot` | 113 |
| `derived-workflow/cases.json` | `derivedworkflow.Workflow` (`View`, `Save`, `Build`, `Accept`) и `derivedworkflow.RecoverApplications` | 112 сценариев, 1101 шаг |

Тесты домена ищутся по имени каталога: `git grep -l '"<домен>"' -- '*_test.go'`.

## Устройство случая

Случай — каталог `<домен>/<случай>/` либо элемент массива в `<домен>/cases.json` (`steps.json`, `scenarios`). У элементов массива обычно есть `name`, `description`, `covers`; ниже они не повторяются, перечислены остальные поля.

- `case.json` — `description`, `call` (вызываемая операция), `project` (`"project"` или `null`: функция вызывается на несуществующем пути), `covers` (доказываемые ветки), `stubbedMedia` (медиа, заменённые текстовыми заглушками `stub <путь>` без влияния на результат).
- `project/` — минимальный входной проект: только файлы, которые читает функция (пустые каталоги — с `.gitkeep`). Если функция читает файл, которого нет во входе, результат зависит от лишнего. Каталог входа всегда называется `project`: для не-проекта имя выводится из basename пути.
- Разность с образцом (проверки проекта, представления, `shot-workflow`, `production-view` и др.): `case.json.base` — домен с общим `project/` (обычно `checks-base`), `overlay/` — новые и изменённые файлы, `case.json.remove` — удалённые пути, `case.json.mkdir` — пустые каталоги. Вход собирает `golden.Case.BuildProject` во временной папке.
- Читающие функции работают на `golden.Case.ProjectPath()` (эталон не меняют), записывающие — на копии `golden.Case.CopyProject`. Читающие случаи дополнительно проверяют неизменность дерева (`golden.TreeDigest`).
- `expected*.json` — ожидаемый исход; `files/<путь>` — точные байты созданных и изменённых файлов. Карта изменений — `{путь: created|changed|removed|unchanged|absent}`.
- Ошибка — `{"throws": "<сообщение>"}` (функция возвращает ошибку, текст не сравнивается) либо текст в поле `error`. `errorPrefix` вместо `error`: сравнивается только префикс, который формирует SongFrame, а текст системной ошибки или разбора JSON — нет.

## Сравнение и нормализация

- `golden.Diff` / `golden.AssertJSON` сравнивают JSON как деревья: порядок ключей и пробелы не важны, числа равны по значению (`8` = `8.0`), а `null`, отсутствующий ключ и `[]` различаются. `golden.AssertValue` сериализует значение Go и нормализует пути.
- Файлы с пометкой «точные байты» сравниваются побайтно: порядок ключей, отступ 2 пробела, `\n` в конце.
- Корень проекта в строках — `<project>` (`golden.NormalizePaths`, хвост пути приводится к `/`). Другие маркеры: `<tmp>` (временная папка ОС, тест задаёт `TMPDIR`), `<base>` (временная родительская папка), `<inputs>` (файлы вне проекта), `<out>` (папка результата вне проекта), `<service>`, `<state>`, `<local>` (каталог состояния), `<fake>`, `<images>`, `<workdir>`, `<prepare>`, `<root>`. Время — `<time>`, `<mtime>`, `<stamp>`, `<updated_at>`; UUID и ID — `<idN>`, `<uuidN>`, `<proposal-N>`, `<requestN>` по порядку первого появления; SHA — `<sha>`, `<sha256>`; адреса FFmpeg `@ 0x…` — `@ <addr>` или `0x?`.
- Фиксированное время: `2026-11-04T12:00:00.000Z` (`2026-11-04T12:00:00+00:00` у инструментов). Тест подставляет его или сверяет поле по формату `YYYY-MM-DDTHH:MM:SS.sssZ`.
- Значения инструментов записаны строками JSON модели значений инструментов (не-ASCII без экранирования): они различают `1` и `1.0`, сохраняют порядок ключей и запись float (`1e-07`), одиночные суррогаты остаются escape-последовательностями `\uD8xx`. Такие файлы читаются моделью `internal/toolrt` (`golden.ValueFile`, `Case.ReadValue`, `golden.ParseValue`), а не `encoding/json`; исход `{result}` или `{error: {type, message}}` (тип исключения — внутренний признак перехвата — и текст сообщения) сверяет `golden.AssertOutcome`. Входы и записи сервисных доменов разбираются моделью `internal/dynvalue`: все числа двойной точности, отдельного целого типа нет.
- Файловые ошибки зависят от маркера мини-проекта: при `plan/project.json` путь внутри проекта показан от его папки с подсказкой (`project.FileProblem`, например «в папке проекта нет «plan/scenes.json». Если файл удалили…»), без маркера и вне проекта — технический текст «нет такого файла или каталога: '<project>/…'».
- Вывод инструментов — `{code, stdout, stderr, unhandled}`. При `unhandled: true` (необработанная ошибка) stderr — одна строка «Ошибка: текст» без типа исключения (`toolrt.Unhandled`); тест проверяет признак `toolrt.IsUnhandled` и сверяет stderr целиком.
- Медиа FFmpeg созданы с `-fflags +bitexact`; версия FFmpeg записана в `ffmpegVersion` файла (6.1.1). MP4, SHA-256 WAV, тексты ошибок FFmpeg и поля `video_sha256`/`ffmpeg_version` сверяются точно только при той же версии; при другой — сводка ffprobe, код и префикс stderr. Без `ffmpeg`/`ffprobe` в PATH такие тесты пропускаются.
- Растровые результаты: PNG карточек аниматика сравниваются по составу и размерам (байты зависят от растеризатора и кодировщика), а SHA в квитанции карточек — с файлами на диске. JPEG сверяется с допуском (декодеры расходятся на ±3), листы и сравнения `contact-sheet` — с допуском 0,5 по средним цветам сетки 4×4.
- Права файлов сверяются только там, где записаны (`modes`, `tree`).

## Входные проекты

- `checks-base/project` — проект-образец «Пробный клип» ([описание](../README.md#проект-образец)). Случаи без префикса — образец с точечной порчей файлов; его аниматик собран, но не свежий (MP4 в Git нет).
- `mini-*` в `status` — синтетический «Мини-клип»: три плана, M03 производный от M01 (`derived_from`), все комплекты приняты по отпечаткам, аниматик из видеопланов с согласованными хешами заглушек, принят. Единственный способ получить `state=complete` и свежий аниматик без настоящего медиа.
- `mini-*` доменов сценария — три плана (M02 наследует состояние M01, M03 — `state_from` фазы same и `derived_from` M01), принятые M01/M02, пакет `plan/batches/M02-attempt-01` с нестандартным форматированием `workflow.json` (проверка точечной замены отпечатка), пакет `plan/awaiting/M03-attempt-01`, кастинг из мира, героини и лодки.

## Форматы доменов

### Статус и тайминги

- `status/*/expected.json` — `ProjectStatus` или `{"throws"}`. `expected-open.json` — `{"error", "sameAsStatus"}`: состояние приложения подменено, поэтому у открытия фиксируются только ошибка и совпадение со статусом. `expected-acceptance.json` — итог принятия, если `plan/scenes.json` содержит планы: `fingerprints` (или `null`), `accepted` (`completed`/`stale`), `reasons`, `problem`; статус сворачивает причины в два сообщения, тест принятия сверяет сами причины.
- `timing-view/*/expected.json` — `TimingView`.
- `timing-save/*/` — `timing-input.json` (вход после сериализации JSON: отсутствующих полей нет), `expected.json` — `{"error", "result", "resave"}` либо `{"error", "result": null, "fileUnchanged"}`; `resave` — повторное сохранение `result` (`sameResult`, `sameBytes`). `expected-timing.json` — точные байты `plan/audio/timing.json`.
- `timing-validation/cases.json` — `{tags?, input: {timing, lyrics, duration}, expected: string[]}`. `lyrics` — строки разбора текста `[Куплет] / Первая строка / Вторая строка / пусто / [Припев] / Огни над водой`. Тег `null-number` помечает `start: null`: оно даёт «границы не числа» и при разборе отличается от нуля.
- `timing-draft/cases.json` — `{input, expected}`: `input` — текст, длительности контейнера и вокала, SHA трека, принятые CTC-сегменты и кандидаты (`source_line`, границы, причина, `acoustic_score`), прежний `timing.json` строкой (`null` — нет файла), `reset` — пересчёт всех строк (по умолчанию `false`); `expected` — `{error, timing}`, `timing` — точные байты (отступ 2 пробела, не-ASCII без экранирования, `\n` в конце), `error` — текст ошибки.

### Проект и исходники

- `project-create/*/` — `input.json` (путь через `<base>`), `setup.json` (`dirs` внутри `<base>` до вызова), `expected.json` (`error`, `status`, `state` — текущий проект и история), `expected-tree.json` (`exists`, `git`, `dirs` и SHA-256 файлов без `.git`). Без git тест проверяет то же дерево.
- `project-validate-new/cases.json` — `{setup, input, expected: string[]}` с маркером `<base>`.
- `project-rename/*/` — `input.json` (`{name}`; `not-in-history` — проект вне истории), `expected.json` (`error`, `status`, `history`, `fileUnchanged` при ошибке), `expected-project.json` — точные байты `plan/project.json`. Чужая запись истории `/elsewhere/…` синтетическая и на диске не существует.
- `project-settings/*/` — `read-*` читают настройки, `save-*` записывают `input.json`; `expected.json` — `{error, errorPrefix?, result, fileUnchanged?}`, `expected-project.json` — точные байты. `input.json.unset` — пути удаляемых полей (тот же список Go получает от `frontend/src/platform/api.ts`).
- `sources-view/*/expected.json` — `SourcesView`. Поля `pinnedReferences` и `entityKinds` заполняет `internal/app` по реестру, производству и кастингу; `sourceedit.ViewProject` отдаёт пустые объекты. `sources-validate/*/` — `input.json` и массив проблем; пути входных файлов — `<inputs>/…`.
- `sources-save/*/` — `inputs/` (файлы вне проекта, в `input.json` — `<inputs>/имя`), `expected.json` (`{error, result, treeUnchanged?}`), `expected-manifest.json` (точные байты `source/manifest.json`, `updated_at` — `<updated_at>`), `expected-source.json` (`dirs` и SHA-256 файлов `source/`). Эталон без ffprobe: у нового трека `duration_seconds: null`; ветку с ffprobe проверяет тест на `internal/components/fixtures/tiny.mp3`.
- `sources-save-cast/*/` — формат `sources-save` плюс `expected.json.castUnchanged` и `expected-cast.json` (точные байты `plan/cast.json`, нет — если файла нет). Словарь свойств — встроенный `internal/cast/default_properties.json`. При отказе и откате (`rollback`, `invalid-input`) `treeUnchanged` охватывает весь проект, включая `plan/cast.json`.

### Кастинг и сценарий

- `cast-view/*/expected.json` — `CastView`; `scenario-view/*/expected.json` — `ScenarioView`, `expected-status.json` — `ScenarioStatus` строкой JSON; исключение — `{"throws"}`. `referencesStale` истинно ровно тогда, когда в `problems` есть «Карта references реестра расходится с кастингом…»: так реестр можно сохранить без правок, чтобы обновить карту.
- Записывающие домены (`cast-write`, `scenario-treatment`, `scenario-scenes`): вход — `cast-input.json`, `treatment-input.json` или `scenes-input.json` (у `cast-write` с `call: "init"` входа нет); `expected.json` — `{"error", "result", "files", "resave"?}`, где `resave` — повторный вызов на `result` (`error`, `sameResult`, `files`); `files/<путь>` — точные байты. `updated_at` описаний `source/manifest.json` у `cast-write` — фиксированное время.
- `scenario-treatment`: трактовка с верной структурой сохраняется черновиком, содержательные проблемы (коды, повтор, название, стык, конец раньше начала, длительность, нет частей) отдаёт `scenario.ValidateProjectTreatment`. Поэтому у `validation-problems` и `no-parts` `error: null`, а `result`, `files` и `resave` описывают нормализованный черновик. `strictError` — текст строгого отказа: проблемы через пробел равны ему, и `scenario.NormalizeTreatment` (ответ агента) отказывает им. Неверная структура (`invalid-document`, `invalid-part`) — отказ сохранения и единственная проблема с тем же текстом.
- `scenario-scenes/*/case.json.mode` — `production`, `keep` или неверный; `expected-impact.json` — оценка сохранения черновика до записи, `expected-validate.json` — проблемы сцен с кастингом проекта.
- `scenario-brief/*/case.json.briefs` — пары `[план, фаза]`; без него — все планы реестра в обеих фазах. Черновик — `scenes-input.json` или `project/plan/scenes.json`. `expected.json` — массив `{shot, phase, result|error}`.
- `scenario-workflow/<случай>/` — `base: checks-base`; `case.json.steps`: `view`, `start` (`pass`, `note`, `selectedIds`), `finish` (`result` — ответ агента), `cancel`, `fail`, `drop` (задания больше нет), `write`, `editCast` (роль второй сущности + « Ведёт лодку.»), `apply`/`discard` (`id` — чужой ID, без него — текущее предложение), `approveCurrent`, `approveScenes`. Исход — `view` или `error`; у запуска — `agent` (`project`, `task`, `prompt` — файл домена `prompt-<pass>.txt`, `context` — файл случая `context-N.txt`, дословно). `files.json` — `{путь: {before, after}}` (SHA-256 или `null`), `after/<путь>` — байты (кроме PNG), `state.json` — запись `scenario-workflow/<sha>.json` или `null`. Ответ агента не в JSON даёт текст `proposalInvalidDocument`.

### Реестр сцен и регулярные выражения

- `tool-json/cases.json` — `{call, input, expected}`: `loads` (`expected` — форматы `indent`, `compact`, `canonical` (ключи по порядку, разделители без пробелов), `ascii`, `repr`, `encodable`/`encodeError` записи в UTF-8 либо `error`), `decode` (вход — hex байтов), `float`, `repr` (вход — JSON строки).
- `tool-regex/cases.json` — `{pattern, ignoreCase, call, text, expected}`; `call` — `search`, `match`, `fullmatch`, `finditer`; `expected` — совпадения `[start, end, groups]` в кодовых точках (`null` — группа не участвовала), пустой список — совпадения нет.
- `scene-registry/cases.json` — `{call, args, expected}`, аргументы — JSON-тексты (`data`, `initial`, `kits`, …), каждый вызов получает свою копию. `call`: `registry` (все функции на одном документе, состояние и отпечаток — по каждому плану; список планов — только при `initial: null`), `project` (`validate`, `validateLoose`, настройки `video`/`image`/`other`), `status` (принятые отпечатки и запись с ними), `seconds`, `clock`, `acceptance` (функции снимка по `sourceSnapshots`/`acceptedSnapshots`, `null` — функции нет).
- `scene-registry/<случай>/` — `project/` (ролики — заглушки `stubbedMedia`, их SHA входит в квитанции), `expected.json` — исход каждой функции чтения под ключами `load_cast`, `initial_states_for`, `load_project`, `load_project_generation`, `read_production_status`, `load`, `project_shot_acceptance`, `source_video_snapshot` (строка JSON `{комплект: [без allow_derived, с allow_derived]}` по каталогам `assets/shots` и отсутствующему `M99`). `case.json.write` — `{updates, clear}` записи принятых отпечатков; `expected.json.write`, `writeFile` и `files/plan/production-status.json` (точные байты, права 0600).

### Инструменты проверки и представлений

- `scene-scaffold/<случай>/` — `case.json.args` (после `--project`), `project/` (трактовка, разметка, кастинг, текст, опись и прежний реестр образца с точечными правками), `expected.json` — `{code, stdout, stderr, unhandled, files: {"plan/scenes.json": …}}`, `files/plan/scenes.json` — точные байты.
- `lint-registry/`, `check-assets/`, `check-workspace/`, `shot-status/` — вход разностью с `checks-base`; `case.json.call` — инструмент, `args` — аргументы после `--project`, `provider` — случай особенности провайдера (пропускается, если адаптера нет в `internal/mediaadapters`). `expected.json` — вывод инструмента; дерево проекта не меняется (проверка по дайджесту).
- `continuity-brief/`, `scene-views/` — вход разностью с `checks-base`, `expected.json` — вывод инструмента. У `scene-views`: `cards` — файлы папки карточек по квитанции после записи на отдельной копии (`null` — записи не было), `files` — изменения в режиме записи, `recheck` — исход повторного `--check`, `files/<путь>` — точные байты текстов (SHA-256 в квитанции `plan/animatic/cards/manifest.json` тест заменяет на `<sha256>` и сверяет с файлами). После правки входа инструмент перерисовывает все карточки, поэтому в «Устарели представления»/«Обновлено представлений: N» набор карточек равен набору эталона либо полному `cards`, счёт сдвигается на разницу и перезапись квитанции, а `recheck` при перерисовке сверяется только на отсутствие карточек и квитанции. `--check` дерево не меняет.
- `animatic-cards/project/` — синтетические референсы и опоры (PNG RGB/RGBA/P/L/LA, WebP с потерями и с альфой, JPEG, GIF, битый файл, каталог `source/folder`); тест читает его на месте.
- `animatic-cards/cases.json` — `{call, shot, project, references | keyframes + with_last, expected}`. `expected.texts` — текстовые блоки по порядку (`text`, `xy`, `width`, `height`, `size` — кегль на входе, `color`, `bold`, `point` — выбранный кегль, `lines` — `[x, y, строка]`); `expected.pastes` — вставки изображений (`size`, `at`, `sha256` пикселей RGB, `exact` — false у JPEG); `result` — результат карточки (без `approved_scene_still`); `error` — `{type, message}` (тип с модулем, например `UnidentifiedImageError`), при ошибке трассировка содержит вызовы до неё; `has_last` — записан ли `last_target`. Пиксели глифов не сравниваются.
- `animatic-cards/textlength.json` — `{text, bold, size, width64}`: ширина строки × 64 (точное целое) с раскладкой Raqm для строк образца и шаблона, кернинга, лигатур, смешения письменностей, парных скобок и нераскрываемых символов.

### Агенты

Настоящие `codex`/`claude` и сеть не вызываются: вместо CLI запускается поддельный агент — тестовый бинарник `go test -c ./internal/agents` с `SONGFRAME_FAKE_AGENT=1` (`internal/agents/fake_test.go`), ссылкой `codex`/`claude` рядом с файлом сценария `<имя>.json`.

- `agents-protocol/cases.json` — группы `args`, `input`, `parse`, `jsonl`, `redact`, `detail`, `failure`, `version`, `authorization`, `normalize`, каждая — массив `{вход…, expected}`; ошибка — `{"throws": {"code"?, "message"|"detail"}}`. Длинный промпт — `{"repeat", "length"}`, изображение — описание синтетического файла (`path`, `mediaType`, `size`, `fill`), большой результат — длина и SHA-256.
- `agents-settings/cases.json` — `{initial, ops, expected, final}`: байты `settings.json` до (`null` — нет файла), вызовы `[имя, аргумент]`, итог каждого или `{"throws"}`, точные байты после. У повреждённого JSON сравниваются префикс и окончание сообщения, причина разбора — нет; аргументы, которые типизированный API Go не выражает, тест пропускает.
- `agents-cli/cases.json` — `{call, config|agent, project?, images?, imageJob?, input?, scenarios, expected}`. `scenarios` — правила поддельного CLI по имени программы (`args`/`prefix`, stdout, построчный вывод с задержкой, stderr, код, зависание, потомок, JSON-RPC app-server, control-протокол). У `check`, `account`, `models` `expected` — итог и записанные аргументы, каталог, stdin; у `manager` — `start`, `events`, `final`, `history` (точные байты), `record` (аргументы, cwd, промпт).
- `ai-access-paid/cases.json` — `{generation, auth, requiredKind?, require?, access|required|error, authCalls}`: `generation` — блок `plan/project.json`, `auth` — ответ входа (`{status, message?}`, `{throws}` — ошибка, `{throwsValue}` — не-ошибка, тест пропускает), агент не выбран.

### Проверка видео

- `video-review-frames/cases.json` — `{ffmpegVersion, cases}`; случай — `{inputs, references?, budget?, outExists?, outFile?, relativeVideo?, videoName?, stderrPrefix?, inputSha256, expected}`. `inputs` — аргументы FFmpeg или байты и EXIF-ориентация; `expected` — код, stderr, точный `manifest.json`, по изображениям размеры, байты, SHA-256 и сетка 4×4, папка результата. Побайтно — только кадры FFmpeg при той же версии; копии опор и JPEG — по размерам и сетке с допуском; у битого видео — префикс stderr. Тексты отказов — `video-review-frames/texts.json`.
- `contact-sheet/cases.json` — `{ffmpegVersion, cases}`; случай — `{inputs, fakeProbe, args, inputSha256, expected}`: `inputs` — аргументы FFmpeg, текст, `hex` или папка; `fakeProbe` — JSON поддельного ffprobe первым в PATH; `args` — после `--project <root>`. `expected` — вывод, файлы проекта, у PNG — размеры и сетка 4×4, у превью — поля ffprobe, неизменность входов, пустой TMPDIR. stdout — побайтно (при другой версии FFmpeg — без размера файла), граничные кадры — точно; байты PNG и превью H.264 не сверяются.
- `video-review/cases.json` — `{frames, parse, scenarios}`: `parse` — разбор отчёта (`input`, `duration`, `result` или `throws` — текст отказа с причиной); сценарий — `{steps, toolCalls, agentStarts}` над копией `project/` с поддельными агентом, подготовкой кадров и `continuity_brief`; шаг — `{op, view, latest}` (точные байты `latest.json`).

### Платная попытка и провайдеры

Сеть и платные запросы не используются: провайдер `test` — сервис `internal/mediatest`, сценарии проигрывает `internal/mediatest/scenario`. Часы детерминированы: монотонное время начинается с 1000 с, ожидание продвигает его без паузы.

- `request-snapshot/cases.json` — `{call, input, expected}`: `input` — JSON-текст (в том числе с `NaN` и одиночным суррогатом), `expected` — `{result}` либо `{error: {type, message}}`.
- `media-request/cases.json`, `cost-check/cases.json` — сценарии `{files, steps, expected}` над папками `project/`, `service/`, `state/` (каталог состояния) и `tmp/` (`TMPDIR`). Шаг — `{tool, args, project, configure?, write?, remove?, mkdir?, fault?}`; `fault`: `lock:<папка>` — замок попытки у другого процесса, `interrupt_on_downloads` — обрыв перед записью журнала с загрузками, `interrupt_before_link:<имя>` — обрыв перед публикацией платного оригинала. `expected[i]` — `{code, stdout, stderr, unhandled, interrupted, calls, tree, dirs}`: новые вызовы сервиса, дерево без `service.json`/`calls.jsonl` (`*.json` — текстом, прочее — `sha256:`), каталоги; у прерванного шага — только журнал и дерево. Рабочая папка `prepare` допускается в `plan/batches`, `plan/awaiting`, `plan/reference-images` (не в самом корне) и временной папке ОС.
- `kling-request/` — значения записаны строками JSON модели значений инструментов, исключения — `{type, message}`; сеанс MCP и вход подменены, HTTP-трассы — с адресом `http://kling.test` (тест подставляет свой httptest). `cases.json` — `{call, args, expected}` чистых функций. `adapter.json` — `args.script` (ответ или исключение на `initialize`, `tools`, `call`, `upload`), `args.files` (base64), `args.credentials`; `expected.log` — журнал вызовов сеанса, `expected.debug` — отладочная запись (`<time>`, `<dir>`). `traces.json` — `stored`, `responses` (`raise` — обрыв соединения), `expected.requests` (метод, путь, явные заголовки, тело), `expected.unused`, `expected.credentials`. `callback.json` — запрос к колбэку входа и ответ. `upload/` — файл трассы загрузки.
- `media-providers/cases.json` — группы: `select` (`provider`, `files` — `{png: [ширина, высота]}` или `{text}`, `input`, `caps`, `candidate?`, `result` с `modelSelection` или `error`), `capabilities` (`kind`, вывод инструмента, `calls`, `result` без `checkedAt`), `guides` (`null` — раздела нет), `environment` (строки среды и обновления проверки), `codexPrepare` (`json` — текст `{input, references}`, от него считается SHA запроса опор), `codexCover` (аргументы запуска, копии внешних опор, `plan/project.json` временного проекта).

### Обложка и референсы

- `cover-generation/cases.json` — `{scenarios, inspect, context}`. `test-agent` исполняет подставной runner с очередью поведений (запись файла, путь, ошибка, ожидание отмены с поздней записью, отказ проверки транспорта), платный `test` — настоящие `media_request` и `cost_check`. Шаг — `op` (`writeProject`, `files`, `agent`, `service`, `create`, `prepare`, `generate` с токеном и SHA `current|previous|none|wrong`, `double`, `wait`, `waitStarted`, `view`, `accept`, `acceptReference`, `attach`, `tamper`, `close`, `shutdown`) и исход: `result` или `error`, `session`, `rootTree` (папка `songframe-cover-<n>`), `projectTree` (без `plan/project.json`), `calls`, `runs`; `"unchanged"` — без изменений. В деревьях JSON и `*.prompt.txt` — текстом, `request/` — именем, `accepted.png` — размерами, прочее — SHA-256 и размером; длинный текст — `{repeat, count}`.
- Фоновая генерация начинается после ожидания шага, поэтому тест держит исполнителя и вызовы сервиса до следующего ожидающего шага (`prepare`, `wait`, `waitStarted`, `close`, `shutdown`). Платный референс готовится в `plan/reference-images/`.

### Производство

- `production-view/<случай>/` — вход разностью с `checks-base`; `expected-production.json` — `ProductionView` без поля `tools` (доступность инструментов зависит от машины), `expected-dashboard.json` — `DashboardView`.
- `production-tools/` — сквозной сценарий над `checks-base` без `plan/batches/M03-attempt-01` и с `provider_selected: true`. `inputs.json` — спецификация, промпт, цены, конфигурация сервиса `test`, ответ подставного `ffprobe` (кадр — PNG 1×1, `ffmpeg -version` печатает `ffmpeg version test-build`). `steps.json` — `{label, tool, args, files}` (`<spec>`, `<sha>` — SHA попытки перед отправкой), `expected.json` — `{label, code, stdout, stderr, files}` с точным текстом файлов (`null` — нет). Шаг `accept-cut` завершается отказом рендера и сверяется полностью.
- `production-workflow/cases.json` — `{blobs, scenarios}` над копией `checks-base` (видео — платный `test`, изображения — `test-agent`). Шаг — `op`: `write`/`remove`/`set` (`config` — настройки генерации), `view`, `start`, `finish` (ответ агента), `job` (статус, код, сообщение задания), `discard`, `pending`, `restart` (`freshAgents` — без истории заданий), `writeLocal`/`patchLocal` (файл папки записей предложений; `target` — путь от проекта), `startNoAgent`. Исход — `result` или `error`, `local` (файлы записей предложений `plan/batches/proposals/<план>.json` проекта с путями от проекта, `unchanged`; копии кандидатов в подпапках планов сверяются через `imageHashes` записей), `starts` (задача, SHA промпта и контекста), `tools` (новые вызовы инструментов). Тексты промптов, контекстов и записей — в `blobs` под SHA-256 нормализованного текста. Ответ агента не в JSON даёт «Ответ агента не является JSON-документом предложения.» (сравнивается по признаку). `discard` обновляет запись завершившегося задания до проверки статуса (сценарий `lipsync`, шаг 27).
- `production-frames/cases.json` — тот же формат (изображения — `test-agent` с адаптером `codex` либо платный `test`). Операции: `generate`, `import` (`images` — `{id, path}` или `null`), `service` (`service.json` сервиса), `agentFiles` (файлы программы-агента в рабочей папке задания опор: `base64`, `text`, `symlink`), `jobFile` (файл рабочей папки, `set` полей `job.json`, `remove`), `finish` (`result`, `status`, `exitCode`, `message`). Исход дополнительно: `packages` (дерево `plan/batches` без папки записей `proposals/`: каталог — `путь/`, текст — SHA нормализованного содержимого, иначе `sha256` и `bytes`; `readonly`, `symlink`), `jobs` (рабочие папки `image-jobs/`), `service` (новые строки `calls.jsonl`). Маркеры `songframe-media-prepare-<n>`, `<request>` (SHA запроса опор из `job.json`). Ожидаемое поведение:
  - ответ программы-агента, не являющийся JSON, — «<программа> не вернул список файлов опор.»;
  - отсутствующий файл кандидата — «Опора Kxx: нужен настоящий файл изображения в папке кандидатов.»;
  - при `proposal.status` `running` или `ready` `canGenerateFrames` ложно;
  - причины блокировки говорят «попытка», а `continue` — «на шаге плана» (так же в `production-view`, `production-workflow`, `production-workflow-apply`).
- `production-workflow-apply/cases.json` — формат `production-workflow` плюс `apply` (`id: current`), `applyCrash` (обрыв до или после `crash.call`-го вызова инструмента, считая `media_request capabilities`; дальше — `restart`), `recover`, `tool` (прямой вызов `shot_workflow`), `candidate` (копия кандидата опоры в `plan/batches/proposals/<shot>/` проекта, как её оставляет импорт; `suffix` — изменённые байты), `importFrames` (запись предложения `seed`), `journal` (прямое применение пакета: колбэк пишет `writes`, удаляет `removes`, затем `fail` или `hang`), `writeState`. Исход этих шагов — `tree` (файлы `plan/` без `plan/batches/proposals`: `dir` или `<права>:text|bin:<SHA>`) и `state` (`production-apply/` каталога состояния, журнал — `pkg:<пакет>`); `unchanged` — как после предыдущего шага. Права записаны при umask 002: тест выставляет его и вне unix пропускается. Ожидаемое поведение: применение запроса не пишет `<id>-request.json` в папку записей предложений; `pending.json` журнала пишется атомарно и читается только версии 2; защищённые файлы image-попыток сравниваются без учёта порядка ключей и сортируются по кодовым единицам UTF-16.
- `cut-speech/project/` — три плана (M01 без lipsync, M02 и M03 с lipsync, 30 к/с), разметка с целыми и дробными границами и строкой вне текста, `source/text.md` с CRLF, `source/track.flac` (1 с, 44,1 кГц стерео: PCM результата не зависит от версии FFmpeg) и `source/track-mono.wav` (0,3 с, 22,05 кГц моно). `cut-speech/inputs/speech-ffmpeg.wav` — тот же PCM в контейнере FFmpeg (`verify-header`).
- `cut-speech/cases.json` — `{ffmpegVersion, cases}`; случай — `{overlay, remove, steps, files, refusal?}`. Шаг — запуск `{run, code, stdout, stderr | unhandled, noFFmpeg?, ffmpegText?}` (`unhandled` — строка «Ошибка: …» необработанной ошибки) или правка `{write, text | input}`, `{tamper, offset}` (инверсия байта), `{remove}`. `files` — JSON текстом, WAV — `{sha256, bytes}`, `"removed"`. `ffmpegText` точно — только при той же версии FFmpeg; `noFFmpeg` — FFmpeg недоступен (`mediacmd.Programs`). `refusal` — текст ожидаемого отказа (код 1, без записи файлов); он заменяет исход шагов случая: `negative-start` отказывает «Начало среза не может быть меньше нуля.».
- `cut-speech/service.json` — `{ffmpegVersion, base, inputs, steps}` подготовки речи над `checks-base`: `inputs` — пакет отправленной попытки `M03-attempt-02` и пакет без `shot`; шаг — `{label, packageDir, bounds?, write?, result | error, audio}` (`PackageView`, содержимое `audio/` пакета `M03-attempt-01`). Песня образца — MP3, поэтому SHA-256 WAV и `output.sha256` — только при той же версии FFmpeg.

### Проба стыков и приёмка участка

- `build-review/project/` — мини-проект: M01–M03 по 12 кадров (`end_seconds` 1.2), у M01 и M03 принятые `accepted-edit.mp4` 64×36 с манифестами, у M02 карточка PNG; в `source/` трек MP3, видео с меняющимся кадром, 24-кадровое видео, WAV в конец песни и короче её, битый MP4. `build-review/inputs/` — файлы вне проекта.
- `build-review/cases.json` и `production-tools/accept-edit/cases.json` — `{ffmpegVersion, cases}` (у второго `base: build-review`, разность — `overlay/`, попытка `plan/batches/M02-attempt-01`). Случай — `{setup, steps, expected}`: `setup` — `write`/`copy`/`remove`, шаг — `{tool, args}`, `expected` — `{steps: [{code, stdout, stderr}], changed, removed, tmp}`; в `changed` каталог — `"dir"`, JSON — `{text}`, новый MP4 — `{sha256, bytes, media}` (сводка ffprobe), прочее — `{sha256}`.
- `build-review/checks/cases.json` — `{steps}`; шаг — `{op, …, result|error, started?, tree?}`: `write`/`symlink`/`mtime` строят `plan/batches`, `list`, `build` (`options` — параметры пробы; `started` — вид, название, проект, инструмент, аргументы и подпись шага), `remove`, `writeOutput`/`removeOutput`/`status` — результат и состояние N-го задания. `tree` — `plan/batches` (`dir`, `symlink` или текст). Тест запускает настоящий менеджер заданий; «ещё собирается» воспроизводит ожидающее задание.
- Ожидаемое поведение: нечисловой `total_frames` в рецепте даёт `totalFrames` 0 (в эталоне `null`); пробы с равным временем идут в обратном порядке обхода; `RemoveReview` проверяет шлюз записи проекта (`projectfs.CheckWrite`); обязательные `--output` и группы проверяются после разбора аргументов, поэтому при нескольких ошибках первой может оказаться другая.

### Аниматик

- `build-animatic/base/`, `build-animatic/keyframes/` — входные проекты (принятый монтаж и карточка; план с опорами), `media/` — синтетические MP4/MP3/PNG. Случай `cases.json` — `{base, steps}`, шаг — `write {path, text | file}`, `remove {path}` или `run {args, expected, ffmpegStderr?}`; `expected` — `{code, stdout, stderr, changes, texts, probe}`: `changes` — `{путь: SHA-256 | null}`, `texts` — точные тексты манифеста, квитанций кэша и документов, `probe` — сводка ffprobe MP4. При другой версии FFmpeg хеши медиа и ключи кэша маскируются, `ffmpegStderr` — по префиксу, `cache-damaged` пропускается. Пути в манифесте и квитанциях — через `/`. Изменения входов во время сборки и сбои ffprobe и склейки — `internal/buildanimatic/build_test.go`.
- `animatic-view/cases.json` — `{fixture, scenarios}`; `fixture` — записи `{path, text}`, сценарий — `{base, steps}`, шаг — `fixture`/`write`/`remove` или `view`, `setStatus` (`decision`; `status` — текст `plan/production-status.json` или `null`), `build` (`planOnly`; `start` — аргументы запуска задания или `null`) с исходом `result` (`builtAt` — `<mtime>` после проверки равенства mtime манифеста) либо `error`. Строковые поля вида всегда строки (`null`/отсутствие — `""`), нечисловые числа — 0.

### Монтаж

- `montage-window-bounds/cases.json` — `{written, cases}`; случай — `{text, displays, expected}`: содержимое `montage-window.json`, рабочие области экранов, пригодное положение или `null` (окно в обычном месте). `written` — формат записи. Приложение берёт только `x`, `y`, `width`, `height` и отбрасывает дробную часть; свёрнутое, развёрнутое и полноэкранное положение не записывается. Тест — `TestUsableMontageBoundsGolden`.
- `apply-montage/cases.json` — `{ffmpegVersion, base, cases}` на копии `checks-base/project`. Случай — `{setup, steps, expected}`: `setup` — `write`, `append {path, hex}`, `copy`, `remove`, `mkdir` (черновики уже содержат SHA подготовленной копии), шаг — `{args, setup?}`; `expected` — `{steps, changed, removed, revisions}`, `changed` — как у `build-review`. `revisions` — ID транзакций (uuid4 hex): тест выдаёт их через `NewID`, поэтому манифесты, журналы и представления сверяются побайтно. В `boundary-views` допускаются перерисованные PNG карточек 1280×720 (квитанция и журнал — без их SHA-256). Сбои транзакции — `internal/applymontage/apply_test.go`.
- `montage/cases.json` — `{scenarios}`; сценарий начинается с пустой папки, шаг — `write`/`remove`/`mkdir`/`mtime` или `view`, `load {id}`, `save {draft, id?}`, `export {draft}`, `apply {draft}`, `videoPath {video}`, `copyVideo {video, destination}`, `recover`; исход — `result` или `error`, у `save`/`export`/`apply` — `files` (тексты JSON) и `started` (аргументы задания), у `copyVideo` — `copied` и `out`, у `recover` — `tree`. Ошибки разбора JSON сверяются по тексту до и после причины.

### Экспорт для монтажёра

- `export-edit-bundle/cases.json` — `{base, cases}` на копиях `checks-base`; случай — `{project, args, overlay, remove, links, dirs, expected}`. Сверяются код, stdout, stderr (у необработанной ошибки — строка «Ошибка: …» в поле `unhandled`) и рабочая папка: тексты пакета побайтно, копии медиа — SHA-256 и размер; путь рабочей папки — `<tmp>`. README пакета пишется в исправленном виде, а переносимый `timeline.fcpxml` — с относительными `src`: тест приводит тексты эталона к этому виду и проверяет, что относительный путь ведёт в тот же файл.
- `export-edit-bundle/numbers.json` — `{frames, formats}`: номера кадров, таймкоды, рациональные числа, округление и форматы float на частотах шкалы и генерации.
- `export-bundle-job/steps.json` — `{base, steps}`; шаг — `setup` (`write`, `mkdir`, `removeFile`, `restoreBatches`, `bundle`, `link`), `status`, `export {target, copy}` или `remove`, исход — `error`, `removed`, `job` (вид, название, шаги инструментов), `exists`. `rejectedBeforeRun` — ожидаемый отказ без создания папки: «Внутри проекта пакет можно собирать только в plan/batches; иначе выберите папку вне проекта.».

### Производные планы

- `derive-shot/cases.json` — `{ffmpegVersion, base, cases}`; случай `{setup, steps, expected}` с операциями write/append/copy/rename/remove/rmtree/mkdir. `expected.changed`: каталог — `"dir"`, резервы `/before/` и `/before-kit/` — SHA, `.json`/`.md` — текст, новые MP4 — SHA, размер и сводка ffprobe; `revisions` — uuid4 транзакций. SHA PNG карточек тест маскирует, перед откатом в журналы подставляются SHA карточек, нарисованных при прогоне.
- `derived-workflow/cases.json` — `{scenarios}`; сценарий `{base: sample|empty, steps}`. Шаг — вход, управление окружением `job`, `clearJobs`, `tools`, `moveProject` или `view`, `save`, `build`, `accept`, `recover` с исходом `result`/`error`, `changed`, `removed`, `started`, `tree`. Причина разбора JSON в `recover-corrupt` не сравнивается.
- Сбои публикации, чужая правка и отмена — точки подмены в `internal/deriveshot/transaction_test.go`.

## Покрытие

Ветки каждого случая перечислены в `covers` (`case.json`, `index.json`, `cases.json`): там видно, что именно доказано. Неудачный откат исходников (`restoreFailed`) проверяет отдельный тест `internal/referenceimage`.

Не покрыто эталонами:

- в статусе — свежесть аниматика с карточками и опорами при существующем MP4 (вид аниматика проверяет `animatic-view`); производный план от производного источника, `source_review` при несвежем источнике;
- статус на пути-файле, ошибки чтения каталогов и записи файлов (права, диск), `realpath` за пределы комплекта, гонки записи;
- все ошибки нестандартных `workflow.json` в оценке сохранения сцен; нестрочный `note` и NaN/Infinity в разметке;
- Windows-переводы строк (`toolrt.TextMode` повторяет текстовый режим, эталоны записаны на Linux) и Windows-замок попытки (`LockFileEx`);
- порядок обхода несортированных каталогов (пробы в `shot_status`, `*/request.json` в `lint_registry`) — в случаях не больше одного такого файла; причины устаревания производных планов в `shot_status`, кроме общей;
- потоковый вывод строк `watch`; изменение входов во время рендера пробы, сбой декодирования трека, отказ защищённого назначения, `--replace`/отмена в режимах участка (общий код с `--full`, покрыт `production-tools`).
