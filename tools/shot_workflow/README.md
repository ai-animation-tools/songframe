# shot_workflow

Ведёт `workflow.json` рабочего пакета одного плана: создание, план опор, принятие кадров и промпта, этапы, перенос в очередь и проверку целостности. Использовать по скиллу вместо ручного редактирования JSON; формат пакета остаётся контрактом [README очереди](../../templates/project/plan/awaiting/README.md). Инструмент не обращается к Kling и не трогает assets.

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

Единый порядок этапов: `description_review → keyframes_review → prompt_review → request_choice → ready → submitted → downloaded → edit_review → accepted`; `needs_revision` достижим с любого этапа и возвращает к согласованию. Вперёд разрешён только следующий этап (а также `request_choice → submitted` после «отправить» и `downloaded → accepted` без обработки), назад — любой. Этапы `ready` и `needs_revision` требуют причину ожидания: `user_saved`, `insufficient_balance`, `cost_or_balance_unknown`. Прежние покадровые названия `first_frame_review`, `keyframe_review`, `last_frame_review` читаются как `keyframes_review`. Названия этапов и причин совпадают с [shot_status](../shot_status/README.md) и [cost_check](../cost_check/README.md).

`init` берёт окно и кадры из реестра и записывает `scene_sha256` из `scene_registry`; `--mode shot` или `frame` фиксирует режим согласования, `--batch ИМЯ` помечает пакет как часть партии независимых планов (имя показывается в `show`). У каждого плана партии свой пакет, своя таблица запроса и своя отправка. `plan-keyframes` строит каркас опор: `K01` первый кадр, промежуточные по времени с заметкой, последняя на границе длительности запроса; длительность задаётся целым числом секунд по `generation.video.duration_rule` проекта (в старом формате `generation.duration_rule`): строго больше окна, не меньше окна либо ровно окно (`exact_window`). Без блока `generation` сохраняется прежнее правило строгого превышения. Для `exact_window` дробное монтажное окно диагностируется: инструмент не округляет его молча. Инструмент проверяет соотношение с окном; поддерживаемую длительность выбранной модели проверяет подготовка запроса. Повторное планирование сохраняет принятые опоры с той же ролью и временем. `approve` копирует принятый кадр в `frames/` пакета, если он лежит снаружи, записывает SHA-256 и обновляет `approved_frames` и `current_keyframe`. `approve-prompt` принимает файл промпта из пакета после всех опор и предупреждает о тексте длиннее 2 500 символов. `park` переносит пакет в `plan/awaiting/Mxx` только после проверки хешей и наличия подготовленного запроса. `show` и `check` сообщают проблемы: изменение постановки или унаследованного состояния после подготовки, изменённые или отсутствующие файлы опор и промпта, отсутствие `request.json`; `check` возвращает код 1 при проблемах.

Для исправленной попытки `init --retry-of ПАКЕТ` записывает ссылку `retry_of` на существующий пакет того же плана, сохраняя его без изменений. Совместимые утверждённые опоры переносятся через `approve`; промпт и платный запрос согласуются заново по скиллу.

## Опоры через Kling в том же workflow

Image-ветка не меняет линейный порядок видео: `description_review` или `keyframes_review → image_request_choice → image_submitted → image_downloaded → keyframes_review`. Прежний прямой путь `description_review → keyframes_review` для ручного импорта и Codex сохраняется. Подготовка/стоимость/отправка принадлежат `kling_request`, `cost_check` и приложению; инструмент workflow не вызывает сервис и не считает `send` самой отправкой.

```sh
python3 -B tools/shot_workflow/shot_workflow.py set-image-request --dir plan/batches/M32-attempt-01 --frame K01 --request-dir image-01
python3 -B tools/shot_workflow/shot_workflow.py decide --dir plan/batches/M32-attempt-01 --verdict send
# После отдельного подтверждения SHA/стоимости и фактической отправки приложения:
python3 -B tools/shot_workflow/shot_workflow.py set-stage --dir plan/batches/M32-attempt-01 image_submitted
# После resume той же попытки и сохранения оригиналов:
python3 -B tools/shot_workflow/shot_workflow.py set-stage --dir plan/batches/M32-attempt-01 image_downloaded
python3 -B tools/shot_workflow/shot_workflow.py select-image --dir plan/batches/M32-attempt-01 --file image-01/original.png
```

`set-image-request` проверяет frozen request `kind=image` той же сцены, SHA запроса/промпта/входов, статус `prepared` без generation ID и существующую непринятую опору. Путь запроса относителен пакету. Команда добавляет запись `{frame_id, request_dir, request_sha256, provider: "kling"}` в `image_requests`, назначает активные `image_request_dir`/`image_frame_id`, выставляет `image_request_choice` и штатный вопрос `send/park/revise`. Факт принятия описания хранится в `description_approved`: `approve` описания ставит `true`, `revise` — `false`; старый пакет без поля использует прежнее решение `description_review/approve`. Это позволяет последовательно готовить K01/K02, когда последний ответ уже относится к image-запросу. Сохраняется текущий `executor` (`app` или `agent`; без поля — `agent`), чужой ожидающий вопрос сначала требует ответа. Поле видео `request_dir`, неизвестные поля и прежние записи истории сохраняются; изменять назначение/хеш существующей записи нельзя.

Новая опора может заменить активный запрос только пока он не отправлен либо после выбора его полученного оригинала. При `select-image` существующая запись истории получает `selected_sha256` выбранного оригинала и `selected_at`; это факт выбора пользователем, не художественное принятие. Для прошлой downloaded-попытки SHA проверяется по сохранённым downloads даже после изменения описания, удаления/переименования опор и сброса candidate path. Старые пакеты без поля используют совпадающие candidate path/hash, после успешной проверки SHA выбора сохраняется в истории. `submitting`/`submission_unknown` и отправленная попытка без выбранного результата блокируют переключение: требуется восстановление/`resume` прежней попытки, а не повторный `submit`. Переход `image_submitted` требует отдельного ответа `send` и уже записанного состояния отправки в `attempt.json`; `image_downloaded` — сохранённого ID и статуса `downloaded`. `set-stage --request-dir` для image-этапов запрещён, чтобы не затереть video request. Ни одна из этих команд не изменяет attempt или его платные оригиналы.

`select-image --file` принимает абсолютный путь либо путь относительно пакета **только из `downloads` активной downloaded-попытки**. Pillow проверяет настоящий PNG/JPEG/WebP и соответствие расширения; файл копируется без перекодировки в `keyframes/Kxx.ext`. Оригинал и принятые опоры не перезаписываются, кандидат получает SHA и `approved: false`. Этап возвращается в `keyframes_review`, прежние `pending_decision`/`decision` очищаются; автоматического принятия или вопроса нет. После выбора всех нужных опор приложение отдельно вызывает `ask --stage keyframes_review`. Для следующей непринятой Kxx создаётся новый запрос и отдельное подтверждение расхода. Ответ `revise` на `keyframes_review` очищает только `path`/`sha256` непринятых кандидатов в workflow: файлы, уже принятые опоры и история выбора оригиналов сохраняются. Повторные K01/K02 готовятся последовательно, каждая с отдельным подтверждением.

Ответы `park/revise` не сбрасывают попытку и не дают разрешения на повторную оплату. `park` переносит подготовленный image-пакет в `plan/awaiting/Mxx`, сохраняя image-этап и относительные ссылки даже без видео-запроса. Повторный `set-image-request` той же prepared-попытки снова показывает вопрос без дублирования истории. Старые workflow без image-полей читаются как прежде; `show --json` дополнительно возвращает image-поля и `image_attempt_status`.

## Тесты

Полный цикл от `init` до очереди, сохранение принятых опор при перепланировании, обнаружение изменённых байтов и изменившейся постановки, словарь переходов и запрет папок вне рабочих.

```sh
python3 -B tools/shot_workflow/test_shot_workflow.py
python3 -B tools/run_tests/run_tests.py --only test_shot_workflow
```

Image-ветка: `python3 -B tools/shot_workflow/test_shot_workflow_images.py`; локальные frozen fixtures проверяют последовательные Kxx, отдельные вопросы/решения, настоящий media-файл, перенос в очередь, сохранность видео/оригиналов/принятых опор и запрет повторного submit при неизвестном исходе. Сервисы генерации не вызываются.

Дополнительный протокол решений и оба исполнителя: `python3 -B tools/shot_workflow/test_shot_workflow_decisions.py`. Проверяются прежние Python-вызовы, `ask/wait`, сохранение владельца после ответа и отсутствие отправки Kling при `send`.

Тесты находятся рядом со скриптом; рабочие сцены не изменяют. Для полного набора — [run_tests](../run_tests/README.md).

## Согласования с приложением

Решения пользователь принимает кнопками в приложении комплекса (страница «Производство»), а агент ждёт ответа, не засоряя чат. Протокол живёт в `workflow.json` пакета: поля `pending_decision` (вопрос приложению), `decision` (ответ) и `executor` (владелец продолжения). Это прежние этапы workflow, отдельное состояние не вводится.

```sh
python3 -B tools/shot_workflow/shot_workflow.py propose --dir plan/batches/M32-attempt-01 K01 /tmp/k01.png
python3 -B tools/shot_workflow/shot_workflow.py ask --dir plan/batches/M32-attempt-01 --stage keyframes_review --executor agent
python3 -B tools/shot_workflow/shot_workflow.py wait --dir plan/batches/M32-attempt-01 --timeout 1800
python3 -B tools/shot_workflow/shot_workflow.py decide --dir plan/batches/M32-attempt-01 --verdict revise --note "Убрать лишнюю руку"
```

- `propose K01 ПУТЬ` регистрирует кандидата опоры: файл копируется в `frames/`, `approved: false`; принятие делает пользователь. Этап `description_review` переходит в `keyframes_review`.
- `ask --stage <этап> [--question …] [--options a,b] [--executor agent|app]` записывает вопрос для приложения и очищает прежний ответ. `agent` по умолчанию сохраняет ручной `ask/wait`; `app` передаёт продолжение приложению. Значение записывается в `workflow.json` как top-level `executor` и `pending_decision.executor`, остаётся после решения и не меняет этап. Старые пакеты без поля читаются как `agent`. Python API добавляет `executor` после `root`, сохраняя прежние позиционные вызовы. Этапы: `description_review`, `keyframes_review`, `prompt_review`, `request_choice`, `downloaded`, `edit_review`, `image_request_choice`; варианты по умолчанию зависят от этапа (`approve`/`revise`, для запроса `send`/`park`/`revise`, для результата `accept`/`retry`/`review`/`revise`).
- `decide --verdict … [--note …]` пишет ответ; его вызывает приложение. На `keyframes_review` ответ `approve` принимает всех кандидатов опор, на `prompt_review` принимает промпт (`approve-prompt`). Остальные ответы только записываются: отправку, сохранение в очередь, приёмку и повтор выполняет агент (если он ждёт) или приложение (если задан `executor=app`).
- `wait [--timeout СЕК] [--interval СЕК]` блокирует выполнение до ответа на текущий вопрос и печатает его JSON (`stage`, `verdict`, `note`, `at`). Код выхода 0 ответ получен, 2 время вышло (вопрос остаётся, можно ждать дальше), 3 этап пакета изменён снаружи. Без ожидающего вопроса команда отдаёт последний ответ или завершается ошибкой «сначала ask».
- `show --json` включает `executor`, `pending_decision` и `decision`. Само решение `send` не запускает Kling: это только ответ на вопрос, отправку отдельно выполняет владелец продолжения по правилам согласования точного запроса.
