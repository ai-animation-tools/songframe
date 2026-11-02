"""Политика ASR для песен и проверка пригодности временных ориентиров. @link README.md"""

import math


def transcription_options():
    """VAD возвращает времена полной записи; повторы припева не запрещаем n-gram-фильтрами."""
    return {
        "language": "ru",
        "beam_size": 5,
        "word_timestamps": True,
        "vad_filter": True,
        "vad_parameters": {"min_silence_duration_ms": 2000, "speech_pad_ms": 400},
        "condition_on_previous_text": False,
        "temperature": (0.0, 0.2, 0.4, 0.6),
        "compression_ratio_threshold": 2.4,
        "log_prob_threshold": -1.0,
        "no_speech_threshold": 0.6,
        "hallucination_silence_threshold": 2.0,
    }


def unusable_reason(segment):
    """Не используем схлопнутые времена как якоря; исходный ответ сохраняется в raw_segments.

    Вероятность отсутствия речи сама по себе не фильтрует пение: у верных строк она тоже бывает высокой.
    """
    start, end = segment["start"], segment["end"]
    if not math.isfinite(start) or not math.isfinite(end) or end <= start:
        return "У фрагмента нет положительного конечного интервала."
    words = [word for word in segment.get("words") or [] if any(char.isalnum() for char in word["word"])]
    if len(words) < 3:
        return None
    durations = [max(0, word["end"] - word["start"]) for word in words]
    # Несколько слов в одной точке — известный сбой word timestamps, а не доказательство произнесённой строки.
    # Порог проверяет одновременно схлопывание большинства слов и физически короткую суммарную опору.
    collapsed = sum(duration <= 1e-6 for duration in durations)
    if collapsed / len(words) >= 0.6 and sum(durations) < 0.04 * len(words):
        return "Времена большинства слов схлопнулись; фрагмент не используется для разметки."
    return None
