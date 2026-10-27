"""Кэш проверенных производных; @link README.md"""

import sys
from pathlib import Path

# После переноса точка запуска находится на два уровня ниже корня проекта.
# Полные импорты tools.* работают и при прямом запуске файла из любой папки.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))


import hashlib
import json
import tempfile
import time

from tools.common import sha


class ArtifactCache:
    """Ключ зависит от содержимого входов; частичная запись не считается готовой."""

    def __init__(self, directory):
        self.directory = Path(directory)
        self.events = []

    def paths(self, kind, recipe, suffix):
        raw = json.dumps(
            {"schema": 1, "kind": kind, "recipe": recipe}, sort_keys=True, ensure_ascii=False, separators=(",", ":")
        ).encode()
        key = hashlib.sha256(raw).hexdigest()
        folder = self.directory / kind
        return key, folder / (key + suffix), folder / (key + ".json")

    def lookup(self, kind, recipe, suffix):
        key, artifact, receipt = self.paths(kind, recipe, suffix)
        try:
            info = json.loads(receipt.read_text())
            if info["key"] == key and info["bytes"] == artifact.stat().st_size and info["sha256"] == sha(artifact):
                return artifact, info["details"]
        except (OSError, ValueError, KeyError, TypeError):
            pass
        return None

    def obtain(self, kind, recipe, suffix, producer):
        started = time.monotonic()
        hit = self.lookup(kind, recipe, suffix)
        if hit:
            artifact, details = hit
            reused = True
        else:
            key, artifact, receipt = self.paths(kind, recipe, suffix)
            artifact.parent.mkdir(parents=True, exist_ok=True)
            # Публикуем результат только после завершения producer и проверки.
            # Несовпадающий хеш после обрыва приведёт к безопасному пересозданию.
            with tempfile.TemporaryDirectory(prefix=".pending-", dir=artifact.parent) as tmp:
                pending = Path(tmp) / ("artifact" + suffix)
                details = producer(pending)
                info = {"key": key, "bytes": pending.stat().st_size, "sha256": sha(pending), "details": details}
                note = Path(tmp) / "receipt.json"
                note.write_text(json.dumps(info, ensure_ascii=False, indent=2) + "\n")
                pending.replace(artifact)
                note.replace(receipt)
            reused = False
        self.events.append(
            {"kind": kind, "hit": reused, "seconds": round(time.monotonic() - started, 6), "path": str(artifact)}
        )
        return artifact, details
