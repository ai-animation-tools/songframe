"""Загрузка закреплённых ONNX-моделей штатным встроенным Python. @link ../song_timing/README.md"""

import argparse
import hashlib
import os
import re
import signal
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from tools.song_timing.models import COMPONENTS, files_for, separator_model


def checksum(path):
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def download(item, directory):
    """Не публикуем неполные веса; повтор продолжает .part, существующий файл остаётся до проверки SHA."""
    target = directory / item["name"]
    if target.is_file() and target.stat().st_size == item["bytes"] and checksum(target) == item["sha256"]:
        print(f"Уже готово: {item['name']}", flush=True)
        return
    partial = target.with_suffix(target.suffix + ".part")
    offset = partial.stat().st_size if partial.exists() else 0
    if offset > item["bytes"]:
        partial.unlink()
        offset = 0
    if offset < item["bytes"]:
        request = urllib.request.Request(item["url"], headers={"Range": f"bytes={offset}-"} if offset else {})
        with urllib.request.urlopen(request, timeout=60) as response:
            # Не все CDN поддерживают Range: полный ответ безопасно заменяет только .part.
            if response.status not in (200, 206):
                raise ValueError(f"Сервер вернул неожиданный HTTP-статус: {response.status}")
            append = offset > 0 and response.status == 206
            if response.status == 206:
                content_range = re.fullmatch(
                    r"bytes (\d+)-(\d+)/(\d+)", response.headers.get("Content-Range", "") or ""
                )
                if not content_range or tuple(map(int, content_range.groups())) != (
                    offset,
                    item["bytes"] - 1,
                    item["bytes"],
                ):
                    raise ValueError("Сервер вернул неверное смещение загрузки; повторите загрузку.")
            received = offset if append else 0
            shown = -1
            with partial.open("ab" if append else "wb") as stream:
                for block in iter(lambda: response.read(1024 * 1024), b""):
                    stream.write(block)
                    received += len(block)
                    percent = min(100, received * 100 // item["bytes"])
                    if percent // 5 != shown:
                        shown = percent // 5
                        print(f"{item['name']}: {percent}%", flush=True)
                    if received > item["bytes"]:
                        break
    if partial.stat().st_size > item["bytes"]:
        partial.unlink(missing_ok=True)
        raise ValueError("Размер файла модели отличается от закреплённого.")
    if partial.stat().st_size < item["bytes"]:
        # Короткий ответ можно продолжить; повреждённый полный файл повторять бессмысленно.
        raise ValueError(f"Файл {item['name']} загружен не полностью")
    if checksum(partial) != item["sha256"]:
        partial.unlink(missing_ok=True)
        raise ValueError(f"Не совпала контрольная сумма {item['name']}. Повторите загрузку.")
    os.replace(partial, target)
    print(f"Проверено: {item['name']}", flush=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--project")
    parser.add_argument("--component", choices=COMPONENTS, default="alignment")
    args = parser.parse_args(argv)
    if not args.output.is_absolute():
        parser.error("--output должен быть абсолютным путём")

    def interrupt(_signum, _frame):
        # Jobs останавливает процесс через SIGTERM; закрытие .part сохраняет докачиваемый префикс.
        raise KeyboardInterrupt

    previous = signal.signal(signal.SIGTERM, interrupt)
    try:
        args.output.mkdir(parents=True, exist_ok=True)
        for item in files_for(args.component):
            download(item, args.output)
    except KeyboardInterrupt:
        print("Загрузка прервана. Повторите загрузку для продолжения.", file=sys.stderr)
        return 130
    except Exception as error:
        print(f"Загрузка моделей не завершена: {error}. Повторите загрузку для продолжения.", file=sys.stderr)
        return 1
    finally:
        signal.signal(signal.SIGTERM, previous)
    label = "уточнения границ" if args.component == "alignment" else separator_model(args.component)["label"]
    print(f"Модели {label} готовы.", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
