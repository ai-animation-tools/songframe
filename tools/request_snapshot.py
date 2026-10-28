"""Общая локальная подготовка неизменяемого запроса; @link regenerate_shot/README.md.

Вызывающий инструмент проверяет допустимую рабочую папку; адаптер отдельно проверяет
команды и ограничения своего сервиса. Этот модуль не отправляет запросы и не выбирает провайдера.
"""

import hashlib
import json
import os
import re
import shutil
import tempfile
from pathlib import Path

from tools.common import sha

def encoded(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2, allow_nan=False) + "\n").encode()


def atomic_json(path, value):
    # Состояние отправки должно пережить обрыв до получения ID. Подписанные
    # адреса и сырые ответы CLI никогда не попадают в этот файл.
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as stream:
        temporary = Path(stream.name)
        try:
            stream.write(encoded(value))
            stream.flush()
            os.fsync(stream.fileno())
        except BaseException:
            temporary.unlink(missing_ok=True)
            raise
    temporary.replace(path)



def validate_spec(spec):
    """Проверяет общую форму снимка без предположений о командах и слотах провайдера."""
    if not isinstance(spec, dict) or spec.get("schema_version") != 1:
        raise ValueError("Неизвестная схема запроса.")
    for field in ("provider", "command", "model", "prompt_file"):
        if not isinstance(spec.get(field), str) or not spec[field].strip():
            raise ValueError(f"Поле {field} должно быть непустой строкой.")
    if spec.get("kind") not in ("image", "video"):
        raise ValueError("Не указан вид результата.")
    if set(spec) - {
        "schema_version", "shot", "provider", "kind", "command", "model", "model_selection",
        "parameters", "outputs", "inputs", "prompt_file",
    }:
        raise ValueError("Неизвестные поля запроса.")
    if not isinstance(spec.get("parameters", {}), dict):
        raise ValueError("parameters должен быть объектом.")
    count = spec.get("outputs", 1)
    if type(count) is not int or count < 1:
        raise ValueError("Неверное число результатов.")
    if not isinstance(spec.get("inputs", []), list):
        raise ValueError("inputs должен быть списком.")
    for item in spec.get("inputs", []):
        if not isinstance(item, dict) or set(item) - {"flag", "slot", "role", "path", "sha256"}:
            raise ValueError("Неизвестные поля входа.")
        for field in ("flag", "path"):
            if not isinstance(item.get(field), str) or not item[field].strip():
                raise ValueError(f"У входа нет непустого {field}.")
        if "slot" in item and (not isinstance(item["slot"], str) or not item["slot"].strip()):
            raise ValueError("slot должен быть непустой строкой.")
        if "sha256" in item and (
            not isinstance(item["sha256"], str) or not re.fullmatch(r"[a-f0-9]{64}", item["sha256"])
        ):
            raise ValueError("У входа нет корректного SHA-256.")
    if "model_selection" in spec:
        selection = spec["model_selection"]
        if not isinstance(selection, dict) or set(selection) != {"preferredModel", "selectedModel", "reason"}:
            raise ValueError("model_selection должен содержать только preferredModel, selectedModel и reason.")
        preferred = selection["preferredModel"]
        if preferred is not None and (not isinstance(preferred, str) or not preferred.strip()):
            raise ValueError("preferredModel должен быть идентификатором модели или null.")
        if selection["selectedModel"] != spec["model"]:
            raise ValueError("selectedModel должен совпадать с model запроса.")
        if not isinstance(selection["reason"], str) or not selection["reason"].strip():
            raise ValueError("reason должен быть непустой строкой с причиной выбора модели.")
    encoded(spec.get("parameters", {}))

def prepare(request, directory, *, extra_fields=None):
    request = Path(request).resolve()
    directory = Path(directory).resolve()
    spec = json.loads(request.read_text())
    validate_spec(spec)
    if directory.exists():
        raise ValueError("Нужна новая папка попытки; существующая не перезаписывается.")
    prompt_source = (request.parent / spec["prompt_file"]).resolve()
    prompt_bytes = prompt_source.read_bytes()
    prompt = prompt_bytes.decode("utf-8")
    if not prompt.strip():
        raise ValueError("Промпт пуст.")
    directory.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".prepare-", dir=directory.parent) as temporary:
        staging = Path(temporary)
        (staging / "inputs").mkdir()
        (staging / "prompt.txt").write_bytes(prompt_bytes)
        inputs = []
        copies = {}
        for number, item in enumerate(spec.get("inputs", []), 1):
            source = (request.parent / item["path"]).resolve()
            digest = sha(source)
            if item.get("sha256", digest) != digest:
                raise ValueError("Хеш входа отличается от указанного в запросе.")
            if digest not in copies:
                name = f"inputs/{number:02}{source.suffix.lower()}"
                shutil.copyfile(source, staging / name)
                if sha(staging / name) != digest:
                    raise ValueError("Вход изменился при подготовке.")
                copies[digest] = name
            inputs.append(
                {k: item[k] for k in ("flag", "slot", "role") if k in item}
                | {"path": copies[digest], "sha256": digest, "bytes": source.stat().st_size}
            )
        frozen = {
            "schema_version": 1,
            "shot": spec.get("shot"),
            "provider": spec["provider"],
            "kind": spec["kind"],
            "command": spec["command"],
            "model": spec["model"],
            "parameters": spec.get("parameters", {}),
            "outputs": spec.get("outputs", 1),
            "inputs": inputs,
            "prompt": {"path": "prompt.txt", "sha256": sha(staging / "prompt.txt")},
        }
        # Метаданные адаптера входят в тот же SHA, но не навязываются другим провайдерам.
        frozen.update(extra_fields or {})
        if "model_selection" in spec:
            frozen["model_selection"] = spec["model_selection"]
        digest = hashlib.sha256(encoded(frozen)).hexdigest()
        atomic_json(staging / "request.json", frozen)
        atomic_json(
            staging / "attempt.json",
            {"schema_version": 1, "request_sha256": digest, "status": "prepared", "downloads": []},
        )
        # Папка появляется только целиком: недописанный запрос нельзя отправить.
        staging.rename(directory)
    return frozen | {"request_sha256": digest, "prompt_text": prompt, "work_dir": str(directory), "warnings": []}
