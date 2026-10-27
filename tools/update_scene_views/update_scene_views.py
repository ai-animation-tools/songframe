"""Обновляет производные представления единого реестра; @link README.md"""

import sys
from pathlib import Path

# После переноса точка запуска находится на два уровня ниже корня проекта.
# Полные импорты tools.* работают и при прямом запуске файла из любой папки.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))


import argparse
import hashlib
import json
import tempfile

from tools.common import sha
from tools.project_inputs import project_inputs, project_inputs_match
from tools.project_views.project_views import ROOT, Sources, documents, prepared
from tools.scene_registry.scene_registry import validate_project


class MissingInputError(ValueError):
    """Отсутствующий источник — ожидаемое состояние проекта, отдельное от ошибок кода."""


def require_inputs(sources):
    """Проверяет обязательные источники до построения и записи производных представлений."""
    for name in ("plan/scenes.json", "plan/project.json", "plan/production-status.json", "plan/audio/timing.json"):
        if name not in sources.files:
            message = f"Нет обязательного файла: {name}."
            if name == "plan/scenes.json":
                message += " Сначала создайте сценарий."
            raise MissingInputError(message)


def approved_keyframes(root, sid):
    """Пакет плана с полностью принятыми опорами: очередь приоритетнее рабочих папок, принятые пакеты не считаются."""
    candidates = [root / "plan/awaiting" / sid / "workflow.json"] + sorted(
        (root / "plan/batches").glob("*/workflow.json")
    )
    for path in candidates:
        if not path.is_file():
            continue
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except ValueError:
            continue
        if data.get("shot") != sid or data.get("stage") == "accepted":
            continue
        frames = data.get("keyframes") or []
        files = [path.parent / (k.get("path") or "") for k in frames]
        if frames and all(k.get("approved") and k.get("path") for k in frames) and all(f.is_file() for f in files):
            return [
                {
                    "id": k["id"],
                    "role": k.get("role"),
                    "time_seconds": k.get("time_seconds"),
                    "path": str(f.relative_to(root)),
                    "sha256": sha(f),
                }
                for k, f in zip(frames, files)
            ]
    return None


def expected_cards(sources, directory, root=None):
    root = ROOT if root is None else Path(root)
    from tools.render_animatic_cards.render_animatic_cards import render_card, render_keyframe_card

    data, items, packages = prepared(sources)
    # Для карточек нужны название и ссылки; generation проверяется перед генерацией.
    project = validate_project(sources.json("plan/project.json"), validate_generation=False)
    result = {}
    for scene in items:
        if scene["id"] in packages:
            continue
        path = directory / (scene["id"] + ".png")
        keyframes = approved_keyframes(root, scene["id"]) if sources.ref is None else None
        if keyframes:
            # Согласованные опоры заменяют текстовую карточку: сборка покажет переход от первой к последней.
            last = directory / (scene["id"] + ".last.png")
            render_keyframe_card(scene, path, project, keyframes, root, last_target=last)
            result[scene["id"]] = {
                "path": "plan/animatic/cards/" + path.name,
                "sha256": sha(path),
                "keyframes": keyframes,
            }
            if last.is_file():
                result[scene["id"]]["last"] = {"path": "plan/animatic/cards/" + last.name, "sha256": sha(last)}
        else:
            render_card(scene, path, project, data["references"], root)
            result[scene["id"]] = {"path": "plan/animatic/cards/" + path.name, "sha256": sha(path)}
    return result


def update(check=False):
    sources = Sources()
    require_inputs(sources)
    output = documents(sources)
    differences = []
    # Все карточки являются производными тех же полей, что и Markdown.
    # Проверка рендерит только во временную папку и не меняет проект.
    with tempfile.TemporaryDirectory(prefix="scene-cards-") as temporary:
        directory = Path(temporary)
        cards = expected_cards(sources, directory)
        output["plan/animatic/cards/manifest.json"] = (
            json.dumps(
                {
                    "schema_version": 1,
                    "generated_from": "plan/scenes.json",
                    "registry_sha256": hashlib.sha256(sources.text("plan/scenes.json").encode()).hexdigest(),
                    "project_inputs": project_inputs(sources.json("plan/project.json")),
                    "reference_hashes": {
                        v["path"]: sources.digest(v["path"]) for v in prepared(sources)[0]["references"].values()
                    },
                    "cards": cards,
                },
                ensure_ascii=False,
                indent=2,
            )
            + "\n"
        )
        expected_files = {}
        for sid, item in cards.items():
            expected_files[item["path"]] = (item["sha256"], directory / (sid + ".png"))
            if item.get("last"):
                expected_files[item["last"]["path"]] = (item["last"]["sha256"], directory / (sid + ".last.png"))
        for name, (digest, rendered) in expected_files.items():
            target = ROOT / name
            same = target.is_file() and sha(target) == digest
            if not same:
                differences.append(name)
                if not check:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(rendered.read_bytes())
        # Папка карточек производная: PNG принятого плана или ушедшей опоры удаляется в том же запуске,
        # который обновляет представления, а не остаётся рядом с актуальными карточками.
        for stale in sorted((ROOT / "plan/animatic/cards").glob("*.png")):
            name = "plan/animatic/cards/" + stale.name
            if name not in expected_files:
                differences.append(name)
                if not check:
                    stale.unlink()
        for name, text in output.items():
            path = ROOT / name
            if not path.exists() or path.read_text() != text:
                differences.append(name)
                if not check:
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text(text)
    return differences


def check_snapshot(sources):
    """Проверяет снимок Git по записанным хешам: карточки и опоры не перерисовываются, пакеты не читаются."""
    require_inputs(sources)
    changed = [
        name for name, text in documents(sources).items() if name not in sources.files or sources.text(name) != text
    ]
    receipt = sources.json("plan/animatic/cards/manifest.json")
    if receipt["registry_sha256"] != hashlib.sha256(
        sources.text("plan/scenes.json").encode()
    ).hexdigest() or not project_inputs_match(
        receipt,
        sources.json("plan/project.json"),
    ):
        changed.append("plan/animatic/cards/manifest.json")
    expected = {s["id"] for s in prepared(sources)[1]} - set(prepared(sources)[2])
    if set(receipt["cards"]) != expected:
        changed.append("plan/animatic/cards/manifest.json")
    for item in receipt["cards"].values():
        for entry in (item, item.get("last")):
            if not entry:
                continue
            sources.require(entry["path"])
            if sources.digest(entry["path"]) != entry["sha256"]:
                changed.append(entry["path"])
    for name, digest in receipt["reference_hashes"].items():
        if sources.digest(name) != digest:
            changed.append("plan/animatic/cards/manifest.json")
    # Лишний PNG в снимке — карточка принятого плана, которую не удалили перед коммитом.
    listed = {entry["path"] for item in receipt["cards"].values() for entry in (item, item.get("last")) if entry}
    changed += sorted(
        name
        for name in sources.files
        if name.startswith("plan/animatic/cards/") and name.endswith(".png") and name not in listed
    )
    return changed


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--staged", action="store_true")
    group.add_argument("--ref")
    args = parser.parse_args()
    try:
        if args.staged or args.ref:
            if not args.check:
                parser.error("Снимок Git доступен только для проверки.")
            changed = check_snapshot(Sources(":" if args.staged else args.ref))
        else:
            changed = update(args.check)
    except MissingInputError as error:
        # Только ожидаемое отсутствие источника выводим кратко; ошибки программы сохраняют traceback.
        parser.exit(1, str(error) + "\n")
    if args.check and changed:
        parser.exit(1, "Устарели представления: " + ", ".join(changed) + "\n")
    print("Представления актуальны." if args.check else f"Обновлено представлений: {len(changed)}.")


if __name__ == "__main__":
    main()
