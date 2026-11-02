"""Локальное распознавание песни со словами и временем; модель читается с диска. @link README.md"""

import sys
from pathlib import Path

# После переноса точка запуска находится на два уровня ниже корня проекта.
# Полные импорты tools.* работают и при прямом запуске файла из любой папки.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))


import argparse
import hashlib
import json
import os
import shutil
import socket
import subprocess
from dataclasses import asdict

from tools.common import ROOT, write_json_atomic
from tools.transcribe_local.hardware import cpu_threads, detect_hardware
from tools.transcribe_local.quality import transcription_options, unusable_reason


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument(
        "--device", choices=("auto", "cpu"), default="auto", help="Автовыбор CUDA или принудительный CPU"
    )
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--start", type=float, default=0)
    parser.add_argument("--end", type=float)
    parser.add_argument("--filter", default="")
    parser.add_argument("--prompt", default=None)
    parser.add_argument("--song-models", type=Path)
    parser.add_argument("--vocal-result", type=Path, help="Проверенный result.json ранее выделенного вокала")
    parser.add_argument(
        "--allow-network",
        action="store_true",
        help="Не требовать изоляции сети (Windows или среда без unshare); модель всё равно берётся только локально",
    )
    args = parser.parse_args()

    if bool(args.song_models) != bool(args.vocal_result):
        raise ValueError("Сначала выделите и выберите вокал: нужны вместе --vocal-result и --song-models.")

    # Исходники не должны покидать компьютер. Требуем изолированное сетевое
    # пространство и уже загруженную модель, исключая загрузки во время анализа.
    if (
        not args.allow_network
        and hasattr(socket, "if_nameindex")
        and any(name != "lo" for _, name in socket.if_nameindex())
    ):
        hint = "unshare -Urn " if shutil.which("unshare") else ""
        raise SystemExit(
            f"Запустите скрипт через {hint or 'изолированную сеть'} либо добавьте --allow-network: "
            "модель загружается только с диска."
        )
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    import numpy as np
    from faster_whisper import WhisperModel

    source = ROOT / "source/track.mp3"
    text_path = ROOT / "source/text.md"
    # Снимок берём до декодирования: распознавание не должно получить подпись уже другого исходника.
    source_hash = hashlib.sha256(source.read_bytes()).hexdigest()
    original_text = text_path.read_bytes() if args.song_models else None
    if args.output.resolve() in {source.resolve(), text_path.resolve(), (ROOT / "plan/audio/timing.json").resolve()}:
        raise ValueError("Результат распознавания нельзя записать поверх исходного трека, текста или разметки.")
    if args.vocal_result and args.output.resolve() in {
        args.vocal_result.resolve(),
        (args.vocal_result.parent / "vocals.wav").resolve(),
    }:
        raise ValueError("Распознавание нельзя записать поверх готового вокала.")
    vocal_metadata = None
    # Подсказка в приложении и запуск используют один способ проверки CUDA. @link hardware.py
    hardware = (
        detect_hardware()
        if args.device == "auto"
        else dict(device="cpu", computeType="int8", reason="CPU выбран вручную.")
    )
    print(hardware["reason"], flush=True)
    # Декодируем через FFmpeg из PATH (в приложении первым стоит встроенный): исходный MP3 остаётся неизменным,
    # а анализ получает монофонический сигнал в памяти без зависимости от API PyAV.
    if args.song_models:
        if args.start or args.end is not None or args.filter:
            raise ValueError("Разметка по вокалу обрабатывает полный трек без обрезки и дополнительных фильтров.")
        from tools.song_timing.models import require_models
        from tools.song_timing.vocal_result import load_audio, validate_result

        require_models(args.song_models)
        vocal_metadata = validate_result(args.vocal_result, source_hash)
        audio = load_audio(args.vocal_result)
    else:
        decode_command = ["ffmpeg", "-v", "error", "-i", str(source)]
        if args.filter:
            decode_command += ["-af", args.filter]
        decoded = subprocess.run(
            decode_command
            + [
                "-f",
                "f32le",
                "-ac",
                "1",
                "-ar",
                "16000",
                "pipe:1",
            ],
            check=True,
            capture_output=True,
        )
        audio = np.frombuffer(decoded.stdout, dtype=np.float32)
    decoded_duration = len(audio) / 16000
    stop = args.end if args.end is not None else decoded_duration
    audio = audio[round(args.start * 16000) : round(stop * 16000)]
    model = WhisperModel(
        str(args.model.resolve()),
        device=hardware["device"],
        compute_type=hardware["computeType"],
        cpu_threads=cpu_threads(),
        local_files_only=True,
    )
    asr_options = transcription_options()
    segments, info = model.transcribe(audio, **asr_options, initial_prompt=args.prompt)
    result = {
        "source": "source/track.mp3",
        "sha256": source_hash,
        "model": args.model.name,
        "model_path": str(args.model.resolve()),
        "python_executable": sys.executable,
        "method": f"faster-whisper, {hardware['device']} {hardware['computeType']}, beam_size=5, word_timestamps=True",
        "hardware": hardware,
        # Не заявляем OS-изоляцию при прямом запуске из приложения. @link README.md
        "network": ("local process" if args.allow_network else "network namespace; only loopback")
        + "; local_files_only; HF_HUB_OFFLINE",
        "decoded_duration": decoded_duration,
        "offset": args.start,
        "filter": args.filter,
        "prompt": args.prompt,
        "language": info.language,
        "asr_options": asr_options,
        "segments": [],
        "candidates": [],
        "raw_segments": [],
        "rejected_segments": [],
    }
    # Сохраняем исходные ответы модели как доказательство, а не исправленный
    # текст песни. Редакторские границы сцен хранятся отдельно от распознавания.
    for segment in segments:
        item = asdict(segment)
        for key in ("start", "end"):
            item[key] = round(item[key] + args.start, 3)
        for word in item.get("words", []):
            for key in ("start", "end"):
                word[key] = round(word[key] + args.start, 3)
        result["raw_segments"].append(item)
        reason = unusable_reason(item)
        if reason:
            result["rejected_segments"].append({"raw_index": len(result["raw_segments"]) - 1, "reason": reason})
            print(f"ASR: фрагмент {item['start']:.2f}–{item['end']:.2f} пропущен: {reason}", flush=True)
        else:
            result["segments"].append(item)
            print(f"{item['start']:7.2f}–{item['end']:7.2f} {item['text']}", flush=True)

    if args.song_models:
        # Освобождаем Whisper перед акустической моделью: обе большие модели не нужны в памяти одновременно.
        del model, segments
        import gc

        gc.collect()
        from tools.align_lyrics.align_lyrics import estimate_lines, lyric_lines, recognized_words
        from tools.song_timing.ctc import refine_lines

        lyrics = lyric_lines(original_text.decode("utf-8-sig"))
        result = refine_lines(
            lyrics, estimate_lines(lyrics, recognized_words(result), decoded_duration), result, audio, args.song_models
        )
        result["method"] += "; готовый вокал + Wav2Vec2 Russian ONNX CTC"
        result["vocalResult"] = dict(modelId=vocal_metadata["modelId"], audioSha256=vocal_metadata["audioSha256"])
        if validate_result(args.vocal_result, source_hash) != vocal_metadata:
            raise ValueError("Готовый вокал изменился во время распознавания. Результат не записан.")
    # ASR, CTC и отмена завершаются до единственной публикации; прежний JSON переживает любой сбой.
    if hashlib.sha256(source.read_bytes()).hexdigest() != source_hash or (
        original_text is not None and text_path.read_bytes() != original_text
    ):
        raise ValueError("Исходный трек или текст изменились во время обработки. Распознавание не записано.")
    # Raw сохраняется без исправлений; NaN/Infinity не должны превратить файл в невалидный для приложения JSON.
    try:
        json.dumps(result, allow_nan=False)
    except ValueError as error:
        raise ValueError("ASR вернул нечисловые значения. Результат не записан.") from error
    write_json_atomic(args.output, result)


if __name__ == "__main__":
    try:
        main()
    except RuntimeError as error:
        # CUDA может пройти предварительную проверку, но не вместить выбранную модель при распознавании.
        raise SystemExit(
            f"Ошибка распознавания: {error}. Если используется NVIDIA, "
            "выберите меньшую модель или режим «Только CPU» в окне разметки."
        ) from error
