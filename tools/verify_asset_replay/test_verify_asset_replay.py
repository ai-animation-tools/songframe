"""Воспроизведение комплекта из оригинала и обнаружение подмены монтажа; @link README.md"""

import sys
from pathlib import Path

# После переноса точка запуска находится на два уровня ниже корня проекта.
# Полные импорты tools.* работают и при прямом запуске файла из любой папки.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))


import json
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from tools.asset_package.asset_package import replay
from tools.common import sha
from tools.verify_asset_replay.verify_asset_replay import verify


def ffmpeg(*args):
    subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-y", *args], check=True, capture_output=True)


class VerifyAssetReplayTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="replay-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        for target in ("tools.verify_asset_replay.verify_asset_replay.ROOT", "tools.asset_package.asset_package.ROOT"):
            patcher = patch(target, self.root)
            patcher.start()
            self.addCleanup(patcher.stop)
        (self.root / "plan").mkdir()
        (self.root / "plan/scenes.json").write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "fps": 30,
                    "audio": {"end_seconds": "1"},
                    "references": {},
                    "sequences": [{"id": "intro"}],
                    "scenes": [
                        {
                            "id": "M01",
                            "sequence": "intro",
                            "start_frame": 0,
                            "end_frame_exclusive": 30,
                            "references": [],
                        }
                    ],
                }
            )
        )
        self.asset = self.root / "assets/shots/M01"
        self.asset.mkdir(parents=True)
        # Оригинал 24 к/с с движущимся тестовым узором; монтаж — его перевод на 30 к/с по рецепту.
        ffmpeg(
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=1920x1080:rate=24",
            "-t",
            "1.5",
            "-an",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-pix_fmt",
            "yuv420p",
            str(self.asset / "original.mp4"),
        )
        for name in ("frame.png", "prompt.txt", "generation-request.json"):
            (self.asset / name).write_bytes(("Файл " + name).encode())
        self.manifest = self.asset / "manifest.json"
        # Принятый монтаж получается штатным воспроизведением рецепта; до него комплект держит заглушку.
        (self.asset / "video.mp4").write_bytes(b"placeholder")
        self.write_manifest(video_sha=sha(self.asset / "video.mp4"))
        self.work = self.root / "work"
        self.work.mkdir()
        replay(self.manifest, self.work / "rebuilt.mp4", from_original=True)
        shutil.copyfile(self.work / "rebuilt.mp4", self.asset / "video.mp4")
        (self.work / "rebuilt.mp4").unlink()
        self.write_manifest(video_sha=sha(self.asset / "video.mp4"))

    def descriptor(self, name):
        return {"path": name, "sha256": sha(self.asset / name)}

    def write_manifest(self, video_sha):
        package = {
            "schema_version": 1,
            "shot": "M01",
            "generation": {
                "original": self.descriptor("original.mp4"),
                "prompt": self.descriptor("prompt.txt"),
                "request": self.descriptor("generation-request.json"),
                "inputs": [self.descriptor("frame.png")],
                "lipsync": False,
            },
            "accepted_edit": {
                "video": {"path": "video.mp4", "sha256": video_sha},
                "fps": 30,
                "frames": 30,
                "duration_seconds": 1,
                "rebuild": {"stages": [{"input": "original.mp4", "filter": "fps=30,setsar=1", "frames": 30}]},
            },
        }
        self.manifest.write_text(json.dumps(package))

    def test_accepted_edit_replays_from_original_within_tolerance(self):
        result = verify("M01", self.work)
        self.assertEqual(
            (result["shot"], result["rebuild_frames"], result["sampled_frame_indices"]), ("M01", 30, [0, 15, 29])
        )
        self.assertTrue(result["accepted_copy_sha256_matches"])
        self.assertLess(result["sampled_yuv_rms"], 12)
        # Временные копии остаются вне комплекта; assets не изменены.
        self.assertEqual(
            {p.name for p in self.asset.iterdir()},
            {"original.mp4", "video.mp4", "frame.png", "prompt.txt", "generation-request.json", "manifest.json"},
        )

    def test_replaced_edit_with_matching_length_fails_visual_comparison(self):
        # Другой клип той же длины и формата проходит проверку хешей и формата, но не совпадает с рецептом покадрово.
        ffmpeg(
            "-f",
            "lavfi",
            "-i",
            "color=c=blue:size=1920x1080:rate=30",
            "-frames:v",
            "30",
            "-an",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-pix_fmt",
            "yuv420p",
            str(self.asset / "video.mp4"),
        )
        self.write_manifest(video_sha=sha(self.asset / "video.mp4"))
        with self.assertRaises(AssertionError):
            verify("M01", self.work)


if __name__ == "__main__":
    unittest.main()
