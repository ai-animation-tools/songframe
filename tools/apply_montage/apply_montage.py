"""Применяет явный ручной монтаж к принятым сценам; @link README.md."""

import sys
from pathlib import Path

# Точка входа работает и из папки клипа через общий launcher.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import argparse
import json
import os
import shutil
import subprocess
from copy import deepcopy
from uuid import uuid4

from tools.accept_shot.accept_shot import AUDIO_POLICY, REBUILD_NOTE, descriptor, render_edit
from tools.asset_package.asset_package import descriptor_file, local_file, validate_package
from tools.build_review.build_review import integer, prepare, probe, run
from tools.common import ROOT, TOOLS_ROOT, sha
from tools.scene_registry.scene_registry import (
    PRODUCTION_STATUS,
    accepted_fingerprints,
    initial_states_for,
    load,
    read_production_status,
    scene_fingerprints,
    validate,
    with_accepted_fingerprints,
)

HISTORY = "plan/montage-history"


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def replace_bytes(path, data):
    """Файл меняется одним rename; журнал записывается тем же способом до публикации."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name("." + path.name + ".montage-tmp")
    try:
        with temporary.open("wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def save_journal(directory, journal):
    replace_bytes(directory / "journal.json", json_bytes(journal))


def digest_or_none(path):
    return sha(path) if path.is_file() else None


def restore(directory, journal, root):
    """Откат повторяем: после обрыва он продолжается по старым и новым SHA-256."""
    # Сначала проверяем весь набор: посторонняя правка после сбоя не должна
    # потеряться от частичного автоматического восстановления.
    for entry in journal["files"]:
        if digest_or_none(root / entry["path"]) not in (entry["before"], entry["after"]):
            raise ValueError("После прерывания изменён файл " + entry["path"] + "; сохранён журнал " + str(directory))
        backup = directory / "before" / entry["path"]
        if entry["before"] is not None and digest_or_none(backup) != entry["before"]:
            raise ValueError("Повреждена резервная копия монтажа: " + entry["path"])
    for entry in reversed(journal["files"]):
        target = root / entry["path"]
        if entry["before"] is None:
            target.unlink(missing_ok=True)
        else:
            replace_bytes(target, (directory / "before" / entry["path"]).read_bytes())
    journal["state"] = "rolled_back"
    save_journal(directory, journal)


def recover(root):
    """Следующий запуск сначала откатывает незавершённую публикацию всех соседей."""
    for path in sorted((root / HISTORY).glob("*/journal.json")):
        journal = json.loads(path.read_text(encoding="utf-8"))
        if journal["state"] == "publishing":
            restore(path.parent, journal, root)
            shutil.rmtree(path.parent / "staging", ignore_errors=True)


def assert_baseline(draft, root):
    if sha(root / "plan/scenes.json") != draft["base_scenes_sha256"]:
        raise ValueError("Реестр сцен изменился. Заново откройте материалы монтажа.")
    for clip in draft["clips"]:
        sid = clip["scene"]
        path = root / "assets/shots" / sid / "manifest.json"
        if not path.is_file() or sha(path) != draft["base_manifest_sha256"].get(sid):
            raise ValueError(sid + ": комплект изменился. Заново откройте материалы монтажа.")


def prepare_draft(draft, root):
    """Проверяет границы и использует ровно фильтры экспорта build_review."""
    if (
        not isinstance(draft, dict)
        or draft.get("schema_version") != 1
        or not isinstance(draft.get("name"), str)
        or not isinstance(draft.get("clips"), list)
        or not draft["clips"]
        or not isinstance(draft.get("base_manifest_sha256"), dict)
        or not isinstance(draft.get("base_scenes_sha256"), str)
    ):
        raise ValueError("Неверный MontageDraft или пустой монтаж.")
    if set(draft) - {"schema_version", "name", "audio", "clips", "base_manifest_sha256", "base_scenes_sha256"}:
        raise ValueError("Неизвестные поля MontageDraft.")
    audio = draft.get("audio")
    if not isinstance(audio, dict):
        raise ValueError("Не задан участок исходной песни.")
    if set(audio) - {"path", "start_frame", "end_frame_exclusive"}:
        raise ValueError("Неизвестные поля audio.")
    start = integer(audio.get("start_frame"), "audio.start_frame")
    end = integer(audio.get("end_frame_exclusive"), "audio.end_frame_exclusive", 1)
    registry = load(root)
    track = registry["audio"].get("path", "source/track.mp3")
    if audio.get("path") != track:
        raise ValueError("Применение использует только исходную песню реестра.")
    by_id = {scene["id"]: index for index, scene in enumerate(registry["scenes"])}
    positions, ids, requests = [], set(), []
    packages = {}
    for clip in draft["clips"]:
        if not isinstance(clip, dict) or clip.get("kind") != "video" or clip.get("scene") not in by_id:
            raise ValueError("Применять можно только видео существующих принятых сцен.")
        if set(clip) - {
            "id",
            "scene",
            "path",
            "kind",
            "source_start_frame",
            "source_end_frame_exclusive",
            "source_frames",
        }:
            raise ValueError("Неизвестные поля участка монтажа.")
        sid = clip["scene"]
        if sid in ids or not isinstance(clip.get("id"), str) or not isinstance(clip.get("path"), str):
            raise ValueError("Сцена повторяется или неверно описан участок.")
        ids.add(sid)
        positions.append(by_id[sid])
        first = integer(clip.get("source_start_frame"), "source_start_frame")
        last = integer(clip.get("source_end_frame_exclusive"), "source_end_frame_exclusive", 1)
        if last <= first:
            raise ValueError("Конец участка должен быть больше начала.")
        name = Path(clip["path"])
        if name.is_absolute() or ".." in name.parts:
            raise ValueError("Источник монтажа задаётся относительным путём проекта.")
        manifest_path = root / "assets/shots" / sid / "manifest.json"
        if not manifest_path.is_file():
            raise ValueError(sid + ": для применения нужен принятый комплект.")
        packages[sid] = validate_package(manifest_path, sid, root)
        package = packages[sid]
        path = (root / name).resolve()
        allowed = [
            descriptor_file(manifest_path.parent, item, root)
            for item in (package["generation"]["original"], package["accepted_edit"]["video"])
        ]
        if path not in allowed:
            raise ValueError(sid + ": выберите original или текущий принятый клип этой сцены.")
        requests.append(
            {
                "scene": sid,
                "kind": "video",
                "path": clip["path"],
                "source_start_frame": first,
                "source_end_frame_exclusive": last,
            }
        )
    if positions != list(range(positions[0], positions[0] + len(positions))):
        raise ValueError("Для применения нужны соседние сцены в исходном порядке.")
    scenes = registry["scenes"]
    if start != scenes[positions[0]]["start_frame"] or end != scenes[positions[-1]]["end_frame_exclusive"]:
        raise ValueError("Применение сохраняет внешние границы выбранных сцен.")
    if sum(item["source_end_frame_exclusive"] - item["source_start_frame"] for item in requests) != end - start:
        raise ValueError("Длины участков должны непрерывно заполнить окно песни.")
    assert_baseline(draft, root)
    plan = prepare({"schema_version": 1, "shots": requests, "audio": {"path": track, "start_frame": start}}, root)
    candidate = deepcopy(registry)
    cursor = start
    for position, item in zip(positions, plan["shots"]):
        candidate["scenes"][position]["start_frame"] = cursor
        cursor += item["frames"]
        candidate["scenes"][position]["end_frame_exclusive"] = cursor
    validate(candidate)
    return candidate, packages, plan


def copy_input(source, target):
    # Большие медиа в staging только читаются; прочие файлы копируются, потому
    # что штатное обновление представлений пишет Markdown и карточки на месте.
    if Path(source).suffix.lower() in {".mp4", ".mp3", ".wav"}:
        try:
            os.link(source, target)
            return target
        except OSError:
            pass
    return shutil.copy2(source, target)


def stage_project(root, stage):
    for folder in ("plan", "assets", "source"):
        shutil.copytree(
            root / folder,
            stage / folder,
            copy_function=copy_input,
            ignore=shutil.ignore_patterns("montage-history", ".cache"),
        )
    roadmap = root / "ROADMAP.md"
    if roadmap.is_file():
        shutil.copy2(roadmap, stage / roadmap.name)


def edit_manifest(package, source_name, item, directory, video_name, version, revision):
    manifest = deepcopy(package)
    video = descriptor(directory, video_name)
    source = descriptor(directory, source_name)
    frames = item["frames"]
    duration = frames / 30
    # Новый рецепт читает сохранённые байты выбранного источника. Это позволяет
    # повторять срез прежнего accepted_edit без ещё одного lossy прохода его цепочки.
    edit = {
        "video": video,
        "fps": 30,
        "frames": frames,
        "duration_seconds": duration,
        "source_interval_seconds": item["source_interval_seconds"],
        "source_interval_end_exclusive": True,
        "source_frame_grid_fps": 30,
        "still_source_time_seconds": None,
        "source_frame_interval_exclusive": [item["source_start_frame"], item["source_end_frame_exclusive"]],
        "speed": {
            "factor": 1.0,
            "ratio": "1",
            "selected_source_seconds": duration,
            "motion_output_seconds": duration,
            "duration_change_seconds": 0.0,
        },
        "hold_first_seconds": 0.0,
        "hold_last_seconds": 0.0,
        "audio_policy": AUDIO_POLICY,
        "montage_source": video,
        "source_fps": next(
            stream["r_frame_rate"]
            for stream in probe(directory / source_name)["streams"]
            if stream["codec_type"] == "video"
        ),
        "fps_conversion": "Выбор кадров без интерполяции движения.",
        "rebuild": {
            "stages": [{"input": source_name, "filter": item["filter"], "frames": frames}],
            "source": source,
            "ffmpeg_version": version,
            "note": REBUILD_NOTE,
        },
        "montage_revision": {
            "id": revision,
            "previous_manifest": descriptor(directory, f"revisions/{revision}/previous-manifest.json"),
        },
    }
    manifest["accepted_edit"] = edit
    return manifest


def view_paths(stage, root):
    names = {
        "ROADMAP.md",
        "plan/edit-list.md",
        "plan/storyboard.md",
        "plan/context/characters.md",
        "plan/audio/timing.md",
        "assets/shots/manifest.json",
        "plan/animatic/cards/manifest.json",
    }
    for base in (root, stage):
        names.update(path.relative_to(base).as_posix() for path in (base / "assets/shots").glob("M*/README.md"))
        names.update(path.relative_to(base).as_posix() for path in (base / "plan/animatic/cards").glob("*.png"))
    return names


def publish_file(source, target):
    """Отдельная точка публикации позволяет проверять rollback реальных файлов."""
    if source.is_file():
        replace_bytes(target, source.read_bytes())
    else:
        target.unlink(missing_ok=True)


def carried_acceptance(root, candidate, shots):
    """Новый статус производства, если перенос границ меняет отпечатки актуальных планов, иначе None.

    Граница плана входит в его постановку. Монтаж переносит принятие только тем планам, что были приняты
    по текущей постановке: прежняя сюжетная правка не должна «прощаться» ручным монтажом.
    """
    status = read_production_status(root)
    accepted = accepted_fingerprints(status)
    initial = initial_states_for(root)
    before, after = scene_fingerprints(load(root), initial), scene_fingerprints(candidate, initial)
    updates = {sid: after[sid] for sid in shots if accepted.get(sid) == before[sid] != after[sid]}
    return with_accepted_fingerprints(status, updates) if updates else None


def apply(draft, root=ROOT, update_views=True):
    root = Path(root).resolve()
    recover(root)
    candidate, packages, plan = prepare_draft(draft, root)
    status_sha = digest_or_none(root / PRODUCTION_STATUS)
    status = carried_acceptance(root, candidate, packages)
    transaction = uuid4().hex
    directory = root / HISTORY / transaction
    directory.mkdir(parents=True)
    stage = directory / "staging"
    replace_bytes(directory / "draft.json", json_bytes(draft))
    journal = {"schema_version": 1, "id": transaction, "state": "preparing", "files": []}
    save_journal(directory, journal)
    publishing = False
    try:
        stage_project(root, stage)
        # При неизменных границах сохраняются даже форматирование и SHA реестра.
        if candidate != load(root):
            replace_bytes(stage / "plan/scenes.json", json_bytes(candidate))
        # Статус пишется до обновления представлений: ROADMAP показывает принятие по новым границам.
        if status is not None:
            replace_bytes(stage / PRODUCTION_STATUS, json_bytes(status))
        version = run(["ffmpeg", "-version"]).decode().splitlines()[0]
        for clip, item in zip(draft["clips"], plan["shots"]):
            sid = clip["scene"]
            asset = stage / "assets/shots" / sid
            revision = asset / "revisions" / transaction
            revision.mkdir(parents=True)
            shutil.copyfile(asset / "manifest.json", revision / "previous-manifest.json")
            source_name = Path(item["path"]).relative_to(root / "assets/shots" / sid).as_posix()
            video_name = f"revisions/{transaction}/video.mp4"
            render_edit(local_file(asset, source_name), item["filter"], item["frames"], asset / video_name)
            manifest = edit_manifest(packages[sid], source_name, item, asset, video_name, version, transaction)
            replace_bytes(asset / "manifest.json", json_bytes(manifest))
            validate_package(asset / "manifest.json", sid, stage)
            if any(stream["codec_type"] == "audio" for stream in probe(asset / video_name)["streams"]):
                raise ValueError("В монтажном клипе появилась лишняя звуковая дорожка.")
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
        names = {"plan/scenes.json", PRODUCTION_STATUS} | {f"assets/shots/{sid}/manifest.json" for sid in packages}
        if update_views:
            names |= view_paths(stage, root)
        for name in sorted(names):
            before, after = digest_or_none(root / name), digest_or_none(stage / name)
            if before == after:
                continue
            if before is not None:
                backup = directory / "before" / name
                backup.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(root / name, backup)
            journal["files"].append({"path": name, "before": before, "after": after})
        # Все входы сверяются после render и непосредственно перед первой записью
        # выбранного состояния: устаревший черновик не затронет ни одного соседа.
        assert_baseline(draft, root)
        if digest_or_none(root / PRODUCTION_STATUS) != status_sha:
            raise ValueError("Статус производства изменился во время монтажа. Повторите применение.")
        for sid in packages:
            validate_package(root / "assets/shots" / sid / "manifest.json", sid, root)
        for item in [*plan["shots"], plan["audio"]]:
            if sha(Path(item["path"])) != item["sha256"]:
                raise ValueError("Источник монтажа изменился во время рендера.")
        journal["state"] = "publishing"
        save_journal(directory, journal)
        publishing = True
        for sid in packages:
            source = stage / "assets/shots" / sid / "revisions" / transaction
            target = root / "assets/shots" / sid / "revisions" / transaction
            target.parent.mkdir(exist_ok=True)
            source.rename(target)
        for entry in journal["files"]:
            publish_file(stage / entry["path"], root / entry["path"])
        for sid in packages:
            validate_package(root / "assets/shots" / sid / "manifest.json", sid, root)
        journal["state"] = "committed"
        save_journal(directory, journal)
    except BaseException:
        if publishing:
            restore(directory, journal, root)
        else:
            journal["state"] = "failed"
            save_journal(directory, journal)
        raise
    finally:
        # Staging не является принятой версией. После успеха или полного отката
        # остаются только журнал, backup и immutable revisions выбранных сцен.
        if journal["state"] in {"committed", "rolled_back", "failed"}:
            shutil.rmtree(stage, ignore_errors=True)
    return {
        "status": "applied",
        "revision": transaction,
        "shots": list(packages),
        "scene_registry_sha256": sha(root / "plan/scenes.json"),
        "history": f"{HISTORY}/{transaction}",
        "views_updated": update_views,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    operation = parser.add_mutually_exclusive_group(required=True)
    operation.add_argument("--spec", type=Path, help="MontageDraft JSON с относительными путями проекта")
    operation.add_argument("--recover", action="store_true", help="Только восстановить прерванную публикацию")
    parser.add_argument("--no-views", action="store_true", help="Не обновлять производные представления")
    args = parser.parse_args()
    try:
        if args.recover:
            recover(ROOT)
            result = {"status": "recovered"}
        else:
            path = args.spec if args.spec.is_absolute() else ROOT / args.spec
            result = apply(json.loads(path.read_text(encoding="utf-8")), update_views=not args.no_views)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except (ValueError, OSError, KeyError, TypeError, StopIteration, subprocess.CalledProcessError) as error:
        message = (
            str(error)
            if type(error) is ValueError
            else "Ошибка файлов монтажа или медиа; журнал в plan/montage-history."
        )
        parser.exit(1, message + "\n")


if __name__ == "__main__":
    main()
