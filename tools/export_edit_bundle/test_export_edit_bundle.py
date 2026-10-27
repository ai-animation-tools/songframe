"""Таблица планов, EDL, FCPXML, строки песни и копирование исходников на временной фикстуре; @link README.md"""

import sys
from pathlib import Path

# После переноса точка запуска находится на два уровня ниже корня проекта.
# Полные импорты tools.* работают и при прямом запуске файла из любой папки.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))


import csv
import hashlib
import json
import tempfile
import unittest
import xml.etree.ElementTree as ET

from tools.export_edit_bundle import export_edit_bundle as tool

SHA = "b" * 64


def scene(sid, start, end, lipsync=False):
    return {
        "id": sid,
        "original": sid,
        "sequence": "s",
        "title": "План " + sid,
        "start_frame": start,
        "end_frame_exclusive": end,
        "camera": "статика",
        "action": "действие " + sid,
        "continuity": "связь",
        "references": ["П"],
        "lipsync": lipsync,
        "card": {"primary_reference": "П"},
        "state_from": None,
        "state_changes": {},
    }


class ExportEditBundleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="edit-bundle-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "repo"
        for name in ("plan/audio", "plan/animatic/cards", "assets/shots/M01", "source/heroes"):
            (self.root / name).mkdir(parents=True)
        registry = {
            "schema_version": 1,
            "fps": 30,
            "audio": {"path": "source/track.mp3", "end_seconds": "4"},
            "references": {"П": {"name": "Мира", "path": "source/heroes/mira.jpg"}},
            "visual_direction": "# Правила",
            "sequences": [{"id": "s", "title": "Сцена", "direction": "направление"}],
            "scenes": [scene("M01", 0, 60, True), scene("M02", 60, 120)],
        }
        (self.root / "plan/scenes.json").write_text(json.dumps(registry, ensure_ascii=False), encoding="utf-8")
        (self.root / "plan/project.json").write_text(
            json.dumps({"schema_version": 1, "name": "Тест", "animatic_video": "test.mp4"})
        )
        (self.root / "plan/audio/timing.json").write_text(
            json.dumps(
                {
                    "status": "оценки",
                    "lines": [{"id": 1, "source_line": 1, "start": 0.5, "end": 1.75, "note": "оценка"}],
                }
            )
        )
        (self.root / "source/text.md").write_text("Первая строка\n", encoding="utf-8")
        for name in (
            "source/track.mp3",
            "source/heroes/mira.jpg",
            "plan/animatic/cards/M02.png",
            "assets/shots/M01/original.mp4",
            "assets/shots/M01/video.mp4",
            "assets/shots/M01/in.png",
            "assets/shots/M01/prompt.txt",
            "assets/shots/M01/speech.wav",
            "assets/shots/M01/audio-recipe.json",
            "assets/shots/M01/generation-request.json",
        ):
            (self.root / name).write_bytes(("файл " + name).encode())
        self.manifest = {
            "schema_version": 1,
            "shot": "M01",
            "kind": "generated_video",
            "generation": {
                "source_shot": "M01",
                "original": {"path": "original.mp4", "sha256": SHA},
                "original_media": {"r_frame_rate": "24/1", "duration": "5.041667"},
                "prompt": {"path": "prompt.txt", "sha256": SHA},
                "request": {"path": "generation-request.json", "sha256": SHA},
                "generation_id": "job",
                "inputs": [
                    {"path": "in.png", "sha256": SHA},
                    {"path": "heroes/mira.jpg", "sha256": SHA, "root": "source"},
                ],
                "lipsync": True,
                "audio": {"path": "speech.wav", "sha256": SHA},
            },
            "accepted_edit": {
                "video": {"path": "video.mp4", "sha256": SHA},
                "fps": 30,
                "frames": 60,
                "duration_seconds": 2.0,
                "source_interval_seconds": [0.5, 2.0],
                "source_fps": "24/1",
                "speed": {"factor": 0.75, "ratio": "3/4"},
                "hold_first_seconds": 0,
                "hold_last_seconds": 0.1,
                "still_source_time_seconds": None,
                "rebuild": {
                    "stages": [{"input": "original.mp4", "filter": "fps=30", "frames": 60}],
                    "source": {"path": "original.mp4", "sha256": SHA},
                },
            },
        }
        (self.root / "assets/shots/M01/manifest.json").write_text(
            json.dumps(self.manifest, ensure_ascii=False), encoding="utf-8"
        )

    def test_tables_edl_and_fcpxml(self):
        out = Path(self.temp.name) / "bundle"
        result = tool.export(out, self.root)
        self.assertEqual((result["shots"], result["videos"], result["copied_files"]), (2, 1, 0))
        rows = list(csv.DictReader((out / "shots.csv").open(encoding="utf-8")))
        first, second = rows
        self.assertEqual(
            (first["status"], first["song_in_tc"], first["song_out_tc"], first["frames_30"]),
            ("video", "00:00:00:00", "00:00:02:00", "60"),
        )
        self.assertEqual(
            (first["source_in_frame_native"], first["source_out_frame_native"], first["source_grid_fps"]),
            ("12", "48", "24.0"),
        )
        self.assertEqual(
            (first["speed"], first["hold_last_s"], first["lipsync"], first["speech_wav"]),
            ("0.75", "0.1", "True", "assets/shots/M01/speech.wav"),
        )
        self.assertEqual(first["inputs"], "assets/shots/M01/in.png; source/heroes/mira.jpg")
        self.assertEqual(
            (second["status"], second["card"], second["song_in_tc"]),
            ("card", "plan/animatic/cards/M02.png", "00:00:02:00"),
        )
        edl = (out / "timeline.edl").read_text(encoding="utf-8")
        self.assertIn("001  M01      V     C        00:00:00:15 00:00:02:00 00:00:00:00 00:00:02:00", edl)
        self.assertIn("M2   M01      022.5", edl)
        self.assertIn("* CARD M02", edl)
        tree = ET.parse(out / "timeline.fcpxml")
        spine = tree.getroot().find("./library/event/project/sequence/spine")
        clips = list(spine)
        self.assertEqual([c.tag for c in clips], ["asset-clip", "video"])
        self.assertEqual(
            (clips[0].get("offset"), clips[0].get("duration"), clips[1].get("offset")), ("0/30s", "60/30s", "60/30s")
        )
        self.assertEqual(clips[0].find("asset-clip").get("lane"), "-1")
        lyrics = list(csv.DictReader((out / "lyrics.csv").open(encoding="utf-8")))
        self.assertEqual(
            (lyrics[0]["text"], lyrics[0]["start_tc"], lyrics[0]["end_tc"]),
            ("Первая строка", "00:00:00:15", "00:00:01:23"),
        )
        self.assertIn("Планов 2, с видео 1", (out / "README.md").read_text(encoding="utf-8"))
        with self.assertRaises(ValueError):
            tool.export(out, self.root)

    def test_copy_mode_rewrites_paths_and_preserves_bytes(self):
        out = Path(self.temp.name) / "copy-bundle"
        result = tool.export(out, self.root, copy=True)
        self.assertEqual(result["copied_files"], 10)
        rows = list(csv.DictReader((out / "shots.csv").open(encoding="utf-8")))
        self.assertEqual(rows[0]["original"], "media/assets/shots/M01/original.mp4")
        self.assertEqual(
            hashlib.sha256((out / rows[0]["original"]).read_bytes()).hexdigest(),
            hashlib.sha256((self.root / "assets/shots/M01/original.mp4").read_bytes()).hexdigest(),
        )
        self.assertTrue(
            (out / "media/source/track.mp3").is_file() and (out / "media/plan/animatic/cards/M02.png").is_file()
        )
        xml = (out / "timeline.fcpxml").read_text(encoding="utf-8")
        self.assertIn("media/assets/shots/M01/video.mp4", xml)
        self.assertNotIn(str(self.root), xml)


if __name__ == "__main__":
    unittest.main()
