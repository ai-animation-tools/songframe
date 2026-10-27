"""Точный WAV липсинка и его рецепт из исходной песни по разметке или заданным границам; @link README.md"""

import sys
from pathlib import Path

# После переноса точка запуска находится на два уровня ниже корня проекта.
# Полные импорты tools.* работают и при прямом запуске файла из любой папки.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))


import argparse
import hashlib
import json
import subprocess
import wave
from decimal import ROUND_HALF_UP, Decimal

from tools.common import ROOT, sha
from tools.scene_registry.scene_registry import load

SAMPLE_RATE = 44100
CHANNELS = 2
SAMPLE_WIDTH = 2
PROCESSING = (
    "Декодирование полного MP3 в PCM s16le, затем срез по номерам сэмплов; "
    "без фильтров, нормализации и изменения скорости."
)


def decode(source):
    """Весь трек в PCM s16le 44,1 кГц стерео, как в принятых рецептах."""
    result = subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-nostdin",
            "-i",
            str(source),
            "-f",
            "s16le",
            "-acodec",
            "pcm_s16le",
            "-ac",
            str(CHANNELS),
            "-ar",
            str(SAMPLE_RATE),
            "pipe:1",
        ],
        stdin=subprocess.DEVNULL,
        capture_output=True,
    )
    if result.returncode or not result.stdout:
        raise ValueError("Не удалось декодировать песню: " + result.stderr.decode(errors="replace")[-300:])
    return result.stdout


def sample_index(seconds):
    return int((Decimal(str(seconds)) * SAMPLE_RATE).to_integral_value(rounding=ROUND_HALF_UP))


def speech_lines(root, shot):
    """Строки разметки, пересекающие окно плана; оценки могут быть неподтверждёнными."""
    registry = load(root)
    scene = next((s for s in registry["scenes"] if s["id"] == shot), None)
    if scene is None:
        raise ValueError(f"{shot}: план отсутствует в реестре сцен.")
    start, end = scene["start_frame"] / registry["fps"], scene["end_frame_exclusive"] / registry["fps"]
    timing = json.loads((root / "plan/audio/timing.json").read_text(encoding="utf-8"))
    lines = [line for line in timing.get("lines", []) if line["end"] > start and line["start"] < end]
    text = (root / "source/text.md").read_text(encoding="utf-8").splitlines()
    for line in lines:
        number = line.get("source_line")
        line["text"] = text[number - 1].strip() if isinstance(number, int) and 0 < number <= len(text) else None
    return registry["audio"]["path"], (start, end), lines, bool(scene.get("lipsync"))


def propose(window, lines, lead, tail, min_seconds):
    if not lines:
        raise ValueError("В окне плана нет строк разметки; задайте границы явно через --start и --end.")
    start = min(line["start"] for line in lines) - lead
    end = max(line["end"] for line in lines) + tail
    if end - start < min_seconds:
        end = start + min_seconds
    return max(0.0, round(start, 3)), round(end, 3)


def cut(root, source, start, end, out, shot=None, lines=(), name="speech.wav"):
    root = Path(root).resolve()
    source_path = (root / source).resolve()
    if not source_path.is_file():
        raise ValueError("Исходная песня не найдена: " + str(source))
    first, last = sample_index(start), sample_index(end)
    if last <= first:
        raise ValueError("Конец среза должен быть больше начала.")
    pcm = decode(source_path)
    frame_bytes = CHANNELS * SAMPLE_WIDTH
    total = len(pcm) // frame_bytes
    if last > total:
        raise ValueError(f"Срез выходит за конец песни: {total / SAMPLE_RATE:.3f} с.")
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    target = out / name
    if target.exists():
        raise ValueError("Файл WAV уже существует; выберите другую папку или имя.")
    with wave.open(str(target), "wb") as stream:
        stream.setnchannels(CHANNELS)
        stream.setsampwidth(SAMPLE_WIDTH)
        stream.setframerate(SAMPLE_RATE)
        stream.writeframes(pcm[first * frame_bytes : last * frame_bytes])
    recipe = {
        "schema_version": 1,
        "source": {"path": str(Path(source)), "sha256": sha(source_path), "bytes": source_path.stat().st_size},
        "source_interval_seconds": [first / SAMPLE_RATE, last / SAMPLE_RATE],
        "interval_end_exclusive": True,
        "sample_rate": SAMPLE_RATE,
        "channels": CHANNELS,
        "sample_width_bytes": SAMPLE_WIDTH,
        "start_sample": first,
        "end_sample_exclusive": last,
        "output": {"path": name, "sha256": sha(target), "bytes": target.stat().st_size},
        "processing": PROCESSING,
    }
    if shot:
        recipe["shot"] = shot
    if lines:
        recipe["timing_lines"] = [
            {
                "id": line["id"],
                "source_line": line.get("source_line"),
                "text": line.get("text"),
                "start": line["start"],
                "end": line["end"],
                "note": line.get("note"),
            }
            for line in lines
        ]
    (out / "audio-recipe.json").write_text(json.dumps(recipe, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return recipe


def verify(root, recipe_path):
    """Повторяет срез по рецепту во временной памяти и сверяет SHA-256 с записанным."""
    recipe = json.loads(Path(recipe_path).read_text(encoding="utf-8"))
    root = Path(root).resolve()
    pcm = decode(root / recipe["source"]["path"])
    frame_bytes = recipe["channels"] * recipe["sample_width_bytes"]
    chunk = pcm[recipe["start_sample"] * frame_bytes : recipe["end_sample_exclusive"] * frame_bytes]
    import io

    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as stream:
        stream.setnchannels(recipe["channels"])
        stream.setsampwidth(recipe["sample_width_bytes"])
        stream.setframerate(recipe["sample_rate"])
        stream.writeframes(chunk)
    digest = hashlib.sha256(buffer.getvalue()).hexdigest()
    expected = recipe["output"]["sha256"]
    # Контейнер WAV может отличаться служебными полями другого записывающего инструмента;
    # содержимое PCM сверяется отдельно и является смыслом рецепта.
    stored = Path(recipe_path).parent / recipe["output"]["path"]
    pcm_match = None
    if stored.is_file():
        result = subprocess.run(
            [
                "ffmpeg",
                "-v",
                "error",
                "-nostdin",
                "-i",
                str(stored),
                "-f",
                "s16le",
                "-acodec",
                "pcm_s16le",
                "-ac",
                str(recipe["channels"]),
                "-ar",
                str(recipe["sample_rate"]),
                "pipe:1",
            ],
            stdin=subprocess.DEVNULL,
            capture_output=True,
        )
        pcm_match = result.returncode == 0 and result.stdout == chunk
    return {
        "recipe": str(recipe_path),
        "expected": expected,
        "actual": digest,
        "match": digest == expected,
        "pcm_match": pcm_match,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    p = sub.add_parser("cut")
    p.add_argument("shot")
    p.add_argument("--out", required=True, help="Папка для speech.wav и audio-recipe.json")
    p.add_argument("--start", type=float, help="Начало среза, с; по умолчанию по разметке")
    p.add_argument("--end", type=float, help="Конец среза, с, исключительно")
    p.add_argument("--lead", type=float, default=0.5, help="Запас до первой строки при выборе по разметке")
    p.add_argument("--tail", type=float, default=0.5, help="Запас после последней строки")
    p.add_argument(
        "--min-seconds", type=float, default=0, help="Минимальная длина среза, например под длительность запроса"
    )
    p.add_argument("--json", action="store_true")
    p = sub.add_parser("verify")
    p.add_argument("recipe")
    args = parser.parse_args()
    try:
        if args.action == "verify":
            result = verify(ROOT, args.recipe)
            print(json.dumps(result, ensure_ascii=False, indent=2))
            if not (result["match"] or result["pcm_match"]):
                raise SystemExit(1)
            return
        source, window, lines, lipsync = speech_lines(ROOT, args.shot)
        if not lipsync:
            print(f"Предупреждение: у {args.shot} в реестре lipsync=false.", file=sys.stderr)
        if args.start is None or args.end is None:
            start, end = propose(window, lines, args.lead, args.tail, args.min_seconds)
        else:
            start, end = args.start, args.end
        recipe = cut(ROOT, source, start, end, args.out, args.shot, lines)
        if args.json:
            print(json.dumps(recipe, ensure_ascii=False, indent=2))
        else:
            print(
                f"{args.shot}: окно {window[0]:.3f}–{window[1]:.3f} с; "
                f"срез {recipe['source_interval_seconds'][0]:.3f}–{recipe['source_interval_seconds'][1]:.3f} с "
                f"({recipe['end_sample_exclusive'] - recipe['start_sample']} сэмплов), "
                f"{recipe['output']['path']} в {args.out}"
            )
            for line in lines:
                print(
                    f"  строка {line.get('source_line')}: {line['start']}–{line['end']} с — "
                    f"{line.get('text') or '?'}; {line.get('note') or ''}"
                )
            print("Границы строк — оценки разметки; подтвердите их на слух до генерации.")
    except (ValueError, OSError, KeyError) as error:
        parser.exit(
            1,
            (
                str(error)
                if isinstance(error, ValueError) and not isinstance(error, json.JSONDecodeError)
                else "Ошибка файлов или аудио; сырой вывод скрыт."
            )
            + "\n",
        )


if __name__ == "__main__":
    main()
