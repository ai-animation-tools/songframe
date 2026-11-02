"""Акустическое CTC-выравнивание исходных русских строк. @link README.md"""

import json
import re
from difflib import SequenceMatcher

import numpy as np

from tools.song_timing.mdx import session

SAMPLE_RATE = 16000
FRAME_STEP = 320
RECEPTIVE = 400


def emissions(audio, model, progress=print):
    """18 секунд полезного сигнала плюс контекст; абсолютные времена исключают сдвиг после склейки."""
    if len(audio) < RECEPTIVE:
        return np.empty((0, 0), dtype=np.float32), np.empty(0, dtype=np.float64)
    values, times = [], []
    core = SAMPLE_RATE * 18
    inputs = {item.name: item for item in model.get_inputs()}
    for start in range(0, len(audio), core):
        left = max(0, start - SAMPLE_RATE)
        right = min(len(audio), start + core + SAMPLE_RATE)
        clip = audio[left:right].astype(np.float32)
        clip = (clip - clip.mean()) / np.sqrt(clip.var() + 1e-7)
        feed = {"input_values": clip[None]}
        if "attention_mask" in inputs:
            feed["attention_mask"] = np.ones((1, len(clip)), dtype=np.int64)
        result = model.run(None, feed)[0]
        if result.ndim != 3 or result.shape[0] != 1 or not result.shape[1] or not np.isfinite(result).all():
            raise ValueError("Акустическая модель вернула неверные вероятности символов.")
        logits = result[0]
        centers = (left + np.arange(len(logits)) * FRAME_STEP + RECEPTIVE / 2) / SAMPLE_RATE
        keep = (centers >= start / SAMPLE_RATE) & (centers < min(len(audio), start + core) / SAMPLE_RATE)
        logits = logits[keep].astype(np.float32)
        logits -= logits.max(axis=-1, keepdims=True)
        log_probs = logits - np.log(np.exp(logits).sum(axis=-1, keepdims=True))
        values.append(log_probs)
        times.append(centers[keep])
        progress(
            f"Акустическое выравнивание: {min(len(audio), start + core) / SAMPLE_RATE:.0f}/"
            f"{len(audio) / SAMPLE_RATE:.0f} с"
        )
    return np.concatenate(values), np.concatenate(times)


def tokenize(text, vocab):
    # Не отбрасываем незнакомые буквы молча: например, «ї» должна отклонить всю строку.
    words = re.findall(r"[^\W_]+", text.lower())
    normalized = "|".join(words)
    if not normalized or any(char not in vocab for char in normalized):
        return None
    return [vocab[char] for char in normalized]


def alignment_path(log_probs, target, blank=0):
    """Возвращает найденный путь и причину сомнения, не подменяя слабый путь принятым. @link README.md"""
    if not target or len(log_probs) < len(target):
        return None
    labels = np.full(2 * len(target) + 1, blank, dtype=np.int64)
    labels[1::2] = target
    states = len(labels)
    previous = np.full(states, -np.inf, dtype=np.float32)
    previous[0] = 0
    moves = np.zeros((len(log_probs), states), dtype=np.int8)
    can_skip = (labels != blank) & (labels != np.roll(labels, 2))
    can_skip[:2] = False
    best = -np.inf
    finish = None
    for frame, probabilities in enumerate(log_probs):
        advance = np.r_[-np.inf, previous[:-1]]
        skip = np.r_[-np.inf, -np.inf, previous[:-2]]
        skip[~can_skip] = -np.inf
        paths = np.stack((previous, advance, skip))
        chosen = paths.argmax(axis=0)
        # Настоящая протяжная буква накапливает преимущество над сильнейшим конкурентом.
        # Чужая речь штрафует и букву, и blank: её нельзя бесплатно перескочить и склеить соседние строки.
        runner_up, strongest = np.partition(probabilities, -2)[-2:]
        competitors = np.where(probabilities[labels] == strongest, runner_up, strongest)
        rewards = probabilities[labels] - competitors
        rewards[labels == blank] = probabilities[blank] - strongest
        previous = paths.max(axis=0) + rewards
        previous[0] = 0  # Вступление не обязано содержать текст первой строки.
        moves[frame] = chosen
        if previous[-2] > best:
            best = previous[-2]
            finish = frame
    if finish is None or not np.isfinite(best):
        return None
    state = states - 2
    points = []
    for frame in range(finish, -1, -1):
        if state % 2:
            points.append((state // 2, frame, float(np.exp(log_probs[frame, labels[state]]))))
        state -= int(moves[frame, state])
        if state == 0:
            break
    if state != 0 or not points:
        return None
    peaks = [max((point[2] for point in points if point[0] == index), default=0) for index in range(len(target))]
    first, last = min(point[1] for point in points), max(point[1] for point in points)
    greedy = log_probs[first : last + 1].argmax(axis=1)
    decoded = [
        int(value)
        for index, value in enumerate(greedy)
        if value != blank and (index == 0 or value != greedy[index - 1])
    ]
    confidence = float(np.mean(peaks))
    lower_peak = float(np.quantile(peaks, 0.2))
    similarity = SequenceMatcher(None, target, decoded, autojunk=False).ratio()
    reasons = []
    if confidence < 0.45:
        reasons.append(f"Средняя вероятность букв {confidence:.3f} ниже порога 0.45.")
    if lower_peak < 0.1:
        reasons.append(f"20-й процентиль вероятностей букв {lower_peak:.3f} ниже порога 0.1.")
    if similarity < 0.8:
        reasons.append(f"Сходство свободного распознавания с исходной строкой {similarity:.3f} ниже порога 0.8.")
    return {"first": first, "last": last, "acoustic_score": confidence, "reason": " ".join(reasons)}


def force_align(log_probs, target, blank=0):
    """Прежний контракт: только принятый CTC-путь; слабый путь доступен отдельно через alignment_path."""
    path = alignment_path(log_probs, target, blank)
    if path is None or path["reason"]:
        return None
    return path["first"], path["last"], path["acoustic_score"]


def refine_lines(lines, estimates, recognition, audio, directory):
    """Слабые реальные пути сохраняются отдельно для ручной проверки, пропуски не интерполируются."""
    vocab = json.loads((directory / "vocab.json").read_text(encoding="utf-8"))
    print("Уточняем исходные строки по русской акустической модели.", flush=True)
    log_probs, times = emissions(audio, session(directory / "alignment.onnx"), lambda text: print(text, flush=True))
    duration = len(audio) / SAMPLE_RATE
    segments = []
    suggestions = []
    reasons = []
    cursor = 0.0
    for index, (number, text) in enumerate(lines):
        target = tokenize(text, vocab)
        estimate = estimates[index]
        if target is None:
            reasons.append(
                {
                    "source_line": number,
                    "reason": "В строке есть символы, не поддерживаемые русской акустической моделью.",
                }
            )
            continue
        if estimate["start"] is not None and estimate["end"] > cursor:
            left = max(cursor, estimate["start"] - 2)
            right = min(duration, estimate["end"] + 2)
        else:
            left = cursor
            next_anchor = next(
                (
                    item["start"]
                    for item in estimates[index + 1 :]
                    if item["start"] is not None and item["start"] > cursor
                ),
                duration,
            )
            right = min(duration, next_anchor + 0.5)
        candidates = np.flatnonzero((times >= left) & (times <= right))
        aligned = alignment_path(log_probs[candidates], target, vocab["<pad>"]) if len(candidates) else None
        if aligned is None:
            reasons.append(
                {
                    "source_line": number,
                    "reason": "Не найден достаточно уверенный акустический путь; укажите границы вручную.",
                }
            )
            continue
        first, last, confidence = aligned["first"], aligned["last"], aligned["acoustic_score"]
        start = max(cursor, float(times[candidates[first]]) - 0.01)
        end = min(duration, float(times[candidates[last]]) + 0.01)
        reason = aligned["reason"]
        # Как в align_lyrics, снимаем только двоичную погрешность у интервала ровно 300 мс.
        if end - start < 0.3 - 1e-9:
            reason = (reason + " Акустический интервал слишком короткий; укажите границы вручную.").strip()
        if reason:
            reasons.append({"source_line": number, "reason": reason})
            if confidence >= 0.45 and end > start:
                # Сомнительный путь не двигает курсор принятых строк и может пересекаться с соседями.
                suggestions.append(
                    {"source_line": number, "start": start, "end": end, "reason": reason, "acoustic_score": confidence}
                )
            continue
        # Один сегмент соответствует известной строке; его точные слова повторно не распределяются равномерно.
        segments.append({"start": start, "end": end, "text": text, "source_line": number, "acoustic_score": confidence})
        cursor = end
    for item in reasons:
        print(f"Строка {item['source_line']}: {item['reason']}", flush=True)
    return {
        **recognition,
        "segments": segments,
        "candidates": suggestions,
        "unmatched": reasons,
        "alignment": "wav2vec2-large-xlsr-53-russian ONNX CTC",
    }
