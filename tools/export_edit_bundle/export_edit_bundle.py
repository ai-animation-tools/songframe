"""Пакет для монтажёра: таблица планов, EDL, FCPXML, строки песни и исходники; @link README.md"""

import sys
from pathlib import Path

# После переноса точка запуска находится на два уровня ниже корня проекта.
# Полные импорты tools.* работают и при прямом запуске файла из любой папки.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))


import argparse
import csv
import json
import shutil
from decimal import ROUND_HALF_UP, Decimal
from fractions import Fraction
from xml.sax.saxutils import quoteattr

from tools.common import ROOT
from tools.scene_registry.scene_registry import load, load_project
from tools.scene_registry.scene_registry import shots as registry_shots

FPS = 30


def frames_at(seconds, fps=FPS):
    value = Fraction(str(seconds)) * Fraction(fps)
    return int((Decimal(value.numerator) / Decimal(value.denominator)).to_integral_value(rounding=ROUND_HALF_UP))


def timecode(seconds, fps=FPS):
    total = frames_at(seconds, fps)
    frames = total % fps
    whole = total // fps
    return f"{whole // 3600:02}:{whole % 3600 // 60:02}:{whole % 60:02}:{frames:02}"


def rational(seconds, fps=FPS):
    return f"{frames_at(seconds, fps)}/{fps}s"


def native_fps(edit, media):
    rate = edit.get("source_fps") or (media or {}).get("r_frame_rate")
    if not rate or edit["rebuild"]["stages"][0]["input"] != "original.mp4":
        return Fraction(edit.get("source_frame_grid_fps") or FPS)
    return Fraction(str(rate))


def collect(root=ROOT):
    root = Path(root).resolve()
    registry = load(root)
    project = load_project(root)
    items = registry_shots(registry)
    timing = (
        json.loads((root / "plan/audio/timing.json").read_text(encoding="utf-8"))
        if (root / "plan/audio/timing.json").is_file()
        else {"lines": []}
    )
    text_lines = (
        (root / "source/text.md").read_text(encoding="utf-8").splitlines()
        if (root / "source/text.md").is_file()
        else []
    )
    rows = []
    for scene in items:
        sid = scene["id"]
        folder = root / "assets/shots" / sid
        row = {
            "shot": sid,
            "title": scene.get("title", ""),
            "sequence": scene["sequence"],
            "song_in_s": float(scene["start"]),
            "song_out_s": float(scene["end"]),
            "duration_s": float(scene["duration"]),
            "frames_30": scene["frames"],
            "song_in_tc": timecode(scene["start"]),
            "song_out_tc": timecode(scene["end"]),
            "camera": scene["camera"],
            "action": scene["action"],
            "continuity": scene["continuity"],
            "lipsync": bool(scene.get("lipsync")),
            "status": "card",
            "card": f"plan/animatic/cards/{sid}.png",
        }
        manifest = folder / "manifest.json"
        if manifest.is_file():
            package = json.loads(manifest.read_text(encoding="utf-8"))
            generation, edit = package["generation"], package["accepted_edit"]
            rate = native_fps(edit, generation.get("original_media"))
            stage_input = edit["rebuild"]["stages"][0]["input"]
            source_in, source_out = edit["source_interval_seconds"]
            still = edit.get("still_source_time_seconds")
            row.update(
                {
                    "status": "video",
                    "card": "",
                    "original": f"assets/shots/{sid}/{generation['original']['path']}",
                    "original_sha256": generation["original"]["sha256"],
                    "original_fps": (generation.get("original_media") or {}).get("r_frame_rate", ""),
                    "original_duration_s": float((generation.get("original_media") or {}).get("duration") or 0) or "",
                    "source_shot": generation.get("source_shot", sid),
                    "accepted_clip": f"assets/shots/{sid}/{edit['video']['path']}",
                    "accepted_sha256": edit["video"]["sha256"],
                    "rebuild_input": f"assets/shots/{sid}/{stage_input}",
                    "source_in_s": float(source_in),
                    "source_out_s": float(source_out),
                    "source_grid_fps": float(rate),
                    "source_in_frame_native": frames_at(source_in, rate),
                    "source_out_frame_native": frames_at(source_out, rate),
                    "speed": float(edit["speed"]["factor"]),
                    "speed_ratio": edit["speed"]["ratio"],
                    "hold_first_s": float(edit.get("hold_first_seconds", 0)),
                    "hold_last_s": float(edit.get("hold_last_seconds", 0)),
                    "still_time_s": float(still) if still is not None else "",
                    "repeat_full_cycles": (edit.get("repeat") or {}).get("full_cycles", ""),
                    "repeat_tail_frames": (edit.get("repeat") or {}).get("tail_frames", ""),
                    "repeat_cycle_frames": (edit.get("repeat") or {}).get("cycle_frames", ""),
                    "prompt": f"assets/shots/{sid}/{generation['prompt']['path']}",
                    "request": f"assets/shots/{sid}/{generation['request']['path']}"
                    if generation.get("request")
                    else "",
                    "inputs": [
                        f"assets/shots/{sid}/{i['path']}"
                        if i.get("root", "asset") == "asset"
                        else f"source/{i['path']}"
                        for i in generation["inputs"]
                    ],
                    "speech_wav": f"assets/shots/{sid}/{generation['audio']['path']}"
                    if generation.get("audio")
                    else "",
                    "audio_recipe": f"assets/shots/{sid}/audio-recipe.json"
                    if (folder / "audio-recipe.json").is_file()
                    else "",
                    "filter": edit["rebuild"]["stages"][0]["filter"],
                }
            )
        rows.append(row)
    lyrics = []
    for line in timing.get("lines", []):
        number = line.get("source_line")
        lyrics.append(
            {
                "id": line["id"],
                "source_line": number,
                "text": text_lines[number - 1].strip()
                if isinstance(number, int) and 0 < number <= len(text_lines)
                else "",
                "start_s": line["start"],
                "end_s": line["end"],
                "start_tc": timecode(line["start"]),
                "end_tc": timecode(line["end"]),
                "note": line.get("note", ""),
            }
        )
    return {
        "project": project,
        "fps": FPS,
        "song": registry["audio"]["path"],
        "song_end_s": float(registry["audio"]["end_seconds"]),
        "references": registry["references"],
        "shots": rows,
        "lyrics": lyrics,
        "timing_status": timing.get("status", ""),
    }


def reel(sid):
    return sid.replace(".", "_")[:8].ljust(8)


def write_edl(bundle, target):
    lines = [f"TITLE: {bundle['project']['name']} animatic", "FCM: NON-DROP FRAME", ""]
    number = 0
    for row in bundle["shots"]:
        if row["status"] != "video":
            lines.append(
                (
                    f"* CARD {row['shot']} {row['song_in_tc']} {row['song_out_tc']}: "
                    f"видео не сгенерировано, в аниматике карточка"
                )
            )
            lines.append("")
            continue
        src_in, src_out = row["source_in_s"], row["source_out_s"]
        # EDL не умеет задавать цикл одной строкой. Каждый полный повтор
        # и последний короткий хвост получают своё непрерывное событие.
        if row.get("repeat_cycle_frames", "") != "":
            cycle = row["repeat_cycle_frames"]
            lengths = [cycle] * row["repeat_full_cycles"]
            if row["repeat_tail_frames"]:
                lengths.append(row["repeat_tail_frames"])
            cursor = frames_at(row["song_in_s"])
            lines.append(
                f"* REPEAT {row['shot']}: полных циклов {row['repeat_full_cycles']}, "
                f"хвост {row['repeat_tail_frames']} кадров, цикл {cycle} кадров"
            )
            for length in lengths:
                number += 1
                lines.append(
                    f"{number:03}  {reel(row['shot'])} V     C        "
                    f"{timecode(src_in)} {timecode(src_in + length / FPS)} "
                    f"{timecode(cursor / FPS)} {timecode((cursor + length) / FPS)}"
                )
                lines.append(f"* FROM CLIP NAME: {row['rebuild_input']}")
                cursor += length
        else:
            number += 1
            lines.append(
                (
                    f"{number:03}  {reel(row['shot'])} V     C        "
                    f"{timecode(src_in)} {timecode(src_out)} {row['song_in_tc']} "
                    f"{row['song_out_tc']}"
                )
            )
        if row.get("repeat_cycle_frames", "") == "":
            lines.append(f"* FROM CLIP NAME: {row['rebuild_input']}")
        if row["speed"] not in (1.0, 0.0) and row["still_time_s"] == "":
            lines.append(f"M2   {reel(row['shot'])} {FPS * row['speed']:05.1f}                {timecode(src_in)}")
        if row["hold_first_s"] or row["hold_last_s"]:
            lines.append(f"* HOLD first {row['hold_first_s']:g}s, last {row['hold_last_s']:g}s")
        if row["still_time_s"] != "":
            lines.append(f"* STILL frame at {row['still_time_s']:g}s of {row['rebuild_input']}")
        lines.append(
            (
                f"* ORIGINAL: {row['original']} ({row['original_fps']}); source "
                f"grid {row['source_grid_fps']:g} fps, native frames "
                f"{row['source_in_frame_native']}-{row['source_out_frame_native']}"
            )
        )
        lines.append("")
    target.write_text("\n".join(lines) + "\n", encoding="utf-8")


def write_fcpxml(bundle, target, media_root):
    """Шкала аниматика: принятые клипы и карточки по порядку, песня связанным клипом."""

    def src(path):
        return (Path(media_root) / path).resolve().as_uri()

    assets, spine = [], []
    song_duration = rational(bundle["song_end_s"])
    assets.append(
        (
            f'    <asset id="song" name="song" '
            f'src={quoteattr(src(bundle["song"]))} start="0s" '
            f'duration="{song_duration}" hasAudio="1" audioSources="1" '
            f'audioChannels="2" audioRate="44100"/>'
        )
    )
    for index, row in enumerate(bundle["shots"]):
        rid = "c" + row["shot"].replace(".", "_")
        offset, duration = rational(row["song_in_s"]), f"{row['frames_30']}/{FPS}s"
        if row["status"] == "video":
            assets.append(
                (
                    f'    <asset id="{rid}" name={quoteattr(row["shot"])} '
                    f'src={quoteattr(src(row["accepted_clip"]))} start="0s" '
                    f'duration="{duration}" hasVideo="1" format="r1"/>'
                )
            )
            clip = (
                f'<asset-clip ref="{rid}" name={quoteattr(row["shot"])} '
                f'offset="{offset}" start="0s" duration="{duration}"'
            )
        else:
            assets.append(
                (
                    f'    <asset id="{rid}" name={quoteattr(row["shot"])} '
                    f'src={quoteattr(src(row["card"]))} start="0s" duration="0s" '
                    f'hasVideo="1" format="r1"/>'
                )
            )
            clip = (
                f'<video ref="{rid}" name={quoteattr(row["shot"] + " (карточка)")} '
                f'offset="{offset}" start="0s" duration="{duration}"'
            )
        if index == 0:
            spine.append(f"        {clip}>")
            spine.append(
                (
                    f'          <asset-clip ref="song" lane="-1" name="song" '
                    f'offset="0s" start="0s" duration="{song_duration}"/>'
                )
            )
            spine.append("        </asset-clip>" if row["status"] == "video" else "        </video>")
        else:
            spine.append(f"        {clip}/>")
    total = rational(bundle["song_end_s"])
    document = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        "<!DOCTYPE fcpxml>",
        '<fcpxml version="1.8">',
        "  <resources>",
        '    <format id="r1" name="FFVideoFormat1080p30" frameDuration="1/30s" width="1920" height="1080"/>',
        *assets,
        "  </resources>",
        (
            f"  <library><event name={quoteattr(bundle['project']['name'])}><project "
            f"name={quoteattr(bundle['project']['name'] + ' animatic')}>"
        ),
        (
            f'    <sequence format="r1" duration="{total}" tcStart="0s" '
            f'tcFormat="NDF" audioLayout="stereo" audioRate="44100">'
        ),
        "      <spine>",
        *spine,
        "      </spine>",
        "    </sequence>",
        "  </project></event></library>",
        "</fcpxml>",
    ]
    target.write_text("\n".join(document) + "\n", encoding="utf-8")


CSV_COLUMNS = [
    "shot",
    "status",
    "song_in_tc",
    "song_out_tc",
    "song_in_s",
    "song_out_s",
    "duration_s",
    "frames_30",
    "original",
    "original_fps",
    "original_duration_s",
    "source_shot",
    "rebuild_input",
    "source_in_s",
    "source_out_s",
    "source_grid_fps",
    "source_in_frame_native",
    "source_out_frame_native",
    "speed",
    "speed_ratio",
    "hold_first_s",
    "hold_last_s",
    "still_time_s",
    "repeat_full_cycles",
    "repeat_tail_frames",
    "repeat_cycle_frames",
    "accepted_clip",
    "lipsync",
    "speech_wav",
    "audio_recipe",
    "prompt",
    "inputs",
    "card",
    "camera",
    "action",
    "continuity",
    "original_sha256",
    "accepted_sha256",
]


def write_csv(rows, target, columns):
    with target.open("w", encoding="utf-8", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=columns, extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            writer.writerow(
                {
                    k: ("; ".join(v) if isinstance(v, list) else round(v, 6) if isinstance(v, float) else v)
                    for k, v in row.items()
                    if k in columns
                }
            )


def copy_media(bundle, root, target):
    """Копирует исходники в пакет и переписывает пути на относительные к пакету."""
    media = target / "media"
    copied = {}

    def take(path):
        if not path or path in copied:
            return copied.get(path, path)
        source = root / path
        if not source.is_file():
            raise ValueError(f"Файл не найден: {path}")
        destination = media / path
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, destination)
        copied[path] = str(destination.relative_to(target))
        return copied[path]

    bundle["song"] = take(bundle["song"])
    for key, reference in bundle["references"].items():
        reference["path"] = take(reference["path"])
    for row in bundle["shots"]:
        for key in (
            "original",
            "accepted_clip",
            "rebuild_input",
            "prompt",
            "request",
            "speech_wav",
            "audio_recipe",
            "card",
        ):
            if row.get(key):
                row[key] = take(row[key])
        row["inputs"] = [take(p) for p in row.get("inputs", [])]
    return len(copied)


def readme(bundle, copied):
    rows = bundle["shots"]
    videos = sum(r["status"] == "video" for r in rows)
    lines = [
        f"# {bundle['project']['name']} — пакет для монтажёра",
        "",
        f"Планов {len(rows)}, с видео {videos}, карточек {len(rows) - videos}. "
        f"Песня целиком: `{bundle['song']}`, длительность {bundle['song_end_s']:.4f} с. "
        "Шкала аниматика — 30 кадров/с, таймкоды non-drop от начала песни. "
        "Аниматик — демо: все монтажные решения в нём предварительные.",
        "",
        "## Файлы",
        "",
        (
            "- `shots.csv` — одна строка на план: таймкоды песни, оригинал "
            "генерации, выбранный участок, скорость, удержания, кадры-опоры, "
            "промпт, WAV липсинка."
        ),
        (
            "- `timeline.edl` — CMX3600 на 30 кадров/с: события указывают на "
            "вход рецепта (`rebuild_input`), source in/out даны на сетке 30 "
            "кадров/с после конвертации, как в `shots.csv`; строки `M2` "
            "отмечают изменение скорости, комментарии — удержания и "
            "стоп-кадры. Карточки — комментарии без событий."
        ),
        (
            "- `timeline.fcpxml` — точная шкала аниматика из принятых клипов "
            "30 кадров/с и карточек, песня связанным клипом; открывается в "
            "Final Cut Pro, DaVinci Resolve, Premiere Pro."
        ),
        "- `lyrics.csv` — строки песни с оценками времени из разметки проекта; границы не подтверждены на слух.",
        "- `bundle.json` — те же данные для скриптов.",
        "- `media/` — копии исходников, если пакет собран с `--copy`."
        if copied
        else "- Пути в таблицах относительны к корню репозитория; файлы не копировались.",
        "",
        "## Как читать интервалы",
        "",
        (
            "- Оригиналы генерации сохраняют собственную частоту кадров (`original_fps`, например 24 кадра/с). "
            "Поля `source_in_s`/`source_out_s` — секунды выбранного участка "
            "на сетке `source_grid_fps` после конвертации в 30 кадров/с; "
            "`source_in_frame_native`/`source_out_frame_native` — те же "
            "границы в кадрах исходной частоты (начало включительно, конец "
            "исключительно)."
        ),
        (
            "- `speed` — множитель скорости принятого монтажа (1,0 — без "
            "изменения; 0 — стоп-кадр), `hold_first_s`/`hold_last_s` — "
            "удержание первого и последнего кадра участка, `still_time_s` — "
            "момент стоп-кадра во входе рецепта."
        ),
        (
            "- `repeat_full_cycles`, `repeat_tail_frames`, `repeat_cycle_frames` — число полных повторов, "
            "кадров последнего хвоста и кадров одного цикла. EDL содержит отдельное событие для каждого "
            "повтора и хвоста; FCPXML использует точный принятый клип."
        ),
        (
            "- Планы с `source_shot`, отличным от `shot`, собраны из чужой "
            "генерации (например, вступление из M13); `rebuild_input` "
            "указывает фактический вход."
        ),
        (
            "- Для речевых планов (`lipsync`) `speech_wav` — точный срез "
            "песни, с которым синхронизированы губы; `audio_recipe` описывает "
            "срез по сэмплам."
        ),
        "- Звук внутри оригиналов генерации в монтаже не используется; музыка — исходная песня.",
        "",
        "## Оговорки",
        "",
        "- Хеши SHA-256 в `shots.csv` позволяют проверить, что получены именно те файлы.",
        "- Карточки — условные изображения для демо, не кадры будущих планов.",
        f"- Разметка строк: {bundle['timing_status'] or 'без примечаний'}.",
        "",
    ]
    return "\n".join(lines)


def export(target, root=ROOT, copy=False):
    root = Path(root).resolve()
    target = Path(target).resolve()
    if target.is_relative_to(root) and not any(
        target.is_relative_to((root / name).resolve()) for name in ("plan/batches",)
    ):
        raise ValueError("Пакет собирается вне папки проекта или в plan/batches.")
    if target.exists() and any(target.iterdir()):
        raise ValueError("Папка пакета должна быть пустой.")
    target.mkdir(parents=True, exist_ok=True)
    bundle = collect(root)
    copied = copy_media(bundle, root, target) if copy else 0
    write_csv(bundle["shots"], target / "shots.csv", CSV_COLUMNS)
    write_csv(
        bundle["lyrics"],
        target / "lyrics.csv",
        ["id", "source_line", "text", "start_tc", "end_tc", "start_s", "end_s", "note"],
    )
    write_edl(bundle, target / "timeline.edl")
    write_fcpxml(bundle, target / "timeline.fcpxml", target if copy else root)
    (target / "bundle.json").write_text(json.dumps(bundle, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (target / "README.md").write_text(readme(bundle, copied), encoding="utf-8")
    return {
        "target": str(target),
        "shots": len(bundle["shots"]),
        "videos": sum(r["status"] == "video" for r in bundle["shots"]),
        "copied_files": copied,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True, help="Пустая папка вне папки проекта или внутри plan/batches")
    parser.add_argument(
        "--copy",
        action="store_true",
        help="Скопировать оригиналы, клипы, кадры, промпты, WAV, карточки и песню в media/",
    )
    args = parser.parse_args()
    try:
        print(json.dumps(export(args.out, copy=args.copy), ensure_ascii=False, indent=2))
    except (ValueError, OSError, KeyError) as error:
        parser.exit(
            1,
            (
                str(error)
                if isinstance(error, ValueError) and not isinstance(error, json.JSONDecodeError)
                else "Ошибка данных проекта; сырой вывод скрыт."
            )
            + "\n",
        )


if __name__ == "__main__":
    main()
