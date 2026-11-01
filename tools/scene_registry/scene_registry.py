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

from tools.common import ROOT, write_json_atomic


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
    # Инструкции текстового агента принадлежат проекту; инструменты сохраняют их без обработки.
    if "agent_instructions" in data and not isinstance(data["agent_instructions"], str):
        raise ValueError("plan/project.json: agent_instructions должен быть строкой.")
    generation = data.get("generation")
    if validate_generation and generation is not None:
        if not isinstance(generation, dict):
            raise ValueError("generation должен быть объектом настроек.")
        if not any(kind in generation for kind in ("video", "image")):
            raise ValueError("В generation нужны независимые блоки video и image.")
        for kind in ("video", "image"):
            if generation.get(kind) is not None:
                generation_settings(data, kind)
    return data


GENERATION_FIELDS = {"provider": str, "resolution": str, "aspect_ratio": str, "watermark": bool, "duration_rule": str}
DURATION_RULES = ("min_supported_strictly_greater_than_window", "min_supported_not_less_than_window", "exact_window")


def generation_settings(data, kind="video"):
    """Читает независимые настройки выбранного медиа без изменения данных проекта."""
    if kind not in ("video", "image"):
        raise ValueError("Вид генерации должен быть video или image.")
    generation = data.get("generation") if isinstance(data, dict) else None
    if not isinstance(generation, dict):
        raise ValueError(f"В plan/project.json нет блока generation.{kind}.")
    block = generation.get(kind)
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
    # Маркер выбора проверяет формат данных; готовность к запуску проверяется перед AI-действием.
    if "provider_selected" in block and not isinstance(block["provider_selected"], bool):
        raise ValueError(f"generation.{kind}.provider_selected должен быть логическим значением.")
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


SHOT_ID = re.compile(r"M\d{2}(?:\.\d+)?")
DERIVED_FORMAT = 'derived_from должен быть объектом {"shot": "Mxx"}.'


def derived_from_problems(scenes):
    """Нарушения необязательного derived_from как пары (ID плана, текст); @link README.md.

    Производный план собирается из материала одного исходного плана: цепочки запрещены,
    чтобы монтаж и представления всегда указывали план с собственной генерацией.
    """
    by_id = {scene.get("id"): scene for scene in scenes if isinstance(scene, dict)}
    problems = []
    for sid, scene in by_id.items():
        if "derived_from" not in scene:
            continue
        value = scene["derived_from"]
        source = value.get("shot") if isinstance(value, dict) and set(value) == {"shot"} else None
        if not isinstance(source, str) or not SHOT_ID.fullmatch(source):
            problems.append((sid, DERIVED_FORMAT))
        elif source == sid:
            problems.append((sid, "derived_from не может ссылаться на сам план."))
        elif source not in by_id:
            problems.append((sid, f"derived_from ссылается на неизвестный план {source}."))
        elif "derived_from" in by_id[source]:
            problems.append((sid, f"источник {source} сам собирается из другого плана; укажите исходный план."))
    return problems


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
            not SHOT_ID.fullmatch(sid)
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
    problems = derived_from_problems(data["scenes"])
    if problems:
        raise ValueError(f"{problems[0][0]}: {problems[0][1]}")
    _resolve_states(data, initial)
    return data


def _resolve_states(data, initial=None):
    """Разворачивает сюжетные зависимости, включая будущие планы вступления.

    `initial` это состояние сущностей до первого события (начальное состояние кастинга): источник
    `state_from: null` стартует с него, а не с пустоты. Каждый план обязан иметь `state_from` и `state_changes`.
    """
    base = deepcopy(initial) if initial is not None else initial_states_for()
    scenes = {s["id"]: s for s in data["scenes"]}
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
        if not {"state_from", "state_changes"} <= scene.keys():
            raise ValueError(f"{sid}: нужны state_from и state_changes.")
        source = scene["state_from"]
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


def scene_fingerprints(data, initial=None):
    """Отпечатки всех планов за одно вычисление состояния; значения совпадают со scene_fingerprint."""
    validate(data, initial)
    states = _resolve_states(data, initial)
    directions = {s["id"]: s.get("direction", "") for s in data["sequences"]}
    result = {}
    for scene in data["scenes"]:
        context = {
            "scene": scene,
            "sequence_direction": directions[scene["sequence"]],
            "visual_direction": data.get("visual_direction", ""),
            "state": states[scene["id"]],
        }
        result[scene["id"]] = hashlib.sha256(
            json.dumps(context, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()
        ).hexdigest()
    return result


# Принятие плана привязано к постановке: отпечаток хранится в plan/production-status.json → shots.
# То же правило повторяет главный процесс приложения; @link README.md#принятие-планов
PRODUCTION_STATUS = "plan/production-status.json"
SHA256 = re.compile(r"[0-9a-f]{64}")
# Содержимое нового файла совпадает с шаблоном проекта, если файла ещё нет.
EMPTY_PRODUCTION_STATUS = {
    "schema_version": 1,
    "current_animatic": None,
    "current_animatic_status": "none",
    "shots": {},
}


def read_production_status(root=ROOT):
    """Объект plan/production-status.json; отсутствующий файл — None, повреждённый — ValueError."""
    path = Path(root) / PRODUCTION_STATUS
    try:
        status = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as error:
        raise ValueError(f"Не удалось прочитать {PRODUCTION_STATUS}: {error}") from None
    if not isinstance(status, dict):
        raise ValueError(f"{PRODUCTION_STATUS} должен быть объектом.")
    return status


def accepted_fingerprints(status):
    """Отпечатки постановки, по которым приняты комплекты: {Mxx: sha}; без поля shots — пусто."""
    shots_field = (status or {}).get("shots", {})
    if not isinstance(shots_field, dict):
        raise ValueError(f'{PRODUCTION_STATUS}: shots должен быть объектом {{"Mxx": {{"scene_sha256": "..."}}}}.')
    result = {}
    for sid, entry in shots_field.items():
        digest = entry.get("scene_sha256") if isinstance(entry, dict) else None
        if not SHOT_ID.fullmatch(sid) or not isinstance(digest, str) or not SHA256.fullmatch(digest):
            raise ValueError(f"{PRODUCTION_STATUS}: shots.{sid} должен содержать scene_sha256 из 64 hex-символов.")
        result[sid] = digest
    return result


def with_accepted_fingerprints(status, updates, clear_source_reviews=False):
    """Копия статуса с новыми отпечатками принятых планов; прочие поля и записи других планов сохраняются."""
    result = deepcopy(status) if status is not None else deepcopy(EMPTY_PRODUCTION_STATUS)
    accepted_fingerprints(result)
    shots_field = dict(result.get("shots", {}))
    for sid, digest in updates.items():
        if not SHOT_ID.fullmatch(sid) or not isinstance(digest, str) or not SHA256.fullmatch(digest):
            raise ValueError(f"{sid}: неверный отпечаток постановки {digest!r}.")
        shots_field[sid] = {**shots_field.get(sid, {}), "scene_sha256": digest}
        if clear_source_reviews:
            # Новая приёмка приносит свой generation receipt; прежняя сверка относилась к другим выбранным байтам.
            shots_field[sid].pop("source_review", None)
    # Порядок по монтажному номеру, как у записи главного процесса: файл не перестраивается от записи к записи.
    result["shots"] = dict(sorted(shots_field.items(), key=lambda item: float(item[0][1:])))
    return result


def write_accepted_fingerprints(root, updates, clear_source_reviews=False):
    """Атомарно записывает отпечатки принятых планов в plan/production-status.json."""
    root = Path(root)
    write_json_atomic(
        root / PRODUCTION_STATUS,
        with_accepted_fingerprints(read_production_status(root), updates, clear_source_reviews=clear_source_reviews),
    )


_source_hashes = {}


def source_video_snapshot(root, source_shot, allow_derived=False):
    """Фактический SHA выбранного клипа; stat-кэш исключает повторное чтение неизменённых больших видео."""
    try:
        directory = (Path(root) / "assets/shots" / source_shot).resolve()
        manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
        if (
            manifest.get("schema_version") != 1
            or manifest.get("shot") != source_shot
            or (manifest.get("kind") == "derived_video" and not allow_derived)
        ):
            return None
        video = manifest["accepted_edit"]["video"]
        name, digest = video["path"], video["sha256"]
        if (
            not isinstance(name, str)
            or not name
            or Path(name).is_absolute()
            or video.get("root", "asset") != "asset"
            or not isinstance(digest, str)
            or not SHA256.fullmatch(digest)
        ):
            return None
        path = (directory / name).resolve()
        if not path.is_relative_to(directory) or not path.is_file():
            return None
        info = path.stat()
        identity = (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
        cached = _source_hashes.get(path)
        if cached is None or cached[0] != identity:
            hasher = hashlib.sha256()
            with path.open("rb") as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                    hasher.update(chunk)
            cached = (identity, hasher.hexdigest())
            if len(_source_hashes) >= 512:
                _source_hashes.clear()
            _source_hashes[path] = cached
        return cached[1] if cached[1] == digest else None
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return None


def shot_acceptance(
    data, kits, accepted, initial=None, source_snapshot=None, reasons=None, source_reviews=None, accepted_snapshot=None
):
    """Свежесть по собственной постановке и сохранённому снимку источника; @link README.md.

    kits содержит прочитанные манифесты. source_snapshot возвращает фактический SHA выбранного
    видео либо None; повторная приёмка источника не переписывает снимок производного плана.
    """
    source_reviews = {} if source_reviews is None else source_reviews
    current = scene_fingerprints(data, initial)
    result = {
        sid: "completed" if accepted.get(sid) == digest else "stale" for sid, digest in current.items() if sid in kits
    }
    reasons = {} if reasons is None else reasons
    reasons.update({sid: "scene_changed" for sid, state in result.items() if state == "stale"})
    scenes = {scene["id"]: scene for scene in data["scenes"]}
    # Свои отпечатки вычислены целиком: источник вправе стоять позже производного плана.
    for scene in data["scenes"]:
        sid = scene["id"]
        if result.get(sid) != "completed":
            continue
        source = (scene.get("derived_from") or {}).get("shot")
        manifest = kits.get(sid)
        stored_derived = isinstance(manifest, dict) and manifest.get("kind") == "derived_video"
        if not source and not stored_derived:
            continue
        generation = manifest.get("generation") if isinstance(manifest, dict) else None
        reason = None
        if (
            not source
            or not stored_derived
            or not isinstance(generation, dict)
            or generation.get("source_shot") != source
        ):
            reason = "derived_link_changed"
        else:
            source_scene = scenes.get(source)
            snapshot = source_snapshot(source) if source_snapshot else None
            if (
                not source_scene
                or source_scene.get("derived_from")
                or result.get(source) != "completed"
                or snapshot is None
            ):
                reason = "source_unavailable"
            elif sid in source_reviews:
                # Явная повторная сверка текущего монтажа не переписывает историческое происхождение generation.
                # Подтверждение действительно только для этих байтов и этой постановки источника; @link README.md.
                review = source_reviews[sid]
                fields = {"source_shot", "source_scene_sha256", "source_accepted_video_sha256", "accepted_video_sha256"}
                valid = (
                    isinstance(review, dict)
                    and set(review) == fields
                    and isinstance(review.get("source_shot"), str)
                    and bool(SHOT_ID.fullmatch(review["source_shot"]))
                    and all(
                        isinstance(review.get(key), str) and SHA256.fullmatch(review[key])
                        for key in fields - {"source_shot"}
                    )
                )
                if not valid:
                    reason = "source_receipt_missing"
                elif review["source_shot"] != source:
                    reason = "derived_link_changed"
                elif not accepted_snapshot or accepted_snapshot(sid) != review["accepted_video_sha256"]:
                    reason = "source_receipt_missing"
                elif (
                    review["source_scene_sha256"] != current[source]
                    or review["source_accepted_video_sha256"] != snapshot
                ):
                    reason = "source_changed"
            elif not isinstance(generation.get("source_scene_sha256"), str) or not isinstance(
                generation.get("source_accepted_video_sha256"), str
            ):
                reason = "source_receipt_missing"
            elif (
                generation["source_scene_sha256"] != current[source]
                or generation["source_accepted_video_sha256"] != snapshot
            ):
                reason = "source_changed"
        if reason:
            result[sid], reasons[sid] = "stale", reason
    return result


def project_shot_acceptance(root=ROOT, data=None, reasons=None):
    """Свежесть комплектов по файлам проекта, без записи и изменения исторических снимков."""
    root = Path(root)
    data = load(root) if data is None else data
    kits = {}
    for scene in data["scenes"]:
        path = root / "assets/shots" / scene["id"] / "manifest.json"
        if path.is_file():
            try:
                kits[scene["id"]] = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                kits[scene["id"]] = None
    status = read_production_status(root)
    accepted = accepted_fingerprints(status)
    reviews = {
        sid: entry["source_review"]
        for sid, entry in (status or {}).get("shots", {}).items()
        if "source_review" in entry
    }
    return shot_acceptance(
        data, kits, accepted, initial_states_for(root), lambda sid: source_video_snapshot(root, sid), reasons,
        source_reviews=reviews,
        accepted_snapshot=lambda sid: source_video_snapshot(root, sid, allow_derived=True),
    )


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
                # «—» в реестре означает план без референсов: в карточки и сборку заглушка не попадает.
                "refs": [ref for ref in scene["references"] if ref != "—"],
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
                    # Ключ появляется только у производного плана, вывод обычных планов прежний.
                    **({"derived_from": scene["derived_from"]} if "derived_from" in scene else {}),
                    "scene_sha256": scene_fingerprint(data, args.shot),
                    "state": state if args.phase == "both" else state[args.phase],
                },
                ensure_ascii=False,
                indent=2,
            )
        )
    except (ValueError, OSError, KeyError) as error:
        parser.exit(1, str(error) + "\n")
