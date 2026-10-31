#!/usr/bin/env python3
"""Проверяет готовый Windows-установщик NSIS на Linux, не исполняя Windows-код. @link README.md"""

import argparse
import ast
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

# Внутри установщика electron-builder дерево приложения лежит отдельным 7z-архивом.
PAYLOAD = "$PLUGINSDIR/app-64.7z"
# Деинсталлятор извлекается при сборке без Wine (nsis-uninstaller.cjs), поэтому его наличие проверяется отдельно.
UNINSTALLER = "$R0/Uninstall SongFrame.exe"
REPORT = "windows-installer-check.json"

REQUIRED_FILES = (
    "SongFrame.exe",
    "resources/app.asar",
    "resources/runtime/manifest.json",
    "resources/runtime/requirements.lock",
    "resources/runtime/python/python.exe",
    "resources/runtime/bin/ffmpeg.exe",
    "resources/runtime/bin/ffprobe.exe",
    "resources/runtime/media-manifest.json",
    "resources/tools/media_request/media_request.py",
    "resources/tools/media_adapters.py",
    "check-runtime.cmd",
    "ПРОЧТИ.md",
)

ADAPTERS_FILE = "resources/tools/media_adapters.py"


def provider_adapter_files(source: str) -> list[str]:
    """Модули адаптеров платных провайдеров берутся из таблицы ADAPTERS, а не вшиваются сюда по имени сервиса."""
    for node in ast.parse(source).body:
        targets = node.targets if isinstance(node, ast.Assign) else []
        if any(isinstance(target, ast.Name) and target.id == "ADAPTERS" for target in targets):
            table = ast.literal_eval(node.value)
            if not isinstance(table, dict) or not table or not all(isinstance(item, str) for item in table.values()):
                raise ValueError(f"Таблица ADAPTERS в {ADAPTERS_FILE} пуста или некорректна.")
            return [f"resources/{module.replace('.', '/')}.py" for module in table.values()]
    raise ValueError(f"В {ADAPTERS_FILE} не найдена таблица ADAPTERS.")


def check_tree(root: Path) -> dict:
    """Проверяет распакованное дерево приложения: состав, целевую платформу и формат check-runtime.cmd."""
    adapters_file = root / ADAPTERS_FILE
    adapters = provider_adapter_files(adapters_file.read_text(encoding="utf-8")) if adapters_file.is_file() else []
    for name in (*REQUIRED_FILES, *adapters):
        path = root / name
        if not path.is_file() or path.stat().st_size == 0:
            raise ValueError(f"Обязательный ресурс отсутствует или пуст: {name}")

    # Запрещены только поставляемые веса в корне runtime; пакеты Python с именем models допустимы.
    if (root / "resources/runtime/models").exists():
        raise ValueError("В Windows-установщик попал каталог весов resources/runtime/models.")
    for name, manifest_file in (("runtime", "manifest.json"), ("media", "media-manifest.json")):
        manifest = json.loads((root / "resources/runtime" / manifest_file).read_text(encoding="utf-8"))
        if not isinstance(manifest, dict) or manifest.get("target") != "win32-x64":
            raise ValueError(f"Манифест {name} должен содержать target: win32-x64.")
    cmd = (root / "check-runtime.cmd").read_bytes()
    without_crlf = cmd.replace(b"\r\n", b"")
    if not cmd.isascii() or b"\n" in without_crlf or b"\r" in without_crlf:
        raise ValueError("check-runtime.cmd должен содержать только ASCII и переносы CRLF.")
    return {
        "requiredFiles": list(REQUIRED_FILES),
        "providerAdapters": adapters,
        "runtimeTarget": True,
        "mediaTarget": True,
        "externalModels": True,
        "cmdAsciiCrlf": True,
    }


def run_7z(seven_zip: str, *args: str) -> None:
    # Имена с кириллицей (ПРОЧТИ.md) 7z распаковывает корректно только в UTF-8 локали.
    env = {**os.environ, "LC_ALL": "C.UTF-8"}
    result = subprocess.run([seven_zip, *args], capture_output=True, text=True, env=env, check=False)
    if result.returncode != 0:
        details = (result.stderr or result.stdout).strip().splitlines()[-5:]
        raise ValueError(f"7z завершился с кодом {result.returncode}: {' '.join(details)}")


def extract_payload(installer: Path, work: Path, seven_zip: str) -> Path:
    """Извлекает из установщика 7z-архив приложения и распаковывает его; 7z падает на повреждённых данных."""
    outer = work / "installer"
    run_7z(seven_zip, "x", "-y", "-bso0", "-bsp0", f"-o{outer}", str(installer), PAYLOAD, UNINSTALLER)
    payload = outer / PAYLOAD
    if not payload.is_file():
        raise ValueError(f"В установщике нет архива приложения {PAYLOAD}.")
    uninstaller = outer / UNINSTALLER
    if not uninstaller.is_file() or uninstaller.read_bytes()[:2] != b"MZ":
        raise ValueError(f"В установщике нет деинсталлятора {UNINSTALLER}.")
    tree = work / "app"
    run_7z(seven_zip, "x", "-y", "-bso0", "-bsp0", f"-o{tree}", str(payload))
    return tree


def check_installer(installer: Path, version: str | None = None) -> dict:
    """Проверяет именно файл установщика и сохраняет рядом его SHA256 и границу проверки."""
    match = re.fullmatch(r"songframe-(.+)-win-x64-setup\.exe", installer.name)
    if not match:
        raise ValueError("Имя установщика должно иметь вид songframe-<версия>-win-x64-setup.exe.")
    installer_version = match.group(1)
    if version is not None and installer_version != version:
        raise ValueError(f"Версия установщика {installer_version} не совпадает с ожидаемой {version}.")
    if not installer.is_file():
        raise ValueError(f"Установщик не найден: {installer}")
    seven_zip = shutil.which("7z")
    if seven_zip is None:
        raise RuntimeError("Не найден 7z: установите p7zip-full или 7zip.")

    with tempfile.TemporaryDirectory(prefix="songframe-installer-") as work:
        checks = check_tree(extract_payload(installer, Path(work), seven_zip))

    with installer.open("rb") as source:
        digest = hashlib.file_digest(source, "sha256").hexdigest()
    report = {
        "ok": True,
        "validation": "archive-only",
        "nativeExecution": False,
        "target": "win32-x64",
        "version": installer_version,
        "installer": installer.name,
        "sha256": digest,
        "installerFile": {"file": installer.name, "bytes": installer.stat().st_size, "sha256": digest},
        "checks": {"archiveIntegrity": True, "payload": PAYLOAD, "uninstaller": UNINSTALLER, **checks},
    }
    installer.with_suffix(installer.suffix + ".sha256").write_text(f"{digest}  {installer.name}\n", encoding="utf-8")
    (installer.parent / REPORT).write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("installer", type=Path, help="Конкретный установщик готовой Windows-поставки")
    parser.add_argument("--version", help="Ожидаемая версия в имени установщика")
    args = parser.parse_args()
    try:
        report = check_installer(args.installer, args.version)
    except (OSError, ValueError, RuntimeError) as error:
        print(f"Ошибка проверки Windows-установщика: {error}", file=sys.stderr)
        return 1
    print(f"Windows-установщик проверен: {report['installer']} (только содержимое, Windows-код не запускался).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
