#!/usr/bin/env python3
"""Проверяет готовый Windows ZIP на Linux, не исполняя Windows-код. @link README.md"""

import argparse
import hashlib
import json
import re
import sys
import zipfile
from pathlib import Path

REQUIRED_FILES = (
    "SongFrame.exe",
    "resources/app.asar",
    "resources/runtime/manifest.json",
    "resources/runtime/requirements.lock",
    "resources/runtime/python/python.exe",
    "resources/runtime/bin/ffmpeg.exe",
    "resources/runtime/bin/ffprobe.exe",
    "resources/runtime/media-manifest.json",
    "resources/kling/package.json",
    "resources/kling/dist/cli.js",
    "resources/kling/manifest.json",
    "resources/kling/SOURCES.md",
    "check-runtime.cmd",
    "ПРОЧТИ.md",
)


def check_archive(archive: Path, version: str | None = None) -> dict:
    """Проверяет именно архив поставки и сохраняет рядом его SHA256 и границу проверки."""
    match = re.fullmatch(r"songframe-(.+)-win-x64\.zip", archive.name)
    if not match:
        raise ValueError("Имя ZIP должно иметь вид songframe-<версия>-win-x64.zip.")
    archive_version = match.group(1)
    if version is not None and archive_version != version:
        raise ValueError(f"Версия ZIP {archive_version} не совпадает с ожидаемой {version}.")

    with zipfile.ZipFile(archive) as package:
        damaged = package.testzip()
        if damaged:
            raise ValueError(f"Повреждён ресурс ZIP (CRC): {damaged}")
        files = {entry.filename: entry for entry in package.infolist()}
        for name in REQUIRED_FILES:
            entry = files.get(name)
            if entry is None or entry.is_dir() or entry.file_size == 0:
                raise ValueError(f"Обязательный ресурс отсутствует или пуст: {name}")

        # Запрещены только поставляемые веса в корне runtime; пакеты Python с именем models допустимы.
        if any(name == "resources/runtime/models" or name.startswith("resources/runtime/models/") for name in files):
            raise ValueError("В Windows ZIP попал каталог весов resources/runtime/models.")
        runtime = json.loads(package.read("resources/runtime/manifest.json"))
        media = json.loads(package.read("resources/runtime/media-manifest.json"))
        for name, manifest in (("runtime", runtime), ("media", media)):
            if not isinstance(manifest, dict) or manifest.get("target") != "win32-x64":
                raise ValueError(f"Манифест {name} должен содержать target: win32-x64.")
        cmd = package.read("check-runtime.cmd")
        without_crlf = cmd.replace(b"\r\n", b"")
        if not cmd.isascii() or b"\n" in without_crlf or b"\r" in without_crlf:
            raise ValueError("check-runtime.cmd должен содержать только ASCII и переносы CRLF.")

    with archive.open("rb") as source:
        digest = hashlib.file_digest(source, "sha256").hexdigest()
    report = {
        "ok": True,
        "validation": "archive-only",
        "nativeExecution": False,
        "target": "win32-x64",
        "version": archive_version,
        "zip": archive.name,
        "sha256": digest,
        "archive": {"file": archive.name, "bytes": archive.stat().st_size, "sha256": digest},
        "checks": {
            "crc": True,
            "requiredFiles": list(REQUIRED_FILES),
            "runtimeTarget": True,
            "mediaTarget": True,
            "externalModels": True,
            "cmdAsciiCrlf": True,
        },
    }
    archive.with_suffix(archive.suffix + ".sha256").write_text(f"{digest}  {archive.name}\n", encoding="utf-8")
    (archive.parent / "windows-archive-check.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path, help="Конкретный ZIP готовой Windows-поставки")
    parser.add_argument("--version", help="Ожидаемая версия в имени ZIP")
    args = parser.parse_args()
    try:
        report = check_archive(args.archive, args.version)
    except (OSError, ValueError, RuntimeError, zipfile.BadZipFile) as error:
        print(f"Ошибка проверки Windows ZIP: {error}", file=sys.stderr)
        return 1
    print(f"Windows ZIP проверен: {report['archive']['file']} (только архив, Windows-код не запускался).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
