"""Проверяет скачивание и повторное использование FFmpeg в CI; @link README.md."""

import hashlib
import io
import os
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from tools.run_tests.prepare_ci_ffmpeg import prepare


def archive_bytes(names=("ffmpeg", "ffprobe")):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:xz") as archive:
        for name in names:
            data = f"fixture-{name}".encode()
            member = tarfile.TarInfo(f"ffmpeg-build/bin/{name}")
            member.size = len(data)
            archive.addfile(member, io.BytesIO(data))
    return output.getvalue()


class CiFfmpegTests(unittest.TestCase):
    def setUp(self):
        self.work = tempfile.TemporaryDirectory(prefix="songframe-ci-ffmpeg-")
        self.addCleanup(self.work.cleanup)
        self.directory = Path(self.work.name)
        self.data = archive_bytes()
        self.lock = {"url": "https://example.invalid/ffmpeg.tar.xz", "sha256": hashlib.sha256(self.data).hexdigest()}

    def test_cached_archive_is_verified_and_used_without_network(self):
        (self.directory / "ffmpeg.tar.xz").write_bytes(self.data)
        with patch("tools.run_tests.prepare_ci_ffmpeg.urlopen") as request:
            binary_dir = prepare(self.directory, self.lock)
        request.assert_not_called()
        self.assertEqual((binary_dir / "ffmpeg").read_bytes(), b"fixture-ffmpeg")
        self.assertEqual((binary_dir / "ffprobe").read_bytes(), b"fixture-ffprobe")
        self.assertTrue((binary_dir / "ffmpeg").stat().st_mode & 0o111)

    def test_corrupt_cache_is_replaced_with_verified_download(self):
        (self.directory / "ffmpeg.tar.xz").write_bytes(b"broken")
        with patch("tools.run_tests.prepare_ci_ffmpeg.urlopen", return_value=io.BytesIO(self.data)) as request:
            prepare(self.directory, self.lock)
        request.assert_called_once()
        self.assertEqual((self.directory / "ffmpeg.tar.xz").read_bytes(), self.data)

    def test_wrong_download_hash_fails_without_installing_executables(self):
        with patch("tools.run_tests.prepare_ci_ffmpeg.urlopen", return_value=io.BytesIO(b"wrong")):
            with self.assertRaisesRegex(ValueError, "SHA-256"):
                prepare(self.directory, self.lock)
        self.assertFalse((self.directory / "bin").exists())
        self.assertEqual(list(self.directory.iterdir()), [])

    def test_missing_or_duplicate_binary_is_rejected(self):
        for names in (("ffmpeg",), ("ffmpeg", "ffprobe", "ffprobe")):
            with self.subTest(names=names):
                data = archive_bytes(names)
                (self.directory / "ffmpeg.tar.xz").write_bytes(data)
                with self.assertRaisesRegex(ValueError, "единственного файла ffprobe"):
                    prepare(self.directory, {**self.lock, "sha256": hashlib.sha256(data).hexdigest()})
                self.assertFalse((self.directory / "bin").exists())


class CiMediaScriptTests(unittest.TestCase):
    def setUp(self):
        self.work = tempfile.TemporaryDirectory(prefix="songframe-ci-media-")
        self.addCleanup(self.work.cleanup)
        self.directory = Path(self.work.name)
        self.commands = self.directory / "commands"
        self.commands.mkdir()
        self.log = self.directory / "commands.log"
        self.github_path = self.directory / "github-path"
        self.script = Path(__file__).resolve().with_name("prepare_ci_media.sh")
        for name, body in {
            "timeout": 'echo "timeout $*" >> "$TEST_LOG"; exit "$TEST_TIMEOUT_RESULT"',
            "sudo": 'echo "sudo $*" >> "$TEST_LOG"; exit "${TEST_SUDO_RESULT:-0}"',
            "ffmpeg": "exit 0",
            "ffprobe": "exit 0",
        }.items():
            path = self.commands / name
            path.write_text(f"#!/bin/sh\n{body}\n")
            path.chmod(0o755)
        self.env = {
            **os.environ,
            "PATH": f"{self.commands}:/usr/bin:/bin",
            "RUNNER_TEMP": str(self.directory),
            "GITHUB_PATH": str(self.github_path),
            "TEST_LOG": str(self.log),
        }

    def run_script(self, timeout_result):
        return subprocess.run(
            ["/bin/bash", str(self.script)],
            env={**self.env, "TEST_TIMEOUT_RESULT": str(timeout_result)},
            capture_output=True,
            text=True,
        )

    def test_success_uses_prepared_binaries_without_apt(self):
        binary_dir = self.directory / "songframe-ci-ffmpeg" / "bin"
        binary_dir.mkdir(parents=True)
        for name in ("ffmpeg", "ffprobe"):
            path = binary_dir / name
            path.write_text("#!/bin/sh\nexit 0\n")
            path.chmod(0o755)
        result = self.run_script(0)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.github_path.read_text().strip(), str(binary_dir))
        self.assertIn("timeout 180s python -B", self.log.read_text())
        self.assertNotIn("sudo", self.log.read_text())

    def test_timeout_falls_back_to_apt_in_temporary_directory(self):
        result = self.run_script(124)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("пакет Ubuntu", result.stdout)
        self.assertIn(
            "Dir::Cache::archives=" + str(self.directory / "songframe-ci-apt" / "archives"), self.log.read_text()
        )
        self.assertIn("install -y --no-install-recommends ffmpeg", self.log.read_text())
        self.assertFalse(self.github_path.exists())

    def test_failed_fallback_stops_ci(self):
        self.env["TEST_SUDO_RESULT"] = "7"
        result = self.run_script(124)
        self.assertEqual(result.returncode, 7)


if __name__ == "__main__":
    unittest.main()
