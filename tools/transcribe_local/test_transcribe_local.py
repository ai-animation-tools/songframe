"""Локальная модель и честное описание сети без ASR и сетевых обращений. @link README.md"""

import json
import os
import sys
import unittest
from dataclasses import dataclass
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from tools.transcribe_local import transcribe_local as tool


@dataclass
class Segment:
    start: float = 0
    end: float = 1
    text: str = "Проба"


class Audio:
    """Минимальный массив для проверки запуска, не имитирует качество распознавания."""

    def __len__(self):
        return 16000

    def __getitem__(self, key):
        return self


class TranscribeTests(unittest.TestCase):
    def test_local_only_and_actual_network_metadata(self):
        with TemporaryDirectory(prefix="Локальная модель ") as directory:
            root = Path(directory)
            (root / "source").mkdir()
            (root / "source/track.mp3").write_bytes(b"local audio")
            output = root / "recognition.json"
            model = Mock()
            model.return_value.transcribe.return_value = ([Segment()], SimpleNamespace(language="ru"))
            modules = {
                "faster_whisper": SimpleNamespace(WhisperModel=model),
                "numpy": SimpleNamespace(frombuffer=lambda *args, **kwargs: Audio(), float32="float32"),
            }
            # Без --allow-network прежняя ручная команда всё ещё требует изолированную сеть.
            with (
                patch.object(tool.socket, "if_nameindex", return_value=[(1, "lo"), (2, "eth0")]),
                patch.object(
                    sys, "argv", ["transcribe_local", "--model", str(root / "model"), "--output", str(output)]
                ),
            ):
                with self.assertRaisesRegex(SystemExit, "изолированную сеть|unshare"):
                    tool.main()
            with (
                patch.object(tool, "ROOT", root),
                patch.dict(sys.modules, modules),
                patch.object(
                    tool,
                    "detect_hardware",
                    return_value=dict(device="cuda", computeType="int8_float16", reason="Проверка теста"),
                ),
                patch.dict(os.environ, {}, clear=False),
                patch.object(
                    sys,
                    "argv",
                    ["transcribe_local", "--model", str(root / "model"), "--output", str(output), "--allow-network"],
                ),
                patch.object(tool.subprocess, "run", return_value=SimpleNamespace(stdout=b"pcm")),
            ):
                tool.main()
                self.assertTrue(model.call_args.kwargs["local_files_only"])
                self.assertEqual(model.call_args.kwargs["device"], "cuda")
                self.assertEqual(model.call_args.kwargs["compute_type"], "int8_float16")
                self.assertEqual(model.call_args.args[0], str((root / "model").resolve()))
                self.assertEqual(os.environ["HF_HUB_OFFLINE"], "1")
                self.assertEqual(os.environ["HF_HUB_DISABLE_TELEMETRY"], "1")
                self.assertEqual(os.environ["TRANSFORMERS_OFFLINE"], "1")
                result = json.loads(output.read_text(encoding="utf-8"))
                self.assertIn("local process", result["network"])
                self.assertIn("cuda int8_float16", result["method"])
                self.assertNotIn("only loopback", result["network"])
                self.assertEqual(result["segments"][0]["text"], "Проба")


if __name__ == "__main__":
    unittest.main()
