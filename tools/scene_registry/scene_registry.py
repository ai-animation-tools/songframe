"""Единственный источник постановки и монтажного времени; @link README.md"""

import sys
from pathlib import Path

# После переноса точка запуска находится на два уровня ниже корня проекта.
# Полные импорты tools.* работают и при прямом запуске файла из любой папки.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))


import argparse
import hashlib
import json
import re
from copy import deepcopy
from decimal import Decimal

from tools.common import ROOT


def validate_project(data, *, validate_generation=True):
    """Проверяет данные оформления без привязки инструментов к конкретному клипу."""
    if (
        not isinstance(data, dict)
        or data.get("schema_version") != 1
        or not isinstance(data.get("name"), str)
        or not data["name"].strip()
        or any(c in data["name"] for c in "\r\n")
    ):
        raise ValueError("В plan/project.json нужны схема и непустое название проекта.")
    filename = data.get("animatic_video")
    if not isinstance(filename, str) or not re.fullmatch(r"[\w.-]+\.mp4", filename) or filename.startswith("."):
        raise ValueError("animatic_video должен быть именем MP4 без пути к папке.")
    generation = data.get("generation")
    if validate_generation and generation is not None:
        if not isinstance(generation, dict):
            raise ValueError("generation должен быть объектом настроек.")
        if "video" in generation or "image" in generation:
            for kind in ("video", "image"):
                if generation.get(kind) is not None:
                    generation_settings(data, kind)
        else:
            generation_settings(data)
    return data


GENERATION_FIELDS = {"provider": str, "resolution": str, "aspect_ratio": str, "watermark": bool, "duration_rule": str}
DURATION_RULES = ("min_supported_strictly_greater_than_window", "min_supported_not_less_than_window", "exact_window")


def generation_settings(data, kind="video"):
    """Читает настройки одного медиа; legacy generation остаётся настройками видео.

    Явные video/image отключают legacy fallback. Возвращаем копию без записи миграции в проект и замороженные запросы.
    """
    if kind not in ("video", "image"):
        raise ValueError("Вид генерации должен быть video или image.")
    generation = data.get("generation") if isinstance(data, dict) else None
    if not isinstance(generation, dict):
        raise ValueError(f"В plan/project.json нет блока generation.{kind}.")
    if "video" in generation or "image" in generation:
        block = generation.get(kind)
    else:
        block = generation if kind == "video" else {"provider": "codex"}
    if not isinstance(block, dict):
        raise ValueError(f"В plan/project.json нет корректного блока generation.{kind}.")
    fields = GENERATION_FIELDS if kind == "video" else {"provider": str}
    missing = [
        key
        for key, expected in fields.items()
        if not isinstance(block.get(key), expected) or (expected is str and not block[key].strip())
    ]
    if missing:
        raise ValueError(f"В generation.{kind} не заполнены поля: {', '.join(missing)}.")
    if kind == "video" and block["duration_rule"] not in DURATION_RULES:
        raise ValueError(f"duration_rule должен быть одним из: {', '.join(DURATION_RULES)}.")
    for field in ("resolution", "aspect_ratio", "model"):
        if field in block and (not isinstance(block[field], str) or not block[field].strip()):
            raise ValueError(f"generation.{kind}.{field} должен быть непустой строкой.")
    # auto допускается в настройках обоих медиа; возможности модели проверяются при подготовке запроса.
    if (
        "aspect_ratio" in block
        and not re.fullmatch(r"\d+:\d+", block["aspect_ratio"])
        and block["aspect_ratio"] != "auto"
    ):
        raise ValueError("aspect_ratio записывается как 16:9 или auto.")
    if "watermark" in block and not isinstance(block["watermark"], bool):
        raise ValueError(f"generation.{kind}.watermark должен быть логическим значением.")
    if "options" in block and not isinstance(block["options"], dict):
        raise ValueError(f"generation.{kind}.options должен быть объектом.")
    if kind == "image" and "outputs" in block and (type(block["outputs"]) is not int or block["outputs"] < 1):
        raise ValueError("generation.image.outputs должен быть положительным целым числом.")
    return deepcopy(block)


def load_project(root=ROOT, *, validate_generation=False):
    """Читает оформление проекта; исполнитель отдельно проверяет настройки нужного медиа, @link README.md."""
    return validate_project(
        json.loads((Path(root) / "plan/project.json").read_text()), validate_generation=validate_generation
    )


_INITIAL_CACHE = {}


def initial_states_for(root=None):
    """Начальное состояние сущностей из plan/cast.json проекта; без кастинга пусто."""
    key = str(Path(root or ROOT).resolve())
    if key not in _INITIAL_CACHE:
        from tools.cast_registry.cast_registry import initial_states, load_cast

        try:
            _INITIAL_CACHE[key] = initial_states(load_cast(key))
        except ValueError:
            _INITIAL_CACHE[key] = {}
    return deepcopy(_INITIAL_CACHE[key])


def validate(data, initial=None):
    # Кадровые границы проверяются до чтения медиа; пропуск, повтор или
    # конфликт с готовым клипом нельзя скрывать прежней таблицей или карточкой.
    if data.get("schema_version") != 1 or data.get("fps") != 30 or not data.get("scenes"):
        raise ValueError("Неизвестная схема или пустой реестр сцен.")
    seen = set()
    end = 0
    groups = {s["id"] for s in data.get("sequences", [])}
    for scene in data["scenes"]:
        sid = scene["id"]
        if (
            not re.fullmatch(r"M\d{2}(?:\.\d+)?", sid)
            or sid in seen
            or type(scene["start_frame"]) is not int
            or type(scene["end_frame_exclusive"]) is not int
            or scene["start_frame"] != end
            or scene["end_frame_exclusive"] <= end
            or scene["sequence"] not in groups
        ):
            raise ValueError(f"{sid}: повтор, разрыв или неверная граница сцены.")
        if any(ref not in data["references"] for ref in scene["references"] if ref != "—"):
            raise ValueError(f"{sid}: неизвестный референс.")
        seen.add(sid)
        end = scene["end_frame_exclusive"]
    if abs(Decimal(end) / data["fps"] - Decimal(data["audio"]["end_seconds"])) >= Decimal(1) / data["fps"]:
        raise ValueError("Монтажный конец расходится с концом песни.")
    _resolve_states(data, initial)
    return data


def _resolve_states(data, initial=None):
    """Разворачивает сюжетные зависимости, включая будущие планы вступления.

    `initial` это состояние сущностей до первого события (начальное состояние кастинга): источник
    `state_from: null` стартует с него, а не с пустоты; без кастинга поведение прежнее.
    """
    base = deepcopy(initial) if initial is not None else initial_states_for()
    scenes = {s["id"]: s for s in data["scenes"]}
    structured = any("state_from" in s or "state_changes" in s for s in scenes.values())
    previous = {s["id"]: (data["scenes"][i - 1]["id"] if i else None) for i, s in enumerate(data["scenes"])}
    resolved, visiting = {}, []

    def apply(state, delta, sid):
        # null удаляет факт, который больше не установлен, а не делает героя чистым.
        # Восстановление и очистка задаются явным значением по @link README.md.
        result = deepcopy(state)
        if not isinstance(delta, dict):
            raise ValueError(f"{sid}: изменения состояния должны быть объектом.")
        for entity, attributes in delta.items():
            if not re.fullmatch(r"[a-z][a-z0-9_]*", entity) or not isinstance(attributes, dict):
                raise ValueError(f"{sid}: неверный объект состояния.")
            for key, value in attributes.items():
                if (
                    not re.fullmatch(r"[a-z][a-z0-9_]*", key)
                    or value is not None
                    and (not isinstance(value, str) or not value.strip())
                ):
                    raise ValueError(f"{sid}: неверное свойство состояния.")
                if value is None:
                    result.get(entity, {}).pop(key, None)
                else:
                    result.setdefault(entity, {})[key] = value
            if entity in result and not result[entity]:
                del result[entity]
        return result

    def visit(sid):
        if sid in resolved:
            return resolved[sid]
        if sid in visiting:
            raise ValueError("Цикл state_from: " + " → ".join(visiting + [sid]))
        if sid not in scenes:
            raise ValueError(f"{sid}: неизвестный источник state_from.")
        visiting.append(sid)
        scene = scenes[sid]
        if structured and not {"state_from", "state_changes"} <= scene.keys():
            raise ValueError(f"{sid}: нужны state_from и state_changes.")
        source = scene.get("state_from", previous[sid])
        phase = "after"
        if isinstance(source, dict):
            if set(source) != {"scene", "phase"}:
                raise ValueError(f"{sid}: неверная ссылка state_from.")
            source, phase = source["scene"], source["phase"]
        if (
            source is not None
            and not isinstance(source, str)
            or phase not in ("before", "after", "same")
            or source is None
            and phase != "after"
        ):
            raise ValueError(f"{sid}: неверный источник или фаза state_from.")
        changes = scene.get("state_changes", {})
        if not isinstance(changes, dict) or set(changes) - {"before", "after"}:
            raise ValueError(f"{sid}: state_changes допускает только before и after.")
        incoming = visit(source) if source is not None else {"before": deepcopy(base), "after": deepcopy(base)}
        if phase == "same":
            # Повтор M13 во вступлении использует обе границы исходного события,
            # не копируя его изменения и не создавая второго события в сюжете.
            if changes:
                raise ValueError(f"{sid}: повтор same не допускает своих state_changes.")
            value = deepcopy(incoming)
        else:
            before = apply(incoming[phase], changes.get("before", {}), sid)
            value = {"before": before, "after": apply(before, changes.get("after", {}), sid)}
        visiting.pop()
        resolved[sid] = value
        return value

    for sid in scenes:
        visit(sid)
    return resolved


def scene_state(data, sid, initial=None):
    """Возвращает независимую сводку до/после, не записывая её в реестр."""
    validate(data, initial)
    states = _resolve_states(data, initial)
    if sid not in states:
        raise ValueError(f"{sid}: сцена отсутствует в реестре.")
    return deepcopy(states[sid])


def scene_fingerprint(data, sid, initial=None):
    """Отложенный запрос зависит и от унаследованных условий, не только от Mxx."""
    state = scene_state(data, sid, initial)
    scene = next(s for s in data["scenes"] if s["id"] == sid)
    direction = next(s.get("direction", "") for s in data["sequences"] if s["id"] == scene["sequence"])
    context = {
        "scene": scene,
        "sequence_direction": direction,
        "visual_direction": data.get("visual_direction", ""),
        "state": state,
    }
    return hashlib.sha256(
        json.dumps(context, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()
    ).hexdigest()


def load(root=ROOT):
    return validate(json.loads((Path(root) / "plan/scenes.json").read_text()))


def seconds(number, fps=30):
    return format((Decimal(number) / fps).quantize(Decimal(".000001")), "f").rstrip("0").rstrip(".") or "0"


def clock(value):
    value = Decimal(value)
    remainder = value % 60
    text = format(remainder, "f")
    if "." not in text:
        text += ".0"
    return f"{int(value) // 60:02}:" + ("0" if remainder < 10 else "") + text


def shots(data):
    validate(data)
    result = []
    titles = {s["id"]: s["title"] for s in data["sequences"]}
    for scene in data["scenes"]:
        start = seconds(scene["start_frame"], data["fps"])
        end = (
            data["audio"]["end_seconds"]
            if scene is data["scenes"][-1]
            else seconds(scene["end_frame_exclusive"], data["fps"])
        )
        duration = format(Decimal(end) - Decimal(start), "f")
        result.append(
            {
                **scene,
                "title": scene.get("title", titles[scene["sequence"]]),
                "sequence_title": titles[scene["sequence"]],
                "start": start,
                "end": end,
                "duration": duration,
                "interval": clock(start) + "–" + clock(end),
                "frames": scene["end_frame_exclusive"] - scene["start_frame"],
                "state": scene["continuity"],
                "refs": scene["references"],
            }
        )
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("shot", help="Код плана, например M37")
    parser.add_argument("--phase", choices=["before", "after", "both"], default="both")
    args = parser.parse_args()
    try:
        data = load()
        scene = next((s for s in data["scenes"] if s["id"] == args.shot), None)
        state = scene_state(data, args.shot)
        print(
            json.dumps(
                {
                    "shot": args.shot,
                    "action": scene["action"],
                    "camera": scene["camera"],
                    "references": scene["references"],
                    "continuity": scene["continuity"],
                    "state_from": scene.get("state_from"),
                    "state_changes": scene.get("state_changes", {}),
                    "scene_sha256": scene_fingerprint(data, args.shot),
                    "state": state if args.phase == "both" else state[args.phase],
                },
                ensure_ascii=False,
                indent=2,
            )
        )
    except (ValueError, OSError, KeyError) as error:
        parser.exit(1, str(error) + "\n")
