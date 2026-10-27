"""Проверяет временные пробы на синтетических медиа; @link README.md"""

import sys
from pathlib import Path

# После переноса точка запуска находится на два уровня ниже корня проекта.
# Полные импорты tools.* работают и при прямом запуске файла из любой папки.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))


import json
import tempfile
import unittest
from copy import deepcopy
from unittest.mock import patch

from PIL import Image

from tools.build_review import build_review as review


class ReviewTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="review-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for name in ("source", "plan/animatic/cards", "assets/shots/M01", "assets/shots/M03"):
            (self.root / name).mkdir(parents=True)
        self.registry = {
            "schema_version": 1,
            "fps": 30,
            "audio": {"path": "source/track.mp3", "end_seconds": "1.2"},
            "references": {},
            "sequences": [{"id": "intro", "title": "Тест", "direction": ""}],
            "scenes": [
                {
                    "id": sid,
                    "original": sid,
                    "sequence": "intro",
                    "start_frame": index * 12,
                    "end_frame_exclusive": (index + 1) * 12,
                    "action": "Проба",
                    "camera": "Статика",
                    "continuity": "",
                    "references": [],
                }
                for index, sid in enumerate(("M01", "M02", "M03"))
            ],
        }
        (self.root / "plan/scenes.json").write_text(json.dumps(self.registry))
        review.run(
            [
                "ffmpeg",
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:sample_rate=44100",
                "-t",
                "2",
                "-ac",
                "2",
                str(self.root / "source/track.mp3"),
            ]
        )
        for sid, color in [("M01", "red"), ("M03", "green")]:
            path = self.root / f"assets/shots/{sid}/accepted-edit.mp4"
            review.run(
                [
                    "ffmpeg",
                    "-v",
                    "error",
                    "-f",
                    "lavfi",
                    "-i",
                    f"color=c={color}:s=320x180:r=30",
                    "-frames:v",
                    "12",
                    "-an",
                    "-c:v",
                    "libx264",
                    "-threads",
                    "2",
                    "-pix_fmt",
                    "yuv420p",
                    str(path),
                ]
            )
            (path.parent / "manifest.json").write_text(
                json.dumps(
                    {
                        "shot": sid,
                        "accepted_edit": {
                            "video": {"path": path.name, "sha256": review.sha(path)},
                            "fps": 30,
                            "frames": 12,
                        },
                    }
                )
            )
            (path.parent / "original.mp4").write_bytes(b"original must never be used for accepted shot")
        self.card = self.root / "plan/animatic/cards/M02.png"
        Image.new("RGB", (320, 180), "blue").save(self.card)
        (self.card.parent / "manifest.json").write_text(
            json.dumps(
                {
                    "registry_sha256": review.sha(self.root / "plan/scenes.json"),
                    "reference_hashes": {},
                    "cards": {"M02": {"sha256": review.sha(self.card)}},
                }
            )
        )
        self.spec = {"schema_version": 1, "shots": [{"scene": sid} for sid in ("M01", "M02", "M03")]}
        self.out = self.root / "plan/batches/review/test.mp4"
        self.protected = {
            str(p): review.sha(p)
            for directory in ("assets", "source", "plan/animatic")
            for p in (self.root / directory).rglob("*")
            if p.is_file()
        }

    def assert_preserved(self):
        self.assertTrue(all(review.sha(Path(p)) == digest for p, digest in self.protected.items()))

    def test_plan_only_reads_selected_inputs_and_writes_nothing(self):
        result = review.build(self.spec, self.out, self.root, plan_only=True)
        self.assertEqual([x["origin"] for x in result["shots"]], ["accepted_edit", "registry_card", "accepted_edit"])
        self.assertTrue(result["shots"][0]["path"].endswith("accepted-edit.mp4"))
        self.assertEqual(result["total_frames"], 36)
        self.assertFalse(self.out.parent.exists())
        self.assert_preserved()

    def test_default_cuts_and_repeat_produce_identical_video(self):
        result = review.build(self.spec, self.out, self.root)
        second = review.build(self.spec, self.out.with_name("second.mp4"), self.root)
        self.assertEqual(result["video_sha256"], second["video_sha256"])
        self.assertEqual([x["start_frame"] for x in result["cuts"]], [12, 24])
        self.assertEqual(result["total_frames"], 36)
        self.assertEqual(result["status"], "review_pending")
        review.run(["ffmpeg", "-v", "error", "-i", str(self.out), "-f", "null", "-"])
        self.assert_preserved()

    def test_trim_speed_and_holds_are_recorded_and_replayed(self):
        varying = self.root / "varying.mp4"
        review.run(
            [
                "ffmpeg",
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "nullsrc=s=320x180:r=30,geq=lum=16+N*10:cb=128:cr=128",
                "-frames:v",
                "12",
                "-c:v",
                "libx264",
                "-threads",
                "2",
                "-pix_fmt",
                "yuv420p",
                str(varying),
            ]
        )
        self.spec["shots"][0].update(
            path=str(varying),
            kind="video",
            source_start_frame=3,
            source_end_frame_exclusive=9,
            speed="0.5",
            hold_first_frames=3,
            hold_last_frames=3,
        )
        result = review.build(self.spec, self.out, self.root)
        item = result["shots"][0]
        self.assertEqual(item["frames"], 18)
        self.assertEqual(item["source_interval_seconds"], [0.1, 0.3])
        self.assertEqual(item["duration_change_seconds"], 0.2)
        self.assertEqual(result["total_frames"], 42)
        pixels = review.run(
            [
                "ffmpeg",
                "-v",
                "error",
                "-i",
                str(self.out),
                "-vf",
                r"select=eq(n\,0)+eq(n\,17),scale=1:1",
                "-fps_mode",
                "vfr",
                "-pix_fmt",
                "gray",
                "-f",
                "rawvideo",
                "-",
            ]
        )
        expected = review.run(
            [
                "ffmpeg",
                "-v",
                "error",
                "-i",
                str(varying),
                "-vf",
                r"select=eq(n\,3)+eq(n\,8),scale=1:1",
                "-fps_mode",
                "vfr",
                "-pix_fmt",
                "gray",
                "-f",
                "rawvideo",
                "-",
            ]
        )
        self.assertEqual(len(pixels), 2)
        self.assertEqual(len(expected), 2)
        self.assertLess(abs(pixels[0] - expected[0]), 3)
        self.assertLess(abs(pixels[1] - expected[1]), 3)
        self.assert_preserved()

    def test_speedup_and_holds_preserve_requested_length(self):
        self.spec["shots"] = [{"scene": "M01", "speed": "2", "hold_first_frames": 1, "hold_last_frames": 2}]
        result = review.build(self.spec, self.out, self.root)
        self.assertEqual(result["total_frames"], 9)
        self.assertEqual(result["shots"][0]["motion_frames"], 6)
        self.assertEqual(result["shots"][0]["duration_change_seconds"], -0.2)

    def test_mixed_cut_and_transition_are_repeatable(self):
        self.spec["transitions"] = [{"after": "M02", "type": "fade", "frames": 3}]
        result = review.build(self.spec, self.out, self.root)
        self.assertEqual(result["total_frames"], 33)
        self.assertEqual(result["cuts"][1]["start_frame"], 21)
        second = review.build(self.spec, self.out.with_name("second.mp4"), self.root)
        self.assertEqual(result["video_sha256"], second["video_sha256"])

    def test_two_transitions_preserve_exact_frame_count(self):
        self.spec["transitions"] = [
            {"after": "M01", "type": "dissolve", "frames": 3},
            {"after": "M02", "type": "fadeblack", "frames": 3},
        ]
        result = review.build(self.spec, self.out, self.root)
        self.assertEqual(result["total_frames"], 30)

    def test_explicit_working_clip_is_used_without_promoting_assets(self):
        self.spec["shots"] = [
            {
                "scene": "M02",
                "path": "assets/shots/M01/accepted-edit.mp4",
                "kind": "video",
                "source_end_frame_exclusive": 6,
            }
        ]
        result = review.build(self.spec, self.out, self.root)
        self.assertEqual(result["total_frames"], 6)
        self.assertEqual(result["audio"]["start_frame"], 12)
        self.assert_preserved()

    def test_native_24fps_generation_uses_normalized_30fps_trim(self):
        raw = self.root / "generation-24fps.mp4"
        review.run(
            [
                "ffmpeg",
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=s=320x180:r=24",
                "-frames:v",
                "12",
                "-c:v",
                "libx264",
                "-threads",
                "2",
                "-pix_fmt",
                "yuv420p",
                str(raw),
            ]
        )
        self.spec["shots"] = [
            {
                "scene": "M02",
                "path": str(raw),
                "kind": "video",
                "source_start_frame": 3,
                "source_end_frame_exclusive": 15,
            }
        ]
        result = review.build(self.spec, self.out, self.root)
        self.assertEqual(result["total_frames"], 12)
        self.assertEqual(result["shots"][0]["source_interval_seconds"], [0.1, 0.5])
        self.assertEqual(review.probe(raw)["streams"][0]["r_frame_rate"], "24/1")
        self.assert_preserved()

    def test_invalid_windows_speed_and_unknown_parameters_are_rejected(self):
        for override in [
            dict(source_end_frame_exclusive=13),
            dict(speed=0),
            dict(speed="NaN"),
            dict(source_start_frame=-1),
            dict(speeed=2),
            dict(hold_last_frames=1.5),
        ]:
            spec = deepcopy(self.spec)
            spec["shots"][0].update(override)
            with self.subTest(override=override):
                with self.assertRaises((ValueError, ArithmeticError)):
                    review.build(spec, self.out, self.root)
        self.assertFalse(self.out.exists())

    def test_stale_card_missing_input_and_excessive_transitions_stop_build(self):
        Image.new("RGB", (320, 180), "black").save(self.card)
        with self.assertRaisesRegex(ValueError, "Карточка"):
            review.prepare(self.spec, self.root)
        self.spec["shots"] = [{"scene": "M01"}]
        self.spec["transitions"] = [{"after": "M01", "type": "fade", "frames": 3}]
        with self.assertRaises(ValueError):
            review.prepare(self.spec, self.root)
        self.spec["shots"] = [{"scene": "M01"}, {"scene": "M03"}]
        self.spec.pop("transitions")
        with self.assertRaisesRegex(ValueError, "audio.start_frame"):
            review.prepare(self.spec, self.root)

    def test_no_overwrite_no_short_audio_and_no_protected_output(self):
        self.out.parent.mkdir(parents=True)
        self.out.write_bytes(b"keep")
        with self.assertRaises(ValueError):
            review.build(self.spec, self.out, self.root)
        self.assertEqual(self.out.read_bytes(), b"keep")
        with self.assertRaises(ValueError):
            review.build(self.spec, self.root / "assets/test.mp4", self.root)
        self.spec["audio"] = {"start_frame": 50}
        with self.assertRaisesRegex(ValueError, "песни"):
            review.prepare(self.spec, self.root)
        self.assert_preserved()

    def test_song_end_rounding_preserves_video_and_pads_only_audio_tail(self):
        # Песня заканчивается на 10 мс раньше кадровой границы: проба сохраняет
        # все кадры и исходный срез звука, добавляя только 441 нулевой сэмпл в конце.
        track = self.root / "source/end.wav"
        review.run(
            [
                "ffmpeg",
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:sample_rate=44100",
                "-af",
                "atrim=end_sample=52479",
                "-ac",
                "2",
                str(track),
            ]
        )
        self.spec["audio"] = {"path": "source/end.wav", "start_frame": 12}
        self.spec["shots"] = self.spec["shots"][1:]
        result = review.build(self.spec, self.out, self.root)
        self.assertEqual(result["total_frames"], 24)
        self.assertEqual(result["audio"]["start_frame"], 12)
        self.assertEqual(result["audio"]["end_frame_exclusive"], 36)
        pcm = review.run(
            [
                "ffmpeg",
                "-v",
                "error",
                "-i",
                str(track),
                "-af",
                result["audio"]["filter"],
                "-ac",
                "2",
                "-f",
                "s16le",
                "-",
            ]
        )
        original = review.run(["ffmpeg", "-v", "error", "-i", str(track), "-ac", "2", "-f", "s16le", "-"])
        self.assertEqual(pcm, original[17640 * 4 :] + bytes(441 * 4))
        self.assertEqual(len(pcm), 24 * 1470 * 4)
        music = next(s for s in review.probe(self.out)["streams"] if s["codec_type"] == "audio")
        self.assertLess(abs(float(music["duration"]) - 0.8), 0.003)
        self.assert_preserved()

    def test_song_shortage_over_half_frame_is_rejected(self):
        track = self.root / "source/short.wav"
        review.run(
            [
                "ffmpeg",
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:sample_rate=44100",
                "-af",
                "atrim=end_sample=52038",
                "-ac",
                "2",
                str(track),
            ]
        )
        self.spec["audio"] = {"path": "source/short.wav"}
        with self.assertRaisesRegex(ValueError, "Участок песни короче пробы"):
            review.build(self.spec, self.out, self.root)
        self.assertFalse(self.out.exists())
        self.assert_preserved()

    def test_input_change_during_render_prevents_publication(self):
        original = review.run

        def changed(argv):
            result = original(argv)
            if argv[0] == "ffmpeg":
                self.card.write_bytes(b"changed during render")
            return result

        with patch.object(review, "run", side_effect=changed):
            with self.assertRaisesRegex(ValueError, "изменился"):
                review.build(self.spec, self.out, self.root)
        self.assertFalse(self.out.exists())
        self.assertFalse(self.out.with_suffix(".json").exists())


if __name__ == "__main__":
    unittest.main()
