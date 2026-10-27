"""Техническая сводка полученного видео: параметры, контактный лист, границы, превью; @link README.md"""

import sys
from pathlib import Path

# После переноса точка запуска находится на два уровня ниже корня проекта.
# Полные импорты tools.* работают и при прямом запуске файла из любой папки.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))


import argparse
import json
import subprocess
import tempfile
from decimal import Decimal

from PIL import Image, ImageDraw, ImageFont

from tools.common import ROOT

FONT = Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf")
SAMPLES = 12
COLUMNS = 4
CELL = (480, 270)


def run(argv):
    result = subprocess.run(argv, stdin=subprocess.DEVNULL, capture_output=True)
    if result.returncode:
        raise ValueError("Ошибка обработки медиа: " + result.stderr.decode(errors="replace")[-600:])
    return result.stdout


def probe(path):
    info = json.loads(run(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)]))
    video = next((s for s in info["streams"] if s["codec_type"] == "video"), None)
    if video is None:
        raise ValueError("В файле нет видеопотока.")
    rate = Decimal(video["r_frame_rate"].split("/")[0]) / Decimal(video["r_frame_rate"].split("/")[1])
    duration = Decimal(video.get("duration") or info["format"].get("duration") or "0")
    frames = (
        int(video["nb_frames"])
        if str(video.get("nb_frames", "")).isdigit()
        else int((duration * rate).to_integral_value())
    )
    return {
        "width": int(video["width"]),
        "height": int(video["height"]),
        "r_frame_rate": video["r_frame_rate"],
        "fps": float(rate),
        "duration": float(duration),
        "nb_frames": frames,
        "codec": video.get("codec_name"),
        "pix_fmt": video.get("pix_fmt"),
        "audio_streams": sum(s["codec_type"] == "audio" for s in info["streams"]),
        "bytes": int(info["format"].get("size", 0)),
    }


def extract(video, indices, directory, scale=None):
    """Один проход FFmpeg: выбранные кадры в PNG по порядку индексов."""
    selection = "+".join(f"eq(n\\,{index})" for index in sorted(set(indices)))
    filters = [f"select={selection}"]
    if scale:
        filters.append(f"scale={scale[0]}:{scale[1]}:force_original_aspect_ratio=decrease")
    run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-nostdin",
            "-y",
            "-i",
            str(video),
            "-vf",
            ",".join(filters),
            "-fps_mode",
            "vfr",
            "-f",
            "image2",
            str(directory / "frame-%03d.png"),
        ]
    )
    files = sorted(directory.glob("frame-*.png"))
    return dict(zip(sorted(set(indices)), files))


def font(size):
    try:
        return ImageFont.truetype(str(FONT), size)
    except OSError:
        return ImageFont.load_default()


def sheet(frames, fps, target):
    rows = -(-len(frames) // COLUMNS)
    canvas = Image.new("RGB", (COLUMNS * CELL[0], rows * (CELL[1] + 26)), "#171E24")
    draw = ImageDraw.Draw(canvas)
    label_font = font(16)
    for position, (index, path) in enumerate(frames):
        image = Image.open(path).convert("RGB")
        image.thumbnail(CELL)
        x = (position % COLUMNS) * CELL[0] + (CELL[0] - image.width) // 2
        y = (position // COLUMNS) * (CELL[1] + 26)
        canvas.paste(image, (x, y))
        seconds = index / fps if fps else 0
        draw.text(
            ((position % COLUMNS) * CELL[0] + 6, y + CELL[1] + 4),
            f"кадр {index} · {seconds:.2f} с",
            font=label_font,
            fill="#EDF0F2",
        )
    canvas.save(target)


def compare(keyframe, actual, caption, target):
    """Опора слева, фактический кадр справа; без оценки, только для просмотра."""
    left, right = Image.open(keyframe).convert("RGB"), Image.open(actual).convert("RGB")
    height = 540
    left = left.resize((round(left.width * height / left.height), height))
    right = right.resize((round(right.width * height / right.height), height))
    canvas = Image.new("RGB", (left.width + right.width + 30, height + 40), "#171E24")
    canvas.paste(left, (10, 30))
    canvas.paste(right, (left.width + 20, 30))
    draw = ImageDraw.Draw(canvas)
    draw.text((10, 6), caption + ": опора", font=font(16), fill="#E8B975")
    draw.text((left.width + 20, 6), caption + ": фактический кадр", font=font(16), fill="#E8B975")
    canvas.save(target)


def resolve(package=None, work_dir=None, video=None, root=ROOT):
    root = Path(root).resolve()
    keyframes = []
    if package is not None:
        package = Path(package)
        package = (package if package.is_absolute() else root / package).resolve()
        workflow = json.loads((package / "workflow.json").read_text(encoding="utf-8"))
        work_dir = package / workflow.get("request_dir", "request")
        keyframes = [k for k in workflow.get("keyframes", []) if k.get("approved") and k.get("path")]
        keyframes = [{**k, "file": package / k["path"]} for k in keyframes]
        base = package
    if video is None:
        if work_dir is None:
            raise ValueError("Укажите пакет, папку попытки или файл видео.")
        work_dir = Path(work_dir)
        work_dir = (work_dir if work_dir.is_absolute() else root / work_dir).resolve()
        attempt = json.loads((work_dir / "attempt.json").read_text(encoding="utf-8"))
        if attempt.get("status") != "downloaded" or not attempt.get("downloads"):
            raise ValueError("Попытка ещё не скачана: сводка делается по полученному файлу.")
        video = work_dir / attempt["downloads"][0]["path"]
        base = package or work_dir
    else:
        video = Path(video).resolve()
        base = video.parent
    if not video.is_file():
        raise ValueError("Файл видео не найден.")
    return video, base, keyframes


def summarize(video, out, keyframes=(), preview=True):
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    media = probe(video)
    total = media["nb_frames"]
    if total < 1:
        raise ValueError("Не удалось определить число кадров.")
    last = total - 1
    sample_indices = sorted({round(i * last / (SAMPLES - 1)) for i in range(SAMPLES)}) if last else [0]
    with tempfile.TemporaryDirectory(prefix="contact-") as temporary:
        small_dir = Path(temporary) / "small"
        small_dir.mkdir()
        small = extract(video, sample_indices, small_dir, CELL)
        sheet([(index, small[index]) for index in sample_indices], media["fps"], out / "contact-sheet.png")
        full_dir = Path(temporary) / "full"
        full_dir.mkdir()
        full = extract(video, [0, last], full_dir)
        Image.open(full[0]).save(out / "first-frame.png")
        Image.open(full[last]).save(out / "last-frame.png")
    files = {"contact_sheet": "contact-sheet.png", "first_frame": "first-frame.png", "last_frame": "last-frame.png"}
    comparisons = []
    for keyframe in keyframes:
        role = keyframe.get("role")
        if role in ("first", "last") and Path(keyframe["file"]).is_file():
            name = f"compare-{role}.png"
            compare(
                keyframe["file"],
                out / ("first-frame.png" if role == "first" else "last-frame.png"),
                f"{keyframe.get('id', role)} ({role})",
                out / name,
            )
            comparisons.append(name)
    if comparisons:
        files["comparisons"] = comparisons
    if preview:
        run(
            [
                "ffmpeg",
                "-v",
                "error",
                "-nostdin",
                "-y",
                "-i",
                str(video),
                "-vf",
                "setpts=PTS/2,scale=960:-2",
                "-an",
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-crf",
                "28",
                "-pix_fmt",
                "yuv420p",
                str(out / "preview-2x.mp4"),
            ]
        )
        files["preview_2x"] = "preview-2x.mp4"
    return {
        "video": str(video),
        "output_dir": str(out),
        "media": media,
        "sampled_frames": sample_indices,
        "files": files,
        "note": "Техническая сводка для просмотра; художественная оценка и принятие остаются за пользователем.",
    }


def table(report):
    media = report["media"]
    audio = (
        "нет" if not media["audio_streams"] else str(media["audio_streams"]) + " поток(а), в монтаже не используется"
    )
    lines = [
        "| Параметр | Значение |",
        "| --- | --- |",
        f"| Файл | {report['video']} |",
        f"| Кадр | {media['width']}×{media['height']}, {media['codec']}, {media['pix_fmt']} |",
        f"| Частота | {media['r_frame_rate']} ({media['fps']:.3f} кадр/с) |",
        f"| Длительность | {media['duration']:.3f} с, {media['nb_frames']} кадров |",
        f"| Звук | {audio} |",
        f"| Размер | {media['bytes'] / 1e6:.1f} МБ |",
        f"| Сводка | {report['output_dir']}: "
        + ", ".join(v if isinstance(v, str) else ", ".join(v) for v in report["files"].values())
        + " |",
    ]
    return "\n".join(lines) + "\n\nСтатус: ожидает просмотра пользователем."


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--package", help="Папка shot_workflow: видео из попытки, опоры для сравнения")
    source.add_argument("--work-dir", help="Папка попытки kling_request")
    source.add_argument("--video", help="Любой видеофайл")
    parser.add_argument("--out", help="Папка сводки; по умолчанию preview/ рядом с пакетом или видео")
    parser.add_argument("--no-preview", action="store_true", help="Не делать превью 2×")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    try:
        video, base, keyframes = resolve(args.package, args.work_dir, args.video)
        out = Path(args.out) if args.out else base / "preview"
        report = summarize(video, out, keyframes, preview=not args.no_preview)
        print(json.dumps(report, ensure_ascii=False, indent=2) if args.json else table(report))
    except (ValueError, OSError, KeyError) as error:
        parser.exit(
            1,
            (
                str(error)
                if isinstance(error, ValueError) and not isinstance(error, json.JSONDecodeError)
                else "Ошибка файлов или медиа; сырой вывод скрыт."
            )
            + "\n",
        )


if __name__ == "__main__":
    main()
