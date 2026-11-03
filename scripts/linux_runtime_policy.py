#!/usr/bin/env python3
"""Оставить в AppDir один GTK4/WebKitGTK 6 backend, не меняя relocation Wails."""

import argparse
from dataclasses import dataclass
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess


# Проверяется версия GTK/WebKit, а не общее вхождение gtk/gdk: GdkPixbuf,
# Pango, Cairo и libsoup могут быть нужны GTK4 и не входят в список удаления.
LEGACY_LIBRARY = re.compile(
    r"(?:lib(?:gtk|gdk)-x11-2\.0|lib(?:gtk|gdk)-3|"
    r"libwebkit2gtk-4\.[0-9]+|libjavascriptcoregtk-4\.[0-9]+)\.so(?:\.[0-9]+)*\Z"
)
LEGACY_DIRECTORY = re.compile(r"(?:gtk-[23]\.0|gdk-3\.0|webkit2?gtk-4\.[0-9]+)\Z")
LEGACY_TYPELIB = re.compile(
    r"(?:(?:Gtk|Gdk|GdkX11|GdkWayland)-[23]\.0|(?:WebKit2|WebKit2WebExtension|JavaScriptCore)-4\.[0-9]+)\.typelib\Z"
)
REQUIRED_LIBRARIES = ("libgtk-4.so.1", "libwebkitgtk-6.0.so.4", "libjavascriptcoregtk-6.0.so.1")
REQUIRED_HELPERS = ("WebKitWebProcess", "WebKitNetworkProcess")
DYNAMIC_TAG = re.compile(r"\((NEEDED|SONAME)\).*?\[([^\]]+)\]")


class PolicyError(Exception):
    """Отказ политики означает непригодный состав, а не разрешение обходить проверку."""


@dataclass(frozen=True)
class Entry:
    """Снимок одного пути без следования symlink; размер относится только к обычному файлу."""

    kind: str
    size: int = 0
    target: str = ""


@dataclass(frozen=True)
class ElfInfo:
    """Динамическая граница ELF читается readelf, сам файл никогда не исполняется."""

    needed: tuple[str, ...]
    soname: str


def legacy_name(name):
    """Распознать только явно старую ABI, typelib или каталог её runtime/helpers."""
    return bool(LEGACY_LIBRARY.fullmatch(name) or LEGACY_DIRECTORY.fullmatch(name) or LEGACY_TYPELIB.fullmatch(name))


def walk_error(error):
    """Нечитаемый каталог означает непроверенный состав, а не разрешение молча пропустить его."""
    raise error


def inventory(root):
    """Снять дерево AppDir, не заходя в directory symlinks и не читая их внешние цели."""
    result = {}
    for base, directories, files in os.walk(root, followlinks=False, onerror=walk_error):
        directories.sort()
        for name in sorted(directories + files):
            path = Path(base, name)
            relative = path.relative_to(root).as_posix()
            info = path.lstat()
            if stat.S_ISLNK(info.st_mode):
                result[relative] = Entry("symlink", target=os.readlink(path))
            elif stat.S_ISDIR(info.st_mode):
                result[relative] = Entry("directory")
            elif stat.S_ISREG(info.st_mode):
                result[relative] = Entry("file", size=info.st_size)
            else:
                raise PolicyError(f"Неподдерживаемый тип файла в AppDir: {relative}")
    return result


def link_target(root, relative, entries):
    """Разрешить только текст одной ссылки внутри AppDir; каталог назначения не обходится."""
    target = Path(entries[relative].target)
    absolute = Path(os.path.normpath(target if target.is_absolute() else root / relative / ".." / target))
    try:
        return absolute.relative_to(root).as_posix()
    except ValueError:
        return None


def real_file(root, relative, entries):
    """Найти обычный файл по известным aliases без открытия путей вне снятого дерева."""
    seen = set()
    while relative in entries and relative not in seen:
        seen.add(relative)
        entry = entries[relative]
        if entry.kind == "file":
            return relative
        if entry.kind != "symlink":
            return None
        relative = link_target(root, relative, entries)
    return None


def inspect_elfs(root, entries):
    """Прочитать DT_NEEDED/DT_SONAME всех обычных ELF; ошибка readelf останавливает рецепт."""
    result = {}
    environment = dict(os.environ, LC_ALL="C")
    for relative, entry in sorted(entries.items()):
        if entry.kind != "file":
            continue
        path = root / relative
        with path.open("rb") as source:
            if source.read(4) != b"\x7fELF":
                continue
        probe = subprocess.run(
            ["readelf", "--dynamic", "--wide", str(path)],
            capture_output=True, text=True, env=environment, timeout=30,
        )
        if probe.returncode:
            raise PolicyError(f"Не удалось прочитать ELF {relative}: {probe.stderr.strip()[:400]}")
        tags = DYNAMIC_TAG.findall(probe.stdout)
        result[relative] = ElfInfo(
            tuple(value for tag, value in tags if tag == "NEEDED"),
            next((value for tag, value in tags if tag == "SONAME"), ""),
        )
    return result


def removal_paths(root, entries, elfs):
    """Найти legacy по пути и SONAME, затем включить содержимое каталогов и все их aliases."""
    removed = {relative for relative in entries if legacy_name(PurePosixPath(relative).name)}
    removed.update(relative for relative, info in elfs.items() if legacy_name(PurePosixPath(info.soname).name))
    changed = True
    while changed:
        before = len(removed)
        for relative, entry in entries.items():
            if any(parent.as_posix() in removed for parent in PurePosixPath(relative).parents):
                removed.add(relative)
            if entry.kind == "symlink":
                target = link_target(root, relative, entries)
                if target is not None and any(
                    candidate.as_posix() in removed for candidate in (PurePosixPath(target), *PurePosixPath(target).parents)
                ):
                    removed.add(relative)
        changed = before != len(removed)
    return removed


def verify_dependencies(elfs, removed):
    """До удаления отвергнуть любой остающийся ELF, которому ещё нужна старая ABI или её alias."""
    removed_names = {PurePosixPath(relative).name for relative in removed}
    removed_names.update(info.soname for relative, info in elfs.items() if relative in removed and info.soname)
    for relative, info in sorted(elfs.items()):
        if relative in removed:
            continue
        for dependency in info.needed:
            name = PurePosixPath(dependency).name
            if legacy_name(name) or name in removed_names:
                raise PolicyError(f"ELF {relative} всё ещё требует удаляемую legacy-зависимость {dependency}; файлы не удалены")


def verify_current(root, entries, elfs, removed):
    """Подтвердить настоящие ELF текущих библиотек и единственную пару WebKit helpers."""
    libraries = {}
    for soname in REQUIRED_LIBRARIES:
        matches = []
        for relative in entries:
            if relative in removed or PurePosixPath(relative).name != soname:
                continue
            target = real_file(root, relative, entries)
            if target not in removed and target in elfs and elfs[target].soname == soname:
                matches.append(relative)
        if not matches:
            raise PolicyError(f"В AppDir отсутствует пригодная библиотека GTK4/WebKitGTK 6: {soname}")
        libraries[soname] = sorted(matches)
    backends = {
        relative for relative, entry in entries.items()
        if relative not in removed and entry.kind == "directory" and PurePosixPath(relative).name == "webkitgtk-6.0"
    }
    if len(backends) != 1:
        raise PolicyError("В AppDir должен быть ровно один каталог backend webkitgtk-6.0")
    backend = next(iter(backends))
    helpers = []
    for name in REQUIRED_HELPERS:
        matches = [relative for relative in entries if relative not in removed and PurePosixPath(relative).name == name]
        if len(matches) != 1 or str(PurePosixPath(matches[0]).parent) != backend:
            raise PolicyError(f"Нужен единственный {name} внутри {backend}")
        target = real_file(root, matches[0], entries)
        if target not in elfs or target in removed:
            raise PolicyError(f"WebKit helper не является внутренним ELF: {matches[0]}")
        helpers.append(matches[0])
    for relative in entries:
        if relative not in removed and PurePosixPath(relative).name == "WebKitGPUProcess":
            if str(PurePosixPath(relative).parent) != backend:
                raise PolicyError(f"Дополнительный WebKit helper находится вне {backend}: {relative}")
    return {"libraries": libraries, "webkitBackend": backend, "helpers": helpers}


def execute(action, appdir):
    """Выполнить одну политику и вернуть JSON-совместимый результат, включая фактические удаления."""
    report = {"action": action, "status": "error", "removedPaths": [], "removedFiles": 0, "removedDirectories": 0, "removedBytes": 0, "checkedELF": 0}
    try:
        path = Path(appdir).absolute()
        if path.is_symlink() or not path.is_dir():
            raise PolicyError("APPDIR должен быть существующим каталогом, а не symlink")
        root = path.resolve()
        entries = inventory(root)
        elfs = inspect_elfs(root, entries)
        report["checkedELF"] = len(elfs)
        removed = removal_paths(root, entries, elfs)
        if action == "check" and removed:
            raise PolicyError(f"В AppDir остался legacy GTK/WebKit: {', '.join(sorted(removed))}")
        verify_dependencies(elfs, removed)
        report.update(verify_current(root, entries, elfs, removed))
        if action == "prune":
            # Все проверки зависимостей завершаются до первого unlink. Ссылки удаляются как ссылки,
            # реальные каталоги — только после известных детей через rmdir, без рекурсивного follow.
            for relative in sorted(removed, key=lambda value: (-len(PurePosixPath(value).parts), value)):
                entry = entries[relative]
                target = root / relative
                if entry.kind == "directory":
                    target.rmdir()
                    report["removedDirectories"] += 1
                else:
                    target.unlink()
                    report["removedFiles"] += 1
                    report["removedBytes"] += entry.size
                report["removedPaths"].append(relative)
            # Повторное чтение после prune — та же конечная граница, что отдельный check после упаковки.
            entries = inventory(root)
            elfs = inspect_elfs(root, entries)
            report["checkedELF"] = len(elfs)
            remaining = removal_paths(root, entries, elfs)
            if remaining:
                raise PolicyError(f"После prune остался legacy: {', '.join(sorted(remaining))}")
            verify_dependencies(elfs, set())
            report.update(verify_current(root, entries, elfs, set()))
        report["status"] = "ready"
    except (PolicyError, OSError, subprocess.SubprocessError) as error:
        report["error"] = str(error)
    return report


def main():
    """CLI выдаёт один JSON-документ; ненулевой exit code делает нарушение политики build-fatal."""
    parser = argparse.ArgumentParser(description="Проверить единственный GTK4/WebKitGTK 6 runtime в AppDir")
    parser.add_argument("action", choices=("prune", "check"))
    parser.add_argument("appdir")
    arguments = parser.parse_args()
    report = execute(arguments.action, arguments.appdir)
    print(json.dumps(report, ensure_ascii=False, sort_keys=True, indent=2))
    return 0 if report["status"] == "ready" else 1


if __name__ == "__main__":
    raise SystemExit(main())
