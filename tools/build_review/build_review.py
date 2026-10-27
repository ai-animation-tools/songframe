"""Сборка временной пробы по параметрам; @link README.md"""

import sys
from pathlib import Path

# После переноса точка запуска находится на два уровня ниже корня проекта.
# Полные импорты tools.* работают и при прямом запуске файла из любой папки.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))


import argparse
import json
import os
import subprocess
import tempfile
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation

from tools.asset_package.asset_package import local_file, sha
from tools.common import ROOT, decoded_audio_duration
from tools.scene_registry.scene_registry import load
from tools.scene_registry.scene_registry import shots as registry_shots

FPS = 30
TRANSITIONS = {"fade", "fadeblack", "fadewhite", "dissolve", "wipeleft", "wiperight"}


def frames(value):
    return int(Decimal(str(value)).to_integral_value(rounding=ROUND_HALF_UP))


def seconds(value):
    return format((Decimal(value) / FPS).quantize(Decimal(".000000001")), "f")


def source(root, name):
    path = (root / name).resolve()
    if not path.is_file():
        raise ValueError("Нет входного файла пробы.")
    return path


def destination(root, name):
    path = Path(name).resolve()
    if not (
        path.is_relative_to((root / "plan/batches").resolve())
        or path.is_relative_to(Path(tempfile.gettempdir()).resolve())
    ):
        raise ValueError("Пробу сохранять только в plan/batches или /tmp.")
    if any(path.is_relative_to((root / folder).resolve()) for folder in ("assets", "source", "plan/animatic")):
        raise ValueError("Проба не может заменять assets, исходники или аниматик.")
    if path.suffix.lower() != ".mp4":
        raise ValueError("Выход пробы должен быть MP4.")
    return path


def run(argv):
    result = subprocess.run(argv, stdin=subprocess.DEVNULL, capture_output=True)
    if result.returncode:
        raise ValueError("Ошибка обработки медиа; исходники не изменены, сырой вывод скрыт.")
    return result.stdout


def probe(path):
    return json.loads(run(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)]))


def integer(value, name, minimum=0):
    if type(value) is not int or value < minimum:
        raise ValueError("Неверное целое поле " + name + ".")
    return value


def prepare(spec, root=ROOT):
    root = Path(root).resolve()
    registry_digest = sha(root / "plan/scenes.json")
    data = load(root)
    registry = registry_shots(data)
    by_id = {s["id"]: s for s in registry}
    if spec.get("schema_version") != 1 or not spec.get("shots"):
        raise ValueError("Неизвестная схема или пустая проба.")
    if set(spec) - {"schema_version", "shots", "audio", "transitions"}:
        raise ValueError("Неизвестные поля пробы.")
    if set(spec.get("audio", {})) - {"path", "start_frame"}:
        raise ValueError("Неизвестные поля audio.")
    items = []
    seen = set()
    receipt = None
    for config in spec["shots"]:
        if set(config) - {
            "scene",
            "path",
            "kind",
            "source_start_frame",
            "source_end_frame_exclusive",
            "speed",
            "hold_first_frames",
            "hold_last_frames",
        }:
            raise ValueError("Неизвестные параметры участка пробы.")
        if "kind" in config and "path" not in config:
            raise ValueError("kind задаётся только вместе с явным path.")
        sid = config["scene"]
        if sid not in by_id or sid in seen:
            raise ValueError("Неизвестная или повторяющаяся сцена пробы.")
        seen.add(sid)
        scene = by_id[sid]
        package_path = root / "assets/shots" / sid / "manifest.json"
        if "path" in config:
            kind = config.get("kind", "video")
            if kind not in ("video", "card"):
                raise ValueError("kind должен быть video или card.")
            path = source(root, config["path"])
            origin = "explicit"
        elif package_path.is_file():
            package = json.loads(package_path.read_text())
            edit = package["accepted_edit"]
            kind = "video"
            origin = "accepted_edit"
            path = local_file(package_path.parent, edit["video"]["path"])
            if (
                package["shot"] != sid
                or sha(path) != edit["video"]["sha256"]
                or edit["fps"] != FPS
                or edit["frames"] != scene["frames"]
            ):
                raise ValueError(sid + ": принятый монтаж не совпадает с реестром или хешем.")
        else:
            kind = "card"
            origin = "registry_card"
            path = source(root, f"plan/animatic/cards/{sid}.png")
            if receipt is None:
                receipt = json.loads((root / "plan/animatic/cards/manifest.json").read_text())
                if receipt["registry_sha256"] != sha(root / "plan/scenes.json") or any(
                    sha(source(root, p)) != digest for p, digest in receipt.get("reference_hashes", {}).items()
                ):
                    raise ValueError("Карточки устарели; обновите представления сцен.")
            if receipt["cards"][sid]["sha256"] != sha(path):
                raise ValueError("Карточка изменена.")
        start = integer(config.get("source_start_frame", 0), "source_start_frame")
        end = integer(
            config.get("source_end_frame_exclusive", start + scene["frames"]), "source_end_frame_exclusive", 1
        )
        if end <= start:
            raise ValueError("Конец участка должен быть больше начала.")
        speed = Decimal(str(config.get("speed", "1")))
        if not speed.is_finite() or speed <= 0:
            raise ValueError("Скорость должна быть положительной.")
        first = integer(config.get("hold_first_frames", 0), "hold_first_frames")
        last = integer(config.get("hold_last_frames", 0), "hold_last_frames")
        if kind == "card" and (start != 0 or speed != 1):
            raise ValueError(
                "Для карточки задавайте длительность через source_end_frame_exclusive без обрезки и скорости."
            )
        motion = frames(Decimal(end - start) / speed)
        if motion < 1:
            raise ValueError("Участок после изменения скорости короче кадра.")
        if kind == "video":
            video = next(s for s in probe(path)["streams"] if s["codec_type"] == "video")
            rate = video.get("r_frame_rate")
            available = (
                int(video["nb_frames"])
                if rate == "30/1" and str(video.get("nb_frames", "")).isdigit()
                else frames(Decimal(video["duration"]) * FPS)
            )
            if end > available:
                raise ValueError(sid + ": выбранный участок выходит за пределы видео.")
        filters = []
        if kind == "video":
            filters += [
                f"fps={FPS}",
                f"trim=start_frame={start}:end_frame={end}",
                f"setpts=(PTS-STARTPTS)/{speed}",
                f"fps={FPS}",
                "tpad=stop_mode=clone:stop=1",
                f"trim=end_frame={motion}",
            ]
        else:
            filters += [f"trim=end_frame={motion}"]
        # Скорость и удержания явные; масштаб сохраняет пропорции и добавляет
        # поля. Последний кадр дополняет только округление длительности до сетки.
        filters += [
            f"setpts=N/({FPS}*TB)",
            "scale=1920:1080:force_original_aspect_ratio=decrease:flags=lanczos",
            "pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black",
            "setsar=1",
            "format=yuv420p",
            f"tpad=start_mode=clone:start={first}:stop_mode=clone:stop={last}",
            f"settb=1/{FPS}",
        ]
        items.append(
            {
                "id": sid,
                "kind": kind,
                "origin": origin,
                "path": str(path),
                "sha256": sha(path),
                "source_start_frame": start,
                "source_end_frame_exclusive": end,
                "source_interval_seconds": [float(seconds(start)), float(seconds(end))],
                "speed": str(speed),
                "motion_frames": motion,
                "hold_first_frames": first,
                "hold_last_frames": last,
                "duration_change_seconds": float(seconds(motion - (end - start))),
                "frames": motion + first + last,
                "filter": ",".join(filters),
            }
        )
    transitions = spec.get("transitions", [])
    by_after = {}
    for transition in transitions:
        if set(transition) - {"after", "type", "frames"}:
            raise ValueError("Неизвестные параметры перехода.")
        after = transition["after"]
        count = integer(transition["frames"], "transition.frames", 1)
        if after in by_after or after not in [s["id"] for s in items[:-1]] or transition["type"] not in TRANSITIONS:
            raise ValueError("Неизвестный, повторный или последний стык перехода.")
        by_after[after] = {"type": transition["type"], "frames": count}
    # Суммарные перекрытия не могут поглотить средний план целиком.
    for index, item in enumerate(items):
        left = by_after.get(items[index - 1]["id"], {}).get("frames", 0) if index else 0
        right = by_after.get(item["id"], {}).get("frames", 0)
        if left + right >= item["frames"]:
            raise ValueError("Переходы поглощают весь план.")
    total = sum(s["frames"] for s in items) - sum(t["frames"] for t in by_after.values())
    positions = [next(i for i, s in enumerate(registry) if s["id"] == item["id"]) for item in items]
    audio = spec.get("audio", {})
    if "start_frame" not in audio and positions != list(range(positions[0], positions[0] + len(positions))):
        raise ValueError("Для непоследовательных сцен явно задайте audio.start_frame.")
    audio_start = integer(audio.get("start_frame", by_id[items[0]["id"]]["start_frame"]), "audio.start_frame")
    track = source(root, audio.get("path", "source/track.mp3"))
    meta = probe(track)
    if not any(s["codec_type"] == "audio" for s in meta["streams"]):
        raise ValueError("Нет звуковой дорожки.")
    duration = decoded_audio_duration(track)
    # Конец песни округляется к ближайшему кадру так же, как монтажная шкала.
    # Остаток до этой границы дополняется тишиной, но более длинная нехватка запрещена.
    if audio_start + total > frames(duration * FPS):
        raise ValueError("Участок песни короче пробы.")
    audio_filter = (
        f"aresample=44100,atrim=start_sample={audio_start * 1470}:end_sample={(audio_start + total) * 1470},"
        f"asetpts=PTS-STARTPTS,apad=whole_len={total * 1470},atrim=end_sample={total * 1470}"
    )
    if sha(root / "plan/scenes.json") != registry_digest:
        raise ValueError("Реестр изменился при подготовке пробы.")
    return {
        "schema_version": 1,
        "scene_registry_sha256": registry_digest,
        "fps": FPS,
        "resolution": [1920, 1080],
        "shots": items,
        "transitions": by_after,
        "total_frames": total,
        "duration_seconds": float(seconds(total)),
        "audio": {
            "path": str(track),
            "sha256": sha(track),
            "start_frame": audio_start,
            "end_frame_exclusive": audio_start + total,
            "filter": audio_filter,
        },
        "transform": (
            "Масштаб с сохранением пропорций и полями; все временные преобразования записаны по кадрам при 30 FPS."
        ),
    }


def build(spec, output, root=ROOT, plan_only=False):
    root = Path(root).resolve()
    output = destination(root, output)
    manifest = output.with_suffix(".json")
    if output.exists() or manifest.exists():
        raise ValueError("Проба или её манифест уже существуют; нужен новый выходной путь.")
    plan = prepare(spec, root)
    if plan_only:
        return plan
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".review-", dir=output.parent) as directory:
        temporary = Path(directory)
        argv = ["ffmpeg", "-v", "error", "-nostdin", "-n"]
        graph = []
        count = len(plan["shots"])
        for index, item in enumerate(plan["shots"]):
            if item["kind"] == "card":
                argv += ["-loop", "1", "-framerate", str(FPS)]
            argv += ["-i", item["path"]]
            graph.append(f"[{index}:v]" + item["filter"] + f"[s{index}]")
        argv += ["-i", plan["audio"]["path"]]
        current = "s0"
        length = plan["shots"][0]["frames"]
        cuts = []
        for index in range(1, count):
            previous = plan["shots"][index - 1]["id"]
            transition = plan["transitions"].get(previous)
            label = f"join{index}"
            overlap = transition["frames"] if transition else 0
            cut = length - overlap
            if transition:
                graph.append(
                    f"[{current}][s{index}]xfade=transition={transition['type']}:duration={seconds(overlap)}:offset={seconds(cut)}[{label}]"
                )
            else:
                graph.append(f"[{current}][s{index}]concat=n=2:v=1:a=0,settb=1/{FPS}[{label}]")
            cuts.append(
                {
                    "after": previous,
                    "start_frame": cut,
                    "end_frame_exclusive": length,
                    "song_frame": plan["audio"]["start_frame"] + cut,
                    "type": transition["type"] if transition else "cut",
                }
            )
            current = label
            length += plan["shots"][index]["frames"] - overlap
        graph.append(f"[{count}:a]" + plan["audio"]["filter"] + "[music]")
        target = temporary / "review.mp4"
        argv += [
            "-filter_complex_threads",
            "1",
            "-filter_complex",
            ";".join(graph),
            "-map",
            f"[{current}]",
            "-map",
            "[music]",
            "-frames:v",
            str(plan["total_frames"]),
            "-r",
            str(FPS),
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
            "-video_track_timescale",
            "15360",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-ar",
            "44100",
            "-ac",
            "2",
            "-map_metadata",
            "-1",
            "-movflags",
            "+faststart",
            str(target),
        ]
        run(argv)
        meta = probe(target)
        video = next(s for s in meta["streams"] if s["codec_type"] == "video")
        music = next(s for s in meta["streams"] if s["codec_type"] == "audio")
        if (int(video["nb_frames"]), video["r_frame_rate"], video["width"], video["height"]) != (
            plan["total_frames"],
            "30/1",
            1920,
            1080,
        ):
            raise ValueError("Проба имеет неверную длину или формат.")
        if abs(Decimal(music["duration"]) - Decimal(plan["total_frames"]) / FPS) > Decimal(".003"):
            raise ValueError("Песня в пробе имеет неверную длину.")
        for item in [*plan["shots"], plan["audio"]]:
            if sha(Path(item["path"])) != item["sha256"]:
                raise ValueError("Вход изменился во время сборки.")
        if sha(root / "plan/scenes.json") != plan["scene_registry_sha256"]:
            raise ValueError("Реестр изменился во время сборки пробы.")
        plan.update(
            cuts=cuts,
            video_sha256=sha(target),
            output=str(output),
            status="review_pending",
            ffmpeg_version=run(["ffmpeg", "-version"]).decode().splitlines()[0],
            encoding={
                "video_codec": "libx264",
                "preset": "fast",
                "crf": 18,
                "threads": 2,
                "filter_complex_threads": 1,
                "pixel_format": "yuv420p",
                "video_track_timescale": 15360,
                "audio_codec": "aac",
                "audio_bitrate": "192k",
                "sample_rate": 44100,
                "channels": 2,
            },
        )
        # Публикация через link не перезапишет результат параллельного запуска.
        metadata = temporary / "review.json"
        metadata.write_text(json.dumps(plan, ensure_ascii=False, indent=2) + "\n")
        os.link(target, output)
        try:
            os.link(metadata, manifest)
        except OSError:
            output.unlink()
            raise
    return plan


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--shots", nargs="+")
    group.add_argument("--spec", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--plan-only", action="store_true")
    args = parser.parse_args()
    try:
        spec = (
            json.loads(args.spec.read_text())
            if args.spec
            else {"schema_version": 1, "shots": [{"scene": sid} for sid in args.shots]}
        )
        result = build(spec, args.output, plan_only=args.plan_only)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except (ValueError, KeyError, TypeError, OSError, StopIteration, InvalidOperation):
        import sys

        error = sys.exc_info()[1]
        parser.exit(
            1,
            (
                str(error)
                if type(error) is ValueError and not isinstance(error, json.JSONDecodeError)
                else "Ошибка параметров или медиа пробы; сырой вывод скрыт."
            )
            + "\n",
        )


if __name__ == "__main__":
    main()
