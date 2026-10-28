# media_request

Ведёт одну попытку генерации изображения или видео у выбранного провайдера: читает возможности аккаунта, готовит неизменяемую попытку, отправляет её, ждёт и получает оригиналы, принимает найденный пользователем результат при неизвестном исходе. Инструмент вызывает приложение после подготовки кадров и согласования точного запроса на странице «Производство»; разработчик при отладке запускает его из checkout. Сервис инструменту не известен: команды, разбор ответов и загрузку выполняет адаптер провайдера из [таблицы адаптеров](../media_adapters.py). Скрипт не выбирает модель, не узнаёт цену, не подтверждает запрос вместо пользователя и не анализирует видео.

## Контракт

Из корня checkout комплекса, для выбранного проекта (или с `--project <папка>`):

```sh
python3 -B tools/media_request/media_request.py capabilities --provider PROVIDER --kind video --json
python3 -B tools/media_request/media_request.py prepare --request /tmp/request.json --work-dir plan/batches/M32-attempt-01/request
python3 -B tools/media_request/media_request.py submit --work-dir plan/batches/M32-attempt-01/request --confirm REQUEST_SHA256
python3 -B tools/media_request/media_request.py resume --work-dir plan/batches/M32-attempt-01/request [--wait-seconds 45 --interval 15]
python3 -B tools/media_request/media_request.py watch --work-dir plan/batches/M52-attempt-01/request plan/batches/M55-attempt-01/request --max-minutes 15 [--interval 20]
python3 -B tools/media_request/media_request.py status --work-dir plan/batches/M32-attempt-01/request
python3 -B tools/media_request/media_request.py attach --work-dir plan/batches/M32-attempt-01/request --file ~/Загрузки/result.mp4
python3 -B tools/media_request/media_request.py not-created --work-dir plan/batches/M32-attempt-01/request
python3 -B tools/media_request/media_request.py login --provider PROVIDER [--no-browser] [--timeout 300]
python3 -B tools/media_request/media_request.py auth-status --provider PROVIDER --json [--timeout 30]
```

Провайдер `prepare` берёт из `spec.provider`, остальные действия — из `provider` замороженного `request.json`. Провайдер без адаптера отклоняется до создания папки и до обращения к сервису. Все действия печатают JSON в stdout; ошибка — код 1 и одна строка в stderr без сырого вывода сервиса. `submit`, `resume`, `watch` и `capabilities` принимают `--timeout` (секунды на один вызов сервиса, по умолчанию 60).

- `capabilities --provider P --kind image|video --json` — свежие объявления моделей аккаунта для команд этого вида медиа; набор команд знает адаптер. Без `--json` печатается краткий список «команда: модели». Генерации нет. Ошибка общего discovery — код 1; неверное объявление отдельной команды попадает в `problems`, не скрывая остальные:

  ```json
  {
    "reports": [
      {"command": "image_to_video", "models": {"MODEL": {"arguments": {"duration": {"default": "5", "allowed": ["5", "10"]}}, "slots": {"first_image": {"required": true}}, "limits": {}}}}
    ],
    "problems": [{"command": "motion_control", "message": "Команда не объявлена в tool_list текущего аккаунта."}]
  }
  ```

  У аргумента и слота возможны `required`, `default`, `description`, `allowed`, `max_items`; в `limits` — ограничения модели в именах адаптера.

- `login --provider P` — вход к провайдеру (обычно в браузере); `--no-browser` только печатает адрес входа. Вывод — `{"ok", "message"}`, при `ok: false` код 1. `auth-status --provider P --json` — `{"status": "authenticated" | "unauthenticated" | "unknown", "message"?}` без генерации. Оба действия вызывают необязательные функции адаптера `login` и `auth_status`; у провайдера без них — понятная ошибка. Проект для них не нужен: приложение вызывает их со страницы «Среда».

- `prepare` работает без сети и создаёт новую папку попытки с точным промптом, входами и хешами по [формату запроса](request-format.md). Перед созданием папки адаптер проверяет ограничения своего сервиса и промпта. Вывод — замороженный `request.json` и сведения для таблицы согласования:

  ```json
  {"schema_version": 1, "shot": "M32", "provider": "PROVIDER", "kind": "video", "command": "image_to_video", "model": "MODEL",
   "parameters": {"duration": 6}, "outputs": 1, "inputs": [{"flag": "input", "slot": "image_1", "path": "inputs/01.png", "sha256": "…", "bytes": 1234}],
   "prompt": {"path": "prompt.txt", "sha256": "…"}, "request_sha256": "…", "prompt_text": "…", "work_dir": "/…/request", "warnings": []}
  ```

  Поля адаптера (например признак оригинала без логотипа) входят в замороженный запрос и его SHA; `warnings` — предупреждения адаптера о промпте.

- `submit --confirm SHA` — только после явного разрешения человека на этот SHA: приложение вызывает его после ответа `send` и подтверждения показанных запроса и цены. Флаг согласия не означает; цену и остаток проверяет [cost_check](../cost_check/README.md). Вывод — `attempt.json` после отправки:

  ```json
  {"schema_version": 1, "request_sha256": "…", "status": "submitted", "downloads": [], "generation_id": "…", "credits_consumed": 12}
  ```

  Повторная отправка попытки запрещена, включая `submitting` и `submission_unknown`. Явный отказ сервиса без ID задания оставляет попытку `prepared`, причина сохраняется в `last_rejection`, stderr: «Сервис отклонил запрос до оплаты: … Генерация не создана, кредиты не списаны.» Отсутствие входа, соединения или незавершённая загрузка входов тоже оставляют `prepared` («… отправка не начиналась.»). Любой другой сбой после начала отправки — `submission_unknown`, stderr «Исход отправки неизвестен…».

- `resume` опрашивает только сохранённый ID: по умолчанию один раз, с `--wait-seconds` — повторно в пределах 60 секунд с шагом `--interval`. Готовые результаты сохраняются как `original.*`, после чего статус `downloaded`; иначе статус ожидания (`running`, `outputs_pending`, `watermark_free_pending`) или `failed`. `--generation-id` привязывает известный ID неизвестной отправки (отладка; приложение его не использует). Вручную загруженный результат (`manual_result`) продолжается без ID и без обращения к сервису. `status` читает только локальный журнал.

- `watch` — одно ожидание до 120 минут для одной или нескольких попыток: опрашивает их по очереди, печатает строки `<папка>: <статус>` только при смене статуса, затем JSON `{"<путь папки>": attempt.json | {"status", "detail"}}`. Завершается, когда все попытки достигли `downloaded` или `failed`. Код 2 — хотя бы одна попытка не дошла до `downloaded`/`failed` (истекло время или ошибка попытки); задание не отменяется, повторный `watch` продолжает те же ID. Попытка без ID или с неизвестным исходом сообщается как `{"status": "error", "detail": …}`.

- `attach --file <файл…>` — только для `submitting`/`submission_unknown` без ID и без скачанных файлов: пользователь нашёл генерацию в истории сервиса и скачал оригинал. Число файлов равно `outputs`; видео проверяется по сигнатуре MP4, изображение — PNG/JPEG/WebP. Файлы копируются без перекодирования в `original.*`, попытка получает `downloaded` и `manual_result: true`; сервис не вызывается.

- `not-created` — для той же попытки, когда генерации в истории нет: статус возвращается в `prepared`, `submit` снова возможен один раз после нового согласия. Решение пользователя (`manual_result` или `not_created`) с временем добавляется в `unknown_outcomes`.

Папка попытки — внутри `plan/batches`, `plan/awaiting` или временной папки ОС (`tempfile.gettempdir()`: `/tmp` на Linux, `%TEMP%` на Windows); сами корни не могут быть попыткой. Целиком перенесённая попытка сохраняет SHA и допускает `status`, `submit` и `resume` по новому пути; отложенные пакеты — по [правилам очереди](../../templates/project/plan/awaiting/README.md). Блокировка попытки неблокирующая: Linux использует `flock`, Windows — один байт `.lock` через `msvcrt.locking`; занятая попытка отклоняется.

## Адаптеры

[tools/media_adapters.py](../media_adapters.py) содержит `ADAPTERS = {id: модуль}` и `adapter(provider)`: id сравнивается без учёта регистра и пробелов по краям, неизвестный провайдер — `ValueError`. Добавление провайдера — строка таблицы и папка адаптера, удаление — обратное. Общий код инструментов (`media_request`, [cost_check](../cost_check/README.md), [regenerate_shot](../regenerate_shot/README.md), [shot_workflow](../shot_workflow/README.md), [lint_registry](../lint_registry/README.md)) узнаёт сервисы только отсюда.

Модуль адаптера предоставляет:

| Имя | Назначение и результат |
| --- | --- |
| `FROZEN_FIELDS` | Словарь полей, добавляемых в замороженный `request.json` и его SHA (может быть пустым). |
| `validate_spec(spec)` | Ограничения сервиса поверх общей формы спецификации; нарушение — `ValueError`. |
| `validate_prompt(prompt)` | Проверка текста промпта; недопустимый — `ValueError`, иначе список предупреждений. |
| `capabilities(kind, timeout=60)` | `{"reports": [{"command", "models"}], "problems": [{"command", "message"}]}` для команд вида медиа. |
| `submit(directory, request, state, timeout)` | Отправка; результат `{"generation_id", "credits_consumed"?}`. Явный отказ — `attempt.RejectedRequest(краткая причина)`, отправка не начиналась — `attempt.NotSubmitted`, любое другое исключение — неизвестный исход. |
| `poll(directory, request, state, timeout)` | `{"status", "service_status"?, "outputs"?}`: `status` — `running`, `outputs_pending`, `watermark_free_pending`, `failed` или `completed` с непрозрачными `outputs` по числу результатов. Ошибка — исключение. |
| `fetch(output, destination)` | Записывает полные байты одного результата в новый файл; публикацию без перезаписи, сигнатуры и журнал ведёт общий код. |
| `account(timeout=60)` | `{"balance": число или None, "source": имя поля или причина}` для `cost_check`. |
| `pricing_file()` | Путь базовой таблицы цен провайдера для `cost_check`; файл в поставке только читается, наблюдения расхода общий код хранит в каталоге состояния ([cost_check](../cost_check/README.md#таблица-цен-и-наблюдения)). |
| `normalize_inputs(spec)` | Необязательная: приводит входы спецификации из неизменного снимка оплаченной отправки прежнего формата к именованным слотам перед повтором; вызывает [regenerate_shot](../regenerate_shot/README.md) до проверки и создания пакета, нет подходящего слота — `ValueError`. Единственное разрешённое чтение прежнего формата, описанное в README адаптера. |
| `snapshot_warnings(snapshot)` | Необязательная: список `(поле, текст)` предупреждений о снимке принятого комплекта для `lint_registry`. |
| `PROMPT_WARNING_CHARS` | Необязательная константа: целый предел длины промпта сервиса. [shot_workflow](../shot_workflow/README.md) `approve-prompt` предупреждает о более длинном видеопромпте провайдера `generation.video`; нет константы — нет предупреждения. Отказ по длине при подготовке остаётся делом `validate_prompt`. |
| `TASK_TRACE_ID` | Необязательная константа: `True` — общий код записывает в `attempt.json` UUID v7 попытки `task_trace_id` до вызова `submit`, адаптер передаёт его сервису. |
| `login(open_browser=True, timeout=300)` | Необязательная: вход к провайдеру, `{"ok", "message"}` без исключений. |
| `auth_status(timeout=30)` | Необязательная: `{"status", "message"?}`, где `status` — `authenticated`, `unauthenticated` или `unknown`. |

Подключённые адаптеры перечислены в таблице; README каждого описывает ограничения своего сервиса. Тестовый адаптер `test` — [tools/testing](../testing/README.md); тесты добавляют его переменной `SONGFRAME_MEDIA_ADAPTERS="test=tools.testing.fake_media_request"` (список `id=module` через запятую дополняет таблицу).

## Тесты

Общий жизненный цикл проверяется на тестовом провайдере без сети: таблица адаптеров и тестовый хук, подготовка с точными байтами и стабильным SHA, обязательный провайдер с адаптером, выбор модели в SHA, правила рабочей папки и перенос в очередь, дедупликация входов, подтверждение SHA и неизменность входов, единственная отправка, `task_trace_id` попытки у объявившего его адаптера, неизвестный исход, явный отказ и недоступный сервис без расхода попытки, ручной ID, `attach`/`not-created`, замок Linux/Windows, статусы ожидания и ошибки опроса, частичное и прерванное получение, атомарная публикация без перезаписи, PNG/JPEG/WebP по сигнатуре и восстановление до/после публикации, `watch`, а также JSON-вывод CLI.

```sh
python3 -B tools/media_request/test_media_request.py
python3 -B tools/run_tests/run_tests.py --only test_media_request
```
