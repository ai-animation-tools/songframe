"""Отдельно выделяет вокал, сохраняя проверяемый stereo WAV вне проекта. @link README.md"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import argparse
import signal
import tempfile
import wave
from datetime import datetime, timezone

import numpy as np

from tools.common import ROOT, sha, write_json_atomic
from tools.song_timing.mdx import RATE, decode_stereo, separate, session
from tools.song_timing.models import DEFINITION, require_models, separator_model


def separate_project(project, model_id, models, output):
    """Уникальная папка и последний result.json отделяют готовый результат от сбоя/отмены."""
    project, models, output = Path(project).resolve(), Path(models), Path(output).resolve()
    if output == project or project in output.parents:
        raise ValueError("Результат выделения вокала должен находиться вне проекта.")
    recipe = separator_model(model_id)
    require_models(models, component=model_id)
    model_path = models / recipe["file"]
    expected = next(item for item in DEFINITION["files"] if item["name"] == recipe["file"])
    model_hash = sha(model_path)
    if model_hash != expected["sha256"]:
        raise ValueError("SHA-256 модели не совпадает с закреплённой версией. Скачайте модель заново.")
    source = project / "source/track.mp3"
    source_hash = sha(source)
    # Не используем существующую папку: предыдущая удачная попытка переживает любую новую ошибку.
    output.mkdir(parents=True, exist_ok=False)
    temporary = None
    try:
        stereo = decode_stereo(source)
        vocals = separate(stereo, session(model_path), lambda text: print(text, flush=True), recipe=recipe)
        if sha(source) != source_hash:
            raise ValueError("Исходный трек изменился во время выделения вокала. Результат не опубликован.")
        with tempfile.NamedTemporaryFile(dir=output, suffix=".tmp", delete=False) as stream:
            temporary = Path(stream.name)
        # PCM16 ограничивает только представимый диапазон; нормализации по пику и изменения длины нет.
        pcm = np.rint(np.clip(vocals.T, -1, 32767 / 32768) * 32768).astype("<i2")
        with wave.open(str(temporary), "wb") as stream:
            stream.setnchannels(2)
            stream.setsampwidth(2)
            stream.setframerate(RATE)
            stream.writeframes(pcm.tobytes())
        if sha(source) != source_hash:
            raise ValueError("Исходный трек изменился перед публикацией вокала.")
        audio = output / "vocals.wav"
        temporary.replace(audio)
        metadata = dict(
            schemaVersion=1,
            sourceSha256=source_hash,
            modelId=model_id,
            modelSha256=model_hash,
            recipeVersion=1,
            sampleRate=RATE,
            channels=2,
            samples=stereo.shape[-1],
            audioFile="vocals.wav",
            audioSha256=sha(audio),
            createdAt=datetime.now(timezone.utc).isoformat(),
        )
        if sha(source) != source_hash:
            raise ValueError("Исходный трек изменился перед публикацией результата.")
        write_json_atomic(output / "result.json", metadata)
        return metadata
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", required=True, choices=("voc-ft", "kim-vocal-1", "kim-vocal-2"))
    parser.add_argument("--models", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()

    # SIGTERM штатного Jobs проходит через finally и не оставляет готовую запись после отмены.
    def cancel(_signum, _frame):
        raise KeyboardInterrupt("Выделение вокала отменено.")

    signal.signal(signal.SIGTERM, cancel)
    separate_project(ROOT, args.model, args.models, args.output)
    print(f"Вокал сохранён: {args.output / 'result.json'}", flush=True)


if __name__ == "__main__":
    main()
