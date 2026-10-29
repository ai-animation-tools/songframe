"""Проверяет согласованность рабочего дерева после приёмки: лишние пакеты, карточки, пустые папки; @link README.md"""

import sys
from pathlib import Path

# После переноса точка запуска находится на два уровня ниже корня проекта.
# Полные импорты tools.* работают и при прямом запуске файла из любой папки.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))


import argparse
import json
import re

from tools.common import ROOT, read_json
from tools.montage_files import retained_montage_folders
from tools.scene_registry.scene_registry import load as load_scenes
from tools.scene_registry.scene_registry import project_shot_acceptance

SHOT_NAME = re.compile(r"(M\d{2}(?:\.\d+)?)(?:[-_]|$)")
PACKAGE_DOCUMENTS = ("workflow.json", "request.json", "request/request.json")


def completed_output(folder):
    """Отличает готовые экспорт и пробу от рабочих пакетов; @link README.md."""
    # Имя папки произвольно и само по себе ничего не доказывает. Рабочий пакет
    # не становится готовым экспортом от добавления bundle.json или рецепта пробы.
    if any((folder / name).exists() for name in PACKAGE_DOCUMENTS):
        return False

    def nonempty(path):
        return path.is_file() and path.stat().st_size > 0

    bundle = read_json(folder / "bundle.json")
    if isinstance(bundle, dict):
        rows = bundle.get("shots")
        project = bundle.get("project")
        if (
            isinstance(project, dict)
            and project.get("schema_version") == 1
            and project.get("name")
            and bundle.get("fps") == 30
            and isinstance(bundle.get("song"), str)
            and bundle["song"]
            and isinstance(bundle.get("song_end_s"), (int, float))
            and bundle["song_end_s"] > 0
            and isinstance(bundle.get("references"), dict)
            and isinstance(bundle.get("lyrics"), list)
            and isinstance(rows, list)
            and rows
            and all(
                isinstance(row, dict)
                and isinstance(row.get("shot"), str)
                and row["shot"]
                and row.get("status") in ("video", "card")
                and isinstance(row.get("frames_30"), int)
                and row["frames_30"] > 0
                and isinstance(row.get("accepted_clip" if row["status"] == "video" else "card"), str)
                and row.get("accepted_clip" if row["status"] == "video" else "card")
                for row in rows
            )
            and all(
                nonempty(folder / name)
                for name in ("shots.csv", "lyrics.csv", "timeline.edl", "timeline.fcpxml", "README.md")
            )
        ):
            return True

    # build_review пишет статус и хеш результата только после успешной сборки.
    # Сам MP4 ищем рядом с рецептом: сохранённый абсолютный output устаревает при переносе проекта.
    for recipe in sorted(folder.glob("*.json")):
        document = read_json(recipe)
        if not isinstance(document, dict):
            continue
        output = document.get("output")
        rows = document.get("shots")
        if (
            document.get("schema_version") == 1
            and document.get("fps") == 30
            and document.get("status") == "review_pending"
            and isinstance(document.get("video_sha256"), str)
            and re.fullmatch(r"[0-9a-f]{64}", document["video_sha256"])
            and isinstance(document.get("total_frames"), int)
            and document["total_frames"] > 0
            and isinstance(document.get("audio"), dict)
            and document["audio"].get("path")
            and isinstance(rows, list)
            and rows
            and all(
                isinstance(row, dict)
                and row.get("id")
                and row.get("kind") in ("video", "card")
                and row.get("path")
                and row.get("sha256")
                and isinstance(row.get("frames"), int)
                and row["frames"] > 0
                for row in rows
            )
            and isinstance(output, str)
            and output
            and Path(output.replace("\\", "/")).stem == recipe.stem
            and Path(output.replace("\\", "/")).suffix.lower() == ".mp4"
            and nonempty(recipe.with_suffix(Path(output.replace("\\", "/")).suffix))
        ):
            return True
    return False


def package_owners(folder):
    """Планы, которым принадлежит папка в plan/batches: поле shot пакета, список shots пробы или код в начале имени."""
    for name in PACKAGE_DOCUMENTS:
        document = read_json(folder / name)
        if isinstance(document, dict) and document.get("shot"):
            return {str(document["shot"])}
    owners = set()
    for spec in sorted(folder.glob("*.json")):
        document = read_json(spec)
        if isinstance(document, dict) and isinstance(document.get("shots"), list):
            owners |= {str(item["id"]) for item in document["shots"] if isinstance(item, dict) and item.get("id")}
    if owners:
        return owners
    match = SHOT_NAME.match(folder.name)
    return {match[1]} if match else set()


def new_attempt(folder, root):
    """Новая попытка уже принятого плана (повтор или доработка) — штатная работа, а не остаток приёмки без --clean.

    Остатком считается пакет на этапе accepted или пакет, чей запрос совпадает с запросом принятого комплекта.
    """
    workflow = read_json(folder / "workflow.json")
    if not isinstance(workflow, dict) or not workflow.get("stage") or workflow["stage"] == "accepted":
        return False
    snapshot = read_json(root / "assets/shots" / str(workflow.get("shot")) / "generation-request.json")
    accepted_sha = snapshot.get("request_sha256") if isinstance(snapshot, dict) else None
    request_dir = workflow.get("request_dir")
    attempt = read_json(folder / request_dir / "attempt.json") if isinstance(request_dir, str) and request_dir else None
    attempt_sha = attempt.get("request_sha256") if isinstance(attempt, dict) else None
    return not (accepted_sha and attempt_sha == accepted_sha)


def collect(root=ROOT):
    """Список несоответствий; пустой список означает, что приёмка и обновление представлений отработали штатно."""
    root = Path(root).resolve()
    try:
        scenes = load_scenes(root)
    except FileNotFoundError:
        # Без сценария проверка ещё невозможна; пустой реестр скрыл бы этот этап.
        raise ValueError("Сначала необходимо создать сценарий: отсутствует plan/scenes.json.") from None
    ids = [s["id"] for s in scenes["scenes"]]
    # Порядок в папке зависит от наличия комплекта: устаревший по постановке комплект по-прежнему
    # заменяет карточку в сборке. Актуальность принятия выводится отдельно и несоответствием не считается.
    accepted = {sid for sid in ids if (root / "assets/shots" / sid / "manifest.json").is_file()}
    acceptance = project_shot_acceptance(root, scenes)
    problems = []

    def add(kind, path, message):
        problems.append({"kind": kind, "path": str(path), "message": message})

    cards = root / "plan/animatic/cards"
    for png in sorted(cards.glob("*.png")) if cards.is_dir() else []:
        sid = png.name.split(".")[0]
        if sid in accepted:
            add("card_of_accepted", png.relative_to(root), f"карточка принятого плана {sid}; обновите представления")
        elif sid not in ids:
            add("card_unknown", png.relative_to(root), "карточка плана, которого нет в реестре")
    for sid in ids:
        if sid not in accepted and not (cards / f"{sid}.png").is_file():
            add(
                "card_missing",
                f"plan/animatic/cards/{sid}.png",
                f"нет карточки незавершённого плана {sid}; обновите представления",
            )
    receipt = read_json(cards / "manifest.json")
    listed = set(receipt.get("cards", {})) if isinstance(receipt, dict) else set()
    expected = {sid for sid in ids if sid not in accepted}
    if listed != expected:
        add(
            "receipt_stale",
            "plan/animatic/cards/manifest.json",
            "квитанция карточек не совпадает с незавершёнными планами; обновите представления",
        )

    batches = root / "plan/batches"
    retained = retained_montage_folders(root)
    for folder in sorted(batches.iterdir()) if batches.is_dir() else []:
        if not folder.is_dir():
            continue
        if folder.resolve() in retained:
            continue
        if not any(folder.iterdir()):
            add("empty_folder", folder.relative_to(root), "пустая папка пробы или пакета")
            continue
        if completed_output(folder):
            continue
        owners = package_owners(folder)
        if not owners:
            add("package_unowned", folder.relative_to(root), "папка без плана-владельца; проверьте вручную")
        elif owners - set(ids):
            add(
                "package_unknown",
                folder.relative_to(root),
                "пакет планов, которых нет в реестре: " + ", ".join(sorted(owners - set(ids))),
            )
        elif owners <= accepted and not new_attempt(folder, root):
            # Проба нескольких планов нужна, пока хотя бы один из них не принят.
            add(
                "package_of_accepted",
                folder.relative_to(root),
                "рабочий пакет принятых планов " + ", ".join(sorted(owners)) + "; приёмка без --clean",
            )

    awaiting = root / "plan/awaiting"
    for folder in sorted(awaiting.glob("M*")) if awaiting.is_dir() else []:
        if (
            folder.is_dir()
            and folder.name in accepted
            and folder.resolve() not in retained
            and not new_attempt(folder, root)
        ):
            add(
                "queue_of_accepted",
                folder.relative_to(root),
                f"пакет очереди принятого плана {folder.name}; приёмка без --clean",
            )
    def number(sid):
        return float(sid[1:])

    return {
        "accepted": sorted((sid for sid in accepted if acceptance[sid] == "completed"), key=number),
        "stale": sorted((sid for sid in accepted if acceptance[sid] == "stale"), key=number),
        "problems": problems,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    try:
        result = collect()
    except (ValueError, OSError, KeyError) as error:
        if args.json:
            print(json.dumps({"error": str(error)}, ensure_ascii=False, indent=2))
            raise SystemExit(1)
        parser.exit(1, str(error) + "\n")
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(f"Принятых планов: {len(result['accepted'])}.")
        if result["stale"]:
            print(
                "Постановка изменена после приёмки, нужно новое производство: " + ", ".join(result["stale"]) + "."
            )
        for problem in result["problems"]:
            print(f"- {problem['path']}: {problem['message']}")
        print(
            "Рабочее дерево согласовано." if not result["problems"] else f"Несоответствий: {len(result['problems'])}."
        )
    raise SystemExit(1 if result["problems"] else 0)


if __name__ == "__main__":
    main()
