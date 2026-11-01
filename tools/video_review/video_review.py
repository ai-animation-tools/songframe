"""Извлечение реальных кадров видео для анализа агентом; @link README.md."""

import argparse
import bisect
import json
import math
import subprocess
import sys
import tempfile
from fractions import Fraction
from io import BytesIO
from pathlib import Path

from PIL import Image, ImageOps

MAX_DURATION = 600
MAX_DECODED_FRAMES = 72_000
MAX_FRAMES = 32
TIMEOUT = 120
IMAGE_BUDGET = 16 * 1024 * 1024
IMAGE_FILE_BUDGET = 1024 * 1024


def run(command):
    """Бинарники берутся из PATH общего PythonLauncher, как у contact_sheet."""
    result = subprocess.run(command, stdin=subprocess.DEVNULL, capture_output=True, timeout=TIMEOUT)
    if result.returncode:
        raise ValueError("Ошибка обработки видео: " + result.stderr.decode(errors="replace")[-1200:])
    return result.stdout


def probe(video):
    base = ["ffprobe", "-v", "error", "-protocol_whitelist", "file", "-select_streams", "v:0"]
    info = json.loads(run([*base, "-show_streams", "-show_format", "-of", "json", str(video)]))
    streams = info.get("streams", [])
    if not streams:
        raise ValueError("В файле нет видеопотока.")
    stream = streams[0]
    try:
        duration = float(stream.get("duration") or info["format"]["duration"])
        fps = float(Fraction(stream.get("avg_frame_rate") or stream["r_frame_rate"]))
        width, height = int(stream["width"]), int(stream["height"])
    except (KeyError, TypeError, ValueError, ZeroDivisionError) as error:
        raise ValueError("Не удалось определить длительность, частоту или размер видео.") from error
    if not math.isfinite(duration) or not 0 < duration <= MAX_DURATION:
        raise ValueError(f"Длительность видео должна быть больше нуля и не больше {MAX_DURATION} секунд.")
    if not math.isfinite(fps) or not 0 < fps <= 120 or min(width, height) <= 0:
        raise ValueError("Недопустимые параметры видеопотока: нужны размер и частота до 120 кадров/с.")
    # Читаем реальные PTS: индекс/fps дал бы ложные таймкоды на VFR и на последнем кадре.
    data = json.loads(run([
        *base, "-read_intervals", f"%+{MAX_DURATION + 1}", "-show_frames",
        "-show_entries", "frame=best_effort_timestamp_time", "-of", "json", str(video),
    ]))
    frames = data.get("frames", [])
    if not frames or len(frames) > MAX_DECODED_FRAMES:
        raise ValueError(f"Нужно от 1 до {MAX_DECODED_FRAMES} декодированных кадров.")
    try:
        timestamps = [float(frame["best_effort_timestamp_time"]) for frame in frames]
    except (KeyError, TypeError, ValueError) as error:
        raise ValueError("У кадров отсутствуют корректные временные метки.") from error
    if any(not math.isfinite(value) for value in timestamps):
        raise ValueError("Некорректные временные метки кадров.")
    timestamps = [value - timestamps[0] for value in timestamps]
    if any(left >= right for left, right in zip(timestamps, timestamps[1:])) or timestamps[-1] > MAX_DURATION:
        raise ValueError("Временные метки кадров должны возрастать и укладываться в 600 секунд.")
    return duration, timestamps


def select_frames(timestamps):
    last = timestamps[-1]
    targets = [position * 0.5 for position in range(math.floor(last / 0.5) + 1)] + [last]
    if len(targets) > MAX_FRAMES:
        targets = [last * position / (MAX_FRAMES - 1) for position in range(MAX_FRAMES)]
    selected = {0, len(timestamps) - 1}
    for target in targets:
        right = bisect.bisect_left(timestamps, target)
        choices = [index for index in (right - 1, right) if 0 <= index < len(timestamps)]
        selected.add(min(choices, key=lambda index: (abs(timestamps[index] - target), index)))
    return sorted(selected)


def budget_images(paths, total_budget=IMAGE_BUDGET, per_file_budget=IMAGE_FILE_BUDGET):
    """Упаковывает только приватные копии, сохраняя порядок и ID; @link README.md."""
    paths = [Path(path) for path in paths]
    if not paths or total_budget <= 0 or per_file_budget <= 0:
        raise ValueError("Для изображений проверки нужен положительный лимит размера.")
    limit = min(per_file_budget, total_budget // len(paths))
    if limit <= 0:
        raise ValueError("Лимит размера изображений проверки слишком мал.")
    packed = []
    for path in paths:
        if 0 < path.stat().st_size <= limit:
            packed.append(path)
            continue
        with Image.open(path) as original:
            image = original.convert("RGB")
        # PNG в пределах бюджета не трогаем: точные пиксели нужны для технических сверок.
        # Для крупных копий сначала снижаем качество JPEG, затем размер, не выбрасывая кадры и опоры.
        while True:
            payload = None
            for quality in (85, 70, 55):
                buffer = BytesIO()
                image.save(buffer, format="JPEG", quality=quality, optimize=True)
                if buffer.tell() <= limit:
                    payload = buffer.getvalue()
                    break
            if payload is not None:
                target = path.with_suffix(".jpg")
                target.write_bytes(payload)
                path.unlink()  # Исходный PNG удаляется только после успешной записи его приватной JPEG-копии.
                packed.append(target)
                break
            if image.size == (1, 1):
                raise ValueError("Лимит размера изображений проверки слишком мал даже для минимального JPEG.")
            width, height = image.size
            image.thumbnail((max(1, width * 3 // 4), max(1, height * 3 // 4)), Image.Resampling.LANCZOS)
    sizes = [path.stat().st_size for path in packed]
    if any(not 0 < size <= limit for size in sizes) or sum(sizes) > total_budget:
        raise ValueError("Изображения проверки превышают лимит размера.")
    return packed


def extract(video, out, references=(), image_budget=IMAGE_BUDGET):
    if type(image_budget) is not int or not 0 < image_budget <= IMAGE_BUDGET:
        raise ValueError(f"Бюджет изображений должен быть целым числом от 1 до {IMAGE_BUDGET} байт.")
    video, out = Path(video), Path(out)
    if not video.is_absolute() or not out.is_absolute():
        raise ValueError("Пути --video и --out должны быть абсолютными.")
    video, out = video.resolve(), out.resolve()
    if not video.is_file():
        raise ValueError("Локальный файл видео не найден.")
    if out.exists() and (not out.is_dir() or any(out.iterdir())):
        raise ValueError("Папка результата должна быть новой или пустой.")
    if not out.parent.is_dir():
        raise ValueError("Родительская папка результата не найдена.")
    if len(references) > 20:
        raise ValueError("Допускается не больше 20 опорных изображений.")
    reference_paths = [Path(path) for path in references]
    if any(not path.is_absolute() or not path.is_file() for path in reference_paths):
        raise ValueError("Опоры должны быть существующими изображениями с абсолютными путями.")
    duration, timestamps = probe(video)
    indices = select_frames(timestamps)
    # Все результаты готовятся отдельно: ошибка декодирования не оставляет неполный отчёт.
    with tempfile.TemporaryDirectory(prefix="video-review-", dir=out.parent) as temporary:
        stage = Path(temporary)
        selection = "+".join(f"eq(n\\,{index})" for index in indices)
        scale = "scale=w='min(960,iw)':h='min(960,ih)':force_original_aspect_ratio=decrease"
        run([
            "ffmpeg", "-v", "error", "-nostdin", "-n", "-protocol_whitelist", "file", "-i", str(video),
            "-map", "0:v:0", "-an", "-vf", f"select={selection},{scale}", "-fps_mode", "vfr",
            "-frames:v", str(len(indices)), "-start_number", "1", str(stage / "F%03d.png"),
        ])
        files = sorted(stage.glob("F*.png"))
        if len(files) != len(indices) or any(path.stat().st_size == 0 for path in files):
            raise ValueError("Не удалось извлечь все выбранные кадры.")
        reference_report = []
        for number, source in enumerate(reference_paths, 1):
            name = f"R{number:03d}.png"
            # EXIF-ориентация применяется к копии; оплаченный оригинал остаётся нетронутым.
            with Image.open(source) as original:
                image = ImageOps.exif_transpose(original).convert("RGB")
                image.thumbnail((960, 960), Image.Resampling.LANCZOS)
                image.save(stage / name)
            reference_report.append(
                {"id": f"R{number:03d}", "source_path": str(source.resolve()), "path": str(out / name)}
            )
        packed = budget_images(
            files + [stage / Path(item["path"]).name for item in reference_report], total_budget=image_budget
        )
        frame_files = packed[:len(files)]
        for item, path in zip(reference_report, packed[len(files):]):
            item["path"] = str(out / path.name)
        report = {
            "schema_version": 1,
            "duration_seconds": duration,
            "references": reference_report,
            "frames": [
                {"id": path.stem, "time_seconds": timestamps[index], "path": str(out / path.name)}
                for index, path in zip(indices, frame_files)
            ],
        }
        (stage / "manifest.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        if out.exists():
            out.rmdir()  # Непустая папка не удаляется, в том числе если изменилась во время извлечения.
        stage.rename(out)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", help="Контекст журнала приложения; извлечение не зависит от проекта")
    parser.add_argument("--video", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--reference", action="append", default=[], help="Абсолютный путь опоры; до 20 повторений")
    parser.add_argument(
        "--image-budget-bytes", type=int, default=IMAGE_BUDGET,
        help="Локальный бюджет всех изображений в байтах: от 1 до 16 МиБ, по умолчанию 16 МиБ",
    )
    parser.add_argument("--json", action="store_true", help="Вывести JSON отчёта (формат вывода по умолчанию)")
    args = parser.parse_args()
    try:
        report = extract(args.video, args.out, args.reference, image_budget=args.image_budget_bytes)
        print(json.dumps(report, ensure_ascii=False))
    except (OSError, ValueError, subprocess.TimeoutExpired) as error:
        print(f"Не удалось подготовить кадры: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
