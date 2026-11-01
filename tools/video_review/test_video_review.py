"""Проверки реальных кадров и таймкодов на синтетическом видео; @link README.md."""

import json
import random
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from tools.video_review import video_review as tool


class VideoReviewTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="video-review-test-", dir="/tmp")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.video = self.root / "video.mkv"
        self.out = self.root / "review"

    def make_video(self, count=25, fps=10, size="160x90", extra=()):
        subprocess.run([
            "ffmpeg", "-v", "error", "-nostdin", "-f", "lavfi", "-i", f"testsrc2=s={size}:r={fps}",
            "-frames:v", str(count), *extra, "-c:v", "ffv1", str(self.video),
        ], check=True, capture_output=True)

    def assert_frame_matches(self, frame, index):
        # Сравниваем с независимым извлечением по индексу: совпадают пиксели, а не только имена файлов.
        expected = subprocess.run([
            "ffmpeg", "-v", "error", "-i", str(self.video), "-vf", f"select=eq(n\\,{index})",
            "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
        ], check=True, capture_output=True).stdout
        with Image.open(frame["path"]) as image:
            self.assertEqual(image.convert("RGB").tobytes(), expected)

    def test_actual_frames_timestamps_and_manifest(self):
        self.make_video()
        report = tool.extract(self.video, self.out)
        frames = report["frames"]
        self.assertEqual([frame["time_seconds"] for frame in frames], [0, 0.5, 1, 1.5, 2, 2.4])
        self.assertAlmostEqual(report["duration_seconds"], 2.5)
        self.assertEqual(report["references"], [])
        self.assertEqual(json.loads((self.out / "manifest.json").read_text()), report)
        for number, frame in enumerate(frames, 1):
            self.assertEqual(frame["id"], f"F{number:03d}")
            self.assertTrue(Path(frame["path"]).is_absolute())
            self.assert_frame_matches(frame, round(frame["time_seconds"] * 10))
            with Image.open(frame["path"]) as image:
                self.assertEqual(image.size, (160, 90))

    def test_variable_frame_rate_uses_actual_timestamps(self):
        self.make_video(count=8, extra=("-vf", "setpts=N*N/(10*TB)", "-fps_mode", "vfr"))
        report = tool.extract(self.video, self.out)
        # PTS: 0, .1, .4, .9, 1.6, 2.5, 3.6, 4.9; последний кадр не 7/fps и не конец контейнера.
        self.assertAlmostEqual(report["frames"][-1]["time_seconds"], 4.9)
        for frame in report["frames"]:
            index = min(range(8), key=lambda number: abs(number * number / 10 - frame["time_seconds"]))
            self.assertAlmostEqual(frame["time_seconds"], index * index / 10)
            self.assert_frame_matches(frame, index)

    def test_single_frame_and_existing_empty_directory(self):
        self.make_video(count=1)
        self.out.mkdir()
        report = tool.extract(self.video, self.out)
        self.assertEqual(len(report["frames"]), 1)
        self.assertEqual(report["frames"][0]["time_seconds"], 0)

    def test_long_video_cap_and_downscaling(self):
        self.make_video(count=40, fps=1, size="1200x600")
        report = tool.extract(self.video, self.out)
        self.assertLessEqual(len(report["frames"]), 32)
        self.assertEqual(report["frames"][-1]["time_seconds"], 39)
        with Image.open(report["frames"][0]["path"]) as image:
            self.assertEqual(image.size, (960, 480))

    def test_nonempty_output_is_preserved(self):
        self.make_video(count=1)
        self.out.mkdir()
        keep = self.out / "keep.txt"
        keep.write_text("сохранить")
        with self.assertRaisesRegex(ValueError, "новой или пустой"):
            tool.extract(self.video, self.out)
        self.assertEqual(keep.read_text(), "сохранить")

    def test_invalid_video_and_relative_paths(self):
        self.video.write_bytes(b"broken")
        with self.assertRaises(ValueError):
            tool.extract(self.video, self.out)
        self.assertFalse(self.out.exists())
        with self.assertRaisesRegex(ValueError, "абсолютными"):
            tool.extract(Path("relative.mp4"), self.out)

    def test_reference_copies_and_limit(self):
        self.make_video(count=1)
        source = self.root / "reference.png"
        Image.new("RGB", (1600, 800), "red").save(source)
        before = source.read_bytes()
        report = tool.extract(self.video, self.out, [source])
        reference = report["references"][0]
        self.assertEqual(reference["id"], "R001")
        self.assertEqual(reference["source_path"], str(source))
        self.assertEqual(source.read_bytes(), before)
        with Image.open(reference["path"]) as image:
            self.assertEqual(image.size, (960, 480))
        with self.assertRaisesRegex(ValueError, "20"):
            tool.extract(self.video, self.root / "too-many", [source] * 21)

    def noisy_reference(self):
        source = self.root / "noisy-reference.png"
        payload = random.Random(17).randbytes(960 * 540 * 3)
        Image.frombytes("RGB", (960, 540), payload).save(source)
        return source

    def test_large_image_set_fits_shared_budget_without_losing_slots(self):
        source = self.noisy_reference()
        original = source.read_bytes()
        stage = self.root / "budget-stage"
        stage.mkdir()
        ids = [f"F{number:03d}" for number in range(1, 33)] + [f"R{number:03d}" for number in range(1, 21)]
        paths = [stage / f"{identifier}.png" for identifier in ids]
        for path in paths:
            shutil.copyfile(source, path)
        self.assertGreater(sum(path.stat().st_size for path in paths), 20 * 1024 * 1024)
        packed = tool.budget_images(paths)
        self.assertEqual([path.stem for path in packed], ids)
        self.assertEqual(len(packed), 52)
        sizes = [path.stat().st_size for path in packed]
        self.assertLessEqual(sum(sizes), tool.IMAGE_BUDGET)
        self.assertTrue(all(size <= min(tool.IMAGE_FILE_BUDGET, tool.IMAGE_BUDGET // 52) for size in sizes))
        for path in packed:
            self.assertEqual(path.suffix, ".jpg")
            self.assertFalse(path.with_suffix(".png").exists())
            with Image.open(path) as image:
                self.assertLessEqual(max(image.size), 960)
                self.assertAlmostEqual(image.width / image.height, 16 / 9, places=2)
        self.assertEqual(source.read_bytes(), original)

    def test_small_png_remains_byte_exact_and_small_budget_reduces_dimensions(self):
        small = self.root / "F001.png"
        Image.new("RGB", (16, 9), "red").save(small)
        before = small.read_bytes()
        self.assertEqual(tool.budget_images([small]), [small])
        self.assertEqual(small.read_bytes(), before)
        noisy = self.noisy_reference()
        packed = tool.budget_images([noisy], total_budget=2048)
        self.assertLessEqual(packed[0].stat().st_size, 2048)
        with Image.open(packed[0]) as image:
            self.assertLess(image.width, 960)
            self.assertLess(image.height, 540)
            self.assertAlmostEqual(image.width / image.height, 16 / 9, delta=0.08)

    def test_packed_reference_path_and_frame_times_match_saved_manifest(self):
        self.make_video()
        source = self.noisy_reference()
        before = source.read_bytes()
        packer = tool.budget_images
        with patch.object(tool, "budget_images", side_effect=lambda paths, **kwargs: packer(paths, total_budget=7168)):
            report = tool.extract(self.video, self.out, [source])
        self.assertTrue(any(Path(frame["path"]).suffix == ".jpg" for frame in report["frames"]))
        self.assertEqual([frame["time_seconds"] for frame in report["frames"]], [0, 0.5, 1, 1.5, 2, 2.4])
        self.assertEqual([frame["id"] for frame in report["frames"]], [f"F{number:03d}" for number in range(1, 7)])
        reference = report["references"][0]
        self.assertEqual(reference["id"], "R001")
        self.assertEqual(reference["source_path"], str(source))
        self.assertEqual(Path(reference["path"]).name, "R001.jpg")
        self.assertTrue(Path(reference["path"]).is_file())
        self.assertEqual(source.read_bytes(), before)
        self.assertEqual(json.loads((self.out / "manifest.json").read_text()), report)
        total = sum(Path(item["path"]).stat().st_size for item in report["frames"] + report["references"])
        self.assertLessEqual(total, 7168)

    def test_impossible_image_budget_does_not_publish_partial_output(self):
        self.make_video(count=1)
        original = tool.budget_images
        with patch.object(tool, "budget_images", side_effect=lambda paths, **kwargs: original(paths, total_budget=1)):
            with self.assertRaisesRegex(ValueError, "лимит|Лимит"):
                tool.extract(self.video, self.out)
        self.assertFalse(self.out.exists())
        self.assertEqual(list(self.root.glob("video-review-*")), [])

    def test_cli_six_mib_budget_bounds_noisy_reference_set(self):
        self.make_video(count=1)
        source = self.noisy_reference()
        before = source.read_bytes()
        budget = 6 * 1024 * 1024
        references = [argument for _ in range(20) for argument in ("--reference", str(source))]
        result = subprocess.run([
            sys.executable, "-B", str(Path(tool.__file__)), "--video", str(self.video), "--out", str(self.out),
            "--image-budget-bytes", str(budget), *references, "--json",
        ], check=True, capture_output=True, text=True)
        report = json.loads(result.stdout)
        self.assertEqual(len(report["frames"]), 1)
        self.assertEqual(report["frames"][0]["time_seconds"], 0)
        self.assertEqual([item["id"] for item in report["references"]], [f"R{number:03d}" for number in range(1, 21)])
        sizes = [Path(item["path"]).stat().st_size for item in report["frames"] + report["references"]]
        self.assertGreater(len(before) * 20, budget)
        self.assertLessEqual(sum(sizes), budget)
        self.assertTrue(all(size <= min(tool.IMAGE_FILE_BUDGET, budget // 21) for size in sizes))
        self.assertEqual(source.read_bytes(), before)
        self.assertEqual(json.loads((self.out / "manifest.json").read_text()), report)

    def test_invalid_image_budget_is_rejected_before_extraction(self):
        for value in (0, -1, tool.IMAGE_BUDGET + 1):
            with self.subTest(budget=value):
                with patch.object(tool, "probe", side_effect=AssertionError("Извлечение не должно начинаться")):
                    with self.assertRaisesRegex(ValueError, "Бюджет изображений"):
                        tool.extract(self.video, self.out, image_budget=value)
                result = subprocess.run([
                    sys.executable, "-B", str(Path(tool.__file__)), "--video", str(self.video), "--out", str(self.out),
                    "--image-budget-bytes", str(value), "--json",
                ], capture_output=True, text=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("Бюджет изображений", result.stderr)
                self.assertFalse(self.out.exists())

    def test_cli_json_without_project(self):
        self.make_video(count=1)
        result = subprocess.run([
            sys.executable, "-B", str(Path(tool.__file__)), "--video", str(self.video),
            "--out", str(self.out), "--project", str(self.root / "unused-project"), "--json",
        ], cwd="/tmp", check=True, capture_output=True, text=True)
        self.assertEqual(json.loads(result.stdout)["schema_version"], 1)


if __name__ == "__main__":
    unittest.main()
