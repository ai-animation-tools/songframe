# testing

Служебные модули тестов комплекса; в работе с клипом не используются и самостоятельными инструментами не являются.

| Модуль | Назначение |
| --- | --- |
| [sample_project.py](sample_project.py) | Копия [проекта-образца](../testdata/README.md) как `SONGFRAME_PROJECT` для тестов с настоящим реестром: `import tools.testing.sample_project` до импорта инструментов. `run_tests` делает это для всего набора; заданная снаружи переменная сохраняется. Без заданного снаружи `SONGFRAME_LOCAL_DIR` каталог состояния тоже временный, чтобы тесты не писали в userData. |
| [fake_media_request.py](fake_media_request.py) | Тестовый адаптер провайдера генерации `test` для [media_request](../media_request/README.md#адаптеры) без сети и платных запросов. |

## Тестовый провайдер `test`

Подключается только тестами: `SONGFRAME_MEDIA_ADAPTERS="test=tools.testing.fake_media_request"` добавляет его в [таблицу адаптеров](../media_adapters.py). Python-тесты вызывают `fake_media_request.enable(self, **конфигурация)`: функция создаёт временную папку с `service.json`, на время теста задаёт обе переменные окружения и `SONGFRAME_LOCAL_DIR=<эта папка>/state` (наблюдения цен и прочее состояние провайдера) и возвращает объект с `directory`, `configure(**поля)` и `calls(action=None)`. Интеграционный тест приложения задаёт переменные сам до запуска Python через `PythonLauncher`:

```sh
SONGFRAME_MEDIA_ADAPTERS=test=tools.testing.fake_media_request
SONGFRAME_TEST_MEDIA_SERVICE=/tmp/…/service.json
```

Поведение задаёт JSON-файл из `SONGFRAME_TEST_MEDIA_SERVICE`; файл читается при каждом вызове, его можно менять между шагами. Без переменной используются значения по умолчанию, а журнал пишется в `<временная папка ОС>/songframe-test-media`. Все поля необязательны; относительные пути отсчитываются от папки файла.

```json
{
  "reports": {"image": [{"command": "text_to_image", "models": {}}], "video": [{"command": "image_to_video", "models": {}}]},
  "problems": {"video": [{"command": "motion_control", "message": "Команда недоступна."}]},
  "capabilities": "error",
  "submit": {"generation_id": "job-1", "credits_consumed": 4},
  "poll": [{"status": "running"}, {"status": "completed"}],
  "results": {"video": "original.mp4", "image": "original.png"},
  "balance": 1000,
  "pricing": "pricing.json"
}
```

- `reports`, `problems` — ответ `capabilities` по видам медиа в формате [media_request](../media_request/README.md#контракт). По умолчанию: `image` — `text_to_image` и `image_to_image` с моделью `test-image`, `video` — `text_to_video` и `image_to_video` с моделью `test-video` (аргументы `duration`, `resolution`, `aspect_ratio`; слоты `image_1`/`image_2` и `first_image`/`tail_image`). `"capabilities": "error"` — отказ discovery.
- `submit` — объект `{generation_id?, credits_consumed?}` (по умолчанию `test-generation-<номер отправки>` без расхода), `"unknown"` — неизвестный исход, `{"reject": "причина"}` — явный отказ без создания задания, `"not_submitted"` — сервис недоступен, отправка не начиналась.
- `poll` — объект `{status, service_status?, outputs?}` или список таких объектов: n-й опрос того же ID берёт n-й элемент, после конца списка — последний. `status`: `running`, `outputs_pending`, `watermark_free_pending`, `failed`, `completed` (по умолчанию). `"error"` — отказ опроса.
- `results` — локальные файлы результата по видам медиа, копируются без изменения байтов для каждого из `outputs`. Без них сохраняются встроенные минимальные файлы с сигнатурами MP4 и PNG 1×1 (для проверок ffmpeg нужен настоящий файл в `results`).
- `balance` — остаток для `cost_check`, `null` — неизвестен. По умолчанию 1000.
- `pricing` — базовая таблица цен (`pricing_file()`) для `cost_check` без `--pricing`; по умолчанию `pricing.json` рядом с конфигурацией, при отсутствии создаётся пустая таблица. Наблюдения `learn` пишутся не в неё, а в `state/providers/test/pricing-observations.json`.

Адаптер принимает любые команды и параметры общей формы, промпт не ограничивает, `FROZEN_FIELDS` пуст.

### Журнал вызовов

Каждый вызов дописывает строку JSON в `calls.jsonl` рядом с конфигурацией; тесты считают по нему отправки и опросы.

| `action` | Поля |
| --- | --- |
| `capabilities` | `kind` |
| `submit` | `work_dir`, `request_sha256`, `provider`, `kind`, `command`, `model`, `parameters`, `outputs`, `inputs` (`flag`, `slot`, `sha256`), `prompt` (точный текст) |
| `poll` | `work_dir`, `generation_id` |
| `fetch` | `output` (путь файла результата или `builtin:<вид>`) |
| `account` | — |
