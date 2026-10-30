"""Читает комплект принятого ассета и воспроизводит его; @link README.md"""

import sys
from pathlib import Path

# После переноса точка запуска находится на два уровня ниже корня проекта.
# Полные импорты tools.* работают и при прямом запуске файла из любой папки.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))


import argparse
import json
import re
import shutil
import subprocess
import tempfile

from tools.common import ROOT, sha
from tools.scene_registry.scene_registry import load as load_scenes


def local_file(directory, name):
    # Локальные пути разрешаются только внутри папки: исходники соседних
    # сцен и результаты прежних принятий нельзя случайно подменить при повторе.
    path = (directory / name).resolve()
    if not path.is_relative_to(directory.resolve()):
        raise ValueError("Файл комплекта находится вне папки ассета.")
    return path


def descriptor_file(directory, item, root=None):
    """Разрешает локальный файл либо общий референс; @link ../../assets/README.md."""
    scope = item.get("root", "asset")
    if scope == "asset":
        return local_file(directory, item["path"])
    if scope != "source":
        raise ValueError("Неизвестный корень файла комплекта.")
    # Общий референс читается только из source и остаётся защищён его SHA-256.
    # Явный корень не разрешает выход через абсолютный путь, .. или символическую ссылку.
    base = ((Path(root) if root is not None else ROOT) / "source").resolve()
    name = Path(item["path"])
    source = (base / name).resolve()
    if name.is_absolute() or ".." in name.parts or not source.is_relative_to(base):
        raise ValueError("Общий референс находится вне source.")
    if source.suffix.lower() not in {".png", ".jpg", ".jpeg", ".webp", ".gif"}:
        raise ValueError("Общий референс должен быть изображением из source.")
    return source


def descriptors(value):
    if isinstance(value, dict):
        if "path" in value and "sha256" in value:
            yield value
        for item in value.values():
            yield from descriptors(item)
    elif isinstance(value, list):
        for item in value:
            yield from descriptors(item)


def validate_package(path, shot_id=None, root=None):
    package = json.loads(path.read_text())
    # Выбор комплекта в assets уже означает одобрение. Здесь проверяется только
    # технический контракт, необходимый для сохранности и повторения монтажа.
    if package["schema_version"] != 1:
        raise ValueError("Неизвестная схема комплекта ассета.")
    if shot_id is not None and package["shot"] != shot_id:
        raise ValueError("Комплект относится к другому плану.")
    generation, edit = package["generation"], package["accepted_edit"]
    if package.get("kind") == "derived_video":
        source_scene = generation.get("source_scene_sha256")
        source_video = generation.get("source_accepted_video_sha256")
        if "source_scene_sha256" not in generation or (
            source_scene is not None
            and (not isinstance(source_scene, str) or not re.fullmatch(r"[0-9a-f]{64}", source_scene))
        ):
            raise ValueError(
                "В производном комплекте нужен source_scene_sha256: "
                "SHA постановки источника либо null для неизвестной версии."
            )
        if not isinstance(source_video, str) or not re.fullmatch(r"[0-9a-f]{64}", source_video):
            raise ValueError("В производном комплекте нужен source_accepted_video_sha256 выбранного клипа источника.")
    repeat = edit.get("repeat")
    if repeat is not None:
        if (
            not isinstance(repeat, dict)
            or set(repeat) != {"full_cycles", "tail_frames", "cycle_frames"}
            or any(type(repeat[key]) is not int for key in repeat)
        ):
            raise ValueError("Повтор задаётся целыми full_cycles, tail_frames и cycle_frames.")
        if (
            repeat["full_cycles"] < 0
            or repeat["cycle_frames"] <= 0
            or not 0 <= repeat["tail_frames"] < repeat["cycle_frames"]
            or repeat["full_cycles"] * repeat["cycle_frames"] + repeat["tail_frames"] != edit["frames"]
        ):
            raise ValueError("Число циклов и хвост повтора расходятся с длиной принятого монтажа.")
    if generation["original"]["path"] == edit["video"]["path"]:
        raise ValueError("Оригинал и принятый монтаж должны быть разными файлами.")
    if not generation["inputs"] or not generation["prompt"]:
        raise ValueError("В комплекте отсутствуют кадры или промпт генерации.")
    # Снимок запроса обязателен: провайдер, модель, параметры и ID либо явная причина его отсутствия.
    if not isinstance(generation.get("request"), dict) or not generation["request"].get("path"):
        raise ValueError("В комплекте нет технического снимка запроса generation-request.json.")
    if generation["lipsync"] and not generation.get("audio"):
        raise ValueError("В комплекте липсинка отсутствует входное аудио.")
    if edit["fps"] <= 0 or edit["frames"] <= 0 or not edit["rebuild"]["stages"]:
        raise ValueError("Не сохранены параметры воспроизведения принятого монтажа.")
    if abs(edit["duration_seconds"] - edit["frames"] / edit["fps"]) > 1e-8:
        raise ValueError("Длительность принятого монтажа расходится с числом кадров.")
    if edit["rebuild"]["stages"][-1]["frames"] != edit["frames"]:
        raise ValueError("Повтор фильтров даёт другую длину монтажа.")
    # Общими могут быть входные изображения и референсы подготовки. Оригинал,
    # монтаж, промпт и WAV принадлежат конкретной сцене и остаются локальными.
    shared = {
        id(item)
        for item in [
            *generation["inputs"],
            *generation.get("auxiliary_references", []),
            *generation.get("preparation", {}).get("files", []),
        ]
    }
    registered = set()
    for item in descriptors(package):
        scope = item.get("root", "asset")
        if scope == "source" and id(item) not in shared:
            raise ValueError("Общими могут быть только входные изображения и референсы подготовки.")
        source = descriptor_file(path.parent, item, root)
        if not source.is_file() or sha(source) != item["sha256"]:
            raise ValueError(f"{package['shot']}: изменился файл комплекта {item['path']}")
        registered.add((scope, item["path"]))
    for stage in edit["rebuild"]["stages"]:
        source = local_file(path.parent, stage["input"])
        if (
            ("asset", stage["input"]) not in registered
            or not source.is_file()
            or not stage["filter"]
            or stage["frames"] <= 0
        ):
            raise ValueError("Не сохранён вход или фильтр этапа воспроизведения.")
    # Даже внутренне согласованный комплект может иметь длину другого окна.
    # Сверяем только JSON реестра, без анализа медиа. @link ../../plan/scenes.json
    registry = load_scenes(ROOT if root is None else root)
    scene = next((s for s in registry["scenes"] if s["id"] == package["shot"]), None)
    if scene is None:
        raise ValueError(f"{package['shot']}: ассет отсутствует в реестре сцен.")
    if edit["fps"] != registry["fps"]:
        raise ValueError(f"{package['shot']}: FPS принятого клипа расходится с реестром сцен.")
    if edit["frames"] != scene["end_frame_exclusive"] - scene["start_frame"]:
        raise ValueError(f"{package['shot']}: длина принятого клипа расходится с монтажным окном.")
    return package


def replay(path, destination, from_original=False, root=None):
    package = validate_package(path, root=root)
    destination = destination.resolve()
    # Любое воспроизведение идёт в новый файл вне выбранных assets. Штатный
    # режим копирует принятые байты, дополнительный режим повторяет фильтры.
    if destination.exists() or destination.is_relative_to((ROOT / "assets").resolve()):
        raise ValueError("Нужен новый выходной файл вне assets.")
    edit = package["accepted_edit"]
    if not from_original:
        with destination.open("xb") as stream:
            with local_file(path.parent, edit["video"]["path"]).open("rb") as source:
                shutil.copyfileobj(source, stream)
        if sha(destination) != edit["video"]["sha256"]:
            raise ValueError("Копия принятого монтажа не совпадает с оригиналом.")
        return
    with tempfile.TemporaryDirectory(prefix="asset-replay-") as folder:
        previous = None
        for number, stage in enumerate(edit["rebuild"]["stages"]):
            source = previous if stage.get("use_previous") else local_file(path.parent, stage["input"])
            target = Path(folder) / f"{number}.mp4"
            result = subprocess.run(
                [
                    "ffmpeg",
                    "-v",
                    "error",
                    "-nostdin",
                    "-n",
                    "-threads",
                    "2",
                    "-i",
                    str(source),
                    "-vf",
                    stage["filter"],
                    "-frames:v",
                    str(stage["frames"]),
                    "-an",
                    "-c:v",
                    "libx264",
                    "-threads",
                    "2",
                    "-preset",
                    "fast",
                    "-crf",
                    "18",
                    "-pix_fmt",
                    "yuv420p",
                    "-r",
                    str(edit["fps"]),
                    str(target),
                ],
                capture_output=True,
            )
            if result.returncode:
                raise ValueError("Не удалось воспроизвести сохранённый монтажный фильтр.")
            previous = target
        with destination.open("xb") as stream, previous.open("rb") as source:
            shutil.copyfileobj(source, stream)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("shot")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--from-original", action="store_true")
    args = parser.parse_args()
    path = ROOT / "assets/shots" / args.shot / "manifest.json"
    if args.output:
        replay(path, args.output, args.from_original)
        print("Принятый монтаж воспроизведён в новом файле.")
    else:
        validate_package(path, args.shot)
        print("Комплект принятого ассета проверен; хеши совпадают.")
