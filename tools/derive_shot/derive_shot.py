"""Локально собирает производный план и принимает подтверждённые байты; @link README.md."""

import sys
from pathlib import Path

# Общий launcher выбирает проект; инструмент не ищет отдельный Python.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import argparse
import hashlib
import json
import shutil
import subprocess
from copy import deepcopy
from fractions import Fraction
from uuid import uuid4

from tools.accept_shot.accept_shot import AUDIO_POLICY, REBUILD_NOTE, descriptor, render_edit
from tools.apply_montage.apply_montage import (
    copy_input,
    digest_or_none,
    json_bytes,
    publish_file,
    replace_bytes,
    view_paths,
)
from tools.asset_package.asset_package import descriptor_file, descriptors, local_file, validate_package
from tools.build_review.build_review import run
from tools.common import ROOT, TOOLS_ROOT, sha
from tools.scene_registry.scene_registry import (
    PRODUCTION_STATUS,
    initial_states_for,
    load,
    project_shot_acceptance,
    read_production_status,
    scene_fingerprints,
    with_accepted_fingerprints,
)

HISTORY = "plan/derived-history"
FPS = 30


def project_path(root, value, prefix=None):
    """Пути рецепта и результата переносимы и остаются в выбранном проекте."""
    name = Path(value)
    path = (root / name).resolve()
    if name.is_absolute() or ".." in name.parts or not path.is_relative_to(root):
        raise ValueError("Нужен относительный путь внутри проекта.")
    if prefix is not None and not path.is_relative_to(root / prefix):
        raise ValueError("Рабочая папка должна находиться в " + prefix + ".")
    return path


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def recipe_plan(recipe, frames, source_frames):
    """Все интервалы явные: fit дублирует/выбирает кадры, repeat повторяет только заданный цикл."""
    if not isinstance(recipe, dict):
        raise ValueError("Рецепт должен быть объектом JSON.")
    mode = recipe.get("mode")
    fields = {
        "trim": {"mode", "start_frame"},
        "fit": {"mode", "start_frame", "end_frame_exclusive"},
        "still": {"mode", "frame"},
        "repeat": {"mode", "start_frame", "end_frame_exclusive"},
    }
    if mode not in fields or set(recipe) != fields[mode]:
        raise ValueError("Рецепт требует ровно поля выбранного режима trim, fit, still или repeat.")
    for key, value in recipe.items():
        if key != "mode" and (type(value) is not int or value < 0):
            raise ValueError(key + " должен быть целым неотрицательным числом кадров.")
    first = recipe["frame"] if mode == "still" else recipe["start_frame"]
    last = first + (1 if mode == "still" else frames) if mode in {"trim", "still"} else recipe["end_frame_exclusive"]
    if not 0 <= first < last <= source_frames:
        raise ValueError("Выбранный участок выходит за текущий принятый клип источника.")
    length = last - first
    stages = ["fps=30", f"trim=start_frame={first}:end_frame={last}", "setpts=PTS-STARTPTS"]
    factor = Fraction(length, frames) if mode == "fit" else Fraction(0 if mode == "still" else 1)
    if mode == "fit":
        stages += [f"setpts=PTS*{frames}/{length}", "fps=30:round=near"]
    elif mode in {"still", "repeat"}:
        stages += [f"loop=loop=-1:size={length}:start=0", f"trim=end_frame={frames}", "setpts=N/(30*TB)"]
    stages += ["scale=1920:1080:force_original_aspect_ratio=decrease", "pad=1920:1080:(ow-iw)/2:(oh-ih)/2", "setsar=1"]
    return {"filter": ",".join(stages), "first": first, "last": last, "factor": factor}


def snapshot(shot, root):
    """Источник — только актуальный accepted_edit обычного плана из derived_from."""
    registry = load(root)
    scenes = {scene["id"]: scene for scene in registry["scenes"]}
    scene = scenes.get(shot)
    if scene is None or not isinstance(scene.get("derived_from"), dict):
        raise ValueError("Выберите производный план с derived_from.shot.")
    if scene.get("lipsync"):
        raise ValueError("Производный план с липсинком нельзя собрать локально: синхронность губ не гарантируется.")
    source_shot = scene["derived_from"].get("shot")
    source_scene = scenes.get(source_shot)
    if source_scene is None or source_scene.get("derived_from"):
        raise ValueError("Источником должен быть обычный план без derived_from.")
    if registry["fps"] != FPS or project_shot_acceptance(root, registry).get(source_shot) != "completed":
        raise ValueError("Сначала примите источник по текущей постановке на сетке 30 FPS.")
    manifest_path = root / "assets/shots" / source_shot / "manifest.json"
    package = validate_package(manifest_path, source_shot, root)
    source = descriptor_file(manifest_path.parent, package["accepted_edit"]["video"], root)
    current = scene_fingerprints(registry, initial_states_for(root))
    # Музыка относится к показанной пробе: замена трека не меняет постановку,
    # но прежнее подтверждение уже не описывает актуальный музыкальный контекст.
    song = project_path(root, registry["audio"]["path"])
    result = {
        "shot": shot,
        "source_shot": source_shot,
        "source_scene_sha256": current[source_shot],
        "source_accepted_video_sha256": sha(source),
        "target_scene_sha256": current[shot],
        "target_frames": scene["end_frame_exclusive"] - scene["start_frame"],
        "audio_source": {"path": registry["audio"]["path"], "sha256": sha(song) if song.is_file() else None},
    }
    return result, registry, scene, package, source


def token_for(preview, build):
    # Токен связывает контекст, рецепт и точные принятые/показанные байты.
    payload = {"preview": {key: value for key, value in preview.items() if key != "result_token"}, "build": build}
    return hashlib.sha256(
        json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def build(shot, recipe, work_dir, root=ROOT):
    root = Path(root).resolve()
    current, registry, scene, package, source = snapshot(shot, root)
    recipe_path = project_path(root, recipe)
    directory = project_path(root, work_dir, "plan/derived/" + shot)
    if directory.parent != root / "plan/derived" / shot or directory.exists():
        raise ValueError("Для новой пробы нужна новая рабочая папка plan/derived/Mxx/<id>.")
    selected = read_json(recipe_path)
    plan = recipe_plan(selected, current["target_frames"], package["accepted_edit"]["frames"])
    receipt = {
        "recipe_path": recipe_path.relative_to(root).as_posix(),
        "recipe_sha256": sha(recipe_path),
        "filter": plan["filter"],
        "target_start_frame": scene["start_frame"],
        "target_end_frame_exclusive": scene["end_frame_exclusive"],
        "source_manifest_sha256": sha(root / "assets/shots" / current["source_shot"] / "manifest.json"),
        "ffmpeg_version": run(["ffmpeg", "-version"]).decode().splitlines()[0],
    }
    # Сначала временная папка; опубликованный work-dir больше не изменяется даже при приёмке.
    directory.parent.mkdir(parents=True, exist_ok=True)
    temporary = directory.with_name("." + directory.name + ".building-" + uuid4().hex)
    temporary.mkdir()
    try:
        render_edit(source, plan["filter"], current["target_frames"], temporary / "candidate.mp4")
        song = project_path(root, registry["audio"]["path"])
        if song.is_file():
            run(
                [
                    "ffmpeg",
                    "-v",
                    "error",
                    "-nostdin",
                    "-n",
                    "-i",
                    str(temporary / "candidate.mp4"),
                    "-ss",
                    str(scene["start_frame"] / FPS),
                    "-i",
                    str(song),
                    "-map",
                    "0:v:0",
                    "-map",
                    "1:a:0",
                    "-c:v",
                    "copy",
                    "-c:a",
                    "aac",
                    "-t",
                    str(current["target_frames"] / FPS),
                    str(temporary / "preview.mp4"),
                ]
            )
        else:
            shutil.copyfile(temporary / "candidate.mp4", temporary / "preview.mp4")
        preview = {
            "schema_version": 1,
            **current,
            "recipe": selected,
            "video": descriptor(temporary, "candidate.mp4"),
            "preview": descriptor(temporary, "preview.mp4"),
        }
        preview["result_token"] = token_for(preview, receipt)
        if snapshot(shot, root)[0] != current or sha(recipe_path) != receipt["recipe_sha256"]:
            raise ValueError("Источник, постановка, музыка или рецепт изменились при сборке. Соберите новую пробу.")
        replace_bytes(temporary / "recipe.json", json_bytes(selected))
        replace_bytes(temporary / "build.json", json_bytes(receipt))
        replace_bytes(temporary / "preview.json", json_bytes(preview))
        temporary.rename(directory)
        return {**preview, "status": "built", "work_dir": directory.relative_to(root).as_posix()}
    finally:
        shutil.rmtree(temporary, ignore_errors=True)


def checked_result(directory, confirm, root):
    preview, receipt = read_json(directory / "preview.json"), read_json(directory / "build.json")
    if (
        preview.get("schema_version") != 1
        or preview.get("result_token") != confirm
        or token_for(preview, receipt) != confirm
    ):
        raise ValueError("Подтверждение не соответствует показанному результату. Соберите новую пробу.")
    current, registry, scene, package, source = snapshot(preview["shot"], root)
    if any(preview.get(key) != value for key, value in current.items()):
        raise ValueError("Источник, постановка или музыка изменились после пробы. Соберите новую пробу.")
    recipe_path = project_path(root, receipt["recipe_path"])
    if sha(recipe_path) != receipt["recipe_sha256"] or read_json(directory / "recipe.json") != preview["recipe"]:
        raise ValueError("Рецепт изменился после пробы. Соберите новую пробу.")
    plan = recipe_plan(preview["recipe"], current["target_frames"], package["accepted_edit"]["frames"])
    if (
        plan["filter"] != receipt["filter"]
        or receipt["target_start_frame"] != scene["start_frame"]
        or receipt["target_end_frame_exclusive"] != scene["end_frame_exclusive"]
    ):
        raise ValueError("Параметры сборки изменились после пробы.")
    source_manifest = root / "assets/shots" / current["source_shot"] / "manifest.json"
    if sha(source_manifest) != receipt["source_manifest_sha256"]:
        raise ValueError("Комплект источника изменился после пробы. Соберите новую пробу.")
    for key, name in (("video", "candidate.mp4"), ("preview", "preview.mp4")):
        if preview[key] != descriptor(directory, name):
            raise ValueError("Файл результата изменился после пробы: " + name)
    return preview, receipt, package, source, plan


def copy_generation(package, source_directory, target, root):
    """Копирует достижимые исходники, сохраняя JSON и root:source без чужой истории/README."""
    generation = deepcopy(package["generation"])
    queue, copied = list(deepcopy(list(descriptors(generation)))), set()
    registered = {(item.get("root", "asset"), item["path"]) for item in queue}
    discovered = []
    while queue:
        item = queue.pop()
        source = descriptor_file(source_directory, item, root)
        if not source.is_file() or sha(source) != item["sha256"]:
            raise ValueError("Изменился исходник комплекта: " + item["path"])
        key = (item.get("root", "asset"), item["path"])
        if key not in registered:
            registered.add(key)
            discovered.append(deepcopy(item))
        if item.get("root", "asset") == "source" or item["path"] in copied:
            continue
        name = item["path"]
        destination = local_file(target, name)
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, destination)
        copied.add(item["path"])
        if source.suffix.lower() == ".json":
            queue.extend(descriptors(read_json(source)))
    # Достижимые только через JSON файлы тоже остаются под штатной проверкой
    # хешей комплекта, а не становятся бесхозными копиями рядом с манифестом.
    if discovered:
        if generation.get("preparation"):
            generation["preparation"].setdefault("files", []).extend(discovered)
        else:
            generation.setdefault("auxiliary_references", []).extend(discovered)
    return generation


def make_manifest(preview, receipt, package, source, plan, target, candidate, root):
    source_directory = root / "assets/shots" / preview["source_shot"]
    generation = copy_generation(package, source_directory, target, root)
    generation.update(
        {key: preview[key] for key in ("source_shot", "source_scene_sha256", "source_accepted_video_sha256")}
    )
    # Пути исходной генерации сохраняются: immutable JSON может ссылаться на
    # video.mp4 или edit-source.mp4. Наши файлы занимают отдельное свободное имя.
    folder, suffix = "derived-output", 0
    while (source_directory / folder).exists() or (target / folder).exists():
        suffix += 1
        folder = f"derived-output-{suffix}"
    (target / folder).mkdir()
    source_name, video_name = folder + "/edit-source.mp4", folder + "/video.mp4"
    shutil.copyfile(source, target / source_name)
    shutil.copyfile(candidate, target / video_name)
    frames, first, last, factor = preview["target_frames"], plan["first"], plan["last"], plan["factor"]
    duration, selected = frames / FPS, (last - first) / FPS
    video = descriptor(target, video_name)
    still = preview["recipe"]["mode"] == "still"
    edit = {
        "video": video,
        "fps": FPS,
        "frames": frames,
        "duration_seconds": duration,
        "source_interval_seconds": [first / FPS, last / FPS],
        "source_interval_end_exclusive": True,
        "source_frame_grid_fps": FPS,
        "source_frame_interval_exclusive": [first, last],
        "still_source_time_seconds": first / FPS if still else None,
        "speed": {
            "factor": float(factor),
            "ratio": str(factor),
            "selected_source_seconds": selected,
            "motion_output_seconds": 0.0 if still else duration,
            "duration_change_seconds": duration - selected,
        },
        "hold_first_seconds": 0.0,
        "hold_last_seconds": 0.0,
        "audio_policy": AUDIO_POLICY,
        "montage_source": video,
        "source_fps": "30/1",
        "fps_conversion": "Выбор кадров без интерполяции движения.",
        "rebuild": {
            "source": descriptor(target, source_name),
            "stages": [{"input": source_name, "filter": receipt["filter"], "frames": frames}],
            "ffmpeg_version": receipt["ffmpeg_version"],
            "note": REBUILD_NOTE,
        },
    }
    if preview["recipe"]["mode"] == "repeat":
        edit["repeat"] = {
            "full_cycles": frames // (last - first),
            "tail_frames": frames % (last - first),
            "cycle_frames": last - first,
        }
    return {
        "schema_version": 1,
        "shot": preview["shot"],
        "kind": "derived_video",
        "generation": generation,
        "accepted_edit": edit,
    }


def tree_files(directory):
    if not directory.exists():
        return None
    return {
        path.relative_to(directory).as_posix(): sha(path) for path in sorted(directory.rglob("*")) if path.is_file()
    }


def tree_digest(directory):
    """Отпечаток целой папки нужен журналу для безопасного повторяемого rename/отката."""
    entries = tree_files(directory)
    return hashlib.sha256(json_bytes(list(entries.items()))).hexdigest() if entries is not None else None


def save_journal(directory, journal):
    replace_bytes(directory / "journal.json", json_bytes(journal))


def restore(directory, journal, root):
    """Сначала сверяет весь набор, затем восстанавливает комплект и документы; повтор безопасен."""
    kit = journal["directory"]
    target, backup, retired = (root / kit[key] for key in ("path", "backup", "retired"))
    if tree_digest(target) not in (None, kit["before"], kit["after"]):
        raise ValueError("После аварии изменён комплект; журнал: " + str(directory))
    if kit["before"] is not None and tree_digest(backup) != kit["before"]:
        raise ValueError("Повреждена резервная копия комплекта; журнал: " + str(directory))
    if retired.exists() and tree_digest(retired) != kit["before"]:
        raise ValueError("После аварии изменён архив комплекта; журнал: " + str(directory))
    for entry in journal["files"]:
        if digest_or_none(root / entry["path"]) not in (entry["before"], entry["after"]):
            raise ValueError("После аварии изменён файл " + entry["path"] + "; журнал: " + str(directory))
        if entry["before"] is not None and digest_or_none(directory / "before" / entry["path"]) != entry["before"]:
            raise ValueError("Повреждена резервная копия " + entry["path"])
    # Копия возвращается через отдельный rename: авария во время копирования
    # не оставляет наполовину восстановленный выбранный комплект.
    if tree_digest(target) != kit["before"]:
        pending = directory / "restore-kit"
        shutil.rmtree(pending, ignore_errors=True)
        if kit["before"] is not None:
            shutil.copytree(backup, pending)
        shutil.rmtree(target, ignore_errors=True)
        if kit["before"] is not None:
            target.parent.mkdir(parents=True, exist_ok=True)
            pending.rename(target)
    for entry in reversed(journal["files"]):
        target_file = root / entry["path"]
        if entry["before"] is None:
            target_file.unlink(missing_ok=True)
        else:
            replace_bytes(target_file, (directory / "before" / entry["path"]).read_bytes())
    shutil.rmtree(retired, ignore_errors=True)
    journal["state"] = "rolled_back"
    save_journal(directory, journal)


def recover(root=ROOT):
    root = Path(root).resolve()
    recovered = []
    for path in sorted((root / HISTORY).glob("*/journal.json")):
        journal = read_json(path)
        if journal["state"] == "publishing":
            restore(path.parent, journal, root)
            shutil.rmtree(path.parent / "staging", ignore_errors=True)
            recovered.append(journal["id"])
    return {"status": "recovered", "transactions": recovered}


def stage_project(root, stage):
    def ignored(directory, names):
        # Исключения принадлежат конкретным служебным папкам проекта.
        # Совпавшее имя внутри source или подготовки не делает исходник временным.
        exclusions = {
            "plan": {"derived", "derived-history", "montage-history"},
            "assets": {"replaced"},
            "plan/animatic": {".cache"},
        }
        relative = Path(directory).relative_to(root).as_posix()
        return set(names) & exclusions.get(relative, set())

    for folder in ("plan", "assets", "source"):
        if (root / folder).is_dir():
            shutil.copytree(
                root / folder,
                stage / folder,
                copy_function=copy_input,
                ignore=ignored,
            )
    if (root / "ROADMAP.md").is_file():
        shutil.copyfile(root / "ROADMAP.md", stage / "ROADMAP.md")


def publish_directory(source, target, retired):
    """Отдельная точка для проверки сбоя между переносом старой и новой папки."""
    if target.exists():
        retired.parent.mkdir(parents=True, exist_ok=True)
        target.rename(retired)
    target.parent.mkdir(parents=True, exist_ok=True)
    source.rename(target)


def accept(work_dir, confirm, replace=False, root=ROOT, update_views=True):
    root = Path(root).resolve()
    recover(root)
    directory = project_path(root, work_dir, "plan/derived")
    preview, receipt, package, source, plan = checked_result(directory, confirm, root)
    shot = preview["shot"]
    if directory.parent != root / "plan/derived" / shot:
        raise ValueError("Рабочая папка относится к другому плану.")
    # Повтор того же подтверждения после успешной публикации ничего не пишет.
    # Проверяется также выбранный комплект: старый токен не примет чужую замену.
    for path in sorted((root / HISTORY).glob("*/journal.json")):
        previous = read_json(path)
        if previous.get("result_token") == confirm and previous["state"] == "committed":
            target = root / previous["directory"]["path"]
            validate_package(target / "manifest.json", shot, root)
            if tree_digest(target) != previous["directory"]["after"]:
                raise ValueError("Ранее принятый результат уже изменён; соберите новую пробу.")
            return {
                "status": "accepted",
                "shot": shot,
                "result_token": confirm,
                "history": path.parent.relative_to(root).as_posix(),
                "idempotent": True,
            }
    target = root / "assets/shots" / shot
    if target.exists() and not replace:
        raise ValueError("У плана уже есть комплект; для замены требуется --replace.")
    status_sha = digest_or_none(root / PRODUCTION_STATUS)
    status = with_accepted_fingerprints(
        read_production_status(root), {shot: preview["target_scene_sha256"]}, clear_source_reviews=True
    )
    transaction = uuid4().hex
    history = root / HISTORY / transaction
    history.mkdir(parents=True)
    stage = history / "staging"
    retired = root / "assets/replaced" / shot / transaction
    journal = {
        "schema_version": 1,
        "id": transaction,
        "shot": shot,
        "state": "preparing",
        "result_token": confirm,
        "work_dir": directory.relative_to(root).as_posix(),
        "files": [],
    }
    save_journal(history, journal)
    publishing = False
    try:
        stage_project(root, stage)
        staged_kit = stage / "assets/shots" / shot
        shutil.rmtree(staged_kit, ignore_errors=True)
        staged_kit.mkdir(parents=True)
        manifest = make_manifest(preview, receipt, package, source, plan, staged_kit, directory / "candidate.mp4", root)
        replace_bytes(staged_kit / "manifest.json", json_bytes(manifest))
        replace_bytes(stage / PRODUCTION_STATUS, json_bytes(status))
        validate_package(staged_kit / "manifest.json", shot, stage)
        if update_views:
            subprocess.run(
                [
                    sys.executable,
                    "-B",
                    str(TOOLS_ROOT / "tools/update_scene_views/update_scene_views.py"),
                    "--project",
                    str(stage),
                ],
                check=True,
                cwd=TOOLS_ROOT,
                capture_output=True,
            )
        names = {PRODUCTION_STATUS}
        if update_views:
            names |= view_paths(stage, root)
        # README новой сцены публикуется вместе с целой папкой, не отдельным файлом.
        names = {name for name in names if not name.startswith(f"assets/shots/{shot}/")}
        for name in sorted(names):
            before, after = digest_or_none(root / name), digest_or_none(stage / name)
            if before == after:
                continue
            if before is not None:
                backup = history / "before" / name
                backup.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(root / name, backup)
            journal["files"].append({"path": name, "before": before, "after": after})
        backup = history / "before-kit"
        before = tree_digest(target)
        if before is not None:
            shutil.copytree(target, backup)
        journal["directory"] = {
            "path": target.relative_to(root).as_posix(),
            "before": before,
            "after": tree_digest(staged_kit),
            "backup": backup.relative_to(root).as_posix(),
            "retired": retired.relative_to(root).as_posix(),
            "before_files": tree_files(target),
            "after_files": tree_files(staged_kit),
        }
        checked_result(directory, confirm, root)
        if digest_or_none(root / PRODUCTION_STATUS) != status_sha or tree_digest(target) != before:
            raise ValueError("Выбранный комплект или статус производства изменился. Повторите приёмку.")
        journal["state"] = "publishing"
        save_journal(history, journal)
        publishing = True
        publish_directory(staged_kit, target, retired)
        for entry in journal["files"]:
            publish_file(stage / entry["path"], root / entry["path"])
        validate_package(target / "manifest.json", shot, root)
        journal["state"] = "committed"
        save_journal(history, journal)
    except BaseException:
        if publishing:
            restore(history, journal, root)
        else:
            journal["state"] = "failed"
            save_journal(history, journal)
        raise
    finally:
        if journal["state"] in {"committed", "rolled_back", "failed"}:
            shutil.rmtree(stage, ignore_errors=True)
    return {
        "status": "accepted",
        "shot": shot,
        "result_token": confirm,
        "history": history.relative_to(root).as_posix(),
        "idempotent": False,
        "views_updated": update_views,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    create = commands.add_parser("build")
    create.add_argument("--shot", required=True)
    create.add_argument("--recipe", required=True)
    create.add_argument("--work-dir", required=True)
    approve = commands.add_parser("accept")
    approve.add_argument("--work-dir", required=True)
    approve.add_argument("--confirm", required=True)
    approve.add_argument("--replace", action="store_true")
    commands.add_parser("recover")
    for command in commands.choices.values():
        command.add_argument("--json", action="store_true")
    args = parser.parse_args()
    try:
        if args.command == "build":
            result = build(args.shot, args.recipe, args.work_dir)
        elif args.command == "accept":
            result = accept(args.work_dir, args.confirm, replace=args.replace)
        else:
            result = recover()
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except (ValueError, OSError, KeyError, TypeError, StopIteration, subprocess.CalledProcessError) as error:
        message = str(error) if isinstance(error, ValueError) else "Ошибка файлов или медиа производного плана."
        if args.json:
            print(json.dumps({"status": "error", "message": message}, ensure_ascii=False))
            raise SystemExit(1) from None
        parser.exit(1, message + "\n")


if __name__ == "__main__":
    main()
