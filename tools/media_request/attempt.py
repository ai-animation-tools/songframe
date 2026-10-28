"""Общий жизненный цикл попытки генерации: подготовка, отправка, получение, ручной результат; @link README.md

Сервис здесь не известен: команды, разбор ответов и загрузку выполняет адаптер из tools/media_adapters.py.
Этот модуль ведёт состояние attempt.json, замок, SHA, единственную отправку и сохранность оригиналов.
"""

import errno
import hashlib
import json
import math
import os
import re
import shutil
import sys
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path

from tools import media_adapters, request_snapshot
from tools.common import ROOT, sha, uuid7
from tools.request_snapshot import atomic_json, encoded

if sys.platform == "win32":
    import msvcrt
else:
    import fcntl

# Статусы, которые адаптер возвращает из poll; completed общий код превращает в получение оригиналов.
PENDING = {"running", "outputs_pending", "watermark_free_pending"}
POLL_STATUSES = PENDING | {"failed", "completed"}
TERMINAL = {"downloaded", "failed"}


class NotSubmitted(ValueError):
    """Отправка не начиналась (например, нет входа или соединения): попытка остаётся подготовленной."""


class RejectedRequest(NotSubmitted):
    """Сервис явно отклонил запрос: задание не создано, повторная проверка параметров безопасна.

    Текст исключения — краткая причина отказа без секретов; он сохраняется в last_rejection.
    """


def work_path(value):
    path = Path(value).resolve()
    # Отложенную попытку можно запускать прямо из очереди без обратного переноса.
    # Корни очереди/партий не должны становиться одной попыткой; @link ../../templates/project/plan/awaiting/README.md.
    allowed = [(ROOT / name).resolve() for name in ("plan/batches", "plan/awaiting")]
    if path in allowed or not any(
        path.is_relative_to(base) for base in [*allowed, Path(tempfile.gettempdir()).resolve()]
    ):
        raise ValueError("Рабочая папка должна находиться внутри plan/batches, plan/awaiting или временной папки ОС.")
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


def prepare(request, directory):
    """Замораживает спецификацию; ограничения сервиса проверяет его адаптер до создания папки."""
    spec = json.loads(Path(request).read_text())
    request_snapshot.validate_spec(spec)
    service = media_adapters.adapter(spec["provider"])
    service.validate_spec(spec)
    prompt = (Path(request).resolve().parent / spec["prompt_file"]).read_bytes().decode("utf-8")
    warnings = service.validate_prompt(prompt)
    prepared = request_snapshot.prepare(request, work_path(directory), extra_fields=service.FROZEN_FIELDS)
    prepared["warnings"].extend(warnings)
    return prepared


def load_attempt(directory, verify_inputs=False):
    request = json.loads(inside(directory, "request.json").read_text())
    if not media_adapters.known(request.get("provider")):
        raise ValueError("В подготовленном запросе нет provider подключённого адаптера генерации.")
    state = json.loads(inside(directory, "attempt.json").read_text())
    if hashlib.sha256(encoded(request)).hexdigest() != state["request_sha256"]:
        raise ValueError("Подготовленный запрос изменён; нужна новая попытка и новое согласование.")
    if verify_inputs:
        for item in [request["prompt"], *request["inputs"]]:
            if sha(inside(directory, item["path"])) != item["sha256"]:
                raise ValueError("Промпт или вход изменён; отправка запрещена.")
    return request, state


def status(directory):
    """Только локальный журнал попытки, без обращения к сервису."""
    return load_attempt(work_path(directory))[1]


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


def submit(directory, confirmation, timeout=60):
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
        service = media_adapters.adapter(request["provider"])
        state.update(status="submitting")
        if getattr(service, "TASK_TRACE_ID", False):
            # Один идентификатор на попытку: сервис связывает по нему загрузки, отправку и опрос одного намерения.
            state.setdefault("task_trace_id", uuid7())
        atomic_json(directory / "attempt.json", state)
        try:
            answer = service.submit(directory, request, dict(state), timeout)
            generation_id = identifier(answer.get("generation_id"))
        except RejectedRequest as error:
            # Явный отказ без ID задания — до оплаты: попытка остаётся неотправленной.
            state.update(status="prepared", last_rejection=str(error))
            atomic_json(directory / "attempt.json", state)
            raise RejectedRequest(
                "Сервис отклонил запрос до оплаты: " + str(error) + " Генерация не создана, кредиты не списаны."
            ) from None
        except NotSubmitted:
            state.update(status="prepared")
            atomic_json(directory / "attempt.json", state)
            raise
        except Exception:
            # Любой другой сбой после начала отправки — неизвестный исход, а не доказанное отсутствие списания.
            state.update(status="submission_unknown")
            atomic_json(directory / "attempt.json", state)
            raise ValueError(
                "Исход отправки неизвестен. Не повторяйте запрос; выясните ID задания и продолжите через resume."
            ) from None
        state.update(status="submitted", generation_id=generation_id)
        credits = answer.get("credits_consumed")
        if type(credits) in (int, float) and math.isfinite(credits):
            state["credits_consumed"] = credits
        atomic_json(directory / "attempt.json", state)
        return state


def publish(service, output, destination):
    """Адаптер пишет байты результата во временный файл; общий код публикует его атомарно и без перезаписи.

    Никаких ffprobe, хешей видео или анализа результата в процедуре получения нет.
    """
    temporary = destination.with_suffix(destination.suffix + ".part")
    try:
        service.fetch(output, temporary)
        if temporary.stat().st_size == 0:
            raise ValueError("Получен пустой результат.")
        os.link(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)


def image_extension(path):
    """Определяет контейнер оригинала по сигнатуре, а не по адресу или имени; @link request-format.md."""
    with path.open("rb") as stream:
        header = stream.read(12)
    if header.startswith(b"\x89PNG\r\n\x1a\n"):
        return ".png"
    if header.startswith(b"\xff\xd8\xff"):
        return ".jpg"
    if header.startswith(b"RIFF") and header[8:12] == b"WEBP":
        return ".webp"
    raise ValueError("Неизвестный формат изображения результата: ожидается PNG, JPEG или WebP по сигнатуре файла.")


def video_extension(path):
    with path.open("rb") as stream:
        header = stream.read(12)
    if header[4:8] != b"ftyp":
        raise ValueError("Ожидается видео MP4: файл не похож на MP4 по сигнатуре.")
    return ".mp4"


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


def verify_download(directory, request, item):
    if request["kind"] == "image":
        verify_saved_image(directory, item)
    elif inside(directory, item["path"]).stat().st_size != item["bytes"]:
        raise ValueError("Сохранённый результат изменился.")


def receive_image(service, output, directory, stem, number, state):
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
        publish(service, output, raw)
        name = stem + image_extension(raw)
        target = directory / name
        if target.exists() or target.is_symlink():
            raise ValueError("Выходной файл уже существует; он не будет перезаписан.")
        proof = {"number": number, "path": name, "bytes": raw.stat().st_size, "sha256": sha(raw)}
        # Хеш и размер записываются до атомарной публикации: существующий чужой файл не станет результатом.
        state["pending_download"] = proof
        atomic_json(directory / "attempt.json", state)
        os.link(raw, target)
        return proof


def receive_video(service, output, directory, name, number, state):
    pending = state.get("pending_download")
    target = directory / name
    # Намерение записывается до скачивания. Если процесс оборвался
    # после атомарной публикации файла, повтор принимает этот файл.
    if target.exists():
        if pending != {"number": number, "path": name} or target.is_symlink() or target.stat().st_size == 0:
            raise ValueError("Выходной файл уже существует; он не будет перезаписан.")
    else:
        state["pending_download"] = {"number": number, "path": name}
        atomic_json(directory / "attempt.json", state)
        try:
            publish(service, output, target)
        except Exception:
            state["status"] = "download_pending"
            atomic_json(directory / "attempt.json", state)
            raise ValueError(
                "Не удалось сохранить результат. Повторите resume для того же задания; "
                "существующие файлы не перезаписываются."
            ) from None
    return {"number": number, "path": name, "bytes": target.stat().st_size}


def receive(service, directory, request, state, outputs):
    """Сохраняет все результаты по порядку; уже зарегистрированные повторно не скачиваются."""
    state["status"] = "downloading"
    atomic_json(directory / "attempt.json", state)
    for number, output in enumerate(outputs, 1):
        existing = next((x for x in state["downloads"] if x["number"] == number), None)
        if existing:
            verify_download(directory, request, existing)
            continue
        stem = "original" if len(outputs) == 1 else f"original-{number:02}"
        if request["kind"] == "image":
            try:
                original = receive_image(service, output, directory, stem, number, state)
            except Exception:
                state["status"] = "download_pending"
                atomic_json(directory / "attempt.json", state)
                raise ValueError(
                    "Не удалось сохранить оригинал PNG/JPEG/WebP. Повторите resume того же задания; "
                    "существующие файлы не перезаписываются."
                ) from None
        else:
            original = receive_video(service, output, directory, stem + ".mp4", number, state)
        state["downloads"].append(original)
        state.pop("pending_download", None)
        atomic_json(directory / "attempt.json", state)
    state["status"] = "downloaded"
    atomic_json(directory / "attempt.json", state)


def resume(directory, generation_id=None, wait_seconds=0, interval=15, timeout=60):
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
        if not state.get("generation_id") and not (state.get("manual_result") and state["status"] == "downloaded"):
            raise ValueError("Нет ID задания; отправку через resume выполнить нельзя.")
        if state["status"] == "downloaded":
            for item in state["downloads"]:
                verify_download(directory, request, item)
            return state
        if state["status"] == "failed":
            return state
        service = media_adapters.adapter(request["provider"])
        deadline = time.monotonic() + wait_seconds
        while True:
            try:
                answer = service.poll(directory, request, dict(state), timeout)
                if answer.get("status") not in POLL_STATUSES:
                    raise ValueError()
            except Exception:
                raise ValueError("Не удалось запросить состояние. ID сохранён; повторите resume, не submit.") from None
            # Не сохраняем сообщения сервиса: они могут включать подписанные URL.
            service_status = str(answer.get("service_status", "unknown")).lower()
            state["service_status"] = service_status if re.fullmatch(r"[a-z_]{1,40}", service_status) else "unknown"
            if answer["status"] == "failed":
                state["status"] = "failed"
                atomic_json(directory / "attempt.json", state)
                return state
            if answer["status"] == "completed":
                outputs = answer.get("outputs")
                if isinstance(outputs, list) and len(outputs) == request["outputs"]:
                    receive(service, directory, request, state, outputs)
                    return state
                state["status"] = "outputs_pending"
            else:
                state["status"] = answer["status"]
            atomic_json(directory / "attempt.json", state)
            if time.monotonic() >= deadline:
                return state
            time.sleep(min(interval, max(0, deadline - time.monotonic())))


def unknown_attempt(directory):
    """Попытка с неизвестным исходом без ID: исход выясняет пользователь в истории генераций сервиса."""
    request, state = load_attempt(directory)
    unknown = state["status"] in ("submitting", "submission_unknown")
    if state.get("generation_id") or not unknown or state.get("downloads"):
        raise ValueError("Действие доступно только попытке с неизвестным исходом отправки и без ID задания.")
    return request, state


def resolve_unknown(state, resolution):
    # История решений сохраняется: по ней видно, что исход установил пользователь, а не сервис.
    stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    state.setdefault("unknown_outcomes", []).append({"resolution": resolution, "at": stamp})


def not_created(directory):
    """Пользователь не нашёл генерацию в истории сервиса: попытка снова готова к отправке с новым согласием."""
    directory = work_path(directory)
    with locked(directory):
        _, state = unknown_attempt(directory)
        state.update(status="prepared")
        resolve_unknown(state, "not_created")
        atomic_json(directory / "attempt.json", state)
        return state


def attach(directory, files):
    """Оригинал, скачанный пользователем из истории генераций, становится результатом попытки без новой отправки."""
    directory = work_path(directory)
    files = [Path(item) for item in files]
    with locked(directory):
        request, state = unknown_attempt(directory)
        if len(files) != request["outputs"]:
            raise ValueError(f"Нужно файлов результата: {request['outputs']}, выбрано: {len(files)}.")
        downloads = []
        with tempfile.TemporaryDirectory(prefix=".manual-result-", dir=directory) as temporary:
            staged = []
            for number, source in enumerate(files, 1):
                if not source.is_file():
                    raise ValueError("Файл результата не найден: " + source.name)
                raw = Path(temporary) / f"{number}.raw"
                shutil.copyfile(source, raw)
                if raw.stat().st_size == 0:
                    raise ValueError("Файл результата пуст: " + source.name)
                extension = image_extension(raw) if request["kind"] == "image" else video_extension(raw)
                name = ("original" if len(files) == 1 else f"original-{number:02}") + extension
                if (directory / name).exists() or (directory / name).is_symlink():
                    raise ValueError("Выходной файл уже существует; он не будет перезаписан.")
                staged.append((number, raw, name))
            for number, raw, name in staged:
                item = {"number": number, "path": name, "bytes": raw.stat().st_size}
                if request["kind"] == "image":
                    item["sha256"] = sha(raw)
                os.link(raw, directory / name)
                downloads.append(item)
        state.update(status="downloaded", downloads=downloads, manual_result=True)
        resolve_unknown(state, "manual_result")
        atomic_json(directory / "attempt.json", state)
        return state


def watch(directories, max_minutes=15, interval=20, timeout=60, report=print):
    """Одно длинное ожидание нескольких попыток: опрос по очереди, вывод только при смене статуса."""
    if not 1 <= max_minutes <= 120 or not 5 <= interval <= 300:
        raise ValueError("Ожидание — от 1 до 120 минут, интервал — от 5 до 300 секунд.")
    pending = {work_path(d): None for d in directories}
    results = {}
    deadline = time.monotonic() + max_minutes * 60
    while pending:
        for directory in list(pending):
            try:
                state = resume(directory, timeout=timeout)
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
            for directory, value in pending.items():
                results[str(directory)] = {
                    "status": value or "unknown",
                    "detail": "время ожидания вышло; задание не отменено, повторите watch",
                }
            break
        if pending:
            time.sleep(min(interval, max(0, deadline - time.monotonic())))
    return results


def capabilities(provider, kind, timeout=60):
    """Объявления моделей провайдера для вида медиа: {"reports": [...], "problems": [...]}."""
    if kind not in ("image", "video"):
        raise ValueError("Вид медиа должен быть image или video.")
    return media_adapters.adapter(provider).capabilities(kind, timeout)
