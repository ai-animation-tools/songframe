"""Контактный лист, граничные кадры, сравнение с опорами и превью на тестовом видео; @link README.md"""

import sys
from pathlib import Path

# После переноса точка запуска находится на два уровня ниже корня проекта.
# Полные импорты tools.* работают и при прямом запуске файла из любой папки.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))


import json
import subprocess
import tempfile
import unittest

from PIL import Image

from tools.contact_sheet import contact_sheet as tool


class ContactSheetTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="contact-sheet-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.package = self.root / "plan/batches/M02-attempt-01"
        self.work = self.package / "request"
        self.work.mkdir(parents=True)
        subprocess.run(
            [
                "ffmpeg",
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=s=640x360:r=24",
                "-frames:v",
                "49",
                "-pix_fmt",
                "yuv420p",
                str(self.work / "original.mp4"),
            ],
            check=True,
        )
        (self.work / "attempt.json").write_text(
            json.dumps({"status": "downloaded", "downloads": [{"number": 1, "path": "original.mp4", "bytes": 1}]})
        )
        (self.package / "frames").mkdir()
        Image.new("RGB", (640, 360), "#336699").save(self.package / "frames/K01.png")
        Image.new("RGB", (640, 360), "#996633").save(self.package / "frames/K02.png")
        (self.package / "workflow.json").write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "shot": "M02",
                    "stage": "downloaded",
                    "request_dir": "request",
                    "keyframes": [
                        {"id": "K01", "role": "first", "path": "frames/K01.png", "approved": True},
                        {"id": "K02", "role": "last", "path": "frames/K02.png", "approved": True},
                    ],
                    "keyframe_notes": [],
                }
            )
        )

    def test_summary_files_and_media_parameters(self):
        video, base, keyframes = tool.resolve(package=self.package, root=self.root)
        self.assertEqual((video, base, len(keyframes)), (self.work / "original.mp4", self.package, 2))
        report = tool.summarize(video, base / "preview", keyframes)
        media = report["media"]
        self.assertEqual(
            (media["width"], media["height"], media["r_frame_rate"], media["nb_frames"], media["audio_streams"]),
            (640, 360, "24/1", 49, 0),
        )
        out = self.package / "preview"
        for name in (
            "contact-sheet.png",
            "first-frame.png",
            "last-frame.png",
            "compare-first.png",
            "compare-last.png",
            "preview-2x.mp4",
        ):
            self.assertTrue((out / name).is_file(), name)
        self.assertEqual(report["sampled_frames"][0], 0)
        self.assertEqual(report["sampled_frames"][-1], 48)
        self.assertEqual(len(report["sampled_frames"]), 12)
        grid = Image.open(out / "contact-sheet.png")
        self.assertEqual(grid.size, (4 * 480, 3 * (270 + 26)))
        self.assertEqual(Image.open(out / "first-frame.png").size, (640, 360))
        preview = tool.probe(out / "preview-2x.mp4")
        self.assertEqual(preview["width"], 960)
        self.assertLess(preview["duration"], media["duration"] * 0.6)
        self.assertIn("ожидает просмотра", tool.table(report))
        self.assertNotIn("sha256", json.dumps(report))

    def test_plain_video_without_package_and_undownloaded_attempt(self):
        video, base, keyframes = tool.resolve(video=self.work / "original.mp4", root=self.root)
        self.assertEqual((base, keyframes), (self.work, []))
        report = tool.summarize(video, self.root / "out", preview=False)
        self.assertNotIn("preview_2x", report["files"])
        self.assertNotIn("comparisons", report["files"])
        (self.work / "attempt.json").write_text(json.dumps({"status": "running"}))
        with self.assertRaises(ValueError):
            tool.resolve(work_dir=self.work, root=self.root)


if __name__ == "__main__":
    unittest.main()
