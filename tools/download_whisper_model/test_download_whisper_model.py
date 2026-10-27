"""Бесплатные проверки CLI на подставном Hub без сети и системного Python."""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("download_whisper_model.py")
FAKE_HUB = """
import json
import os
import sys
from pathlib import Path

assert "HF_HUB_OFFLINE" not in os.environ, "Hub импортирован до снятия офлайн-флага"

def snapshot_download(*, repo_id, local_dir):
    directory = Path(local_dir)
    directory.mkdir(parents=True, exist_ok=True)
    log = directory / "calls.jsonl"
    with log.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps({"repo_id": repo_id, "local_dir": local_dir}) + "\\n")
    print("Прогресс Hub: загрузка", file=sys.stderr)
    (directory / "model.bin").write_bytes(b"weights")
    if os.environ.get("FAKE_HUB_MODE") == "error":
        raise OSError("Нет соединения")
    if os.environ.get("FAKE_HUB_MODE") == "interrupt":
        raise KeyboardInterrupt()
    (directory / "config.json").write_text("{}", encoding="utf-8")
    (directory / "tokenizer.json").write_text("{}", encoding="utf-8")
    if os.environ.get("FAKE_HUB_MODE") == "empty":
        (directory / "model.bin").write_bytes(b"")
    if os.environ.get("FAKE_HUB_MODE") != "incomplete":
        (directory / os.environ.get("FAKE_VOCABULARY", "vocabulary.txt")).write_text("word", encoding="utf-8")
    if os.environ.get("FAKE_HUB_MODE", "").startswith("missing:"):
        (directory / os.environ["FAKE_HUB_MODE"].removeprefix("missing:")).unlink()
    return str(directory)
"""


class DownloadWhisperModelTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.output = self.root / "Модель с пробелами"
        self.hub = self.root / "fake-hub"
        self.hub.mkdir()
        (self.hub / "huggingface_hub.py").write_text(FAKE_HUB, encoding="utf-8")

    def run_cli(self, *, mode="", vocabulary="vocabulary.txt", output=None):
        env = dict(os.environ)
        # Пустой PATH доказывает, что CLI и повтор запуска используют уже
        # выбранный интерпретатор; подставной Hub не обращается к сети.
        env.update(
            PATH="",
            PYTHONIOENCODING="utf-8",
            PYTHONUTF8="1",
            PYTHONPATH=str(self.hub),
            HF_HUB_OFFLINE="1",
            FAKE_HUB_MODE=mode,
            FAKE_VOCABULARY=vocabulary,
        )
        return subprocess.run(
            [
                sys.executable,
                "-B",
                str(SCRIPT),
                "--project",
                str(self.root / "Несуществующий проект"),
                "--repository",
                "Systran/faster-whisper-medium",
                "--output",
                str(self.output if output is None else output),
            ],
            env=env,
            cwd=self.root,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=15,
            check=False,
        )

    def test_complete_model_both_vocabularies_and_repeat(self):
        for vocabulary in ("vocabulary.txt", "vocabulary.json"):
            with self.subTest(vocabulary=vocabulary):
                output = self.root / vocabulary
                first = self.run_cli(vocabulary=vocabulary, output=output)
                self.assertEqual(first.returncode, 0, first.stderr)
                marker = output / ".cache" / "huggingface" / "existing.metadata"
                marker.parent.mkdir(parents=True)
                marker.write_text("existing", encoding="utf-8")
                second = self.run_cli(vocabulary=vocabulary, output=output)
                self.assertEqual(second.returncode, 0, second.stderr)
                calls = [json.loads(line) for line in (output / "calls.jsonl").read_text().splitlines()]
                self.assertEqual(calls, [{"repo_id": "Systran/faster-whisper-medium", "local_dir": str(output)}] * 2)
                self.assertEqual(marker.read_text(), "existing")
                self.assertIn("Модель готова", second.stdout)
                self.assertIn("Прогресс Hub", second.stderr)
                self.assertFalse((self.root / "Несуществующий проект").exists())

    def test_incomplete_or_empty_model_is_not_ready(self):
        for mode in ("incomplete", "empty", "missing:config.json", "missing:model.bin", "missing:tokenizer.json"):
            with self.subTest(mode=mode):
                result = self.run_cli(mode=mode, output=self.root / mode.replace(":", "_"))
                self.assertEqual(result.returncode, 1)
                self.assertIn("не полностью", result.stderr)
                self.assertNotIn("Модель готова", result.stdout)

    def test_failed_download_keeps_partial_data_and_can_continue(self):
        failed = self.run_cli(mode="error")
        self.assertEqual(failed.returncode, 1)
        self.assertIn("Нет соединения", failed.stderr)
        self.assertNotIn("Traceback", failed.stderr)
        self.assertEqual((self.output / "model.bin").read_bytes(), b"weights")
        resumed = self.run_cli()
        self.assertEqual(resumed.returncode, 0, resumed.stderr)
        self.assertIn("Модель готова", resumed.stdout)

    def test_interrupt_is_short_and_preserves_downloaded_data(self):
        result = self.run_cli(mode="interrupt")
        self.assertEqual(result.returncode, 130)
        self.assertIn("Загрузка прервана", result.stderr)
        self.assertNotIn("Traceback", result.stderr)
        self.assertTrue((self.output / "model.bin").is_file())

    def test_relative_output_fails_before_loading_hub(self):
        result = self.run_cli(output=Path("relative-model"))
        self.assertEqual(result.returncode, 2)
        self.assertIn("абсолютный путь", result.stderr)
        self.assertFalse((self.root / "relative-model").exists())


if __name__ == "__main__":
    unittest.main()
