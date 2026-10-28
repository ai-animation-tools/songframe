"""Выбор текущего проекта клипа для инструментов и скиллов комплекса; @link README.md

Файл `current-project.json` в постоянном каталоге состояния читают все инструменты, когда проект не задан
аргументом `--project` или переменной окружения. Его же пишет приложение при выборе проекта.
"""

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from tools.common import (
    CURRENT_PROJECT_FILE,
    PROJECT_ENV,
    PROJECT_MARKER,
    ROOT,
    ROOT_SOURCE,
    read_json,
    resolve_project,
    write_json_atomic,
)

SCHEMA_VERSION = 1


def write_current(path, file=CURRENT_PROJECT_FILE):
    """Записывает выбранный проект; папка должна существовать, иначе ValueError."""
    project = Path(path).expanduser().resolve()
    if not project.is_dir():
        raise ValueError(f"Папка проекта не найдена: {project}")
    data = {
        "schema_version": SCHEMA_VERSION,
        "path": str(project),
        "selected_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    if read_json(file) is False:
        raise ValueError(
            f"Повреждён файл текущего проекта: {file}. Файл сохранён; исправьте его или сначала выполните clear."
        )
    write_json_atomic(file, data)
    return data


def clear_current(file=CURRENT_PROJECT_FILE):
    """Удаляет файл текущего проекта; отсутствие файла не ошибка."""
    try:
        file.unlink()
        return True
    except FileNotFoundError:
        return False


def describe(file=CURRENT_PROJECT_FILE, argv=(), environ=None, resolved=None):
    """Текущее решение: откуда взят проект, существует ли папка и есть ли в ней маркер проекта.

    `resolved` — уже принятое решение `tools.common`: при импорте он вырезает `--project` из `sys.argv`,
    поэтому команда `show` передаёт его, а не вычисляет порядок заново.
    """
    root, source = resolved if resolved is not None else resolve_project(list(argv), environ, current_file=file)
    info = {
        "path": None if root is None else str(root),
        "source": source,
        "exists": False,
        "is_project": False,
        "name": None,
    }
    if root is not None and root.is_dir():
        info["exists"] = True
        project = read_json(root / PROJECT_MARKER)
        if isinstance(project, dict):
            info["is_project"] = True
            info["name"] = project.get("name")
    return info


def main():
    parser = argparse.ArgumentParser(description="Текущий проект клипа для инструментов комплекса.")
    parser.add_argument("--json", action="store_true", help="Вывести результат в JSON")
    commands = parser.add_subparsers(dest="command")
    commands.add_parser("show", help="Показать, какой проект будет использован и откуда он взят")
    setter = commands.add_parser("set", help="Записать проект в файл текущего проекта")
    setter.add_argument("path")
    commands.add_parser("clear", help="Удалить файл текущего проекта")
    args = parser.parse_args()
    if args.command == "set":
        try:
            data = write_current(args.path)
        except ValueError as error:
            parser.exit(2, f"{error}\n")
        print(json.dumps(data, ensure_ascii=False, indent=2) if args.json else f"Текущий проект: {data['path']}")
        return
    if args.command == "clear":
        removed = clear_current()
        print(
            json.dumps({"removed": removed})
            if args.json
            else ("Файл текущего проекта удалён." if removed else "Файл текущего проекта и так отсутствует.")
        )
        return
    info = describe(resolved=(ROOT if ROOT_SOURCE else None, ROOT_SOURCE))
    if args.json:
        print(json.dumps(info, ensure_ascii=False, indent=2))
    elif info["path"] is None:
        print(
            f"Проект не выбран: нет --project, переменной {PROJECT_ENV}, файла {CURRENT_PROJECT_FILE} "
            f"и маркера {PROJECT_MARKER} в текущей папке."
        )
    else:
        state = (
            "проект"
            if info["is_project"]
            else ("папка без plan/project.json" if info["exists"] else "папка не существует")
        )
        print(
            f"{info['path']} ({state}, источник: {info['source']}"
            + (f", название: {info['name']}" if info["name"] else "")
            + ")"
        )
    raise SystemExit(0 if info["is_project"] else 1)


if __name__ == "__main__":
    main()
