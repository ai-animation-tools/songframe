"""Каркас реестра сцен из трактовки и разметки трека; @link README.md

Детерминированная часть сценария: кадровые окна планов на сетке 30 кадров/с по строкам песни и частям
трактовки `plan/treatment.json`, карта `references` из кастинга, заготовки полей постановки. Смысл планов
(камера, действие, непрерывность, состояние) дописывает агент или редактор сценария в приложении.
"""

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from tools.cast_registry.cast_registry import load_cast
from tools.cast_registry.cast_registry import references as cast_references
from tools.common import ROOT, read_json
from tools.scene_registry.scene_registry import validate

FPS = 30
TREATMENT_PATH = Path("plan/treatment.json")
TIMING_PATH = Path("plan/audio/timing.json")
SCENES_PATH = Path("plan/scenes.json")
TEXT_PATH = Path("source/text.md")
MIN_SHOT_FRAMES = 15
GAP_SECONDS = 2.5
DEFAULT_MAX_SHOT = 6.0
PLACEHOLDER = "ЗАПОЛНИТЬ"


def validate_treatment(data, duration):
    """Части трактовки покрывают трек без разрывов и наложений; возвращает отсортированные части."""
    if (
        not isinstance(data, dict)
        or data.get("schema_version") != 1
        or not isinstance(data.get("sequences"), list)
        or not data["sequences"]
    ):
        raise ValueError("plan/treatment.json: нужны schema_version 1 и непустой список sequences.")
    parts = sorted(data["sequences"], key=lambda s: float(s["start"]))
    cursor = 0.0
    seen = set()
    for part in parts:
        if not isinstance(part.get("id"), str) or not part["id"] or part["id"] in seen:
            raise ValueError(f"Часть без уникального id: {part}")
        seen.add(part["id"])
        start, end = float(part["start"]), float(part["end"])
        if abs(start - cursor) > 0.06 or end <= start:
            raise ValueError(f"Часть {part['id']}: начало {start} не стыкуется с {cursor:.2f} или конец раньше начала.")
        cursor = end
    if abs(cursor - duration) > 0.06:
        raise ValueError(f"Части заканчиваются на {cursor:.2f}, а трек длится {duration:.2f}.")
    return parts


def frame(seconds):
    return int(round(float(seconds) * FPS))


def shot_boundaries(part, lines, end_frame):
    """Границы планов внутри части в кадрах: по началам строк песни, инструментал равными кусками."""
    start = frame(part["start"])
    inside = [line for line in lines if start <= frame((line["start"] + line["end"]) / 2) < end_frame]
    boundaries = [start]
    if inside:
        first = frame(inside[0]["start"])
        if first - start >= frame(GAP_SECONDS):
            boundaries.append(first)
        for line in inside[1:]:
            boundaries.append(frame(line["start"]))
        last_end = frame(inside[-1]["end"])
        if end_frame - last_end >= frame(GAP_SECONDS):
            boundaries.append(last_end)
    else:
        step = float(part.get("max_shot_seconds", DEFAULT_MAX_SHOT))
        count = max(1, int(round((end_frame - start) / FPS / step)))
        for index in range(1, count):
            boundaries.append(start + round((end_frame - start) * index / count))
    cleaned = [boundaries[0]]
    for value in boundaries[1:]:
        if value - cleaned[-1] >= MIN_SHOT_FRAMES and end_frame - value >= MIN_SHOT_FRAMES:
            cleaned.append(value)
    # Длинный кусок без строки (проигрыш внутри части, хвост) делится на равные планы не длиннее шага.
    step_frames = int(float(part.get("max_shot_seconds", DEFAULT_MAX_SHOT)) * FPS)
    result = []
    for index, start_at in enumerate(cleaned):
        stop_at = cleaned[index + 1] if index + 1 < len(cleaned) else end_frame
        result.append(start_at)
        has_line = any(start_at <= frame((line["start"] + line["end"]) / 2) < stop_at for line in inside)
        if not has_line and stop_at - start_at > step_frames * 1.5:
            count = int(round((stop_at - start_at) / step_frames))
            for piece in range(1, count):
                result.append(start_at + round((stop_at - start_at) * piece / count))
    return result, inside


def build_scenes(treatment, timing, text_lines, cast, duration, existing=None):
    """Собирает реестр: последовательности из трактовки, планы по границам, заготовки полей."""
    parts = validate_treatment(treatment, duration)
    refs = cast_references(cast) if cast else {}
    lines = sorted(timing.get("lines", []), key=lambda line: line["start"])
    total_end = frame(duration)
    sequences = [{"id": p["id"], "title": p.get("title", p["id"]), "direction": p.get("direction", "")} for p in parts]
    scenes = []
    previous = None
    for index, part in enumerate(parts):
        end_frame = total_end if index == len(parts) - 1 else frame(parts[index + 1]["start"])
        boundaries, inside = shot_boundaries(part, lines, end_frame)
        entities = [e for e in part.get("entities", []) if e in refs]
        for b_index, start in enumerate(boundaries):
            end = boundaries[b_index + 1] if b_index + 1 < len(boundaries) else end_frame
            covering = [line for line in inside if start <= frame((line["start"] + line["end"]) / 2) < end]
            original = (
                " / ".join(
                    text_lines[line["source_line"] - 1].strip()
                    for line in covering
                    if 0 < line["source_line"] <= len(text_lines)
                )
                or f"Инструментал: {part.get('title', part['id'])}"
            )
            number = len(scenes) + 1
            if number > 99:
                raise ValueError("Больше 99 планов: укрупните части или увеличьте max_shot_seconds.")
            sid = f"M{number:02d}"
            scenes.append(
                {
                    "id": sid,
                    "original": original,
                    "sequence": part["id"],
                    "start_frame": start,
                    "end_frame_exclusive": end,
                    "camera": PLACEHOLDER,
                    "action": f"{PLACEHOLDER}: {original}",
                    "continuity": "",
                    "references": entities or ["—"],
                    "lipsync": bool(part.get("lipsync", False)) and bool(covering),
                    "card": {"primary_reference": entities[0] if entities else (next(iter(refs), ""))},
                    "state_from": previous,
                    "state_changes": {},
                }
            )
            previous = sid
    data = {
        "schema_version": 1,
        "fps": FPS,
        "audio": {"path": "source/track.mp3", "end_seconds": format_seconds(duration)},
        "references": refs,
        "visual_direction": (existing or {}).get("visual_direction")
        or f"{PLACEHOLDER}: общие визуальные правила клипа (стиль, формат, возраст героев, сезон, свет).",
        "sequences": sequences,
        "scenes": scenes,
    }
    if not refs:
        raise ValueError("В кастинге нет сущностей с изображениями: карточкам планов нужен хотя бы один референс.")
    validate(data)
    return data


def format_seconds(value):
    text = f"{float(value):.6f}".rstrip("0").rstrip(".")
    return text or "0"


def main():
    parser = argparse.ArgumentParser(description="Каркас plan/scenes.json из трактовки, разметки и кастинга.")
    parser.add_argument("--force", action="store_true", help="Перезаписать существующий реестр сцен")
    parser.add_argument("--dry-run", action="store_true", help="Показать планы, файл не писать")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    root = ROOT
    try:
        treatment = read_json(root / TREATMENT_PATH)
        timing = read_json(root / TIMING_PATH)
        if not isinstance(treatment, dict):
            raise ValueError(f"Нет {TREATMENT_PATH}: сначала трактовка (первый проход сценария).")
        if not isinstance(timing, dict) or not timing.get("lines"):
            raise ValueError(f"Нет разметки {TIMING_PATH}: сначала этап таймингов.")
        # Конец шкалы равен декодированной длительности: сборка аниматика сверяет звук с ней,
        # а длительность контейнера MP3 больше на долю секунды из-за заполнения последнего кадра.
        duration = float(timing.get("duration_decoded") or timing.get("duration_container") or 0)
        if not duration:
            raise ValueError("В разметке нет длительности трека.")
        text_lines = (root / TEXT_PATH).read_text(encoding="utf-8").splitlines() if (root / TEXT_PATH).is_file() else []
        cast = load_cast(root)
        if cast is None:
            raise ValueError("Нет plan/cast.json: создайте кастинг (cast_registry init или страница «Кастинг»).")
        existing = read_json(root / SCENES_PATH)
        if isinstance(existing, dict) and not args.force and not args.dry_run:
            raise ValueError(
                f"{SCENES_PATH} уже существует: добавьте --force, чтобы заменить его каркасом "
                "(постановка будет потеряна)."
            )
        data = build_scenes(
            treatment, timing, text_lines, cast, duration, existing if isinstance(existing, dict) else None
        )
    except (ValueError, OSError, KeyError) as error:
        parser.exit(1, f"{error}\n")
    if not args.dry_run:
        (root / SCENES_PATH).parent.mkdir(parents=True, exist_ok=True)
        (root / SCENES_PATH).write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if args.json:
        # Приложение получает весь каркас без записи; обычный JSON-отчёт сохраняет прежний контракт.
        result = (
            data
            if args.dry_run
            else {
                "written": True,
                "scenes": len(data["scenes"]),
                "sequences": len(data["sequences"]),
                "references": list(data["references"]),
            }
        )
        print(json.dumps(result, ensure_ascii=False))
        return
    for scene in data["scenes"]:
        print(
            f"{scene['id']} {scene['start_frame'] / FPS:7.2f}–{scene['end_frame_exclusive'] / FPS:7.2f} "
            f"[{scene['sequence']}] {scene['original']}"
        )
    print(
        f"\nПланов: {len(data['scenes'])}, частей: {len(data['sequences'])}."
        + ("" if args.dry_run else f" Записано: {SCENES_PATH}")
    )


if __name__ == "__main__":
    main()
