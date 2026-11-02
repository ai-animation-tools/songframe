"""Публикация и повторное использование вокала без настоящих моделей. @link README.md"""

import json
import sys
import unittest
import wave
from contextlib import ExitStack, contextmanager
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from tools.common import sha
from tools.separate_vocals import separate_vocals as tool
from tools.song_timing.models import separator_model
from tools.song_timing.vocal_result import validate_result


@contextmanager
def runtime():
    """Настоящие файлы/хеши и PCM при подмене только дорогостоящей модели и MP3-декодирования."""
    with TemporaryDirectory() as folder, ExitStack() as stack:
        root = Path(folder)
        project = root / "project"
        (project / "source").mkdir(parents=True)
        source = project / "source/track.mp3"
        source.write_bytes(b"source MP3")
        timing = project / "plan/audio/timing.json"
        timing.parent.mkdir(parents=True)
        timing.write_bytes(b"verified timing")
        models = root / "models"
        models.mkdir()
        model = models / separator_model("voc-ft")["file"]
        model.write_bytes(b"model")
        definition = {"files": [{"name": model.name, "sha256": sha(model)}]}
        signal = np.zeros((2, 44100), dtype=np.float32)
        signal[0, 10000] = 0.5
        signal[1, 10000] = -0.25
        stack.enter_context(patch.object(tool, "DEFINITION", definition))
        stack.enter_context(patch("tools.song_timing.vocal_result.DEFINITION", definition))
        stack.enter_context(patch.object(tool, "require_models"))
        stack.enter_context(patch.object(tool, "decode_stereo", return_value=signal))
        stack.enter_context(patch.object(tool, "session"))
        separator = stack.enter_context(patch.object(tool, "separate", return_value=signal))
        yield root, project, models, source, timing, separator


class SeparateTests(unittest.TestCase):
    def test_complete_result_preserves_stereo_clock_amplitude_and_sources(self):
        with runtime() as (root, project, models, source, timing, separator):
            output = root / "unique"
            data = tool.separate_project(project, "voc-ft", models, output)
            self.assertEqual(validate_result(output / "result.json", sha(source)), data)
            with wave.open(str(output / "vocals.wav"), "rb") as stream:
                pcm = np.frombuffer(stream.readframes(44100), dtype="<i2").reshape(-1, 2)
                self.assertEqual(stream.getnframes(), 44100)
                self.assertEqual(stream.getframerate(), 44100)
                np.testing.assert_array_equal(pcm[10000], [16384, -8192])
                self.assertEqual(np.count_nonzero(pcm[:10000]), 0)
            self.assertEqual(source.read_bytes(), b"source MP3")
            self.assertEqual(timing.read_bytes(), b"verified timing")
            self.assertEqual(
                set(data),
                {
                    "schemaVersion",
                    "sourceSha256",
                    "modelId",
                    "modelSha256",
                    "recipeVersion",
                    "sampleRate",
                    "channels",
                    "samples",
                    "audioFile",
                    "audioSha256",
                    "createdAt",
                },
            )
            with self.assertRaises(FileExistsError):
                tool.separate_project(project, "voc-ft", models, output)

    def test_changed_wav_metadata_source_and_recipe_are_rejected(self):
        with runtime() as (root, project, models, source, timing, separator):
            output = root / "unique"
            data = tool.separate_project(project, "voc-ft", models, output)
            path = output / "result.json"
            for key, value in (
                ("sourceSha256", "stale"),
                ("recipeVersion", 2),
                ("modelSha256", "wrong"),
                ("samples", 1),
                ("audioFile", "../other.wav"),
            ):
                with self.subTest(key=key):
                    path.write_text(json.dumps(dict(data, **{key: value})))
                    with self.assertRaises(ValueError):
                        validate_result(path, sha(source))
            path.write_text(json.dumps(data))
            audio = output / "vocals.wav"
            audio.write_bytes(audio.read_bytes() + b"changed")
            with self.assertRaisesRegex(ValueError, "WAV изменился"):
                validate_result(path, sha(source))

    def test_failure_cancel_and_changed_source_never_publish_metadata(self):
        with runtime() as (root, project, models, source, timing, separator):
            for index, error in enumerate((ValueError("model failed"), KeyboardInterrupt("cancelled"))):
                separator.side_effect = error
                output = root / f"attempt-{index}"
                with self.assertRaises(type(error)):
                    tool.separate_project(project, "voc-ft", models, output)
                self.assertFalse((output / "result.json").exists())

            def changed(*args, **kwargs):
                source.write_bytes(b"new MP3")
                return np.zeros((2, 44100), dtype=np.float32)

            separator.side_effect = changed
            with self.assertRaisesRegex(ValueError, "трек изменился"):
                tool.separate_project(project, "voc-ft", models, root / "stale")
            self.assertFalse((root / "stale/result.json").exists())
            self.assertEqual(timing.read_bytes(), b"verified timing")

    def test_failed_atomic_metadata_keeps_previous_attempt_and_cleans_temporary(self):
        with runtime() as (root, project, models, source, timing, separator):
            tool.separate_project(project, "voc-ft", models, root / "accepted")
            previous = (root / "accepted/result.json").read_bytes()
            with patch.object(tool, "write_json_atomic", side_effect=OSError("disk failure")):
                with self.assertRaises(OSError):
                    tool.separate_project(project, "voc-ft", models, root / "failed")
            self.assertEqual((root / "accepted/result.json").read_bytes(), previous)
            self.assertFalse((root / "failed/result.json").exists())
            self.assertEqual(list((root / "failed").glob("*.tmp")), [])

    def test_output_inside_project_is_rejected(self):
        with runtime() as (root, project, models, source, timing, separator):
            with self.assertRaisesRegex(ValueError, "вне проекта"):
                tool.separate_project(project, "voc-ft", models, project / "vocals")
            separator.assert_not_called()


if __name__ == "__main__":
    unittest.main()
