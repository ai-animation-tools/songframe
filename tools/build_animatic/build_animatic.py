"""Детерминированная сборка единственного latest; @link README.md"""

import sys
from pathlib import Path

# После переноса точка запуска находится на два уровня ниже корня проекта.
# Полные импорты tools.* работают и при прямом запуске файла из любой папки.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))


import argparse
import hashlib
import json
import re
import subprocess
import tempfile
import time
from decimal import ROUND_HALF_UP, Decimal

from tools.animatic_cache.animatic_cache import ArtifactCache, sha
from tools.common import ROOT, decoded_audio_duration
from tools.project_inputs import project_inputs, project_inputs_match
from tools.scene_registry.scene_registry import load as load_scenes
from tools.scene_registry.scene_registry import load_project
from tools.scene_registry.scene_registry import shots as registry_shots

FPS = 30
ENCODE = [
    "-an",
    "-c:v",
    "libx264",
    "-preset",
    "fast",
    "-crf",
    "18",
    "-threads",
    "2",
    "-pix_fmt",
    "yuv420p",
    "-r",
    str(FPS),
    "-video_track_timescale",
    "15360",
    "-map_metadata",
    "-1",
]


def run(args):
    result = subprocess.run(args, capture_output=True)
    if result.returncode:
        raise ValueError(
            "Команда обработки медиа завершилась с ошибкой: " + result.stderr.decode(errors="replace")[-1200:]
        )
    return result.stdout


def frame(seconds):
    return int((Decimal(seconds) * FPS).to_integral_value(rounding=ROUND_HALF_UP))


def read_shots(root):
    """Сборка читает канонический реестр, а не его Markdown-представления."""
    return registry_shots(load_scenes(root))


def local(root, name):
    path = (root / name).resolve()
    if not path.is_relative_to(root.resolve()) or not path.is_file():
        raise ValueError(f"Нет допустимого входного файла: {name}")
    return path


def prepare_plan(root=ROOT):
    root = Path(root).resolve()
    project = load_project(root)
    registry = load_scenes(root)
    shots = registry_shots(registry)
    receipt_path = root / "plan/animatic/cards/manifest.json"
    receipt = json.loads(receipt_path.read_text()) if receipt_path.is_file() else None
    receipt_checked = False
    # Папка с манифестом означает готовую сцену. Повреждённая готовая сцена
    # останавливает сборку: её нельзя молча заменить карточкой.
    for shot in shots:
        folder = root / "assets/shots" / shot["id"]
        manifest = folder / "manifest.json"
        if manifest.is_file():
            package = json.loads(manifest.read_text())
            edit = package["accepted_edit"]
            source = local(folder, edit["video"]["path"])
            if (
                package["shot"] != shot["id"]
                or sha(source) != edit["video"]["sha256"]
                or edit["fps"] != FPS
                or edit["frames"] != shot["frames"]
            ):
                raise ValueError(f"{shot['id']}: принятый монтаж не совпадает с окном или хешем.")
            shot.update(media="video", path=str(source.relative_to(root)))
        else:
            source = local(root, f"plan/animatic/cards/{shot['id']}.png")
            if receipt is None:
                raise ValueError("Нет манифеста карточек; обновите представления реестра сцен.")
            if not receipt_checked:
                if (
                    receipt["registry_sha256"] != sha(root / "plan/scenes.json")
                    or not project_inputs_match(
                        receipt,
                        project,
                    )
                ) or any(
                    sha(local(root, name)) != digest for name, digest in receipt.get("reference_hashes", {}).items()
                ):
                    raise ValueError("Карточки устарели; обновите представления реестра сцен.")
                receipt_checked = True
            entry = receipt["cards"][shot["id"]]
            if entry["sha256"] != sha(source):
                raise ValueError("Карточки устарели; обновите представления реестра сцен.")
            shot.update(media="card", path=str(source.relative_to(root)))
            # Сохраняем только реально нарисованные источники карточки, а не новые кандидаты других попыток.
            # @link ../update_scene_views/update_scene_views.py approved_keyframes, expected_cards
            if entry.get("keyframes"):
                shot["keyframes"] = entry["keyframes"]
                shot["card_sources"] = {item["path"]: item["sha256"] for item in entry["keyframes"]}
            else:
                references = set(shot.get("refs", [])) | {shot.get("card", {}).get("primary_reference")}
                shot["card_sources"] = {
                    registry["references"][ref]["path"]: receipt["reference_hashes"][
                        registry["references"][ref]["path"]
                    ]
                    for ref in sorted(ref for ref in references if ref in registry["references"])
                }
            for name, digest in shot["card_sources"].items():
                if sha(local(root, name)) != digest:
                    raise ValueError("Источники карточки изменились; обновите представления реестра сцен.")
            if entry.get("last"):
                # Кадровый аниматик: карточка из принятых опор показывает переход от первой к последней.
                last = local(root, entry["last"]["path"])
                if entry["last"]["sha256"] != sha(last):
                    raise ValueError("Карточки устарели; обновите представления реестра сцен.")
                shot.update(media="keyframes", path_last=str(last.relative_to(root)), sha256_last=sha(last))
        shot["sha256"] = sha(source)
    track = local(root, "source/track.mp3")
    duration = decoded_audio_duration(track)
    if abs(duration - Decimal(shots[-1]["end"])) > Decimal(1) / FPS:
        raise ValueError("Конец монтажного списка не совпадает с длительностью песни.")
    return shots, {"path": "source/track.mp3", "sha256": sha(track)}


def probe(path):
    return json.loads(
        run(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-show_chapters", "-of", "json", str(path)])
    )


def segment(cache, root, shot, toolchain):
    # Готовый клип уже содержит всю принятую обработку. Здесь только единый
    # формат кодирования, без повторной обрезки, изменения скорости и удержаний.
    vf = "setpts=PTS-STARTPTS,setsar=1"
    if shot["media"] in ("card", "keyframes"):
        vf = "scale=1920:1080:flags=lanczos,setsar=1,setpts=PTS-STARTPTS"
    recipe = {
        "schema": 2,
        "sha256": shot["sha256"],
        "media": shot["media"],
        "frames": shot["frames"],
        "filter": vf,
        "encode": ENCODE,
        "toolchain": toolchain,
    }
    if shot["media"] == "keyframes":
        recipe["sha256_last"] = shot["sha256_last"]

    def produce(path):
        source = root / shot["path"]
        if shot["media"] == "video":
            stream = next(s for s in probe(source)["streams"] if s["codec_type"] == "video")
            if (stream["width"], stream["height"], stream["r_frame_rate"], int(stream["nb_frames"])) != (
                1920,
                1080,
                "30/1",
                shot["frames"],
            ):
                raise ValueError(f"{shot['id']}: принятый клип имеет неверный формат или число кадров.")
        if shot["media"] == "keyframes":
            # Удержание первой опоры, растворение в последнюю, удержание последней: 40 / 20 / 40 процентов окна.
            total = shot["frames"]
            offset = max(0, min(round(total * 0.4), total - 1))
            fade = max(1, min(round(total * 0.2), total - offset))
            graph = (
                "[0:v]scale=1920:1080:flags=lanczos,setsar=1,format=yuv420p[a];"
                "[1:v]scale=1920:1080:flags=lanczos,setsar=1,format=yuv420p[b];"
                f"[a][b]xfade=transition=fade:duration={fade / FPS:.6f}:"
                f"offset={offset / FPS:.6f},setpts=PTS-STARTPTS[v]"
            )
            run(
                [
                    "ffmpeg",
                    "-v",
                    "error",
                    "-nostdin",
                    "-n",
                    "-threads",
                    "2",
                    "-loop",
                    "1",
                    "-framerate",
                    str(FPS),
                    "-t",
                    f"{(offset + fade) / FPS:.6f}",
                    "-i",
                    str(source),
                    "-loop",
                    "1",
                    "-framerate",
                    str(FPS),
                    "-t",
                    f"{(total - offset) / FPS:.6f}",
                    "-i",
                    str(root / shot["path_last"]),
                    "-filter_complex",
                    graph,
                    "-map",
                    "[v]",
                    *ENCODE,
                    "-frames:v",
                    str(total),
                    str(path),
                ]
            )
        else:
            inputs = (
                ["-i", str(source)]
                if shot["media"] == "video"
                else ["-loop", "1", "-framerate", str(FPS), "-i", str(source)]
            )
            run(
                [
                    "ffmpeg",
                    "-v",
                    "error",
                    "-nostdin",
                    "-n",
                    "-threads",
                    "2",
                    *inputs,
                    "-map",
                    "0:v:0",
                    "-vf",
                    vf,
                    *ENCODE,
                    "-frames:v",
                    str(shot["frames"]),
                    str(path),
                ]
            )
        stream = next(s for s in probe(path)["streams"] if s["codec_type"] == "video")
        if (stream["width"], stream["height"], stream["r_frame_rate"], int(stream["nb_frames"])) != (
            1920,
            1080,
            "30/1",
            shot["frames"],
        ):
            raise ValueError("Производный фрагмент не соответствует монтажному окну.")
        return {"frames": shot["frames"]}

    return cache.obtain("segments", recipe, ".mp4", produce)[0]


def media_counts(shots):
    """Сводка входов: клипы, текстовые карточки и карточки принятых опор."""
    return {
        "video": sum(s["media"] == "video" for s in shots),
        "cards": sum(s["media"] == "card" for s in shots),
        "keyframes": sum(s["media"] == "keyframes" for s in shots),
    }


def build(root=ROOT, plan_only=False):
    root = Path(root).resolve()
    registry_digest = sha(root / "plan/scenes.json")
    project = load_project(root)
    inputs = project_inputs(project, animatic=True)
    video_name = project["animatic_video"]
    shots, track = prepare_plan(root)
    if plan_only:
        return {"shots": len(shots), **media_counts(shots), "build_started": False}
    started = time.monotonic()
    cache = ArtifactCache(root / "plan/animatic/.cache")
    toolchain = run(["ffmpeg", "-version"]).decode()
    parts = []
    for shot in shots:
        parts.append(segment(cache, root, shot, toolchain))
        print(shot["id"], "из кэша" if cache.events[-1]["hit"] else "подготовлена", flush=True)
    base = root / "plan/animatic"
    # До успешного завершения кодирования и проверок прежний latest остаётся
    # доступным. Временные файлы и кэш не являются дополнительными версиями.
    with tempfile.TemporaryDirectory(prefix="build-", dir=cache.directory) as temp:
        work = Path(temp)
        listing = work / "concat.txt"
        listing.write_text("".join("file '" + str(p).replace("'", "'\\''") + "'\n" for p in parts))
        # Спецсимволы названия не должны менять структуру FFmetadata.
        title = project["name"] + " — текущий аниматик"
        title = re.sub(r"([\\=;#])", r"\\\1", title)
        chapters = [";FFMETADATA1", "title=" + title]
        for shot in shots:
            chapters += [
                "[CHAPTER]",
                "TIMEBASE=1/30",
                f"START={frame(shot['start'])}",
                f"END={frame(shot['end'])}",
                "title=" + shot["id"],
            ]
        (work / "chapters.ffmeta").write_text("\n".join(chapters) + "\n")
        video = work / video_name
        run(
            [
                "ffmpeg",
                "-v",
                "error",
                "-nostdin",
                "-n",
                "-f",
                "concat",
                "-safe",
                "0",
                "-i",
                str(listing),
                "-i",
                str(root / track["path"]),
                "-i",
                str(work / "chapters.ffmeta"),
                "-map",
                "0:v:0",
                "-map",
                "1:a:0",
                "-map_metadata",
                "2",
                "-map_chapters",
                "2",
                # Входной MP3 может быть моно или с другой частотой: выход всегда соответствует контракту сборки.
                "-c:v",
                "copy",
                "-c:a",
                "aac",
                "-ac",
                "2",
                "-ar",
                "44100",
                "-threads",
                "1",
                "-b:a",
                "192k",
                "-af",
                "asetpts=PTS-STARTPTS",
                "-movflags",
                "+faststart",
                str(video),
            ]
        )
        info = probe(video)
        v = next(s for s in info["streams"] if s["codec_type"] == "video")
        a = next(s for s in info["streams"] if s["codec_type"] == "audio")
        if (
            (v["width"], v["height"], v["r_frame_rate"], int(v["nb_frames"]))
            != (1920, 1080, "30/1", frame(shots[-1]["end"]))
            or len(info["chapters"]) != len(shots)
            or a["channels"] != 2
            or a["sample_rate"] != "44100"
        ):
            raise ValueError("Полный результат имеет неверный формат, длину или главы.")
        if abs(Decimal(a["duration"]) - Decimal(shots[-1]["end"])) > Decimal(".003"):
            raise ValueError("Звуковая дорожка обрезана или продлена.")
        run(["ffmpeg", "-v", "error", "-threads", "2", "-i", str(video), "-f", "null", "-"])
        for shot in shots:
            if (
                sha(root / shot["path"]) != shot["sha256"]
                or shot["media"] == "keyframes"
                and sha(root / shot["path_last"]) != shot["sha256_last"]
            ):
                raise ValueError("Вход изменился во время сборки.")
        for shot in shots:
            for name, digest in shot.get("card_sources", {}).items():
                if sha(local(root, name)) != digest:
                    raise ValueError("Источник карточки изменился во время сборки.")
        if sha(root / "plan/scenes.json") != registry_digest:
            raise ValueError("Реестр сцен изменился во время сборки.")
        if sha(root / track["path"]) != track["sha256"]:
            raise ValueError("Исходная песня изменилась во время сборки.")
        # Смена провайдера во время кодирования не меняет входы текущего монтажа.
        if project_inputs(load_project(root), animatic=True) != inputs:
            raise ValueError("Данные проекта изменились во время сборки.")
        result = {
            "schema_version": 1,
            "version": "latest",
            "path_base": "project_root",
            "resolution": [1920, 1080],
            "fps": FPS,
            "total_frames": int(v["nb_frames"]),
            "video_duration": float(v["duration"]),
            "source_audio": track["path"],
            "source_audio_sha256": track["sha256"],
            "source_audio_duration": float(a["duration"]),
            "scene_registry_sha256": registry_digest,
            "project_inputs": inputs,
            "shots": shots,
            "source_hashes": {s["path"]: s["sha256"] for s in shots}
            | {s["path_last"]: s["sha256_last"] for s in shots if s["media"] == "keyframes"}
            | {track["path"]: track["sha256"]}
            | {name: digest for shot in shots for name, digest in shot.get("card_sources", {}).items()},
            "video_file": video_name,
            "toolchain_sha256": hashlib.sha256(toolchain.encode()).hexdigest(),
            "video_sha256": sha(video),
        }
        (work / "manifest.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
        (work / "README.md").write_text(
            f"# Текущий полный аниматик\n\n[Видео]({video_name}) · [Манифест](manifest.json).\n\n"
            "Сборка: страница «Аниматик» приложения. "
            "Источники — принятые монтажные клипы сцен, карточки и песня; "
            "правила находятся в [описании](../README.md).\n"
        )
        # Переносим только три файла готовой сборки по @link README.md.
        # Список склейки и описание глав нужны FFmpeg только во временной папке.
        latest = base / "latest"
        latest.mkdir(exist_ok=True)
        previous_manifest = latest / "manifest.json"
        previous_name = (
            json.loads(previous_manifest.read_text()).get("video_file") if previous_manifest.is_file() else None
        )
        for name in (video_name, "manifest.json", "README.md"):
            (work / name).replace(latest / name)
        # Прежняя HTML-страница больше не входит в сборку; убираем её после успешной проверки.
        (latest / "index.html").unlink(missing_ok=True)
        # При смене настроенного имени прежний результат не становится архивом.
        # Удаляем только известный MP4 из манифеста, после публикации новой сборки.
        if (
            previous_name
            and previous_name != video_name
            and Path(previous_name).name == previous_name
            and previous_name.endswith(".mp4")
        ):
            (latest / previous_name).unlink(missing_ok=True)
    return {
        "status": "passed",
        "video_sha256": result["video_sha256"],
        "shots": len(shots),
        **media_counts(shots),
        "segments_created": sum(not e["hit"] for e in cache.events),
        "segments_reused": sum(e["hit"] for e in cache.events),
        "seconds": round(time.monotonic() - started, 3),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plan-only", action="store_true", help="Проверить входы без записи и кодирования.")
    args = parser.parse_args()
    try:
        result = build(plan_only=args.plan_only)
        if not args.plan_only:
            from tools.project_views.project_views import Sources, documents

            for name, text in documents(Sources()).items():
                path = ROOT / name
                if not path.exists() or path.read_text() != text:
                    path.write_text(text)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except (ValueError, KeyError, OSError) as error:
        parser.exit(1, str(error) + "\n")


if __name__ == "__main__":
    main()
