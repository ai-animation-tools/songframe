"""Ведение workflow.json рабочего пакета плана: этапы, опоры, промпт, очередь; @link README.md"""

import sys
from pathlib import Path

# После переноса точка запуска находится на два уровня ниже корня проекта.
# Полные импорты tools.* работают и при прямом запуске файла из любой папки.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))


import argparse
import json
import re
import shutil
import tempfile
import time
from datetime import datetime, timezone

from tools.common import ROOT, sha
from tools.scene_registry.scene_registry import generation_settings, load, scene_fingerprint
from tools.shot_status.shot_status import STAGE_LABELS, WAIT_LABELS

# Единый порядок этапов подготовки; прежние покадровые названия читаются как keyframes_review.
STAGES = [
    "description_review",
    "keyframes_review",
    "prompt_review",
    "request_choice",
    "ready",
    "submitted",
    "downloaded",
    "edit_review",
    "accepted",
]
# Image-ветка не меняет индексы и прежние переходы видео. @link README.md
IMAGE_STAGES = ("image_request_choice", "image_submitted", "image_downloaded")
REVISION = "needs_revision"
AWAITING = {"ready", REVISION}
MODES = ("shot", "frame")
# Протокол согласований с приложением: этапы, на которых задаётся вопрос, и допустимые ответы.
DECISION_STAGES = (
    "description_review",
    "keyframes_review",
    "prompt_review",
    "request_choice",
    "downloaded",
    "edit_review",
    "image_request_choice",
)
VERDICTS = ("approve", "revise", "send", "park", "accept", "retry", "review")
DEFAULT_QUESTIONS = {
    "description_review": ("Сгенерировать опоры по этому плану?", ["approve", "revise"]),
    "keyframes_review": ("Утвердить опоры?", ["approve", "revise"]),
    "prompt_review": ("Утвердить видеопромпт?", ["approve", "revise"]),
    "request_choice": ("Отправить запрос или сохранить пакет в очередь?", ["send", "park", "revise"]),
    "image_request_choice": ("Отправить запрос изображения или сохранить его на потом?", ["send", "park", "revise"]),
    "downloaded": ("Принять результат, исправить или собрать пробу?", ["accept", "retry", "review", "revise"]),
    "edit_review": ("Принять этот монтажный участок?", ["accept", "revise"]),
}
PROMPT_WARNING_CHARS = 2500
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp"}


def atomic_json(path, value):
    with tempfile.NamedTemporaryFile("w", dir=path.parent, delete=False, encoding="utf-8") as stream:
        stream.write(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
        temporary = Path(stream.name)
    temporary.replace(path)


def package_dir(value, root=ROOT, exist=True):
    """Папка пакета внутри plan/batches, plan/awaiting или временной папки; корни и защищённые папки запрещены."""
    root = Path(root).resolve()
    path = Path(value)
    path = (path if path.is_absolute() else root / path).resolve()
    allowed = [(root / name).resolve() for name in ("plan/batches", "plan/awaiting")]
    bases = [*allowed, Path(tempfile.gettempdir()).resolve()]
    if path in allowed or not any(path.is_relative_to(base) for base in bases):
        raise ValueError("Папка пакета должна находиться внутри plan/batches, plan/awaiting или временной папки.")
    if any(path.is_relative_to((root / name).resolve()) for name in ("assets", "source", "plan/animatic")):
        raise ValueError("Папка пакета не может находиться в assets, source или plan/animatic.")
    if exist and not (path / "workflow.json").is_file():
        raise ValueError("В папке нет workflow.json; создайте пакет командой init.")
    return path


def load_workflow(directory):
    data = json.loads((directory / "workflow.json").read_text(encoding="utf-8"))
    if data.get("schema_version") != 1 or not isinstance(data.get("shot"), str):
        raise ValueError("Неизвестная схема workflow.json.")
    if data.get("stage") not in (*STAGES, *IMAGE_STAGES, REVISION):
        raise ValueError("Неизвестный этап: " + str(data.get("stage")))
    data.setdefault("keyframes", [])
    data.setdefault("approved_frames", {})
    return data


def save_workflow(directory, data):
    pending = [k["id"] for k in data["keyframes"] if not k.get("approved")]
    data["current_keyframe"] = pending[0] if pending else None
    atomic_json(directory / "workflow.json", data)
    return data


def scene_of(root, shot):
    registry = load(root)
    scene = next((s for s in registry["scenes"] if s["id"] == shot), None)
    if scene is None:
        raise ValueError(f"{shot}: план отсутствует в реестре сцен.")
    return registry, scene


def init(shot, directory, mode="shot", root=ROOT, batch=None, retry_of=None):
    if mode not in MODES:
        raise ValueError("Режим согласования: shot или frame.")
    if batch is not None and not re.fullmatch(r"[A-Za-z0-9_.-]{1,40}", batch):
        raise ValueError("Имя партии: латиница, цифры, точка, дефис, подчёркивание.")
    registry, scene = scene_of(root, shot)
    directory = package_dir(directory, root, exist=False)
    # Повтор связывается с пакетом того же плана штатной командой, без ручной правки workflow.json.
    if retry_of is not None:
        previous = package_dir(retry_of, root)
        if previous == directory or load_workflow(previous)["shot"] != shot:
            raise ValueError("Повтор должен ссылаться на другой пакет того же плана.")
        retry_of = (
            str(previous.relative_to(Path(root).resolve()))
            if previous.is_relative_to(Path(root).resolve())
            else str(previous)
        )
    if directory.exists() and any(directory.iterdir()):
        raise ValueError("Папка пакета уже содержит файлы; выберите новую.")
    directory.mkdir(parents=True, exist_ok=True)
    frames = scene["end_frame_exclusive"] - scene["start_frame"]
    data = {
        "schema_version": 1,
        "shot": shot,
        "mode": mode,
        "stage": "description_review",
        "wait_reason": None,
        "request_dir": None,
        "description_approved": False,
        "scene_sha256": scene_fingerprint(registry, shot),
        "timing": {
            "fps": registry["fps"],
            "frames": frames,
            "window_seconds": frames / registry["fps"],
            "request_seconds": None,
        },
        "keyframes": [],
        "approved_frames": {},
        "prompt": {"path": "video-prompt.txt", "approved": False},
        "approved_prompt_sha256": None,
        "retry_of": retry_of,
        "frame_source": None,
        "model": None,
        "batch": batch,
    }
    return save_workflow(directory, data)


def plan_keyframes(directory, request_seconds, middles=(), root=ROOT):
    """Каркас опор: первый кадр, промежуточные по времени, конечный на границе запроса."""
    directory = package_dir(directory, root)
    data = load_workflow(directory)
    if type(request_seconds) is not int or request_seconds <= 0:
        raise ValueError("Длительность запроса задаётся целым числом секунд.")
    # Старые пакеты без generation сохраняют запас; новые используют правило выбранного проекта.
    project_path = Path(root) / "plan/project.json"
    project = json.loads(project_path.read_text(encoding="utf-8")) if project_path.is_file() else {}
    rule = (
        generation_settings(project)["duration_rule"]
        if "generation" in project
        else "min_supported_strictly_greater_than_window"
    )
    window = data["timing"]["window_seconds"]
    if rule == "exact_window":
        if not float(window).is_integer():
            raise ValueError(
                "exact_window требует целого монтажного окна в секундах: "
                "инструмент принимает целую длительность запроса."
            )
        if request_seconds != window:
            raise ValueError("Длительность запроса должна равняться монтажному окну по правилу exact_window.")
    elif rule == "min_supported_not_less_than_window":
        if request_seconds < window:
            raise ValueError("Длительность запроса должна быть не меньше монтажного окна по правилу проекта.")
    elif request_seconds <= window:
        raise ValueError("Длительность запроса должна быть строго больше монтажного окна по правилу проекта.")
    points = [(0.0, "first", "первый кадр")]
    for time_seconds, note in sorted(middles):
        if not 0 < time_seconds < request_seconds:
            raise ValueError("Промежуточная опора должна лежать внутри длительности запроса.")
        points.append((float(time_seconds), "middle", note))
    points.append((float(request_seconds), "last", "конечный кадр"))
    previous = {k["id"]: k for k in data["keyframes"]}
    keyframes = []
    for number, (time_seconds, role, note) in enumerate(points, 1):
        kid = f"K{number:02}"
        old = previous.get(kid)
        keep = old and old.get("role") == role and old.get("time_seconds") == time_seconds and old.get("approved")
        keyframes.append(
            {
                "id": kid,
                "role": role,
                "time_seconds": time_seconds,
                "note": note,
                "path": old["path"] if keep else None,
                "sha256": old["sha256"] if keep else None,
                "approved": bool(keep),
            }
        )
    data["keyframes"] = keyframes
    data["approved_frames"] = {k["id"]: k["sha256"] for k in keyframes if k["approved"]}
    data["timing"]["request_seconds"] = request_seconds
    return save_workflow(directory, data)


def approve(directory, keyframe_id, source, root=ROOT):
    directory = package_dir(directory, root)
    data = load_workflow(directory)
    keyframe = next((k for k in data["keyframes"] if k["id"] == keyframe_id), None)
    if keyframe is None:
        raise ValueError("Опора не входит в план: " + keyframe_id)
    source = Path(source).resolve()
    if not source.is_file() or source.suffix.lower() not in IMAGE_SUFFIXES:
        raise ValueError("Опора должна быть существующим изображением.")
    if source.is_relative_to(directory):
        relative = source.relative_to(directory)
    else:
        # Принятые байты остаются в пакете: пакет самодостаточен и переносится целиком.
        target = directory / "frames" / (keyframe_id + source.suffix.lower())
        target.parent.mkdir(exist_ok=True)
        shutil.copyfile(source, target)
        relative = target.relative_to(directory)
    digest = sha(directory / relative)
    keyframe.update(path=str(relative), sha256=digest, approved=True)
    data["approved_frames"][keyframe_id] = digest
    if data["stage"] == "description_review":
        data["stage"] = "keyframes_review"
    return save_workflow(directory, data)


def approve_prompt(directory, file=None, root=ROOT):
    directory = package_dir(directory, root)
    data = load_workflow(directory)
    pending = [k["id"] for k in data["keyframes"] if not k.get("approved")]
    if not data["keyframes"] or pending:
        raise ValueError("Сначала примите все опоры: " + (", ".join(pending) or "план опор пуст"))
    name = file or data.get("prompt", {}).get("path", "video-prompt.txt")
    path = (directory / name).resolve()
    if not path.is_relative_to(directory) or not path.is_file():
        raise ValueError("Файл промпта должен лежать в пакете.")
    text = path.read_text(encoding="utf-8")
    if not text.strip():
        raise ValueError("Промпт пуст.")
    digest = sha(path)
    data["prompt"] = {"path": str(path.relative_to(directory)), "approved": True, "chars": len(text)}
    data["approved_prompt_sha256"] = digest
    if data["stage"] in ("description_review", "keyframes_review"):
        data["stage"] = "prompt_review"
    warnings = (
        [f"Промпт длиннее {PROMPT_WARNING_CHARS} символов ({len(text)})."] if len(text) > PROMPT_WARNING_CHARS else []
    )
    return save_workflow(directory, data), warnings


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def propose(directory, keyframe_id, source, root=ROOT):
    """Регистрирует кандидата опоры: файл копируется в пакет, принятие остаётся за пользователем."""
    directory = package_dir(directory, root)
    data = load_workflow(directory)
    keyframe = next((k for k in data["keyframes"] if k["id"] == keyframe_id), None)
    if keyframe is None:
        raise ValueError("Опора не входит в план: " + keyframe_id)
    source = Path(source).resolve()
    if not source.is_file() or source.suffix.lower() not in IMAGE_SUFFIXES:
        raise ValueError("Кандидат опоры должен быть существующим изображением.")
    if source.is_relative_to(directory):
        relative = source.relative_to(directory)
    else:
        target = directory / "frames" / (keyframe_id + source.suffix.lower())
        target.parent.mkdir(exist_ok=True)
        shutil.copyfile(source, target)
        relative = target.relative_to(directory)
    keyframe.update(path=str(relative), sha256=sha(directory / relative), approved=False)
    data["approved_frames"].pop(keyframe_id, None)
    if data["stage"] == "description_review":
        data["stage"] = "keyframes_review"
    return save_workflow(directory, data)


def image_attempt(directory, data, request_dir=None):
    """Читает прежний frozen request/attempt, не создавая ещё одного журнала отправки."""
    from tools.kling_request.kling_request import load_attempt

    name = request_dir if request_dir is not None else data.get("image_request_dir")
    if not isinstance(name, str) or not name or Path(name).is_absolute():
        raise ValueError("Для изображения нужен относительный путь подготовленного запроса.")
    path = (directory / name).resolve()
    if path == directory or not path.is_relative_to(directory):
        raise ValueError("Запрос изображения должен лежать внутри рабочего пакета.")
    request, attempt = load_attempt(path, verify_inputs=True)
    if request.get("kind") != "image" or request.get("command") not in ("text_to_image", "image_to_image"):
        raise ValueError("Нужен подготовленный запрос kind=image.")
    if request.get("shot") not in (None, data["shot"]):
        raise ValueError("Запрос изображения относится к другому плану.")
    if not re.fullmatch(r"[a-f0-9]{64}", str(attempt.get("request_sha256", ""))):
        raise ValueError("Нет SHA подготовленного запроса изображения.")
    history = data.get("image_requests", [])
    if not isinstance(history, list) or any(not isinstance(item, dict) for item in history):
        raise ValueError("Повреждена история запросов изображений.")
    if request_dir is None:
        entry = next((item for item in history if item.get("request_dir") == name), None)
        if not entry or (entry.get("request_sha256"), entry.get("frame_id"), entry.get("provider")) != (
            attempt["request_sha256"],
            data.get("image_frame_id"),
            "kling",
        ):
            raise ValueError("Активный запрос не совпадает с историей изображений.")
    return path, request, attempt


def image_downloads(directory, attempt):
    """Возвращает только зарегистрированные оригиналы: посторонний файл кандидатом не становится."""
    downloads = attempt.get("downloads")
    if not isinstance(downloads, list) or not downloads:
        raise ValueError("У изображения нет сохранённых результатов.")
    paths = []
    for item in downloads:
        if not isinstance(item, dict) or not isinstance(item.get("path"), str) or Path(item["path"]).is_absolute():
            raise ValueError("Повреждён список результатов изображения.")
        path = (directory / item["path"]).resolve()
        if not path.is_relative_to(directory) or not path.is_file() or path.stat().st_size != item.get("bytes"):
            raise ValueError("Сохранённый оригинал отсутствует или изменён.")
        paths.append(path)
    return paths


def set_image_request(directory, frame_id, request_dir, root=ROOT):
    """Выставляет один вопрос о платной опоре; видео-запрос и история попыток сохраняются."""
    directory = package_dir(directory, root)
    data = load_workflow(directory)
    if data["stage"] not in ("description_review", "keyframes_review", "image_request_choice", REVISION):
        raise ValueError("Сначала завершите текущую отправку и выберите её результат.")
    # Отдельный факт принятия описания не теряется после send/выбора первой опоры.
    # Старый пакет получает его из прежнего решения только при отсутствии нового поля.
    decision = data.get("decision") or {}
    description_approved = data.get(
        "description_approved", decision.get("stage") == "description_review" and decision.get("verdict") == "approve"
    )
    if description_approved is not True:
        raise ValueError("Сначала утвердите описание перед подготовкой изображения.")
    frame = next((item for item in data["keyframes"] if item["id"] == frame_id), None)
    if (
        not re.fullmatch(r"K\d{2}", frame_id)
        or frame is None
        or frame.get("approved")
        or frame_id in data["approved_frames"]
    ):
        raise ValueError("Нужна существующая непринятая опора Kxx.")
    pending = data.get("pending_decision")
    if pending and pending.get("stage") != "image_request_choice":
        raise ValueError("Сначала ответьте на текущий вопрос производства.")
    # Не теряем оплаченную или неизвестную отправку при выборе следующей опоры.
    if data.get("image_request_dir"):
        previous_dir, _, previous = image_attempt(directory, data)
        if previous.get("status") != "prepared" or previous.get("generation_id"):
            if previous.get("status") != "downloaded":
                raise ValueError("Предыдущая отправка не выбрана; продолжите её без повторного submit.")
            previous_record = next(
                item for item in data["image_requests"] if item.get("request_dir") == data["image_request_dir"]
            )
            originals = image_downloads(previous_dir, previous)
            selected_sha256 = previous_record.get("selected_sha256")
            # Выбор оригинала переживает исправление описания и сброс candidate path.
            # Старый пакет пока можно подтвердить совпадающим кандидатом. @link README.md
            if selected_sha256 is None:
                selected = next((item for item in data["keyframes"] if item["id"] == data.get("image_frame_id")), {})
                selected_path = (directory / (selected.get("path") or "")).resolve()
                if not selected_path.is_file() or selected.get("sha256") != sha(selected_path):
                    raise ValueError("Опора не совпадает с выбранным оригиналом предыдущей отправки.")
                selected_sha256 = selected["sha256"]
            if (
                not isinstance(selected_sha256, str)
                or not re.fullmatch(r"[a-f0-9]{64}", selected_sha256)
                or not any(sha(path) == selected_sha256 for path in originals)
            ):
                raise ValueError("Хеш выбора не совпадает с сохранённым оригиналом предыдущей отправки.")
            previous_record["selected_sha256"] = selected_sha256
    path, _, attempt = image_attempt(directory, data, request_dir)
    name = str(path.relative_to(directory))
    if attempt.get("status") != "prepared" or attempt.get("generation_id") or attempt.get("downloads"):
        raise ValueError("Запрос уже отправлялся: используйте resume, не новую отправку.")
    history = data.get("image_requests", [])
    entry = {
        "frame_id": frame_id,
        "request_dir": name,
        "request_sha256": attempt["request_sha256"],
        "provider": "kling",
    }
    previous_entry = next((item for item in history if item.get("request_dir") == name), None)
    if previous_entry and any(previous_entry.get(key) != value for key, value in entry.items()):
        raise ValueError("Историю запроса изображения нельзя переписать.")
    if not previous_entry:
        history.append(entry)
    executor = data.get("executor", "agent")
    if executor not in ("app", "agent"):
        raise ValueError("Исполнитель продолжения: agent или app.")
    data.update(
        image_requests=history,
        image_request_dir=name,
        image_frame_id=frame_id,
        description_approved=True,
        stage="image_request_choice",
        wait_reason=None,
    )
    save_workflow(directory, data)
    return ask(directory, "image_request_choice", root=root, executor=executor)


def select_image(directory, file, root=ROOT):
    """Выбор оригинала создаёт только непринятый кадр, не меняя платный результат. @link README.md"""
    directory = package_dir(directory, root)
    data = load_workflow(directory)
    if data["stage"] != "image_downloaded":
        raise ValueError("Сначала дождитесь image_downloaded текущей попытки.")
    request_dir, _, attempt = image_attempt(directory, data)
    if attempt.get("status") != "downloaded":
        raise ValueError("Попытка изображения ещё не downloaded.")
    source = Path(file)
    source = (source if source.is_absolute() else directory / source).resolve()
    if source not in image_downloads(request_dir, attempt):
        raise ValueError("Выберите файл из downloads активной попытки изображения.")
    try:
        from PIL import Image

        with Image.open(source) as image:
            actual_format = image.format
            image.load()
    except (ImportError, OSError, ValueError, SyntaxError):
        raise ValueError("Нужен настоящий PNG, JPEG или WebP; для проверки требуется Pillow.") from None
    formats = {"PNG": {".png"}, "JPEG": {".jpg", ".jpeg"}, "WEBP": {".webp"}}
    if source.suffix.lower() not in formats.get(actual_format, set()):
        raise ValueError("Расширение оригинала не соответствует формату PNG, JPEG или WebP.")
    frame = next((item for item in data["keyframes"] if item["id"] == data.get("image_frame_id")), None)
    if frame is None or frame.get("approved") or frame["id"] in data["approved_frames"]:
        raise ValueError("Принятую или отсутствующую опору нельзя заменять.")
    target = directory / "keyframes" / (frame["id"] + source.suffix.lower())
    target.parent.mkdir(exist_ok=True)
    destination = target.resolve()
    request_dirs = [directory / item["request_dir"] for item in data["image_requests"]]
    if data.get("request_dir"):
        request_dirs.append(directory / data["request_dir"])
    if not destination.is_relative_to(directory) or any(
        destination.is_relative_to(path.resolve()) for path in request_dirs
    ):
        raise ValueError("Копия кандидата не должна заменять оригиналы запросов.")
    if any(
        item.get("approved") and item.get("path") and (directory / item["path"]).resolve() == destination
        for item in data["keyframes"]
    ):
        raise ValueError("Путь кандидата занят принятой опорой.")
    digest = sha(source)
    if target.exists() and target.samefile(source):
        raise ValueError("Кандидат должен быть отдельной копией оригинала.")
    shutil.copyfile(source, target)
    if sha(target) != digest:
        raise ValueError("Изображение изменилось при копировании кандидата.")
    # Это подтверждение выбора сохранённого оригинала, а не художественное принятие опоры.
    selected_record = next(
        item for item in data["image_requests"] if item.get("request_dir") == data["image_request_dir"]
    )
    selected_record.update(selected_sha256=digest, selected_at=now())
    frame.update(path=str(target.relative_to(directory)), sha256=digest, approved=False)
    data["approved_frames"].pop(frame["id"], None)
    data.update(stage="keyframes_review", pending_decision=None, decision=None, wait_reason=None)
    return save_workflow(directory, data)


def ask(directory, stage, question=None, options=None, root=ROOT, executor="agent"):
    """Записывает вопрос и владельца продолжения; прежние вызовы оставляют ожидание агенту."""
    directory = package_dir(directory, root)
    data = load_workflow(directory)
    if stage not in DECISION_STAGES:
        raise ValueError("Вопрос задаётся на этапах: " + ", ".join(DECISION_STAGES))
    if executor not in ("agent", "app"):
        raise ValueError("Исполнитель продолжения: agent или app.")
    default_question, default_options = DEFAULT_QUESTIONS[stage]
    options = options or default_options
    if any(o not in VERDICTS for o in options):
        raise ValueError("Варианты ответа: " + ", ".join(VERDICTS))
    # Владелец остаётся в пакете после ответа; это не отдельный этап согласования.
    data["executor"] = executor
    data["pending_decision"] = {
        "stage": stage,
        "question": question or default_question,
        "options": list(options),
        "asked_at": now(),
        "executor": executor,
    }
    data["decision"] = None
    return save_workflow(directory, data)


def decide(directory, verdict, note="", root=ROOT):
    """Применить принятие опор и промпта; остальные ответы исполняет агент или приложение."""
    directory = package_dir(directory, root)
    data = load_workflow(directory)
    if verdict not in VERDICTS:
        raise ValueError("Неизвестный ответ: " + verdict)
    pending = data.get("pending_decision") or {}
    stage = pending.get("stage") or data["stage"]
    if pending.get("options") and verdict not in pending["options"]:
        raise ValueError(f"Для вопроса «{pending.get('question')}» допустимы ответы: {', '.join(pending['options'])}.")
    if stage == "description_review" and verdict in ("approve", "revise"):
        data["description_approved"] = verdict == "approve"
    if verdict == "revise" and stage == "keyframes_review":
        # Отклонённый кандидат перестаёт считаться готовой опорой; файлы и paid originals остаются.
        for keyframe in data["keyframes"]:
            if not keyframe.get("approved"):
                keyframe.update(path=None, sha256=None)
    if verdict == "approve" and stage == "keyframes_review":
        candidates = [k for k in data["keyframes"] if k.get("path") and not k.get("approved")]
        if not candidates and not all(k.get("approved") for k in data["keyframes"]):
            raise ValueError("Нет кандидатов опор для принятия.")
        for keyframe in candidates:
            path = directory / keyframe["path"]
            if not path.is_file() or sha(path) != keyframe["sha256"]:
                raise ValueError(f"{keyframe['id']}: файл кандидата отсутствует или изменён.")
            keyframe["approved"] = True
            data["approved_frames"][keyframe["id"]] = keyframe["sha256"]
        save_workflow(directory, data)
    elif verdict == "approve" and stage == "prompt_review":
        save_workflow(directory, data)
        data, _ = approve_prompt(directory, None, root)
    data["decision"] = {"stage": stage, "verdict": verdict, "note": note or "", "at": now()}
    data["pending_decision"] = None
    return save_workflow(directory, data)


def wait(directory, timeout=1800, interval=3, root=ROOT, sleep=time.sleep, clock=time.monotonic):
    """Ждёт ответа пользователя из приложения: 0 решение, 2 время вышло, 3 пакет изменил этап снаружи."""
    directory = package_dir(directory, root)
    data = load_workflow(directory)
    pending = data.get("pending_decision")
    if not pending:
        if data.get("decision"):
            return 0, data["decision"]
        raise ValueError("Нет ожидающего вопроса: сначала ask.")
    stage_at_start = data["stage"]
    deadline = clock() + timeout
    while True:
        data = load_workflow(directory)
        decision = data.get("decision")
        if decision and decision.get("stage") == pending["stage"] and not data.get("pending_decision"):
            return 0, decision
        if data["stage"] != stage_at_start and data["stage"] != REVISION:
            return 3, {"stage": data["stage"], "verdict": None, "note": "этап пакета изменён снаружи", "at": now()}
        if clock() >= deadline:
            return 2, None
        sleep(interval)


def allowed_transition(current, target):
    if target == REVISION:
        return current != "accepted"
    if current == REVISION:
        return target in STAGES[:4] or target in ("ready", "image_request_choice")
    if target in IMAGE_STAGES or current in IMAGE_STAGES:
        return (current, target) in {
            ("description_review", "image_request_choice"),
            ("keyframes_review", "image_request_choice"),
            ("image_request_choice", "image_submitted"),
            ("image_submitted", "image_downloaded"),
            ("image_request_choice", "keyframes_review"),
            ("image_downloaded", "keyframes_review"),
        }
    here, there = STAGES.index(current), STAGES.index(target)
    return (
        there < here
        or there == here + 1
        or (current, target) in {("request_choice", "submitted"), ("downloaded", "accepted")}
    )


def set_stage(directory, stage, wait_reason=None, request_dir=None, root=ROOT):
    directory = package_dir(directory, root)
    data = load_workflow(directory)
    if stage not in (*STAGES, *IMAGE_STAGES, REVISION):
        raise ValueError("Неизвестный этап: " + stage)
    if stage in IMAGE_STAGES:
        if request_dir is not None:
            raise ValueError("Для изображения используйте set-image-request; video request_dir сохраняется.")
        _, _, attempt = image_attempt(directory, data)
        if stage == "image_request_choice" and (attempt.get("status") != "prepared" or attempt.get("generation_id")):
            raise ValueError("Отправленный запрос нельзя вернуть к новому submit; используйте resume.")
        if stage == "image_submitted":
            decision = data.get("decision") or {}
            if (
                decision.get("stage") != "image_request_choice"
                or decision.get("verdict") != "send"
                or data.get("pending_decision")
            ):
                raise ValueError("Сначала подтвердите отдельный запрос изображения ответом send.")
            statuses = {
                "submitting",
                "submission_unknown",
                "submitted",
                "running",
                "downloading",
                "download_pending",
                "outputs_pending",
                "watermark_free_pending",
                "downloaded",
                "failed",
            }
            if attempt.get("status") not in statuses or (
                not attempt.get("generation_id") and attempt.get("status") not in ("submitting", "submission_unknown")
            ):
                raise ValueError("Отправка изображения ещё не зарегистрирована в attempt.json.")
        if stage == "image_downloaded" and (attempt.get("status") != "downloaded" or not attempt.get("generation_id")):
            raise ValueError("Результат изображения ещё не downloaded.")
    if stage == data["stage"] and wait_reason is None and request_dir is None:
        return data
    if stage != data["stage"] and not allowed_transition(data["stage"], stage):
        raise ValueError(
            f"Переход {data['stage']} → {stage} не предусмотрен: вперёд только на следующий этап, назад — на любой."
        )
    if stage in AWAITING:
        if wait_reason is None and data.get("wait_reason") is None:
            raise ValueError("Для этапа очереди укажите причину ожидания: " + ", ".join(WAIT_LABELS))
        if wait_reason is not None and wait_reason not in WAIT_LABELS:
            raise ValueError("Неизвестная причина ожидания: " + wait_reason)
        data["wait_reason"] = wait_reason or data["wait_reason"]
    else:
        data["wait_reason"] = None
    if request_dir is not None:
        if not (directory / request_dir / "request.json").is_file():
            raise ValueError("В указанной папке запроса нет request.json.")
        data["request_dir"] = request_dir
    if stage in ("request_choice", "ready", "submitted") and not data.get("request_dir"):
        raise ValueError("Для этого этапа нужен подготовленный запрос: укажите --request-dir.")
    data["stage"] = stage
    return save_workflow(directory, data)


def problems(directory, data, root=ROOT):
    issues = []
    try:
        registry, _ = scene_of(root, data["shot"])
        if scene_fingerprint(registry, data["shot"]) != data.get("scene_sha256"):
            issues.append("постановка или унаследованное состояние изменились после подготовки: пересогласуйте пакет")
    except ValueError as error:
        issues.append(str(error))
    for keyframe in data["keyframes"]:
        if keyframe.get("approved"):
            path = directory / keyframe["path"]
            if not path.is_file():
                issues.append(f"{keyframe['id']}: файл опоры отсутствует")
            elif sha(path) != keyframe["sha256"]:
                issues.append(f"{keyframe['id']}: байты опоры изменились после принятия")
    prompt = data.get("prompt", {})
    if prompt.get("approved"):
        path = directory / prompt["path"]
        if not path.is_file() or sha(path) != data.get("approved_prompt_sha256"):
            issues.append("промпт изменён или удалён после принятия")
    if data.get("request_dir"):
        request_dir = directory / data["request_dir"]
        if not (request_dir / "request.json").is_file():
            issues.append("папка запроса не содержит request.json")
    if data.get("image_request_dir"):
        try:
            image_attempt(directory, data)
        except (ValueError, OSError, KeyError, TypeError) as error:
            issues.append("запрос изображения: " + str(error))
    return issues


def report(directory, root=ROOT):
    directory = package_dir(directory, root)
    data = load_workflow(directory)
    attempt = None
    if data.get("request_dir") and (directory / data["request_dir"] / "attempt.json").is_file():
        attempt = json.loads((directory / data["request_dir"] / "attempt.json").read_text(encoding="utf-8"))
    image_status = None
    if data.get("image_request_dir"):
        try:
            _, _, image_state = image_attempt(directory, data)
            image_status = image_state.get("status")
        except (ValueError, OSError, KeyError, TypeError):
            pass
    hints = {
        "image_request_choice": "покажите image request SHA и cost_check; каждую отправку подтвердите отдельно",
        "image_submitted": "продолжите ту же попытку: kling_request resume, не submit",
        "image_downloaded": "пользователь выбирает оригинал: select-image --file ПУТЬ",
        "description_review": "согласуйте описание, затем plan-keyframes и approve",
        "keyframes_review": "примите опоры: approve ID ПУТЬ; затем approve-prompt",
        "prompt_review": "после принятия промпта подготовьте запрос: kling_request prepare, "
        "затем set-stage request_choice --request-dir",
        "request_choice": "покажите таблицу запроса и cost_check; «отправить» — submit, «сохранить» — park",
        "ready": "пакет ждёт в очереди; продолжение по скиллу",
        REVISION: "исправьте затронутые опоры или промпт",
        "submitted": "ожидайте результат: kling_request resume",
        "downloaded": "покажите результат; решение пользователя",
        "edit_review": "уточните монтажный участок, затем accept_shot",
        "accepted": "перенесите комплект в assets и очистите пакет",
    }
    return {
        "directory": str(directory),
        "shot": data["shot"],
        "mode": data.get("mode"),
        "stage": data["stage"],
        "stage_label": STAGE_LABELS.get(data["stage"], data["stage"]),
        "wait_reason": data.get("wait_reason"),
        "batch": data.get("batch"),
        "current_keyframe": data.get("current_keyframe"),
        "timing": data.get("timing"),
        "keyframes": data["keyframes"],
        "prompt": data.get("prompt"),
        "request_dir": data.get("request_dir"),
        "attempt_status": attempt.get("status") if isinstance(attempt, dict) else None,
        "image_request_dir": data.get("image_request_dir"),
        "image_frame_id": data.get("image_frame_id"),
        "image_requests": data.get("image_requests", []),
        "image_attempt_status": image_status,
        "description_approved": data.get(
            "description_approved",
            (data.get("decision") or {}).get("stage") == "description_review"
            and (data.get("decision") or {}).get("verdict") == "approve",
        ),
        "executor": data.get("executor", "agent"),
        "pending_decision": data.get("pending_decision"),
        "decision": data.get("decision"),
        "problems": problems(directory, data, root),
        "next_action": hints.get(data["stage"], ""),
    }


def park(directory, root=ROOT, wait_reason="user_saved"):
    """Переносит самодостаточный пакет в plan/awaiting/Mxx после проверки файлов и хешей."""
    directory = package_dir(directory, root)
    data = load_workflow(directory)
    if wait_reason not in WAIT_LABELS:
        raise ValueError("Неизвестная причина ожидания: " + wait_reason)
    issues = problems(directory, data, root)
    if issues:
        raise ValueError("Пакет не готов к переносу: " + "; ".join(issues))
    image_only = data["stage"] == "image_request_choice" and bool(data.get("image_request_dir"))
    if image_only:
        _, _, attempt = image_attempt(directory, data)
        if attempt.get("status") != "prepared" or attempt.get("generation_id"):
            raise ValueError("Отправленную image-попытку продолжайте через resume.")
    elif not data.get("request_dir"):
        raise ValueError("В очередь переносится пакет с подготовленным запросом: укажите request_dir через set-stage.")
    target = Path(root).resolve() / "plan/awaiting" / data["shot"]
    if target.exists():
        raise ValueError(f"Пакет {data['shot']} уже есть в очереди; сначала прочитайте и решите его судьбу.")
    data["stage"] = "ready" if not image_only and data["stage"] not in AWAITING else data["stage"]
    data["wait_reason"] = wait_reason
    save_workflow(directory, data)
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(directory), str(target))
    return target


def table(info):
    lines = [
        f"План {info['shot']} · режим {info['mode']} · этап: {info['stage_label']} (`{info['stage']}`)"
        + (f" · партия {info['batch']}" if info.get("batch") else "")
    ]
    if info["wait_reason"]:
        lines.append("Причина ожидания: " + WAIT_LABELS.get(info["wait_reason"], info["wait_reason"]))
    timing = info.get("timing") or {}
    lines.append(
        f"Окно {timing.get('window_seconds')} с ({timing.get('frames')} кадров), "
        f"запрос {timing.get('request_seconds') or 'не задан'} с"
    )
    if info["keyframes"]:
        lines += ["", "| Опора | Роль | Время, с | Принята | Файл |", "| --- | --- | --- | --- | --- |"]
        for k in info["keyframes"]:
            lines.append(
                f"| {k['id']} | {k['role']} | {k['time_seconds']:g} | "
                f"{'да' if k.get('approved') else 'нет'} | {k.get('path') or '—'} |"
            )
    prompt = info.get("prompt") or {}
    lines += [
        "",
        "Промпт: "
        + ("принят" if prompt.get("approved") else "не принят")
        + (f", {prompt['chars']} символов" if prompt.get("chars") else ""),
    ]
    if info["request_dir"]:
        lines.append(
            f"Запрос: {info['request_dir']}"
            + (f", состояние попытки {info['attempt_status']}" if info["attempt_status"] else "")
        )
    if info.get("image_request_dir"):
        lines.append(
            f"Запрос опоры {info['image_frame_id']}: {info['image_request_dir']}, "
            f"состояние {info['image_attempt_status']}"
        )
    for issue in info["problems"]:
        lines.append("Проблема: " + issue)
    lines.append("Дальше: " + info["next_action"])
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    p = sub.add_parser("init")
    p.add_argument("shot")
    p.add_argument("--dir", required=True)
    p.add_argument("--mode", choices=MODES, default="shot")
    p.add_argument("--batch", help="Имя партии независимых планов, готовящихся вместе")
    p.add_argument("--retry-of", help="Пакет того же плана, для которого создаётся исправленная попытка")
    p = sub.add_parser("plan-keyframes")
    p.add_argument("--dir", required=True)
    p.add_argument("--request-seconds", type=int, required=True)
    p.add_argument("--middle", action="append", default=[], metavar="СЕК:ЗАМЕТКА")
    p = sub.add_parser("approve")
    p.add_argument("--dir", required=True)
    p.add_argument("keyframe")
    p.add_argument("path")
    p = sub.add_parser("approve-prompt")
    p.add_argument("--dir", required=True)
    p.add_argument("--file")
    p = sub.add_parser("set-stage")
    p.add_argument("--dir", required=True)
    p.add_argument("stage")
    p.add_argument("--wait-reason", choices=sorted(WAIT_LABELS))
    p.add_argument("--request-dir")
    p = sub.add_parser("set-image-request")
    p.add_argument("--dir", required=True)
    p.add_argument("--frame", required=True)
    p.add_argument("--request-dir", required=True)
    p = sub.add_parser("select-image")
    p.add_argument("--dir", required=True)
    p.add_argument("--file", required=True)
    p = sub.add_parser("park")
    p.add_argument("--dir", required=True)
    p.add_argument("--wait-reason", choices=sorted(WAIT_LABELS), default="user_saved")
    p = sub.add_parser("propose")
    p.add_argument("--dir", required=True)
    p.add_argument("keyframe")
    p.add_argument("path")
    p = sub.add_parser("ask")
    p.add_argument("--dir", required=True)
    p.add_argument("--stage", required=True, choices=DECISION_STAGES)
    p.add_argument("--question")
    p.add_argument("--options", help="Через запятую: " + ",".join(VERDICTS))
    p.add_argument(
        "--executor",
        choices=("agent", "app"),
        default="agent",
        help="Кто продолжает после решения: агент с wait или приложение",
    )
    p = sub.add_parser("decide")
    p.add_argument("--dir", required=True)
    p.add_argument("--verdict", required=True, choices=VERDICTS)
    p.add_argument("--note", default="")
    p.add_argument("--json", action="store_true")
    p = sub.add_parser("wait")
    p.add_argument("--dir", required=True)
    p.add_argument("--timeout", type=float, default=1800)
    p.add_argument("--interval", type=float, default=3)
    for action in ("show", "check"):
        p = sub.add_parser(action)
        p.add_argument("--dir", required=True)
        p.add_argument("--json", action="store_true")
    args = parser.parse_args()
    try:
        if args.action == "init":
            data = init(args.shot, args.dir, args.mode, batch=args.batch, retry_of=args.retry_of)
            print(f"Пакет {data['shot']} создан: этап {data['stage']}, окно {data['timing']['window_seconds']} с.")
        elif args.action == "plan-keyframes":
            middles = []
            for item in args.middle:
                seconds, _, note = item.partition(":")
                middles.append((float(seconds), note or "промежуточная опора"))
            data = plan_keyframes(args.dir, args.request_seconds, middles)
            print(table(report(args.dir)))
        elif args.action == "approve":
            data = approve(args.dir, args.keyframe, args.path)
            print(
                f"{args.keyframe} принята; следующая: "
                f"{data['current_keyframe'] or 'все опоры приняты, можно approve-prompt'}."
            )
        elif args.action == "approve-prompt":
            data, warnings = approve_prompt(args.dir, args.file)
            print("Промпт принят: " + data["approved_prompt_sha256"] + ("\n" + "\n".join(warnings) if warnings else ""))
        elif args.action == "set-stage":
            data = set_stage(args.dir, args.stage, args.wait_reason, args.request_dir)
            print(f"Этап: {data['stage']}.")
        elif args.action == "set-image-request":
            data = set_image_request(args.dir, args.frame, args.request_dir)
            print(f"Запрос опоры {data['image_frame_id']} ждёт отдельного подтверждения: {data['image_request_dir']}.")
        elif args.action == "select-image":
            data = select_image(args.dir, args.file)
            print(f"{data['image_frame_id']}: кандидат выбран; художественное принятие отдельно.")
        elif args.action == "park":
            print("Пакет перенесён: " + str(park(args.dir, wait_reason=args.wait_reason)))
        elif args.action == "propose":
            data = propose(args.dir, args.keyframe, args.path)
            print(f"{args.keyframe} предложена как кандидат; ждёт решения пользователя.")
        elif args.action == "ask":
            data = ask(
                args.dir,
                args.stage,
                args.question,
                args.options.split(",") if args.options else None,
                executor=args.executor,
            )
            continuation = (
                "Ждите ответ командой wait." if args.executor == "agent" else "Продолжение выполняет приложение."
            )
            print(
                f"Вопрос записан для приложения: {data['pending_decision']['question']} "
                f"({', '.join(data['pending_decision']['options'])}). {continuation}"
            )
        elif args.action == "decide":
            data = decide(args.dir, args.verdict, args.note)
            print(
                json.dumps(data["decision"], ensure_ascii=False)
                if args.json
                else f"Ответ записан: {args.verdict}" + (f" ({args.note})" if args.note else "")
            )
        elif args.action == "wait":
            code, decision = wait(args.dir, args.timeout, args.interval)
            print(
                json.dumps(decision, ensure_ascii=False)
                if decision
                else "Время ожидания вышло; вопрос остаётся, повторите wait."
            )
            raise SystemExit(code)
        else:
            info = report(args.dir)
            print(json.dumps(info, ensure_ascii=False, indent=2) if args.json else table(info))
            if args.action == "check" and info["problems"]:
                raise SystemExit(1)
    except (ValueError, OSError, KeyError, TypeError) as error:
        parser.exit(
            1,
            (
                str(error)
                if isinstance(error, ValueError) and not isinstance(error, json.JSONDecodeError)
                else "Ошибка файлов пакета; сырой вывод скрыт."
            )
            + "\n",
        )


if __name__ == "__main__":
    main()
