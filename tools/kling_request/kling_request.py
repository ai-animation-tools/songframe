"""Адаптер провайдера генерации Kling для media_request; @link README.md

Знает команды и ограничения Kling, собирает вызовы MCP-сервера через клиент kling_mcp, разбирает ответы,
выбирает адреса оригиналов без логотипа, читает остаток аккаунта и выполняет вход. Состояние попытки, замок,
SHA и сохранение оригиналов ведёт общий tools/media_request/attempt.py.
"""

import json
import math
import re
import shutil
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import urlopen

from tools.kling_request import kling_mcp as mcp
from tools.media_request.attempt import NotSubmitted, RejectedRequest, inside

KIND_COMMANDS = {
    "image": ["text_to_image", "image_to_image"],
    "video": ["text_to_video", "image_to_video", "omni_ref_video", "motion_control"],
}
COMMANDS = {command for commands in KIND_COMMANDS.values() for command in commands}
SUCCESS = {"completed", "partial_completed", "succeed", "succeeded", "success"}
FAILED = {"failed", "cancelled", "canceled", "rejected", "error"}
FLAGS = {"input", "image", "tailImage", "audio", "video"}
RESERVED = FLAGS | {"model", "prompt", "rationale", "taskTraceId", "poll", "base-url", "credentials", "token"}
# Модели, объявляющие prefer_multi_shots в who_am_i; у v3_0 значение по умолчанию true,
# поэтому единый план без явного false может получить внутренние склейки. @link README.md#почему
MULTI_SHOT_MODELS = {"kling-video-v3_0", "kling-video-v3_0_omni"}
# У v4_0 разрешение по умолчанию 720p, что ниже настроек проекта: требуем явное значение.
EXPLICIT_RESOLUTION_MODELS = {"kling-video-v4_0"}
# Документированный предел промпта API Kling; поведение сервера при превышении не проверено.
PROMPT_WARNING_CHARS = 2500
# Признак входит в замороженный запрос и его SHA: получаются только оригиналы без логотипа.
FROZEN_FIELDS = {"video_without_watermark": True}
# Общий код сохраняет в attempt.json UUID v7 попытки: он уходит с каждым вызовом как taskTraceId.
TASK_TRACE_ID = True


def validate_spec(spec):
    """Ограничения Kling поверх общей формы спецификации, проверенной request_snapshot."""
    if spec.get("command") not in COMMANDS:
        raise ValueError("Неизвестная команда генерации.")
    if not re.fullmatch(r"[A-Za-z0-9_.-]+", spec.get("model", "")):
        raise ValueError("Не указан точный идентификатор модели.")
    if ("image" if spec["command"].endswith("_image") else "video") != spec["kind"]:
        raise ValueError("Вид результата не соответствует команде.")
    if "model_selection" in spec:
        preferred = spec["model_selection"]["preferredModel"]
        if preferred is not None and not re.fullmatch(r"[A-Za-z0-9_.-]+", preferred):
            raise ValueError("preferredModel должен быть точным идентификатором модели или null.")
    parameters = spec.get("parameters", {})
    for name in parameters:
        if (
            not re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]*", name)
            or name in RESERVED
            or any(x in name.lower() for x in ("token", "credential", "password", "base_url"))
        ):
            raise ValueError("Недопустимый параметр команды; файлы передаются через inputs.")
    if spec["kind"] == "video" and spec["model"] in MULTI_SHOT_MODELS and "prefer_multi_shots" not in parameters:
        raise ValueError("Для этой модели укажите prefer_multi_shots явно: для единого плана — false.")
    if spec["kind"] == "video" and spec["model"] in EXPLICIT_RESOLUTION_MODELS and "resolution" not in parameters:
        raise ValueError("Для этой модели укажите resolution явно: по умолчанию сервис даёт 720p.")
    count = spec.get("outputs", 1)
    if not 1 <= count <= 9:
        raise ValueError("Неверное число результатов.")
    if "imageCount" in parameters and str(parameters["imageCount"]) != str(count):
        raise ValueError("outputs и imageCount должны совпадать.")
    if not spec["command"].startswith("text_to_") and not spec.get("inputs"):
        raise ValueError("Для этой команды нет входов.")
    slots = set()
    for item in spec.get("inputs", []):
        # Сервер принимает только именованные входы; короткие флаги приложение раскрывает в слоты до SHA.
        if item.get("flag") != "input" or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]*", item.get("slot", "")):
            raise ValueError("Вход должен быть именованным слотом: flag=input и slot из объявления модели.")
        if item["slot"] in slots:
            raise ValueError("Один входной слот указан дважды.")
        slots.add(item["slot"])


def validate_prompt(prompt):
    """Промпт уходит отдельным аргументом prompt; длинный текст только предупреждает."""
    if len(prompt) > PROMPT_WARNING_CHARS:
        return [
            f"Промпт длиннее {PROMPT_WARNING_CHARS} символов ({len(prompt)}): "
            "сервис может обрезать или ослабить хвост текста."
        ]
    return []


def capability_fields(values):
    """Сохраняет объявленные параметры и слоты, нормализуя только имена полей контракта приложения."""
    if not isinstance(values, list):
        raise ValueError("who_am_i вернул неверное объявление параметров или слотов.")
    fields = {}
    for value in values:
        if (
            not isinstance(value, dict)
            or not isinstance(value.get("name"), str)
            or not value["name"]
            or value["name"] in fields
            or ("required" in value and not isinstance(value["required"], bool))
        ):
            raise ValueError("who_am_i вернул неверное объявление параметров или слотов.")
        entry = {key: value[key] for key in ("required", "default", "description") if key in value}
        allowed = value.get("allowedValues", value.get("allowed_values"))
        if allowed is not None:
            if not isinstance(allowed, list) or any(not isinstance(item, str) for item in allowed):
                raise ValueError("who_am_i вернул неверные допустимые значения параметра.")
            entry["allowed"] = allowed
        if "maxItems" in value:
            if type(value["maxItems"]) is not int or value["maxItems"] < 1:
                raise ValueError("who_am_i вернул неверный лимит параметра или слота.")
            entry["max_items"] = value["maxItems"]
        fields[value["name"]] = entry
    return fields


def capability_catalog(timeout, commands=None):
    """Один снимок аккаунта обслуживает все команды: параллельные who_am_i давали случайные частичные ошибки."""
    try:
        session = mcp.Session(timeout)
        tools = session.tools()
        if any(not isinstance(tool, dict) for tool in tools):
            raise ValueError("tools/list вернул неверное объявление команд.")
        body = session.call("who_am_i", {"tools": list(commands)} if commands else {})
    except mcp.AuthRequired as error:
        raise ValueError(f"{error} Объявления моделей недоступны.") from None
    except (mcp.KlingError, OSError):
        raise ValueError(f"Discovery {mcp.TITLE} недоступен: сервер не ответил или ответил ошибкой.") from None
    if not isinstance(body, dict):
        raise ValueError("who_am_i вернул неверный ответ; сырой ответ скрыт.")
    return {tool.get("name") for tool in tools if isinstance(tool.get("name"), str)}, body


def command_capabilities(command, model, tools, body):
    """Проверяет объявление каждой команды отдельно, не теряя остальные корректные модели снимка."""
    if command not in tools:
        raise ValueError("Команда не объявлена в tool_list текущего аккаунта.")
    available = body.get("availableModels", body.get("available_models"))
    if not isinstance(available, dict):
        raise ValueError("who_am_i не вернул объявления моделей.")
    entries = available.get(command, [])
    if isinstance(entries, dict):
        entries = entries.get("models", [])
    if not isinstance(entries, list):
        raise ValueError("who_am_i вернул неверное объявление моделей команды.")
    models = {}
    for value in entries:
        if (
            not isinstance(value, dict)
            or not isinstance(value.get("model"), str)
            or not value["model"]
            or value["model"] in models
        ):
            raise ValueError("who_am_i вернул неверное объявление модели.")
        limits = {
            target: value[source]
            for source, target in (
                ("combinedItemCap", "combined_item_cap"),
                ("combinedItemCaps", "combined_item_caps"),
                ("elementSupport", "element_support"),
            )
            if source in value
        }
        models[value["model"]] = {
            "arguments": capability_fields(value.get("arguments", [])),
            "slots": capability_fields(value.get("inputs", [])),
            "limits": limits,
        }
    if not models:
        raise ValueError(
            "who_am_i не объявил модели для этой команды; обновите возможности и проверьте доступность команды."
        )
    if model is not None:
        if model not in models:
            raise ValueError("Модель не объявлена для этой команды: " + ", ".join(sorted(models)))
        models = {model: models[model]}
    return {"command": command, "models": models}


def capabilities(kind, timeout=60):
    """Согласованный каталог команд вида медиа за два вызова MCP независимо от количества команд."""
    tools, body = capability_catalog(timeout, KIND_COMMANDS[kind])
    reports, problems = [], []
    for command in KIND_COMMANDS[kind]:
        try:
            reports.append(command_capabilities(command, None, tools, body))
        except ValueError as error:
            problems.append({"command": command, "message": str(error)})
    return {"reports": reports, "problems": problems}


# Короткие флаги старых снимков и шаблоны объявленных слотов, в которые они раскрываются (как в приложении).
LEGACY_INPUT_SLOTS = {
    "image": re.compile(r"^(?:first_image|image(?:_\d+)?|keyframe_\d+)$"),
    "tailImage": re.compile(r"^tail_image(?:_\d+)?$"),
    "audio": re.compile(r"^audio(?:_\d+)?$"),
    "video": re.compile(r"^video(?:_\d+)?$"),
}


def normalize_inputs(spec, timeout=60):
    """Раскрывает короткие флаги старых снимков (image, tailImage…) в объявленные слоты модели до заморозки запроса.

    Нужна повтору по снимку, сделанному прежним CLI: отправка принимает только именованные слоты.
    """
    if all(item.get("flag") == "input" for item in spec["inputs"]):
        return spec
    report = command_capabilities(spec["command"], spec["model"], *capability_catalog(timeout, [spec["command"]]))
    slots = list(report["models"][spec["model"]]["slots"])
    used = {item["slot"] for item in spec["inputs"] if item.get("flag") == "input" and item.get("slot")}
    for item in spec["inputs"]:
        if item.get("flag") == "input":
            continue
        pattern = LEGACY_INPUT_SLOTS.get(item.get("flag"))
        slot = next((name for name in slots if pattern and pattern.match(name) and name not in used), None)
        if not slot:
            raise ValueError(
                f"Для входа {item.get('flag')} модель {spec['model']} не объявляет подходящего слота; "
                "повторите запрос вручную в новой подготовке."
            )
        used.add(slot)
        item["flag"], item["slot"] = "input", slot
    return spec


def argument(value):
    """Значения аргументов MCP — строки: строки как есть, прочее компактным JSON."""
    return (
        value
        if isinstance(value, str)
        else json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    )


def envelope(request, prompt, inputs):
    """Конверт инструмента генерации: модель, строковые аргументы, промпт и именованные входы по URL."""
    arguments = [{"name": "prompt", "value": prompt}]
    arguments += [{"name": name, "value": argument(value)} for name, value in sorted(request["parameters"].items())]
    value = {"model": request["model"], "arguments": arguments, "rationale": ""}
    if inputs:
        value["inputs"] = [{"name": slot, "inputType": "URL", "url": url} for slot, url in inputs]
    return value


def submit(directory, request, state, timeout):
    """Загрузка входов и единственный tools/call; всё до вызова генерации — «не отправлено»."""
    if any(item.get("flag") != "input" or not item.get("slot") for item in request["inputs"]):
        raise NotSubmitted("Входы запроса передаются только именованными слотами; подготовьте новую попытку.")
    session = mcp.Session(timeout, trace_id=state.get("task_trace_id"))
    try:
        prompt = inside(directory, request["prompt"]["path"]).read_bytes().decode("utf-8")
        session.initialize()
        inputs = [(item["slot"], session.upload(inside(directory, item["path"]))) for item in request["inputs"]]
    except (mcp.KlingError, OSError, ValueError) as error:
        raise NotSubmitted(f"{error} Загрузка не завершена, отправка не начиналась.") from None
    try:
        body = session.call(request["command"], envelope(request, prompt, inputs), timeout=mcp.SUBMIT_TIMEOUT)
    except (mcp.AuthRequired, mcp.NotSent) as error:
        raise NotSubmitted(f"{error} Отправка не начиналась.") from None
    except mcp.ToolError as error:
        # isError — явный ответ сервера без созданного задания.
        raise RejectedRequest(str(error)) from None
    except Exception as error:
        mcp.debug("submit", error, getattr(error, "status", None), getattr(error, "text", None))
        raise
    generation_id = body.get("generationId", body.get("generation_id")) if isinstance(body, dict) else None
    if not isinstance(generation_id, str) or not generation_id:
        error = ValueError("ответ без generationId")
        mcp.debug("submit", error, 200, json.dumps(body, ensure_ascii=False))
        raise error
    answer = {"generation_id": generation_id}
    if type(body.get("creditsConsumed")) in (int, float) and math.isfinite(body["creditsConsumed"]):
        answer["credits_consumed"] = body["creditsConsumed"]
    return answer


def poll(directory, request, state, timeout):
    """Состояние задания по сохранённому ID; адреса результатов не попадают в журнал попытки."""
    session = mcp.Session(timeout, trace_id=state.get("task_trace_id"))
    body = session.call("query_tasks", {"generationId": state["generation_id"]})
    if not isinstance(body, dict):
        raise ValueError("query_tasks вернул неверный ответ.")
    if body.get("generationId", body.get("generation_id", state["generation_id"])) != state["generation_id"]:
        raise ValueError("query_tasks вернул состояние другого задания.")
    service_status = str(body.get("status", "unknown")).lower()
    answer = {"service_status": service_status}
    if service_status in FAILED:
        return answer | {"status": "failed"}
    if service_status not in SUCCESS:
        return answer | {"status": "running"}
    works = [
        w
        for w in body.get("works", [])
        if isinstance(w, dict)
        and str(w.get("status", "completed")).lower() in SUCCESS
        and w.get("contentType", w.get("content_type", request["kind"])) == request["kind"]
    ]
    if len(works) != request["outputs"]:
        return answer | {"status": "outputs_pending"}
    # Явный оригинал без логотипа приоритетен у обоих медиа. У изображения
    # обычный url остаётся адресом результата сервиса, без анализа его содержимого.
    urls = [
        w.get("urlWithoutWatermark")
        or w.get("url_without_watermark")
        or (w.get("url") if request["kind"] == "image" else None)
        for w in works
    ]
    if not all(isinstance(url, str) and urlparse(url).scheme == "https" for url in urls):
        return answer | {"status": "watermark_free_pending" if request["kind"] == "video" else "outputs_pending"}
    return answer | {"status": "completed", "outputs": urls}


def fetch(url, destination):
    """Скачивает полный оригинал; публикацию и защиту от перезаписи выполняет общий код."""
    if urlparse(url).scheme != "https":
        raise ValueError("Сервис вернул недопустимый адрес результата.")
    with urlopen(url, timeout=60) as response, Path(destination).open("wb") as target:
        shutil.copyfileobj(response, target)
        if response.headers.get("Content-Length") and target.tell() != int(response.headers["Content-Length"]):
            raise ValueError("Загрузка не завершена.")


def find_balance(value, path=""):
    """Ищет числовое поле остатка в ответе account, не сохраняя сам ответ."""
    found = []
    if isinstance(value, dict):
        for key, item in value.items():
            name = f"{path}.{key}" if path else str(key)
            if (
                isinstance(item, (int, float))
                and not isinstance(item, bool)
                and re.search(r"credit|balance|remain|point", str(key), re.I)
            ):
                found.append((name, float(item)))
            else:
                found += find_balance(item, name)
    elif isinstance(value, list):
        for index, item in enumerate(value):
            found += find_balance(item, f"{path}[{index}]")
    return found


def account(timeout=60):
    """Остаток кредитов: только число и имя поля ответа query_membership_and_credits."""
    try:
        body = mcp.Session(timeout).call("query_membership_and_credits")
    except mcp.AuthRequired as error:
        return {"balance": None, "source": str(error)}
    except (mcp.KlingError, OSError, ValueError):
        return {"balance": None, "source": "ответ query_membership_and_credits не получен или не разобран"}
    found = find_balance(body)
    if not found:
        return {"balance": None, "source": "в ответе query_membership_and_credits нет числового поля остатка"}
    preferred = [f for f in found if re.search(r"remain|available|balance|left", f[0], re.I)]
    name, value = (preferred or found)[0]
    return {"balance": value, "source": name}


def login(open_browser=True, timeout=mcp.LOGIN_TIMEOUT):
    """Вход в браузере; адрес авторизации печатается в stderr строкой AUTHORIZE_URL."""
    try:
        mcp.login(open_browser=open_browser, timeout=timeout)
    except (mcp.KlingError, OSError, ValueError) as error:
        return {"ok": False, "message": f"Вход в {mcp.TITLE} не завершён: {error}"}
    return {"ok": True, "message": f"Вход в {mcp.TITLE} выполнен, авторизация сохранена."}


def auth_status(timeout=30):
    """Состояние входа: authenticated только после успешного who_am_i; без сети — unknown."""
    if mcp.read_credentials() is None:
        return {"status": "unauthenticated", "message": mcp.LOGIN_REQUIRED}
    try:
        mcp.Session(timeout).call("who_am_i")
    except mcp.AuthRequired as error:
        return {"status": "unauthenticated", "message": str(error)}
    except mcp.NotSent:
        return {"status": "unknown", "message": f"Нет соединения с {mcp.TITLE}. Проверьте сеть и повторите проверку."}
    except (mcp.KlingError, OSError, ValueError):
        return {"status": "unknown", "message": f"{mcp.TITLE} не подтвердил вход. Повторите проверку позже."}
    return {"status": "authenticated"}


def pricing_file():
    """Таблица цен Kling заполняется по кабинету сервиса; наблюдения дописывает cost_check learn."""
    return Path(__file__).with_name("pricing.json")


def snapshot_warnings(snapshot):
    """Предупреждения о снимке принятого комплекта: (поле, текст)."""
    parameters = snapshot.get("parameters", snapshot.get("arguments", {}))
    if (
        snapshot.get("model") in MULTI_SHOT_MODELS
        and isinstance(parameters, dict)
        and "prefer_multi_shots" not in parameters
        and "prefer_multi_shots" not in snapshot
    ):
        return [
            (
                "parameters",
                "запрос к модели с авто-раскадровкой отправлен без prefer_multi_shots: "
                "у сервиса значение по умолчанию true",
            )
        ]
    return []

