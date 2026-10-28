"""Тестовый адаптер провайдера генерации `test` без сети и платных запросов; @link README.md

Подключается только тестами: SONGFRAME_MEDIA_ADAPTERS="test=tools.testing.fake_media_request".
Поведение задаёт JSON-файл из SONGFRAME_TEST_MEDIA_SERVICE (без него — значения по умолчанию),
каждый вызов адаптера пишется строкой JSON в calls.jsonl рядом с этим файлом.
"""

import json
import os
import shutil
import struct
import tempfile
import unittest.mock
import zlib
from pathlib import Path

from tools.media_adapters import TEST_HOOK
from tools.media_request.attempt import NotSubmitted, RejectedRequest

ID = "test"
MODULE = "tools.testing.fake_media_request"
CONFIG_ENV = "SONGFRAME_TEST_MEDIA_SERVICE"
LOCAL_DIR_ENV = "SONGFRAME_LOCAL_DIR"
FROZEN_FIELDS = {}

VIDEO_ARGUMENTS = {
    "duration": {"default": "5", "allowed": ["3", "4", "5", "6", "8", "10"]},
    "resolution": {"default": "1080p", "allowed": ["720p", "1080p"]},
    "aspect_ratio": {"default": "16:9", "allowed": ["16:9", "9:16", "1:1"]},
}
IMAGE_ARGUMENTS = {"aspect_ratio": {"default": "16:9", "allowed": ["16:9", "9:16", "1:1"]}}
DEFAULT_REPORTS = {
    "image": [
        {
            "command": "text_to_image",
            "models": {"test-image": {"arguments": IMAGE_ARGUMENTS, "slots": {}, "limits": {}}},
        },
        {
            "command": "image_to_image",
            "models": {
                "test-image": {
                    "arguments": IMAGE_ARGUMENTS,
                    "slots": {"image_1": {"required": True}, "image_2": {"required": False}},
                    "limits": {},
                }
            },
        },
    ],
    "video": [
        {
            "command": "text_to_video",
            "models": {"test-video": {"arguments": VIDEO_ARGUMENTS, "slots": {}, "limits": {}}},
        },
        {
            "command": "image_to_video",
            "models": {
                "test-video": {
                    "arguments": VIDEO_ARGUMENTS,
                    "slots": {"first_image": {"required": True}, "tail_image": {"required": False}},
                    "limits": {},
                }
            },
        },
    ],
}
# Встроенные результаты: минимальные файлы с верными сигнатурами MP4 и PNG.
BUILTIN_VIDEO = b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom"


def builtin_png():
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    pixels = zlib.compress(b"\x00\x80\x80\x80" * 1)
    header = struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", pixels) + chunk(b"IEND", b"")


def config_path():
    value = os.environ.get(CONFIG_ENV)
    return Path(value) if value else None


def service_dir():
    path = config_path()
    return path.parent if path else Path(tempfile.gettempdir()) / "songframe-test-media"


def config():
    path = config_path()
    return json.loads(path.read_text(encoding="utf-8")) if path and path.is_file() else {}


def local(value):
    """Пути конфигурации отсчитываются от её папки."""
    return service_dir() / value


def journal(action, **details):
    service_dir().mkdir(parents=True, exist_ok=True)
    with (service_dir() / "calls.jsonl").open("a", encoding="utf-8") as stream:
        stream.write(json.dumps({"action": action, **details}, ensure_ascii=False) + "\n")


def calls(action=None):
    path = service_dir() / "calls.jsonl"
    entries = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()] if path.exists() else []
    return [entry for entry in entries if action is None or entry["action"] == action]


def validate_spec(spec):
    """Тестовый сервис принимает любые команды и параметры общей формы."""


def validate_prompt(prompt):
    return []


def capabilities(kind, timeout=60):
    journal("capabilities", kind=kind)
    data = config()
    if data.get("capabilities") == "error":
        raise ValueError("Тестовый сервис не подтвердил возможности.")
    return {
        "reports": data.get("reports", {}).get(kind, DEFAULT_REPORTS[kind]),
        "problems": data.get("problems", {}).get(kind, []),
    }


def submit(directory, request, state, timeout):
    prompt = (Path(directory) / request["prompt"]["path"]).read_bytes().decode("utf-8")
    journal(
        "submit",
        work_dir=str(directory),
        request_sha256=state["request_sha256"],
        **{key: request[key] for key in ("provider", "kind", "command", "model", "parameters", "outputs")},
        inputs=[{key: item[key] for key in ("flag", "slot", "sha256") if key in item} for item in request["inputs"]],
        prompt=prompt,
    )
    answer = config().get("submit", {})
    if answer == "unknown":
        raise RuntimeError("Тестовый сервис оборвал отправку.")
    if answer == "not_submitted":
        raise NotSubmitted("Тестовый сервис недоступен; отправка не начиналась.")
    if "reject" in answer:
        raise RejectedRequest(answer["reject"])
    result = {"generation_id": answer.get("generation_id", f"test-generation-{len(calls('submit'))}")}
    if "credits_consumed" in answer:
        result["credits_consumed"] = answer["credits_consumed"]
    return result


def poll(directory, request, state, timeout):
    previous = [entry for entry in calls("poll") if entry["generation_id"] == state["generation_id"]]
    journal("poll", work_dir=str(directory), generation_id=state["generation_id"])
    answer = config().get("poll", {"status": "completed"})
    if answer == "error":
        raise ValueError("Тестовый сервис не ответил на запрос состояния.")
    if isinstance(answer, list):
        answer = answer[min(len(previous), len(answer) - 1)]
    result = {"status": answer["status"], "service_status": answer.get("service_status", answer["status"])}
    if answer["status"] == "completed":
        files = config().get("results", {})
        output = str(local(files[request["kind"]])) if request["kind"] in files else "builtin:" + request["kind"]
        result["outputs"] = answer.get("outputs", [output] * request["outputs"])
    return result


def fetch(output, destination):
    journal("fetch", output=output)
    if output == "builtin:video":
        Path(destination).write_bytes(BUILTIN_VIDEO)
    elif output == "builtin:image":
        Path(destination).write_bytes(builtin_png())
    else:
        shutil.copyfile(output, destination)


def account(timeout=60):
    journal("account")
    balance = config().get("balance", 1000)
    if balance is None:
        return {"balance": None, "source": "тестовый сервис не сообщил остаток"}
    return {"balance": float(balance), "source": "тестовый сервис"}


def pricing_file():
    """Таблица цен из конфигурации; по умолчанию пустая таблица рядом с ней (цены узнаются наблюдениями)."""
    value = config().get("pricing")
    path = local(value) if value else service_dir() / "pricing.json"
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"schema_version": 1, "models": {}, "observed": []}), encoding="utf-8")
    return path


class Service:
    """Конфигурация и журнал тестового сервиса одного теста."""

    def __init__(self, path):
        self.path = path

    @property
    def directory(self):
        return self.path.parent

    def configure(self, **values):
        data = json.loads(self.path.read_text(encoding="utf-8"))
        data.update(values)
        self.path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")

    def calls(self, action=None):
        return calls(action)


def enable(test, **values):
    """Подключает адаптер `test` на время теста: запись в таблице адаптеров, конфигурация и каталог состояния
    (наблюдения цен, токены) во временной папке."""
    directory = Path(tempfile.mkdtemp(prefix="test-media-service-"))
    test.addCleanup(shutil.rmtree, directory, True)
    path = directory / "service.json"
    path.write_text(json.dumps(values, ensure_ascii=False), encoding="utf-8")
    variables = {TEST_HOOK: f"{ID}={MODULE}", CONFIG_ENV: str(path), LOCAL_DIR_ENV: str(directory / "state")}
    patcher = unittest.mock.patch.dict(os.environ, variables)
    patcher.start()
    test.addCleanup(patcher.stop)
    return Service(path)
