"""Проверка готового вокала перед распознаванием и публикацией. @link README.md"""

import json
import subprocess
import wave
from datetime import datetime
from pathlib import Path

import numpy as np

from tools.common import sha
from tools.song_timing.models import DEFINITION, separator_model


def validate_result(path, source_hash):
    """Сверяем запись целиком: устаревший MP3 или изменённый WAV не становятся входом ASR."""
    path = Path(path)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            raise ValueError("Метаданные должны быть объектом.")
        recipe = separator_model(data.get("modelId"))
        expected = next(item for item in DEFINITION["files"] if item["name"] == recipe["file"])
        if (
            data.get("schemaVersion") != 1
            or data.get("recipeVersion") != 1
            or data.get("sourceSha256") != source_hash
            or data.get("modelSha256") != expected["sha256"]
            or data.get("sampleRate") != 44100
            or data.get("channels") != 2
            or type(data.get("samples")) is not int
            or data["samples"] <= 0
            or data.get("audioFile") != "vocals.wav"
        ):
            raise ValueError("Метаданные вокала устарели или относятся к другому треку/рецепту.")
        created = datetime.fromisoformat(data["createdAt"].replace("Z", "+00:00"))
        if created.tzinfo is None:
            raise ValueError("Время результата должно содержать часовой пояс.")
        audio = path.parent / "vocals.wav"
        if sha(audio) != data.get("audioSha256"):
            raise ValueError("SHA-256 вокала не совпадает: WAV изменился.")
        with wave.open(str(audio), "rb") as stream:
            if (
                (stream.getframerate(), stream.getnchannels(), stream.getsampwidth(), stream.getnframes())
                != (44100, 2, 2, data["samples"])
                or stream.getcomptype() != "NONE"
                or len(stream.readframes(data["samples"])) != data["samples"] * 4
            ):
                raise ValueError("Параметры или длина WAV не совпадают с метаданными.")
        return data
    except (OSError, KeyError, TypeError, StopIteration, wave.Error, json.JSONDecodeError) as error:
        raise ValueError(f"Не удалось проверить готовый вокал: {error}") from error


def load_audio(path):
    """ASR/CTC получают mono16k из готового WAV; MDX здесь принципиально не вызывается."""
    result = subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-i",
            str(Path(path).parent / "vocals.wav"),
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
    audio = np.frombuffer(result.stdout, dtype=np.float32).copy()
    if not len(audio) or not np.isfinite(audio).all():
        raise ValueError("Готовый вокал не содержит корректного аудио.")
    return audio
