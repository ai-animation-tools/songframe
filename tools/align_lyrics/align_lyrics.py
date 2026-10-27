"""Черновик разметки песни: выравнивание точного текста по словам локального распознавания; @link README.md

Вход: `source/text.md` проекта и JSON распознавания от transcribe_local (сегменты со словами и временем).
Выход: `plan/audio/timing.json` версии 2 с оценкой начала и конца каждой строки песни, частями по заголовкам
в квадратных скобках и промежутками без вокала. Все оценки помечены как не подтверждённые на слух;
подтверждает их пользователь в редакторе таймингов приложения, уже подтверждённые строки инструмент не трогает.
"""

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from difflib import SequenceMatcher
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from tools.common import ROOT, TOOLS_ROOT, read_json

TIMING_PATH = Path("plan/audio/timing.json")
TEXT_PATH = Path("source/text.md")
TRACK_PATH = Path("source/track.mp3")
# Веса хранятся отдельно от приложения; умолчание CLI совпадает с каталогом данных ОС.
MODEL_DATA = (
    Path(os.environ.get("LOCALAPPDATA", str(Path.home() / "AppData/Local")))
    if sys.platform == "win32"
    else Path(os.environ.get("XDG_DATA_HOME", str(Path.home() / ".local/share")))
)
DEFAULT_MODEL = (
    Path(os.environ["SONGFRAME_MODEL_DIR"])
    if os.environ.get("SONGFRAME_MODEL_DIR")
    else MODEL_DATA / "songframe/models/faster-whisper-medium"
)
HEADER = re.compile(r"^\[([^\[\]]+)\]$")
SECTION_TITLE = re.compile(
    r"^(?:[а-яёa-z]+\s+){0,2}(?:припев|куплет|бридж|интро|вступление|аутро|проигрыш|кода|финал|запев)(?:\s+(?:[а-яёa-z]+|\d+)){0,2}[:.]?$",
    re.IGNORECASE,
)
WORD = re.compile(r"[а-яёa-z0-9]+", re.IGNORECASE)
UNVERIFIED = "сверка на слух не выполнена"
MIN_LENGTH = 0.3


def lyric_lines(text):
    """Строки песни с физическими номерами (1-based): пропускаются пустые строки и заголовки частей."""
    lines = []
    for number, raw in enumerate(text.lstrip("\ufeff").splitlines(), start=1):
        line = raw.strip()
        section = HEADER.fullmatch(line)
        if ("[" in line or "]" in line) and (not section or not section[1].strip()):
            raise ValueError(
                f"Строка {number}: заголовок секции должен быть отдельной строкой вида [Припев], "
                "с непустым названием и обеими скобками."
            )
        if re.match(r"^(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|```|~~~)", line) or SECTION_TITLE.fullmatch(line):
            raise ValueError(
                f"Строка {number}: слова песни пишутся обычным текстом, секции — как [Припев], "
                "без Markdown и нумерации."
            )
        if line and not section:
            lines.append((number, line))
    return lines


def text_sections(text):
    """Части по заголовкам: имя и физические номера первой и последней строки.

    Строки до первого заголовка идут в «Без названия».
    """
    sections, current = [], None
    for number, raw in enumerate(text.lstrip("\ufeff").splitlines(), start=1):
        line = raw.strip()
        header = HEADER.match(line)
        if header:
            current = {"name": header.group(1).strip(), "first": None, "last": None}
            sections.append(current)
        elif line:
            if current is None:
                current = {"name": "Без названия", "first": None, "last": None}
                sections.append(current)
            current["first"] = current["first"] or number
            current["last"] = number
    return [s for s in sections if s["first"] is not None]


def tokens(text):
    return [w.lower().replace("ё", "е") for w in WORD.findall(text)]


def recognized_words(recognition):
    """Слова распознавания с временем; сегмент без слов делится по словам равномерно."""
    words = []
    for segment in recognition.get("segments", []):
        items = segment.get("words") or []
        if items:
            for item in items:
                for token in tokens(item.get("word", "")):
                    words.append((token, float(item["start"]), float(item["end"])))
            continue
        parts = tokens(segment.get("text", ""))
        if not parts:
            continue
        start, end = float(segment["start"]), float(segment["end"])
        step = (end - start) / len(parts)
        for index, token in enumerate(parts):
            words.append((token, round(start + index * step, 3), round(start + (index + 1) * step, 3)))
    return words


def similarity(a, b):
    if a == b:
        return 1.0
    return SequenceMatcher(None, a, b).ratio()


def align(lyric, recognized, threshold=0.72, gap=-0.5, mismatch=-0.8):
    """Глобально выравнивает последовательности слов.

    Для каждого слова текста возвращает индекс слова распознавания или None.
    """
    n, m = len(lyric), len(recognized)
    score = [[0.0] * (m + 1) for _ in range(n + 1)]
    move = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(1, n + 1):
        score[i][0] = i * gap
        move[i][0] = 1
    for j in range(1, m + 1):
        score[0][j] = j * gap
        move[0][j] = 2
    for i in range(1, n + 1):
        word = lyric[i - 1]
        for j in range(1, m + 1):
            sim = similarity(word, recognized[j - 1][0])
            diagonal = score[i - 1][j - 1] + (2 * sim if sim >= threshold else mismatch)
            up = score[i - 1][j] + gap
            left = score[i][j - 1] + gap
            best = max(diagonal, up, left)
            score[i][j] = best
            move[i][j] = 0 if best == diagonal else (1 if best == up else 2)
    mapping = [None] * n
    i, j = n, m
    while i > 0 and j > 0:
        step = move[i][j]
        if step == 0:
            if similarity(lyric[i - 1], recognized[j - 1][0]) >= threshold:
                mapping[i - 1] = j - 1
            i, j = i - 1, j - 1
        elif step == 1:
            i -= 1
        else:
            j -= 1
    return mapping


def estimate_lines(lines, recognized, duration):
    """Оценки строк: по сопоставленным словам, для пустых строк интерполяция между соседями."""
    all_tokens, owners = [], []
    for index, (_, text) in enumerate(lines):
        for token in tokens(text):
            all_tokens.append(token)
            owners.append(index)
    mapping = align(all_tokens, recognized)
    estimates = []
    for index, (number, text) in enumerate(lines):
        matched = [
            recognized[mapping[k]] for k in range(len(all_tokens)) if owners[k] == index and mapping[k] is not None
        ]
        total = owners.count(index)
        if matched:
            estimates.append(
                {
                    "number": number,
                    "text": text,
                    "start": min(w[1] for w in matched),
                    "end": max(w[2] for w in matched),
                    "matched": len(matched),
                    "total": total,
                }
            )
        else:
            estimates.append({"number": number, "text": text, "start": None, "end": None, "matched": 0, "total": total})
    _interpolate(estimates, duration)
    for previous, current in zip(estimates, estimates[1:]):
        if previous["end"] > current["start"]:
            middle = round((previous["end"] + current["start"]) / 2, 3)
            previous["end"], current["start"] = middle, middle
    # Строки идут по порядку текста без наложений и не короче минимума: короткая строка без слов
    # сдвигает следующие, а не накладывается на них.
    cursor = 0.0
    for item in estimates:
        item["start"] = round(max(item["start"], cursor), 3)
        item["end"] = round(max(item["end"], item["start"] + MIN_LENGTH), 3)
        cursor = item["end"]
    return estimates


def _interpolate(estimates, duration):
    index = 0
    while index < len(estimates):
        if estimates[index]["start"] is not None:
            index += 1
            continue
        stop = index
        while stop < len(estimates) and estimates[stop]["start"] is None:
            stop += 1
        left = estimates[index - 1]["end"] if index > 0 else 0.0
        right = estimates[stop]["start"] if stop < len(estimates) else duration
        weights = [max(1, e["total"]) for e in estimates[index:stop]]
        span = max(0.0, right - left)
        cursor = left
        for item, weight in zip(estimates[index:stop], weights):
            length = span * weight / sum(weights)
            item["start"], item["end"] = round(cursor, 3), round(cursor + length, 3)
            cursor += length
        index = stop


def track_duration(path):
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(path)],
        capture_output=True,
        text=True,
    )
    try:
        return round(float(probe.stdout.strip()), 3)
    except ValueError:
        return None


def build_timing(text, recognition, duration, previous=None, source=str(TRACK_PATH), sha256=None):
    """Собирает timing.json v2: строки с оценками и признаком подтверждения, части по заголовкам и промежутки."""
    lines = lyric_lines(text)
    if not lines:
        raise ValueError("В source/text.md нет строк песни.")
    words = recognized_words(recognition)
    if not words:
        raise ValueError("В распознавании нет слов: проверьте JSON transcribe_local.")
    estimates = estimate_lines(lines, words, duration)
    kept = {
        line["source_line"]: line
        for line in (previous or {}).get("lines", [])
        if line.get("verified") and isinstance(line.get("source_line"), int)
    }
    result_lines = []
    for index, item in enumerate(estimates, start=1):
        old = kept.get(item["number"])
        if old:
            result_lines.append({**old, "id": index})
            continue
        if item["matched"] == 0:
            note = f"Слова не распознаны, оценка по соседним строкам; {UNVERIFIED}."
        elif item["matched"] < item["total"]:
            note = f"Совпало {item['matched']} из {item['total']} слов; {UNVERIFIED}."
        else:
            note = f"Совпали все {item['total']} слов; {UNVERIFIED}."
        result_lines.append(
            {
                "id": index,
                "source_line": item["number"],
                "start": round(item["start"], 3),
                "end": round(item["end"], 3),
                "verified": False,
                "note": note,
            }
        )
    by_number = {line["source_line"]: line for line in result_lines}
    sections = build_sections(text_sections(text), by_number, duration)
    verified = sum(1 for line in result_lines if line.get("verified"))
    status = (
        "Разметка подтверждена на слух."
        if verified == len(result_lines)
        else (
            f"Автоматическая разметка по локальному распознаванию ({recognition.get('model', 'модель не указана')}); "
            f"подтверждено на слух {verified} из {len(result_lines)} строк."
        )
    )
    return {
        "version": 2,
        "status": status,
        "source": source,
        "sha256": sha256,
        "duration_decoded": recognition.get("decoded_duration", duration),
        "duration_container": duration,
        "clock": "Секунды от начала декодированного звука, не SMPTE",
        "lines": result_lines,
        "sections": sections,
    }


def build_sections(parts, by_number, duration, gap_threshold=2.0):
    """Части по заголовкам текста плюс вступление, промежутки длиннее порога и хвост без вокала."""
    sections = []
    named = []
    for part in parts:
        members = [by_number[n] for n in range(part["first"], part["last"] + 1) if n in by_number]
        if members:
            named.append(
                {
                    "name": part["name"],
                    "start": min(line["start"] for line in members),
                    "end": max(line["end"] for line in members),
                    "note": f"строки {members[0]['id']}–{members[-1]['id']}",
                }
            )
    cursor = 0.0
    for index, part in enumerate(named):
        if part["start"] - cursor >= gap_threshold:
            name = "Вступление" if index == 0 else f"Проигрыш после «{named[index - 1]['name']}»"
            sections.append(
                {"name": name, "start": round(cursor, 3), "end": round(part["start"], 3), "note": "без вокала"}
            )
        sections.append(
            {"name": part["name"], "start": round(part["start"], 3), "end": round(part["end"], 3), "note": part["note"]}
        )
        cursor = part["end"]
    if duration and duration - cursor >= gap_threshold:
        sections.append(
            {"name": "Финал без вокала", "start": round(cursor, 3), "end": round(duration, 3), "note": "до конца трека"}
        )
    return sections


def missing_model_files(model):
    """Проверяем комплект без чтения весов: словарь менялся между поколениями Whisper."""

    def present(name):
        file = model / name
        return file.is_file() and file.stat().st_size > 0

    missing = [name for name in ("model.bin", "config.json", "tokenizer.json") if not present(name)]
    if not any(present(name) for name in ("vocabulary.txt", "vocabulary.json")):
        missing.append("vocabulary.txt или vocabulary.json")
    return missing


def transcribe(root, model, output, device="auto"):
    """Прямой локальный запуск: наличие unshare не означает разрешение user namespaces. @link README.md"""
    script = TOOLS_ROOT / "tools/transcribe_local/transcribe_local.py"
    command = [
        sys.executable,
        "-B",
        str(script),
        "--project",
        str(root),
        "--model",
        str(model),
        "--output",
        str(output),
        "--allow-network",
        "--device",
        device,
    ]
    completed = subprocess.run(command, stdin=subprocess.DEVNULL)
    if completed.returncode:
        raise ValueError(f"Распознавание завершилось с кодом {completed.returncode}.")
    return read_json(output)


def main():
    parser = argparse.ArgumentParser(description="Черновик разметки песни по локальному распознаванию.")
    parser.add_argument(
        "--recognition", type=Path, help="Готовый JSON transcribe_local; без него запускается распознавание"
    )
    parser.add_argument(
        "--model", type=Path, default=DEFAULT_MODEL, help=f"Папка модели faster-whisper (по умолчанию {DEFAULT_MODEL})"
    )
    parser.add_argument(
        "--device", choices=("auto", "cpu"), default="auto", help="Автовыбор CUDA или принудительный CPU"
    )
    parser.add_argument("--output", type=Path, help=f"Куда записать разметку (по умолчанию {TIMING_PATH} проекта)")
    parser.add_argument(
        "--keep-recognition", type=Path, help="Сохранить JSON распознавания по этому пути (вне проекта)"
    )
    parser.add_argument(
        "--reset", action="store_true", help="Не переносить подтверждённые строки из существующей разметки"
    )
    parser.add_argument("--dry-run", action="store_true", help="Показать оценки, файлы не записывать")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    root = ROOT
    text_path, track = root / TEXT_PATH, root / TRACK_PATH
    if not text_path.is_file() or not track.is_file():
        parser.exit(2, f"Нужны {TEXT_PATH} и {TRACK_PATH} в проекте {root}.\n")
    duration = track_duration(track)
    if duration is None:
        parser.exit(2, "ffprobe не смог определить длительность трека.\n")
    try:
        text = text_path.read_text(encoding="utf-8-sig")
        # Ошибка формата должна появиться до долгого распознавания, а не после него.
        lyric_lines(text)
        if args.recognition:
            recognition = read_json(args.recognition)
            if not isinstance(recognition, dict):
                raise ValueError(f"Не удалось прочитать распознавание: {args.recognition}")
        else:
            missing = missing_model_files(args.model)
            if missing:
                raise ValueError(
                    f"Модель неполна ({args.model}): нет {', '.join(missing)}. Установите модель отдельно: "
                    "инструкция в README комплекса, раздел «Модель распознавания». Проверьте папку --model."
                )
            keep = args.keep_recognition or Path(tempfile.gettempdir()) / f"songframe-recognition-{root.name}.json"
            recognition = transcribe(root, args.model, keep, args.device)
            print(f"Распознавание сохранено: {keep}", file=sys.stderr)
        output = args.output or root / TIMING_PATH
        previous = read_json(output) if output.is_file() and not args.reset else None
        timing = build_timing(
            text,
            recognition,
            duration,
            previous if isinstance(previous, dict) else None,
            sha256=hashlib.sha256(track.read_bytes()).hexdigest(),
        )
    except ValueError as error:
        parser.exit(1, f"{error}\n")
    if not args.dry_run:
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(timing, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if args.json:
        print(
            json.dumps(
                {
                    "output": str(output),
                    "written": not args.dry_run,
                    "lines": len(timing["lines"]),
                    "sections": len(timing["sections"]),
                    "status": timing["status"],
                },
                ensure_ascii=False,
            )
        )
        return
    text_lines = text_path.read_text(encoding="utf-8").splitlines()
    for line in timing["lines"]:
        print(
            f"{line['id']:3d} {line['start']:7.2f}–{line['end']:7.2f} {'✓' if line.get('verified') else ' '} "
            f"{text_lines[line['source_line'] - 1].strip()}  [{line.get('note', '')}]"
        )
    print(f"\n{timing['status']}" + ("" if args.dry_run else f"\nЗаписано: {output}"))


if __name__ == "__main__":
    main()
