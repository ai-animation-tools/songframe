"""Черновик разметки песни: выравнивание точного текста по словам локального распознавания; @link README.md

Вход: `source/text.md` проекта и JSON распознавания от transcribe_local (сегменты со словами и временем).
Выход: `plan/audio/timing.json` версии 2 с оценкой начала и конца каждой строки песни, частями по заголовкам
в квадратных скобках и промежутками без вокала. Все оценки помечены как не подтверждённые на слух;
подтверждает их пользователь в редакторе таймингов приложения, уже подтверждённые строки инструмент не трогает.
"""

import argparse
import hashlib
import json
import math
import os
import re
import subprocess
import sys
import tempfile
from difflib import SequenceMatcher
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from tools.common import ROOT, TOOLS_ROOT, read_json, write_json_atomic

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
TIME_EPSILON = 1e-9


def is_auto_line_note(note):
    """Только полная системная фраза заменяется новой; пользовательский хвост и похожее начало сохраняем."""
    return (
        re.fullmatch(
            r"(?:Совпало [0-9]+ из [0-9]+ слов|Совпали все [0-9]+ слов|"
            r"Слова не распознаны, оценка по соседним строкам|"
            r"Границы уточнены по выделенному вокалу и исходному тексту); " + re.escape(UNVERIFIED) + r"\.",
            note,
        )
        is not None
    )


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
    """Берём только настоящие времена слов: длительность сегмента не задаёт границы его слов."""
    words = []
    for segment in recognition.get("segments", []):
        if (
            not all(
                isinstance(segment.get(key), (int, float)) and math.isfinite(segment[key]) for key in ("start", "end")
            )
            or segment["start"] < 0
            or segment["end"] < segment["start"]
        ):
            raise ValueError("В распознавании есть неверные границы сегмента.")
        # Whisper иногда возвращает нулевые интервалы на тишине; они не являются границами слов.
        if segment["end"] == segment["start"]:
            continue
        items = segment.get("words") or []
        if items:
            for item in items:
                if (
                    not all(
                        isinstance(item.get(key), (int, float)) and math.isfinite(item[key]) for key in ("start", "end")
                    )
                    or item["start"] < 0
                    or item["end"] < item["start"]
                ):
                    raise ValueError("В распознавании есть неверные границы слова.")
                if item["end"] == item["start"]:
                    continue
                for token in tokens(item.get("word", "")):
                    words.append((token, float(item["start"]), float(item["end"])))
            continue
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
    """Оценки строк по сопоставленным словам; без совпадений строка остаётся без границ."""
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
    # Отсутствие совпадения — не найденная строка, а не оценка от нуля/соседей.
    # Сопоставленные границы тоже не растягиваем до произвольного минимума.
    for item in estimates:
        if item["start"] is not None and (
            item["matched"] < min(2, item["total"])
            or item["matched"] / max(1, item["total"]) < 0.4
            or item["end"] - item["start"] < MIN_LENGTH - TIME_EPSILON
            or item["end"] > duration + 0.001
        ):
            item["start"] = item["end"] = None
    return estimates


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


def timing_candidates(recognition, source_numbers, assigned, duration):
    """Кандидаты проверяются отдельно: их пересечения не делают подтверждённую карту ошибочной."""
    values = recognition.get("candidates", [])
    if not isinstance(values, list):
        raise ValueError("Список сомнительных кандидатов должен быть массивом.")
    result, seen = [], set()
    for item in values:
        if not isinstance(item, dict):
            raise ValueError("Неверный сомнительный кандидат строки.")
        number = item.get("source_line")
        if type(number) is not int or number not in source_numbers or number in seen:
            raise ValueError("Неверный или повторный source_line сомнительного кандидата.")
        seen.add(number)
        if (
            not all(type(item.get(key)) in (int, float) and math.isfinite(item[key]) for key in ("start", "end"))
            or item["start"] < 0
            or item["end"] <= item["start"]
            or item["end"] > duration + 0.5
            or not isinstance(item.get("reason"), str)
            or not item["reason"].strip()
            or ("note" in item and not isinstance(item["note"], str))
            or (
                "acoustic_score" in item
                and (
                    type(item["acoustic_score"]) not in (int, float)
                    or not math.isfinite(item["acoustic_score"])
                    or not 0 <= item["acoustic_score"] <= 1
                )
            )
        ):
            raise ValueError("В сомнительном кандидате есть неверные границы, оценка или причина сомнения.")
        # Сохранённая подтверждённая строка и новый принятый результат имеют приоритет над предложением.
        if number not in assigned:
            keys = ("source_line", "start", "end", "reason", "acoustic_score", "note")
            result.append({key: item[key] for key in keys if key in item})
    return result


def timing_line_order(lines, previous):
    """Сохраняем ручную очередь по физическим номерам и добавляем новые строки исходного текста."""
    numbers = [number for number, _ in lines]
    result = []
    previous_order = (previous or {}).get("line_order", [])
    if isinstance(previous_order, list):
        for number in previous_order:
            if type(number) is int and number in numbers and number not in result:
                result.append(number)
    return result + [number for number in numbers if number not in result]


def build_timing(text, recognition, duration, previous=None, source=str(TRACK_PATH), sha256=None):
    """Собирает timing.json v2: строки с оценками и признаком подтверждения, части по заголовкам и промежутки."""
    decoded_duration = recognition.get("decoded_duration", duration)
    # Готовый --recognition обходит transcribe_local: проверяем длительности и здесь до замены прежнего JSON.
    for value in (duration, decoded_duration):
        if type(value) not in (int, float) or not math.isfinite(value) or value <= 0:
            raise ValueError("В распознавании или треке указана неверная длительность.")
    lines = lyric_lines(text)
    if not lines:
        raise ValueError("В source/text.md нет строк песни.")
    acoustic = recognition.get("alignment") == "wav2vec2-large-xlsr-53-russian ONNX CTC"
    # Готовые CTC-строки не превращаем в фиктивные слова: их границы проверяются ниже целиком.
    words = recognized_words(recognition)
    estimates = estimate_lines(lines, [] if acoustic else words, duration)
    if acoustic:
        # CTC уже проверил исходную строку целиком: не делим её повторно на равномерные слова.
        by_source = {segment.get("source_line"): segment for segment in recognition.get("segments", [])}
        for item in estimates:
            segment = by_source.get(item["number"])
            if not segment or tokens(segment.get("text", "")) != tokens(item["text"]):
                item["start"] = item["end"] = None
            else:
                item["start"], item["end"] = float(segment["start"]), float(segment["end"])

    kept = {
        line["source_line"]: line
        for line in (previous or {}).get("lines", [])
        if line.get("verified") and isinstance(line.get("source_line"), int)
    }
    # Заметка кандидата — ручная правка текста, а не приём его границ.
    # Пользовательская заметка прежней строки имеет приоритет при повторной автоматической разметке.
    retained_notes = {
        item["source_line"]: item["note"]
        for item in (previous or {}).get("candidates", [])
        if isinstance(item.get("note"), str)
    }
    retained_notes.update(
        {
            item["source_line"]: item["note"]
            for item in (previous or {}).get("lines", [])
            if isinstance(item.get("note"), str) and item["note"].strip() and not is_auto_line_note(item["note"])
        }
    )
    result_lines = []
    for index, item in enumerate(estimates, start=1):
        old = kept.get(item["number"])
        if old:
            result_lines.append({**old, "id": index})
            continue
        if item["start"] is None:
            continue
        if recognition.get("alignment"):
            note = f"Границы уточнены по выделенному вокалу и исходному тексту; {UNVERIFIED}."
        elif item["matched"] == 0:
            continue
        elif item["matched"] < item["total"]:
            note = f"Совпало {item['matched']} из {item['total']} слов; {UNVERIFIED}."
        else:
            note = f"Совпали все {item['total']} слов; {UNVERIFIED}."
        note = retained_notes.get(item["number"], note)
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
    candidates = timing_candidates(
        recognition, {number for number, _ in lines}, {line["source_line"] for line in result_lines}, duration
    )
    for candidate in candidates:
        if candidate["source_line"] in retained_notes:
            candidate["note"] = retained_notes[candidate["source_line"]]
    if not result_lines and not candidates:
        raise ValueError(
            "Не удалось сопоставить ни одной строки с аудио. Прежняя разметка сохранена; "
            "задайте границы вручную или выберите другую модель."
        )
    # После пропусков номера остаются плотными, физические source_line не меняются.
    for index, line in enumerate(result_lines, start=1):
        line["id"] = index
    by_number = {line["source_line"]: line for line in result_lines}
    # Кандидаты расширяют вокальные части, но не участвуют в проверке канонических пересечений.
    positions = {number: index for index, (number, _) in enumerate(lines, start=1)}
    section_members = {
        **by_number,
        **{item["source_line"]: {**item, "id": positions[item["source_line"]]} for item in candidates},
    }
    sections = resolve_sections(
        (previous or {}).get("sections"),
        text_sections(text),
        section_members,
        duration,
        uncertain=bool(candidates) or len(result_lines) < len(lines),
    )
    ordered = sorted(result_lines, key=lambda line: line["start"])
    if (
        any(
            not math.isfinite(line["start"])
            or not math.isfinite(line["end"])
            or line["start"] < 0
            or line["end"] > duration + 0.5
            # Допуск снимает только ошибку float у ровно 300 мс, не принимает короткие акустические пути.
            or line["end"] - line["start"] < MIN_LENGTH - TIME_EPSILON
            for line in ordered
        )
        or any(right["start"] < left["end"] - 0.001 for left, right in zip(ordered, ordered[1:]))
    ):
        raise ValueError(
            "Новые границы конфликтуют между собой или с подтверждёнными строками. "
            "Прежняя разметка сохранена; исправьте границы вручную."
        )
    verified = sum(1 for line in result_lines if line.get("verified"))
    missing_count = len(lines) - len(result_lines) - len(candidates)
    status = (
        "Разметка подтверждена на слух."
        if verified == len(result_lines) and not missing_count and not candidates
        else (
            f"Автоматическая разметка по локальному распознаванию ({recognition.get('model', 'модель не указана')}); "
            f"подтверждено на слух {verified} из {len(lines)} строк."
        )
    )
    if candidates:
        status += f" Предложений для ручной проверки: {len(candidates)}."
    if missing_count:
        status += f" Не найдено строк: {missing_count}; укажите их границы вручную."
    timing = {
        "version": 2,
        "status": status,
        "source": source,
        "sha256": sha256,
        "duration_decoded": decoded_duration,
        "duration_container": duration,
        "clock": "Секунды от начала декодированного звука, не SMPTE",
        "lines": result_lines,
        "candidates": candidates,
        "line_order": timing_line_order(lines, previous),
        "sections": sections,
    }
    # Ручная карта тоже входит в публикацию: NaN/Infinity в любом сохранённом поле не портят прежний файл.
    try:
        json.dumps(timing, allow_nan=False)
    except ValueError as error:
        raise ValueError("В разметке есть нечисловые значения. Прежний JSON сохранён.") from error
    return timing


def is_auto_section(section, parts):
    """Старую автоматику узнаём только по полной системной подписи; чужие заметки считаем ручными."""
    if "origin" in section:
        return section["origin"] == "auto"
    name, note = section.get("name", ""), section.get("note", "")
    return (
        (name in {part["name"] for part in parts} and re.fullmatch(r"строки [1-9]\d*–[1-9]\d*", note) is not None)
        or ((name == "Вступление" or re.fullmatch(r"Проигрыш после «.+»", name) is not None) and note == "без вокала")
        or (name == "Финал без вокала" and note == "до конца трека")
    )


def resolve_sections(previous, parts, by_number, duration, uncertain=False):
    """Полностью ручная карта самостоятельна; у смешанной пересчитываем только автоматические части."""
    old = previous or []
    manual = [section for section in old if not is_auto_section(section, parts)]
    if old and len(manual) == len(old):
        return old
    generated = build_sections(parts, by_number, duration, uncertain=uncertain)
    manual_names = {section["name"] for section in manual}
    combined = manual + [section for section in generated if section["name"] not in manual_names]
    return sorted(combined, key=lambda item: item["start"])


def build_sections(parts, by_number, duration, gap_threshold=2.0, uncertain=False):
    """Карта учитывает кандидатов; при пропусках не объявляет неизвестные промежутки инструменталом."""
    sections = []
    named = []
    for part in parts:
        members = [by_number[n] for n in range(part["first"], part["last"] + 1) if n in by_number]
        if members:
            members.sort(key=lambda line: line["start"])
            named.append(
                {
                    "name": part["name"],
                    "start": min(line["start"] for line in members),
                    "end": max(line["end"] for line in members),
                    "note": f"строки {members[0]['id']}–{members[-1]['id']}",
                    "origin": "auto",
                }
            )
    cursor = 0.0
    for index, part in enumerate(named):
        if part["start"] - cursor >= gap_threshold:
            name = "Вступление" if index == 0 else f"Проигрыш после «{named[index - 1]['name']}»"
            sections.append(
                {
                    "name": "Не размечено" if uncertain else name,
                    "start": round(cursor, 3),
                    "end": round(part["start"], 3),
                    "note": "границы вокала не подтверждены" if uncertain else "без вокала",
                    "origin": "auto",
                }
            )
        sections.append({**part, "start": round(part["start"], 3), "end": round(part["end"], 3)})
        cursor = max(cursor, part["end"])
    if duration and duration - cursor >= gap_threshold:
        sections.append(
            {
                "name": "Не размечено" if uncertain else "Финал без вокала",
                "start": round(cursor, 3),
                "end": round(duration, 3),
                "note": "границы вокала не подтверждены" if uncertain else "до конца трека",
                "origin": "auto",
            }
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


def transcribe(root, model, output, device="auto", song_models=None, vocal_result=None):
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
    if song_models:
        command += ["--song-models", str(song_models)]
    if vocal_result:
        command += ["--vocal-result", str(vocal_result)]
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
    parser.add_argument("--song-models", type=Path, help="Модель русского CTC-уточнения границ")
    parser.add_argument("--vocal-result", type=Path, help="Готовый result.json выделенного вокала")
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
    source_hash = hashlib.sha256(track.read_bytes()).hexdigest()
    original_text = text_path.read_bytes()
    output = args.output or root / TIMING_PATH
    if output.resolve() in {track.resolve(), text_path.resolve()}:
        parser.exit(2, "Разметку нельзя записать поверх исходного трека или текста.\n")
    if args.keep_recognition and args.keep_recognition.resolve() in {
        track.resolve(),
        text_path.resolve(),
        output.resolve(),
        (root / TIMING_PATH).resolve(),
    }:
        parser.exit(2, "Распознавание нельзя записать поверх исходников или разметки.\n")
    vocal_metadata = None
    if args.vocal_result and not args.recognition:
        from tools.song_timing.vocal_result import validate_result

        vocal_metadata = validate_result(args.vocal_result, source_hash)
        protected = {args.vocal_result.resolve(), (args.vocal_result.parent / "vocals.wav").resolve()}
        if output.resolve() in protected or (args.keep_recognition and args.keep_recognition.resolve() in protected):
            parser.exit(2, "Разметку и распознавание нельзя записать поверх готового вокала.\n")
    original_timing = output.read_bytes() if output.exists() else None
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
            if bool(args.song_models) != bool(args.vocal_result):
                raise ValueError("Сначала выделите и выберите вокал: нужны вместе --vocal-result и --song-models.")
            missing = missing_model_files(args.model)
            if missing:
                raise ValueError(
                    f"Модель неполна ({args.model}): нет {', '.join(missing)}. Установите модель отдельно: "
                    "инструкция в README комплекса, раздел «Модель распознавания». Проверьте папку --model."
                )
            if args.keep_recognition:
                recognition = transcribe(
                    root, args.model, args.keep_recognition, args.device, args.song_models, args.vocal_result
                )
                print(f"Распознавание сохранено: {args.keep_recognition}", file=sys.stderr)
            else:
                # Отдельная папка на попытку исключает общий JSON у проектов с одинаковым именем и убирает мусор.
                with tempfile.TemporaryDirectory(prefix="songframe-recognition-") as temporary:
                    recognition = transcribe(
                        root,
                        args.model,
                        Path(temporary) / "recognition.json",
                        args.device,
                        args.song_models,
                        args.vocal_result,
                    )
        if recognition.get("sha256") and recognition["sha256"] != source_hash:
            raise ValueError("Распознавание относится к другому треку. Прежняя разметка сохранена.")
        output = args.output or root / TIMING_PATH
        previous = read_json(output) if output.is_file() and not args.reset else None
        timing = build_timing(
            text,
            recognition,
            duration,
            previous if isinstance(previous, dict) else None,
            sha256=source_hash,
        )
    except ValueError as error:
        parser.exit(1, f"{error}\n")
    if not args.dry_run:
        if vocal_metadata is not None:
            try:
                if validate_result(args.vocal_result, source_hash) != vocal_metadata:
                    raise ValueError("Вокал изменился во время выравнивания.")
            except ValueError as error:
                parser.exit(1, f"{error} Прежняя разметка сохранена.\n")
        if hashlib.sha256(track.read_bytes()).hexdigest() != source_hash or text_path.read_bytes() != original_text:
            parser.exit(
                1, "Исходный трек или текст изменились во время обработки. Результат не записан; повторите разметку.\n"
            )
        if (output.read_bytes() if output.exists() else None) != original_timing:
            parser.exit(
                1, "Разметка изменилась во время обработки. Сохранённые правки не перезаписаны; повторите разметку.\n"
            )
        output.parent.mkdir(parents=True, exist_ok=True)
        write_json_atomic(output, timing)
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
