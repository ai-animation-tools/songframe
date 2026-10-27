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

from tools.common import ROOT
from tools.transcribe_local.hardware import cpu_threads, detect_hardware


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
    parser.add_argument(
        "--allow-network",
        action="store_true",
        help="Не требовать изоляции сети (Windows или среда без unshare); модель всё равно берётся только локально",
    )
    args = parser.parse_args()

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
    # Подсказка в приложении и запуск используют один способ проверки CUDA. @link hardware.py
    hardware = (
        detect_hardware()
        if args.device == "auto"
        else dict(device="cpu", computeType="int8", reason="CPU выбран вручную.")
    )
    print(hardware["reason"], flush=True)
    model = WhisperModel(
        str(args.model.resolve()),
        device=hardware["device"],
        compute_type=hardware["computeType"],
        cpu_threads=cpu_threads(),
        local_files_only=True,
    )
    # Декодируем через FFmpeg из PATH (в приложении первым стоит встроенный): исходный MP3 остаётся неизменным,
    # а анализ получает монофонический сигнал в памяти без зависимости от API PyAV.
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
    segments, info = model.transcribe(
        audio,
        language="ru",
        beam_size=5,
        word_timestamps=True,
        vad_filter=False,
        condition_on_previous_text=False,
        temperature=0,
        initial_prompt=args.prompt,
    )
    result = {
        "source": "source/track.mp3",
        "sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
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
        "segments": [],
    }
    # Сохраняем исходные ответы модели как доказательство, а не исправленный
    # текст песни. Редакторские границы сцен хранятся отдельно от распознавания.
    args.output.parent.mkdir(parents=True, exist_ok=True)
    for segment in segments:
        item = asdict(segment)
        for key in ("start", "end"):
            item[key] = round(item[key] + args.start, 3)
        for word in item.get("words", []):
            for key in ("start", "end"):
                word[key] = round(word[key] + args.start, 3)
        result["segments"].append(item)
        args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
        print(f"{item['start']:7.2f}–{item['end']:7.2f} {item['text']}", flush=True)


if __name__ == "__main__":
    try:
        main()
    except RuntimeError as error:
        # CUDA может пройти предварительную проверку, но не вместить выбранную модель при распознавании.
        raise SystemExit(
            f"Ошибка распознавания: {error}. Если используется NVIDIA, "
            "выберите меньшую модель или режим «Только CPU» в окне разметки."
        ) from error
