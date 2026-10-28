"""Повторяемая отправка одной попытки Kling; @link README.md"""

import sys
from pathlib import Path

# После переноса точка запуска находится на два уровня ниже корня проекта.
# Полные импорты tools.* работают и при прямом запуске файла из любой папки.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))


import argparse
import errno
import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import tempfile
import time
from contextlib import contextmanager
from urllib.parse import urlparse
from urllib.request import urlopen

from tools.asset_package.asset_package import sha
from tools.common import ROOT
from tools import request_snapshot
from tools.request_snapshot import atomic_json, encoded
from tools.kling_cli import resolve as resolve_kling_cli
from tools.kling_cli import run as run_kling_cli

if sys.platform == "win32":
    import msvcrt
else:
    import fcntl

COMMANDS = {"text_to_image", "image_to_image", "text_to_video", "image_to_video", "omni_ref_video", "motion_control"}
SUCCESS = {"completed", "partial_completed", "succeed", "succeeded", "success"}
FAILED = {"failed", "cancelled", "canceled", "rejected", "error"}
FLAGS = {"input", "image", "tailImage", "audio", "video"}
RESERVED = FLAGS | {"model", "prompt", "poll", "quiet", "q", "help", "version", "base-url", "credentials", "token"}
# Модели, объявляющие prefer_multi_shots по справке CLI 0.2.3; у v3_0 значение по умолчанию true,
# поэтому единый план без явного false может получить внутренние склейки. @link request-format.md
MULTI_SHOT_MODELS = {"kling-video-v3_0", "kling-video-v3_0_omni"}
# У v4_0 разрешение по умолчанию 720p, что ниже настроек проекта: требуем явное значение.
EXPLICIT_RESOLUTION_MODELS = {"kling-video-v4_0"}
# Документированный предел промпта API Kling; поведение CLI при превышении не проверено.
PROMPT_WARNING_CHARS = 2500



def work_path(value):
    path = Path(value).resolve()
    # Отложенную попытку можно запускать прямо из очереди без обратного переноса.
    # Корни очереди/партий не должны становиться одной попыткой; @link ../../plan/awaiting/README.md.
    allowed = [(ROOT / name).resolve() for name in ("plan/batches", "plan/awaiting")]
    if path in allowed or not any(
        path.is_relative_to(base) for base in [*allowed, Path(tempfile.gettempdir()).resolve()]
    ):
        raise ValueError("Рабочая папка должна находиться внутри plan/batches, plan/awaiting или /tmp.")
    if any(path.is_relative_to((ROOT / name).resolve()) for name in ("assets", "source", "plan/animatic")):
        raise ValueError("Рабочая папка не может заменять исходники или аниматик.")
    return path


def inside(directory, name):
    path = (directory / name).resolve()
    if not path.is_relative_to(directory.resolve()) or not path.is_file():
        raise ValueError("Нет локального файла подготовленной попытки.")
    return path


@contextmanager
def locked(directory):
    with (directory / ".lock").open("a+b") as stream:
        try:
            if sys.platform == "win32":
                # Windows блокирует один существующий байт с неизменным смещением, Linux — весь файл.
                # Неблокирующий захват сохраняет прежний отказ повторной отправки вместо ожидания.
                stream.seek(0, os.SEEK_END)
                if stream.tell() == 0:
                    stream.write(b"\0")
                    stream.flush()
                stream.seek(0)
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            if error.errno not in (errno.EACCES, errno.EAGAIN, errno.EDEADLK):
                raise
            raise ValueError("Эту попытку уже обрабатывает другой процесс.") from None
        try:
            yield
        finally:
            if sys.platform == "win32":
                stream.seek(0)
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(stream, fcntl.LOCK_UN)


def validate_spec(spec):
    request_snapshot.validate_spec(spec)
    if spec["provider"].strip().casefold() != "kling":
        raise ValueError("Адаптер Kling не обслуживает провайдера " + spec["provider"] + ".")
    if spec.get("schema_version") != 1 or spec.get("command") not in COMMANDS:
        raise ValueError("Неизвестная схема или команда генерации.")
    if spec.get("kind") not in ("image", "video") or not re.fullmatch(r"[A-Za-z0-9_.-]+", spec.get("model", "")):
        raise ValueError("Не указан вид результата или точный идентификатор модели.")
    if ("image" if spec["command"].endswith("_image") else "video") != spec["kind"]:
        raise ValueError("Вид результата не соответствует команде.")
    if set(spec) - {
        "schema_version",
        "shot",
        "provider",
        "kind",
        "command",
        "model",
        "model_selection",
        "parameters",
        "outputs",
        "inputs",
        "prompt_file",
    }:
        raise ValueError("Неизвестные поля запроса.")
    if "model_selection" in spec:
        selection = spec["model_selection"]
        # Модель уже выбрана вызывающим кодом по возможностям аккаунта; здесь
        # проверяем только объяснение выбора, которое войдёт в согласуемый SHA.
        if not isinstance(selection, dict) or set(selection) != {"preferredModel", "selectedModel", "reason"}:
            raise ValueError("model_selection должен содержать только preferredModel, selectedModel и reason.")
        preferred = selection["preferredModel"]
        if preferred is not None and (
            not isinstance(preferred, str) or not re.fullmatch(r"[A-Za-z0-9_.-]+", preferred)
        ):
            raise ValueError("preferredModel должен быть точным идентификатором модели или null.")
        if selection["selectedModel"] != spec["model"]:
            raise ValueError("selectedModel должен совпадать с model запроса.")
        if not isinstance(selection["reason"], str) or not selection["reason"].strip():
            raise ValueError("reason должен быть непустой строкой с причиной выбора модели.")
    parameters = spec.get("parameters", {})
    if not isinstance(parameters, dict):
        raise ValueError("parameters должен быть объектом.")
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
    if type(count) is not int or not 1 <= count <= 9:
        raise ValueError("Неверное число результатов.")
    if "imageCount" in parameters and str(parameters["imageCount"]) != str(count):
        raise ValueError("outputs и imageCount должны совпадать.")
    slots = set()
    for item in spec.get("inputs", []):
        if set(item) - {"flag", "slot", "role", "path", "sha256"}:
            raise ValueError("Неизвестные поля входа.")
        flag = item.get("flag")
        if flag != "input" and "slot" in item:
            raise ValueError("slot допустим только для флага input.")
        if flag not in FLAGS or (flag == "input" and not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]*", item.get("slot", ""))):
            raise ValueError("Неверный флаг или именованный слот входа.")
        slot = (flag, item.get("slot") if flag == "input" else "")
        if slot in slots:
            raise ValueError("Один входной слот указан дважды.")
        slots.add(slot)
    if any(flag == "input" for flag, _ in slots) and any(flag != "input" for flag, _ in slots):
        raise ValueError("Не смешивайте именованные входы с image/tailImage/audio/video.")
    encoded(parameters)


def prepare(request, directory):
    # Общая подготовка копирует точные байты; особенности Kling проверяются до создания папки.
    spec = json.loads(Path(request).read_text())
    validate_spec(spec)
    prompt_source = Path(request).resolve().parent / spec["prompt_file"]
    if re.match(r"^--[A-Za-z]", prompt_source.read_bytes().decode("utf-8")):
        raise ValueError("Промпт начинается с флага CLI; измените начало текста до согласования.")
    prepared = request_snapshot.prepare(request, work_path(directory), extra_fields={"video_without_watermark": True})
    if len(prepared["prompt_text"]) > PROMPT_WARNING_CHARS:
        prepared["warnings"].append(
            f"Промпт длиннее {PROMPT_WARNING_CHARS} символов ({len(prepared['prompt_text'])}): "
            "сервис может обрезать или ослабить хвост текста."
        )
    return prepared


def capability_body(cli, command, timeout):
    """Читает полный JSON через приватный файл: CLI может завершиться до сброса stdout в pipe."""
    with tempfile.TemporaryFile(mode="w+b") as output:
        result = run_kling_cli([cli, command, "--quiet"], timeout, stdout=output)
        output.seek(0)
        try:
            value = json.load(output)
        except (ValueError, UnicodeError):
            raise ValueError(f"{command}: CLI вернул неполный или неверный JSON; сырой ответ скрыт.") from None
    if (
        result.returncode != 0
        or not isinstance(value, dict)
        or value.get("ok") is not True
        or value.get("isError")
        or not isinstance(value.get("body"), dict)
    ):
        raise ValueError(f"{command}: CLI не подтвердил discovery; проверьте соединение и повторите.")
    return value["body"]


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


def capability_catalog(cli, timeout):
    """Один снимок аккаунта обслуживает все команды: параллельные who_am_i давали случайные частичные ошибки."""
    try:
        resolve_kling_cli(cli)
    except OSError as error:
        raise ValueError(f"{error}; объявления моделей недоступны.") from None
    deadline = time.monotonic() + timeout
    try:
        tools = capability_body(cli, "tool_list", max(0.001, deadline - time.monotonic())).get("tools")
        if not isinstance(tools, list) or any(not isinstance(tool, dict) for tool in tools):
            raise ValueError("tool_list вернул неверное объявление команд.")
        body = capability_body(cli, "who_am_i", max(0.001, deadline - time.monotonic()))
    except (OSError, subprocess.TimeoutExpired):
        raise ValueError("Discovery CLI недоступен: команда не ответила вовремя или не запустилась.") from None
    return {tool.get("name") for tool in tools if isinstance(tool.get("name"), str)}, body


def command_capabilities(command, model, tools, body):
    """Проверяет объявление каждой команды отдельно, не теряя остальные корректные модели снимка."""
    if command not in COMMANDS:
        raise ValueError("Неизвестная команда генерации.")
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


def capabilities(cli="kling", command="image_to_video", model=None, timeout=60):
    """Сохраняет контракт отдельной команды для инструментов производства и внешних вызовов."""
    if command not in COMMANDS:
        raise ValueError("Неизвестная команда генерации.")
    tools, body = capability_catalog(cli, timeout)
    return command_capabilities(command, model, tools, body)


def capabilities_batch(cli, commands, timeout=60):
    """Возвращает согласованный каталог за два вызова CLI независимо от количества команд."""
    if not commands or len(set(commands)) != len(commands) or any(command not in COMMANDS for command in commands):
        raise ValueError("Укажите неповторяющиеся команды генерации через запятую.")
    tools, body = capability_catalog(cli, timeout)
    reports, problems = [], []
    for command in commands:
        try:
            reports.append(command_capabilities(command, None, tools, body))
        except ValueError as error:
            problems.append({"command": command, "message": str(error)})
    return {"reports": reports, "problems": problems}


def capabilities_table(report):
    lines = [
        "| Модель | Длительности | Разрешение | Пропорции | multi-shot | Звук | Слоты |",
        "| --- | --- | --- | --- | --- | --- | --- |",
    ]
    for name, model in report["models"].items():
        arguments, slots = model["arguments"], model["slots"]

        def cell(key):
            entry = arguments.get(key)
            if not entry:
                return "—"
            allowed = entry.get("allowed")
            text = "|".join(allowed) if allowed else "любое"
            return text + (f" (по умолчанию {entry['default']})" if entry.get("default") else "")

        slot_text = ", ".join(name + ("*" if entry.get("required") else "") for name, entry in slots.items()) or "—"
        cap = model["limits"].get("combined_item_cap")
        if isinstance(cap, dict) and cap.get("maxItems"):
            slot_text += f"; всего не более {cap['maxItems']}"
        lines.append(
            (
                f"| {name} | {cell('duration')} | {cell('resolution')} | "
                f"{cell('aspect_ratio')} | {cell('prefer_multi_shots')} | "
                f"{cell('enable_audio')} | {slot_text} |"
            )
        )
    lines += [
        "",
        "Звёздочка — обязательный слот. Объявления относятся к текущему аккаунту и команде `"
        + report["command"]
        + "`.",
    ]
    return "\n".join(lines)


def load_attempt(directory, verify_inputs=False):
    request = json.loads(inside(directory, "request.json").read_text())
    provider = request.get("provider")
    if not isinstance(provider, str) or provider.strip().casefold() != "kling":
        raise ValueError("Адаптер Kling требует явный provider Kling в подготовленном запросе.")
    state = json.loads(inside(directory, "attempt.json").read_text())
    if hashlib.sha256(encoded(request)).hexdigest() != state["request_sha256"]:
        raise ValueError("Подготовленный запрос изменён; нужна новая попытка и новое согласование.")
    if verify_inputs:
        for item in [request["prompt"], *request["inputs"]]:
            if sha(inside(directory, item["path"])) != item["sha256"]:
                raise ValueError("Промпт или вход изменён; отправка запрещена.")
    return request, state


def cli_body(result):
    try:
        value = json.loads(result.stdout)
        if not isinstance(value, dict) or value.get("ok") is False or value.get("isError"):
            raise ValueError()
        body = value.get("body", value)
        if not isinstance(body, dict):
            raise ValueError()
        return body
    except (ValueError, TypeError):
        raise ValueError("CLI не вернул однозначный успешный JSON-ответ; сырой вывод скрыт.") from None


def call_cli(argv, timeout):
    # Промпт и пути передаются отдельными аргументами, без интерпретации shell.
    return run_kling_cli(argv, timeout)


def identifier(value):
    if (
        not isinstance(value, str)
        or not 1 <= len(value) <= 2048
        or value.startswith("-")
        or "://" in value
        or any(ord(c) < 33 or ord(c) > 126 for c in value)
    ):
        raise ValueError("Некорректный generationId.")
    return value


def argument(value):
    return (
        value
        if isinstance(value, str)
        else json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    )


def submit(directory, confirmation, cli="kling", timeout=60):
    directory = work_path(directory)
    if not math.isfinite(timeout) or timeout <= 0:
        raise ValueError("Таймаут должен быть положительным.")
    with locked(directory):
        request, state = load_attempt(directory, verify_inputs=True)
        if state["status"] != "prepared" or state.get("generation_id"):
            raise ValueError(
                "Эта попытка уже отправлялась; используйте resume. При неизвестной отправке повтор запрещён."
            )
        if confirmation != state["request_sha256"]:
            raise ValueError("Нужно подтверждение SHA-256 именно подготовленного запроса.")
        try:
            # Отсутствующий CLI обнаруживается до состояния submitting; подготовленную попытку ещё можно использовать.
            resolve_kling_cli(cli)
        except OSError as error:
            raise ValueError(f"{error}; отправка не начиналась.") from None
        argv = [cli, request["command"], "--model=" + request["model"], "--quiet"]
        for name, value in sorted(request["parameters"].items()):
            argv += ["--" + name + "=" + argument(value)]
        for item in request["inputs"]:
            value = str(inside(directory, item["path"]))
            argv += ["--" + item["flag"] + "=" + (item["slot"] + "=" + value if item["flag"] == "input" else value)]
        argv += [inside(directory, request["prompt"]["path"]).read_bytes().decode("utf-8")]
        state.update(status="submitting")
        atomic_json(directory / "attempt.json", state)
        try:
            result = call_cli(argv, timeout)
            body = cli_body(result)
            generation_id = identifier(body.get("generationId", body.get("generation_id")))
        except (ValueError, OSError, subprocess.TimeoutExpired):
            state.update(status="submission_unknown")
            atomic_json(directory / "attempt.json", state)
            raise ValueError(
                "Исход отправки неизвестен. Не повторяйте запрос; выясните ID задания и продолжите через resume."
            ) from None
        state.update(status="submitted", generation_id=generation_id)
        if type(body.get("creditsConsumed")) in (int, float) and math.isfinite(body["creditsConsumed"]):
            state["credits_consumed"] = body["creditsConsumed"]
        atomic_json(directory / "attempt.json", state)
        return state


def download(url, destination):
    if urlparse(url).scheme != "https":
        raise ValueError("Сервис вернул недопустимый адрес результата.")
    # Публикуем файл атомарно после полного скачивания. Никаких ffprobe,
    # хешей результата или анализа видео в процедуре получения нет.
    temporary = destination.with_suffix(destination.suffix + ".part")
    try:
        with urlopen(url, timeout=60) as response, temporary.open("wb") as target:
            shutil.copyfileobj(response, target)
            if response.headers.get("Content-Length") and target.tell() != int(response.headers["Content-Length"]):
                raise ValueError("Загрузка не завершена.")
        if temporary.stat().st_size == 0:
            raise ValueError("Получен пустой результат.")
        os.link(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)


def image_extension(path):
    """Определяет контейнер оригинала по сигнатуре, а не по адресу CDN; @link request-format.md."""
    with path.open("rb") as stream:
        header = stream.read(12)
    if header.startswith(b"\x89PNG\r\n\x1a\n"):
        return ".png"
    if header.startswith(b"\xff\xd8\xff"):
        return ".jpg"
    if header.startswith(b"RIFF") and header[8:12] == b"WEBP":
        return ".webp"
    raise ValueError("Неизвестный формат изображения результата: ожидается PNG, JPEG или WebP по сигнатуре файла.")


def verify_saved_image(directory, item):
    """Проверяет сохранённый оригинал без переименования и перекодирования."""
    if (directory / item["path"]).is_symlink():
        raise ValueError("Сохранённый оригинал изображения не должен быть символической ссылкой.")
    target = inside(directory, item["path"])
    actual = image_extension(target)
    suffix = Path(item["path"]).suffix.lower()
    if suffix != actual and not (actual == ".jpg" and suffix == ".jpeg"):
        raise ValueError(
            "Расширение сохранённого оригинала не соответствует изображению. Оригинал оставлен без изменений."
        )
    if target.stat().st_size != item["bytes"] or (item.get("sha256") and sha(target) != item["sha256"]):
        raise ValueError("Сохранённый результат изменился.")
    return target


def download_image(url, directory, stem, number, state):
    """Сначала получает исходные байты, затем фиксирует намерение и публикует оригинал."""
    pending = state.get("pending_download")
    names = {stem + extension for extension in (".png", ".jpg", ".jpeg", ".webp")}
    if pending and pending.get("number") == number and pending.get("path") in names:
        target = directory / pending["path"]
        if target.exists() or target.is_symlink():
            # После обрыва между публикацией и журналом принимаем только тот же оригинал.
            proof = pending if "bytes" in pending else pending | {"bytes": target.stat().st_size}
            verify_saved_image(directory, proof)
            return proof
    with tempfile.TemporaryDirectory(prefix=".image-download-", dir=directory) as temporary:
        raw = Path(temporary) / "original.raw"
        download(url, raw)
        extension = image_extension(raw)
        name = stem + extension
        target = directory / name
        if target.exists() or target.is_symlink():
            raise ValueError("Выходной файл уже существует; он не будет перезаписан.")
        proof = {"number": number, "path": name, "bytes": raw.stat().st_size, "sha256": sha(raw)}
        # Хеш и размер записываются до атомарной публикации: существующий чужой файл не станет результатом.
        state["pending_download"] = proof
        atomic_json(directory / "attempt.json", state)
        os.link(raw, target)
        return proof


def resume(directory, cli="kling", generation_id=None, wait_seconds=0, interval=15, timeout=60):
    directory = work_path(directory)
    if not math.isfinite(timeout) or timeout <= 0:
        raise ValueError("Таймаут должен быть положительным.")
    if not 0 <= wait_seconds <= 60 or not 1 <= interval <= 60:
        raise ValueError("Ожидание ограничено 60 секундами; интервал — от 1 до 60.")
    with locked(directory):
        request, state = load_attempt(directory)
        if generation_id:
            generation_id = identifier(generation_id)
            if state.get("generation_id") not in (None, generation_id):
                raise ValueError("У попытки уже другой ID.")
            if not state.get("generation_id") and state["status"] not in ("submitting", "submission_unknown"):
                raise ValueError("Ручное восстановление ID разрешено только после неизвестной отправки.")
            state.update(generation_id=generation_id, status="submitted")
            atomic_json(directory / "attempt.json", state)
        if not state.get("generation_id"):
            raise ValueError("Нет ID задания; отправку через resume выполнить нельзя.")
        if state["status"] == "downloaded":
            for item in state["downloads"]:
                if request["kind"] == "image":
                    verify_saved_image(directory, item)
                elif inside(directory, item["path"]).stat().st_size != item["bytes"]:
                    raise ValueError("Сохранённый результат изменился.")
            return state
        if state["status"] == "failed":
            return state
        deadline = time.monotonic() + wait_seconds
        while True:
            try:
                result = call_cli([cli, "query_tasks", state["generation_id"], "--quiet"], timeout)
                body = cli_body(result)
                if result.returncode:
                    raise ValueError()
                returned_id = body.get("generationId", body.get("generation_id", state["generation_id"]))
                if returned_id != state["generation_id"]:
                    raise ValueError()
            except (ValueError, OSError, subprocess.TimeoutExpired):
                raise ValueError("Не удалось запросить состояние. ID сохранён; повторите resume, не submit.") from None
            service_status = str(body.get("status", "unknown")).lower()
            # Не сохраняем сообщения сервиса: они могут включать подписанные URL.
            state["service_status"] = service_status if re.fullmatch(r"[a-z_]{1,40}", service_status) else "unknown"
            if service_status in FAILED:
                state["status"] = "failed"
                atomic_json(directory / "attempt.json", state)
                return state
            if service_status in SUCCESS:
                works = [
                    w
                    for w in body.get("works", [])
                    if isinstance(w, dict)
                    and str(w.get("status", "completed")).lower() in SUCCESS
                    and w.get("contentType", w.get("content_type", request["kind"])) == request["kind"]
                ]
                if len(works) != request["outputs"]:
                    state["status"] = "outputs_pending"
                else:
                    # Явный оригинал без логотипа приоритетен у обоих медиа. У изображения
                    # обычный url остаётся адресом результата сервиса, без анализа его содержимого.
                    urls = [
                        w.get("urlWithoutWatermark")
                        or w.get("url_without_watermark")
                        or (w.get("url") if request["kind"] == "image" else None)
                        for w in works
                    ]
                    if not all(isinstance(url, str) and urlparse(url).scheme == "https" for url in urls):
                        state["status"] = "watermark_free_pending" if request["kind"] == "video" else "outputs_pending"
                    else:
                        state["status"] = "downloading"
                        atomic_json(directory / "attempt.json", state)
                        for number, url in enumerate(urls, 1):
                            existing = next((x for x in state["downloads"] if x["number"] == number), None)
                            if existing:
                                if request["kind"] == "image":
                                    verify_saved_image(directory, existing)
                                elif inside(directory, existing["path"]).stat().st_size != existing["bytes"]:
                                    raise ValueError("Сохранённый результат изменился.")
                                continue
                            if request["kind"] == "image":
                                stem = "original" if len(urls) == 1 else f"original-{number:02}"
                                try:
                                    original = download_image(url, directory, stem, number, state)
                                except Exception:
                                    state["status"] = "download_pending"
                                    atomic_json(directory / "attempt.json", state)
                                    raise ValueError(
                                        (
                                            "Не удалось сохранить оригинал PNG/JPEG/WebP. Повторите resume "
                                            "того же задания; существующие файлы не перезаписываются."
                                        )
                                    ) from None
                                state["downloads"].append(original)
                                state.pop("pending_download", None)
                                atomic_json(directory / "attempt.json", state)
                                continue
                            extension = ".mp4"
                            name = ("original" if len(urls) == 1 else f"original-{number:02}") + extension
                            pending = state.get("pending_download")
                            target = directory / name
                            # Намерение записывается до скачивания. Если процесс оборвался
                            # после атомарной публикации файла, повтор принимает этот файл.
                            if target.exists():
                                if (
                                    pending != {"number": number, "path": name}
                                    or target.is_symlink()
                                    or target.stat().st_size == 0
                                ):
                                    raise ValueError("Выходной файл уже существует; он не будет перезаписан.")
                            else:
                                state["pending_download"] = {"number": number, "path": name}
                                atomic_json(directory / "attempt.json", state)
                                try:
                                    download(url, target)
                                except Exception:
                                    state["status"] = "download_pending"
                                    atomic_json(directory / "attempt.json", state)
                                    raise ValueError(
                                        (
                                            "Не удалось сохранить результат. Повторите resume для того же "
                                            "задания; существующие файлы не перезаписываются."
                                        )
                                    ) from None
                            state["downloads"].append({"number": number, "path": name, "bytes": target.stat().st_size})
                            state.pop("pending_download", None)
                            atomic_json(directory / "attempt.json", state)
                        state["status"] = "downloaded"
                        atomic_json(directory / "attempt.json", state)
                        return state
            else:
                state["status"] = "running"
            atomic_json(directory / "attempt.json", state)
            if time.monotonic() >= deadline:
                return state
            time.sleep(min(interval, max(0, deadline - time.monotonic())))


TERMINAL = {"downloaded", "failed"}


def watch(directories, cli="kling", max_minutes=15, interval=20, timeout=60, report=print):
    """Одно длинное ожидание нескольких попыток: опрос по очереди, вывод только при смене статуса."""
    if not 1 <= max_minutes <= 120 or not 5 <= interval <= 300:
        raise ValueError("Ожидание — от 1 до 120 минут, интервал — от 5 до 300 секунд.")
    pending = {work_path(d): None for d in directories}
    results = {}
    deadline = time.monotonic() + max_minutes * 60
    while pending:
        for directory in list(pending):
            try:
                state = resume(directory, cli, timeout=timeout)
            except ValueError as error:
                results[str(directory)] = {"status": "error", "detail": str(error)}
                report(f"{directory.name}: {error}")
                del pending[directory]
                continue
            if state["status"] != pending[directory]:
                report(f"{directory.name}: {state['status']}")
                pending[directory] = state["status"]
            if state["status"] in TERMINAL:
                results[str(directory)] = state
                del pending[directory]
        if pending and time.monotonic() >= deadline:
            for directory, status in pending.items():
                results[str(directory)] = {
                    "status": status or "unknown",
                    "detail": "время ожидания вышло; задание не отменено, повторите watch",
                }
            break
        if pending:
            time.sleep(min(interval, max(0, deadline - time.monotonic())))
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    p = sub.add_parser("prepare")
    p.add_argument("--request", type=Path, required=True)
    p.add_argument("--work-dir", type=Path, required=True)
    p = sub.add_parser("capabilities")
    selection = p.add_mutually_exclusive_group()
    selection.add_argument("--command", default="image_to_video")
    selection.add_argument("--commands")
    p.add_argument("--model")
    p.add_argument("--json", action="store_true")
    p.add_argument("--cli", default="kling")
    p.add_argument("--timeout", type=float, default=60)
    p = sub.add_parser("watch")
    p.add_argument("--work-dir", type=Path, nargs="+", required=True)
    p.add_argument("--max-minutes", type=float, default=15)
    p.add_argument("--interval", type=float, default=20)
    p.add_argument("--cli", default="kling")
    p.add_argument("--timeout", type=float, default=60)
    for action in ("submit", "resume", "status"):
        p = sub.add_parser(action)
        p.add_argument("--work-dir", type=Path, required=True)
        if action != "status":
            p.add_argument("--cli", default="kling")
            p.add_argument("--timeout", type=float, default=60)
        if action == "submit":
            p.add_argument("--confirm", required=True)
        if action == "resume":
            p.add_argument("--generation-id")
            p.add_argument("--wait-seconds", type=float, default=0)
            p.add_argument("--interval", type=float, default=15)
    args = parser.parse_args()
    try:
        if args.action == "capabilities":
            if args.commands is not None:
                if args.model or not args.json:
                    raise ValueError("--commands используется с --json и без --model.")
                report = capabilities_batch(args.cli, args.commands.split(","), args.timeout)
            else:
                report = capabilities(args.cli, args.command, args.model, args.timeout)
            print(json.dumps(report, ensure_ascii=False, indent=2) if args.json else capabilities_table(report))
            return
        if args.action == "watch":
            result = watch(
                args.work_dir,
                args.cli,
                args.max_minutes,
                args.interval,
                args.timeout,
                report=lambda line: print(line, flush=True),
            )
            print(json.dumps(result, ensure_ascii=False, indent=2))
            if any(s.get("status") not in TERMINAL for s in result.values()):
                raise SystemExit(2)
            return
        if args.action == "prepare":
            result = prepare(args.request, args.work_dir)
        elif args.action == "submit":
            result = submit(args.work_dir, args.confirm, args.cli, args.timeout)
        elif args.action == "resume":
            result = resume(args.work_dir, args.cli, args.generation_id, args.wait_seconds, args.interval, args.timeout)
        else:
            result = load_attempt(work_path(args.work_dir))[1]
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except (ValueError, KeyError, TypeError, OSError):
        # Не печатаем repr исключения: пути, CLI и сетевые ошибки могут содержать секреты.
        import sys

        error = sys.exc_info()[1]
        parser.exit(
            1,
            (
                str(error)
                if type(error) is ValueError and not isinstance(error, json.JSONDecodeError)
                else "Ошибка локальных данных или файлов; сырой вывод скрыт."
            )
            + "\n",
        )


if __name__ == "__main__":
    main()
