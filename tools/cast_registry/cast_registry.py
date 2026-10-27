"""Кастинг клипа plan/cast.json: сущности, их референсы, начальное состояние и словарь свойств; @link README.md

Кастинг владеет списком сущностей (персонажи, транспорт, локации, предметы, мир) и их начальным
состоянием. Из него выводится карта `references` реестра сцен и словарь подписей для редактора
и врезки непрерывности. Реестр сцен хранит только изменения состояния, не копии кастинга.
"""

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from tools.common import ROOT, read_json

CAST_PATH = Path("plan/cast.json")
SCENES_PATH = Path("plan/scenes.json")
SOURCE_MANIFEST = Path("source/manifest.json")
# Типы сущностей открыты: их список с подписями и папками ведёт source/manifest.json (kinds).
# Зарезервирован только world.
KIND_PATTERN = re.compile(r"^[a-z][a-z0-9_]*$")
WORLD_ID = "world"

# Словарь свойств состояния по умолчанию: подписи, подсказки, типовые значения и вопрос для чек-листа.
# Значения свободные строки; список values только подсказывает. Ключи попадают в state_changes реестра.
# Словарь свойств состояния по умолчанию общий для инструментов и приложения: default_properties.json.
_DEFAULTS = json.loads(Path(__file__).with_name("default_properties.json").read_text(encoding="utf-8"))
DEFAULT_PROPERTIES = _DEFAULTS["default"]
GENERIC_PROPERTIES = _DEFAULTS["generic"]


def default_cast():
    return {
        "schema_version": 1,
        "entities": [world_entity()],
        "properties": json.loads(json.dumps(DEFAULT_PROPERTIES, ensure_ascii=False)),
    }


def world_entity():
    return json.loads(json.dumps(_DEFAULTS["world"], ensure_ascii=False))


def validate_cast(data):
    """Проверяет структуру без схемы (схему проверяет lint_registry) и возвращает список ошибок."""
    problems = []
    if (
        not isinstance(data, dict)
        or data.get("schema_version") != 1
        or not isinstance(data.get("entities"), list)
        or not isinstance(data.get("properties"), dict)
    ):
        return ["cast.json: нужны schema_version 1, entities и properties."]
    seen = set()
    for entity in data["entities"]:
        if not isinstance(entity, dict):
            problems.append("entities: элемент не объект.")
            continue
        eid = entity.get("id")
        if not isinstance(eid, str) or not eid:
            problems.append("entities: сущность без id.")
            continue
        if eid in seen:
            problems.append(f"{eid}: id повторяется.")
        seen.add(eid)
        if not isinstance(entity.get("kind"), str) or not KIND_PATTERN.match(entity["kind"]):
            problems.append(f"{eid}: тип должен быть кодом из латиницы, цифр и подчёркивания.")
        if not isinstance(entity.get("name"), str) or not entity["name"].strip():
            problems.append(f"{eid}: нет названия.")
        for image in entity.get("images", []) or []:
            if not isinstance(image, str) or "/" not in image:
                problems.append(f"{eid}: путь изображения должен быть вида heroes/<файл>.")
        state = entity.get("initial_state", {})
        if not isinstance(state, dict) or any(not isinstance(v, str) or not v.strip() for v in state.values()):
            problems.append(f"{eid}: initial_state должен быть объектом из непустых строк.")
    worlds = [e for e in data["entities"] if isinstance(e, dict) and e.get("kind") == "world"]
    if len(worlds) > 1:
        problems.append("Сущность типа world должна быть одна.")
    return problems


def load_cast(root=None):
    """Кастинг проекта или None, если файла нет; повреждённый файл это ValueError."""
    path = Path(root or ROOT) / CAST_PATH
    data = read_json(path)
    if data is None:
        return None
    if data is False:
        raise ValueError(f"{CAST_PATH} повреждён.")
    problems = validate_cast(data)
    if problems:
        raise ValueError(" ".join(problems))
    return data


def initial_states(cast):
    """Начальное состояние всех сущностей в форме состояния реестра сцен: {entity: {property: value}}."""
    if not cast:
        return {}
    return {e["id"]: dict(e["initial_state"]) for e in cast["entities"] if e.get("initial_state")}


def references(cast):
    """Карта references для plan/scenes.json: сущности с изображением, первый файл основной."""
    result = {}
    for entity in cast["entities"]:
        if entity.get("images"):
            item = {"name": entity["name"], "path": "source/" + entity["images"][0]}
            if entity.get("short_name") and entity["short_name"] != entity["name"]:
                item["short_name"] = entity["short_name"]
            result[entity["id"]] = item
    return result


def labels(cast):
    """Подписи свойств по типу сущности: {kind: {key: property}}; типу без словаря достаётся общий набор."""
    result = {}
    source = cast["properties"] if cast else DEFAULT_PROPERTIES
    for kind, items in source.items():
        result[kind] = {item["key"]: item for item in items}
    for entity in (cast or {}).get("entities", []):
        result.setdefault(entity["kind"], {item["key"]: item for item in GENERIC_PROPERTIES})
    return result


def ensure_properties(cast):
    """Добавляет словарь свойств для каждого типа сущностей, которого ещё нет: известным типам свой, остальным общий."""
    for entity in cast["entities"]:
        kind = entity["kind"]
        if kind not in cast["properties"]:
            cast["properties"][kind] = json.loads(
                json.dumps(DEFAULT_PROPERTIES.get(kind, GENERIC_PROPERTIES), ensure_ascii=False)
            )
    return cast


def from_sources(manifest, existing=None):
    """Кастинг из source/manifest.json: референсы становятся сущностями, прежние правки сохраняются."""
    cast = existing or default_cast()
    by_id = {e["id"]: e for e in cast["entities"]}
    for ref in manifest.get("references", []):
        kind = (
            ref.get("kind")
            if isinstance(ref.get("kind"), str) and KIND_PATTERN.match(ref["kind"]) and ref["kind"] != WORLD_ID
            else "prop"
        )
        entity = by_id.get(ref["id"])
        images = [f["path"] for f in ref.get("files", [])]
        if entity:
            entity["images"] = images or entity.get("images", [])
            entity.setdefault("appearance", "")
            if not entity["appearance"] and ref.get("description"):
                entity["appearance"] = ref["description"]
            continue
        entity = {
            "id": ref["id"],
            "kind": kind,
            "name": ref["name"],
            "short_name": ref.get("short_name") or ref["name"],
            "role": "",
            "appearance": ref.get("description", ""),
            "images": images,
            "initial_state": {},
        }
        cast["entities"].append(entity)
        by_id[ref["id"]] = entity
    if not any(e["kind"] == "world" for e in cast["entities"]):
        cast["entities"].insert(0, world_entity())
    return ensure_properties(cast)


def sync_scenes(root, cast):
    """Переписывает references реестра сцен по кастингу; сцены со ссылками на исчезнувшие сущности это ошибка."""
    path = Path(root) / SCENES_PATH
    scenes = read_json(path)
    if not isinstance(scenes, dict):
        raise ValueError(f"{SCENES_PATH} отсутствует или повреждён.")
    refs = references(cast)
    used = {r for scene in scenes.get("scenes", []) for r in scene.get("references", []) if r != "—"}
    used |= {scene.get("card", {}).get("primary_reference") for scene in scenes.get("scenes", [])}
    missing = sorted(u for u in used if u and u not in refs)
    if missing:
        raise ValueError(f"В сценах используются референсы без изображения в кастинге: {', '.join(missing)}.")
    scenes["references"] = refs
    path.write_text(json.dumps(scenes, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return refs


def write_cast(root, cast):
    problems = validate_cast(cast)
    if problems:
        raise ValueError(" ".join(problems))
    path = Path(root) / CAST_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(cast, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return path


def main():
    parser = argparse.ArgumentParser(
        description="Кастинг клипа: проверка, референсы для реестра сцен, создание из исходников."
    )
    parser.add_argument("--json", action="store_true")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("check", help="Проверить plan/cast.json и его согласованность с реестром сцен")
    commands.add_parser("references", help="Показать карту references, выводимую из кастинга")
    commands.add_parser("sync", help="Записать карту references в plan/scenes.json")
    init = commands.add_parser("init", help="Создать или дополнить plan/cast.json по референсам source/manifest.json")
    init.add_argument("--force", action="store_true", help="Перезаписать существующий кастинг, потеряв правки")
    commands.add_parser("vocab", help="Словарь свойств состояния по типам сущностей")
    args = parser.parse_args()
    root = ROOT
    try:
        if args.command == "init":
            manifest = read_json(root / SOURCE_MANIFEST)
            if not isinstance(manifest, dict):
                raise ValueError(f"Нет {SOURCE_MANIFEST}: сначала загрузите исходники.")
            existing = None if args.force else load_cast(root)
            cast = from_sources(manifest, existing)
            write_cast(root, cast)
            result = {"written": str(CAST_PATH), "entities": [e["id"] for e in cast["entities"]]}
        else:
            cast = load_cast(root)
            if cast is None:
                raise ValueError(f"Нет {CAST_PATH}: создайте кастинг командой init или в приложении.")
            if args.command == "check":
                problems = []
                scenes = read_json(root / SCENES_PATH)
                if isinstance(scenes, dict) and scenes.get("references") != references(cast):
                    problems.append("references в plan/scenes.json расходятся с кастингом: выполните sync.")
                for entity in cast["entities"]:
                    for image in entity["images"]:
                        if not (root / "source" / image).is_file():
                            problems.append(f"{entity['id']}: нет файла source/{image}.")
                result = {"ok": not problems, "problems": problems, "entities": len(cast["entities"])}
            elif args.command == "references":
                result = references(cast)
            elif args.command == "sync":
                result = {"references": sync_scenes(root, cast)}
            else:
                result = cast["properties"]
    except ValueError as error:
        parser.exit(1, f"{error}\n")
    if args.json or args.command in ("references", "vocab"):
        print(json.dumps(result, ensure_ascii=False, indent=2))
    elif args.command == "check":
        print("Кастинг согласован." if result["ok"] else "\n".join(result["problems"]))
        if not result["ok"]:
            raise SystemExit(1)
    elif args.command == "init":
        print(f"Записан {result['written']}: " + ", ".join(result["entities"]))
    else:
        print(f"references обновлены: {', '.join(result['references'])}")


if __name__ == "__main__":
    main()
