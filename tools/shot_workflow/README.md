# shot_workflow

Ведёт `workflow.json` рабочего пакета одного плана: создание, план опор, принятие кадров и промпта, этапы, перенос в очередь и проверку целостности. Инструмент вызывает приложение вместо ручного редактирования JSON (разработчик при отладке — из checkout с `--project <папка>`); формат пакета остаётся контрактом [README очереди](../../templates/project/plan/awaiting/README.md). Инструмент не обращается к сервисам генерации и не трогает assets.

```sh
python3 -B tools/shot_workflow/shot_workflow.py init M32 --dir plan/batches/M32-attempt-01 --mode shot
python3 -B tools/shot_workflow/shot_workflow.py init M32 --dir plan/batches/M32-attempt-02 --retry-of plan/batches/M32-attempt-01
python3 -B tools/shot_workflow/shot_workflow.py plan-keyframes --dir plan/batches/M32-attempt-01 --request-seconds 7 --middle 3.5:колёса остановились
python3 -B tools/shot_workflow/shot_workflow.py approve --dir plan/batches/M32-attempt-01 K01 /tmp/M32-first.png
python3 -B tools/shot_workflow/shot_workflow.py approve-prompt --dir plan/batches/M32-attempt-01
python3 -B tools/shot_workflow/shot_workflow.py set-stage --dir plan/batches/M32-attempt-01 request_choice --request-dir request
python3 -B tools/shot_workflow/shot_workflow.py park --dir plan/batches/M32-attempt-01 --wait-reason insufficient_balance
python3 -B tools/shot_workflow/shot_workflow.py show --dir plan/awaiting/M32
python3 -B tools/shot_workflow/shot_workflow.py check --dir plan/awaiting/M32
```

Единый порядок этапов: `description_review → keyframes_review → prompt_review → request_choice → ready → submitted → downloaded → edit_review → accepted`; `needs_revision` достижим с любого этапа, кроме `accepted`, и возвращает к согласованию. Вперёд разрешён только следующий этап (а также `request_choice → submitted` после «отправить» и `downloaded → accepted` без обработки), назад — любой. Этапы `ready` и `needs_revision` требуют причину ожидания: `user_saved`, `insufficient_balance`, `cost_or_balance_unknown`. Названия этапов и причин совпадают с [shot_status](../shot_status/README.md) и [cost_check](../cost_check/README.md).

`init` берёт окно и кадры из реестра и записывает `scene_sha256` из `scene_registry`; `--mode shot` или `frame` фиксирует режим согласования, `--batch ИМЯ` помечает пакет как часть партии независимых планов (имя показывается в `show`). У каждого плана партии свой пакет, своя таблица запроса и своя отправка. `plan-keyframes` строит каркас опор: `K01` первый кадр, промежуточные по времени с заметкой, последняя на границе длительности запроса; длительность задаётся целым числом секунд по `generation.video.duration_rule` проекта: строго больше окна, не меньше окна либо ровно окно (`exact_window`). Проект без корректного блока `generation.video` — ошибка с пояснением. Для `exact_window` дробное монтажное окно диагностируется: инструмент не округляет его молча. Инструмент проверяет соотношение с окном; поддерживаемую длительность выбранной модели проверяет подготовка запроса. Повторное планирование сохраняет принятые опоры с той же ролью и временем. `approve` копирует принятый кадр в `frames/` пакета, если он лежит снаружи, записывает SHA-256 и обновляет `approved_frames` и `current_keyframe`. `approve-prompt [--file ИМЯ]` принимает файл промпта из пакета (по умолчанию записанный в `prompt.path` или `video-prompt.txt`) после всех опор. Если адаптер провайдера `generation.video` проекта объявляет предел длины промпта `PROMPT_WARNING_CHARS` ([интерфейс адаптера](../media_request/README.md#адаптеры)), более длинный текст даёт предупреждение; без адаптера или предела предупреждения нет. Сам предел инструменту неизвестен. `park` переносит пакет в `plan/awaiting/Mxx` только после проверки хешей и наличия подготовленного запроса. `show` и `check` сообщают проблемы: изменение постановки или унаследованного состояния после подготовки, изменённые или отсутствующие файлы опор и промпта, отсутствие `request.json`; `check` возвращает код 1 при проблемах.

Для исправленной попытки `init --retry-of ПАКЕТ` записывает ссылку `retry_of` на существующий пакет того же плана, сохраняя его без изменений. Совместимые утверждённые опоры переносятся через `approve`; промпт и платный запрос согласуются заново в приложении.

## Опоры через платного провайдера в том же workflow

Image-ветка не меняет линейный порядок видео: `description_review` или `keyframes_review → image_request_choice → image_submitted → image_downloaded → keyframes_review`. Прямой путь `description_review → keyframes_review` остаётся для опор без платного провайдера: ручного импорта и кандидатов текстового агента. Подготовка/стоимость/отправка принадлежат [media_request](../media_request/README.md), `cost_check` и приложению; инструмент workflow не вызывает сервис и не считает `send` самой отправкой.

```sh
python3 -B tools/shot_workflow/shot_workflow.py set-image-request --dir plan/batches/M32-attempt-01 --frame K01 --request-dir image-01
python3 -B tools/shot_workflow/shot_workflow.py decide --dir plan/batches/M32-attempt-01 --verdict send
# После отдельного подтверждения SHA/стоимости и фактической отправки приложения:
python3 -B tools/shot_workflow/shot_workflow.py set-stage --dir plan/batches/M32-attempt-01 image_submitted
# После resume той же попытки и сохранения оригиналов:
python3 -B tools/shot_workflow/shot_workflow.py set-stage --dir plan/batches/M32-attempt-01 image_downloaded
python3 -B tools/shot_workflow/shot_workflow.py select-image --dir plan/batches/M32-attempt-01 --file image-01/original.png
```

`set-image-request` проверяет замороженную попытку `media_request` с `kind=image` той же сцены и провайдером с подключённым адаптером, SHA запроса/промпта/входов, статус `prepared` без generation ID и существующую непринятую опору. Путь запроса относителен пакету. Команда добавляет запись `{frame_id, request_dir, request_sha256, provider}` с провайдером из самого запроса в `image_requests`, назначает активные `image_request_dir`/`image_frame_id`, выставляет `image_request_choice` и штатный вопрос `send/park/revise`. Факт принятия описания хранится в `description_approved`: `approve` описания ставит `true`, `revise` — `false`; без поля `true` подготовка изображения недоступна. Это позволяет последовательно готовить K01/K02, когда последний ответ уже относится к image-запросу. Поле видео `request_dir`, неизвестные поля и прежние записи истории сохраняются; изменять назначение/хеш существующей записи нельзя.

Новая опора может заменить активный запрос только пока он не отправлен либо после выбора его полученного оригинала. При `select-image` существующая запись истории получает `selected_sha256` выбранного оригинала и `selected_at`; это факт выбора пользователем, не художественное принятие. Для прошлой downloaded-попытки SHA проверяется по сохранённым downloads даже после изменения описания, удаления/переименования опор и сброса candidate path. Запись без `selected_sha256` считается невыбранной: следующую опору подготовить нельзя, пока результат не выбран. `submitting`/`submission_unknown` и отправленная попытка без выбранного результата блокируют переключение: требуется восстановление/`resume` прежней попытки, а не повторный `submit`. Переход `image_submitted` требует отдельного ответа `send` и уже записанного состояния отправки в `attempt.json`; `image_downloaded` — статуса `downloaded` и сохранённого ID либо признака `manual_result` (оригинал загружен пользователем после неизвестного исхода). `set-stage --request-dir` для image-этапов запрещён, чтобы не затереть video request. Ни одна из этих команд не изменяет attempt или его платные оригиналы.

`select-image --file` принимает абсолютный путь либо путь относительно пакета **только из `downloads` активной downloaded-попытки**. Pillow проверяет настоящий PNG/JPEG/WebP и соответствие расширения; файл копируется без перекодировки в `keyframes/Kxx.ext`. Оригинал и принятые опоры не перезаписываются, кандидат получает SHA и `approved: false`. Этап возвращается в `keyframes_review`, прежние `pending_decision`/`decision` очищаются; автоматического принятия или вопроса нет. После выбора всех нужных опор приложение отдельно вызывает `ask --stage keyframes_review`. Для следующей непринятой Kxx создаётся новый запрос и отдельное подтверждение расхода. Ответ `revise` на `keyframes_review` очищает только `path`/`sha256` непринятых кандидатов в workflow: файлы, уже принятые опоры и история выбора оригиналов сохраняются. Повторные K01/K02 готовятся последовательно, каждая с отдельным подтверждением.

Ответы `park/revise` не сбрасывают попытку и не дают разрешения на повторную оплату. `park` переносит подготовленный image-пакет в `plan/awaiting/Mxx`, сохраняя image-этап и относительные ссылки даже без видео-запроса. Повторный `set-image-request` той же prepared-попытки снова показывает вопрос без дублирования истории. Image-поля необязательны: пакет, опоры которого не заказывались у провайдера, их не содержит. `show --json` дополнительно возвращает image-поля и `image_attempt_status`.

## Тесты

Полный цикл от `init` до очереди, правила длительности и обязательный `generation.video`, предел промпта из адаптера тестового провайдера, сохранение принятых опор при перепланировании, обнаружение изменённых байтов и изменившейся постановки, словарь переходов и запрет папок вне рабочих. Согласование опор по одной: вопрос `--frame`, принятие и доработка одной опоры при нескольких кандидатах, замечания со `scope`, `reopen` (и отказ после принятия промпта), `set-note`, CLI и схема `workflow.json`.

```sh
python3 -B tools/shot_workflow/test_shot_workflow.py
python3 -B tools/run_tests/run_tests.py --only test_shot_workflow
```

Image-ветка: `python3 -B tools/shot_workflow/test_shot_workflow_images.py`; локальные frozen fixtures проверяют последовательные Kxx, отдельные вопросы/решения, настоящий media-файл, перенос в очередь, сохранность видео/оригиналов/принятых опор и запрет повторного submit при неизвестном исходе. Сервисы генерации не вызываются.

Дополнительный протокол решений: `python3 -B tools/shot_workflow/test_shot_workflow_decisions.py`. Проверяются кандидаты опор, `ask/decide` и отсутствие отправки при `send`.

Тесты находятся рядом со скриптом; рабочие сцены не изменяют. Для полного набора — [run_tests](../run_tests/README.md).

## Согласования с приложением

Пакет всегда ведёт приложение: вопрос следующего согласования оно записывает командой `ask`, пользователь отвечает кнопками на странице «Производство», а продолжение после ответа выполняет само приложение. Протокол живёт в `workflow.json` пакета: поля `pending_decision` (вопрос приложению) и `decision` (ответ). Это прежние этапы workflow, отдельное состояние не вводится.

```sh
python3 -B tools/shot_workflow/shot_workflow.py propose --dir plan/batches/M32-attempt-01 K01 /tmp/k01.png
python3 -B tools/shot_workflow/shot_workflow.py ask --dir plan/batches/M32-attempt-01 --stage keyframes_review
python3 -B tools/shot_workflow/shot_workflow.py decide --dir plan/batches/M32-attempt-01 --verdict revise --note "Убрать лишнюю руку"
# Согласование опор по одной и замечания к ним:
python3 -B tools/shot_workflow/shot_workflow.py ask --dir plan/batches/M32-attempt-01 --stage keyframes_review --frame K02
python3 -B tools/shot_workflow/shot_workflow.py decide --dir plan/batches/M32-attempt-01 --verdict revise --note "Фонарь левее" --note-scope frame
python3 -B tools/shot_workflow/shot_workflow.py reopen --dir plan/batches/M32-attempt-01 K01 --note "Теплее свет"
python3 -B tools/shot_workflow/shot_workflow.py set-note --dir plan/batches/M32-attempt-01 --id 2 --active false
```

- `propose K01 ПУТЬ` регистрирует кандидата опоры: файл копируется в `frames/`, `approved: false`; принятие делает пользователь. Этап `description_review` переходит в `keyframes_review`.
- `ask --stage <этап> [--question …] [--options a,b]` записывает вопрос для приложения и очищает прежний ответ; этап не меняется. Этапы: `description_review`, `keyframes_review`, `prompt_review`, `request_choice`, `downloaded`, `edit_review`, `image_request_choice`; варианты по умолчанию зависят от этапа (`approve`/`revise`, для запроса `send`/`park`/`revise`, для результата `accept`/`retry`/`review`/`revise`).
- `decide --verdict … [--note …] [--json]` пишет ответ (с `--json` печатает записанный `decision`); его вызывает приложение. На `keyframes_review` ответ `approve` принимает всех кандидатов опор, на `prompt_review` принимает промпт (`approve-prompt`). Остальные ответы только записываются: отправку, сохранение в очередь, приёмку и повтор выполняет приложение.
- `ask --stage keyframes_review --frame Kxx` задаёт вопрос об одной опоре «Утвердить опору Kxx?» (`approve`/`revise`) и пишет `frame` в `pending_decision`. Опора должна входить в план, иметь кандидата (`path`) и быть неутверждённой; `--frame` на других этапах — ошибка.
- При вопросе об одной опоре `decide --verdict approve` утверждает только её (файл и SHA кандидата проверяются, запись в `approved_frames`); остальные кандидаты ждут своих вопросов. `decide --verdict revise --note ТЕКСТ [--note-scope frame|following]` снимает кандидата только этой опоры (`path`/`sha256` = `null`, `approved: false`, файл остаётся в пакете). Без `frame` ответ `revise` по-прежнему снимает всех неутверждённых кандидатов.
- Непустое замечание ответа `revise` на `keyframes_review` добавляется в обязательный список `keyframe_notes` (у нового пакета `[]`): `{id, frame, note, scope, active, at}`. `id` — номер подряд с 1 в пакете, `frame` — опора вопроса или `null` для ответа по всем кандидатам, `scope` — `frame` (только эта опора) или `following` (эта и все следующие генерации опор пакета, по умолчанию), `active` — учитывается ли замечание. Учитывает замечания при генерации приложение; инструмент только хранит их. Пакет без `keyframe_notes` не читается: его нужно привести к актуальному формату.
- `reopen Kxx --note ТЕКСТ [--note-scope frame|following]` возвращает утверждённую опору на доработку с обязательным непустым замечанием: опора становится неутверждённой, кандидат снимается (файл остаётся), запись удаляется из `approved_frames`, `prompt.approved` и `approved_prompt_sha256` сбрасываются (промпт строился по прежним опорам), этап — `keyframes_review`, вопрос очищается, `decision` = `{stage: keyframes_review, verdict: revise, note, at}`. Допустимо, только пока видеопромпт не утверждён и нет `request_dir`, и на этапах `keyframes_review`, `prompt_review`, `image_request_choice`, `needs_revision` (не во время отправки изображения); иначе ошибка с объяснением, а для готового промпта — исправленная попытка `init --retry-of`.
- `set-note --id N --active true|false` включает или выключает замечание.
- `show` выводит активные замечания, `show --json` и `check --json` включают `pending_decision`, `decision` и `keyframe_notes`. Само решение `send` не запускает генерацию: это только ответ на вопрос, отправку отдельно выполняет приложение по правилам согласования точного запроса.
