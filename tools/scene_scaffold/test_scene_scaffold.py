"""Тесты каркаса реестра: окна по строкам и инструменталу, стыковка частей, заготовки полей."""

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from tools.scene_scaffold import scene_scaffold as tool

CAST = {
    "schema_version": 1,
    "properties": {},
    "entities": [
        {
            "id": "world",
            "kind": "world",
            "name": "Мир",
            "short_name": "Мир",
            "role": "",
            "appearance": "",
            "images": [],
            "initial_state": {"weather": "пасмурно"},
        },
        {
            "id": "mira",
            "kind": "character",
            "name": "Мира",
            "short_name": "Мира",
            "role": "",
            "appearance": "",
            "images": ["heroes/mira.jpg"],
            "initial_state": {},
        },
        {
            "id": "boat",
            "kind": "vehicle",
            "name": "Лодка",
            "short_name": "Лодка",
            "role": "",
            "appearance": "",
            "images": ["vehicles/boat.png"],
            "initial_state": {},
        },
    ],
}
TEXT = ["[Куплет]", "первая строка", "вторая строка", "", "[Припев]", "третья строка"]
TIMING = {
    "duration_container": 40.0,
    "lines": [
        {"id": 1, "source_line": 2, "start": 10.0, "end": 13.0},
        {"id": 2, "source_line": 3, "start": 13.5, "end": 16.0},
        {"id": 3, "source_line": 6, "start": 22.0, "end": 25.0},
    ],
}
TREATMENT = {
    "schema_version": 1,
    "sequences": [
        {
            "id": "intro",
            "title": "Вступление",
            "direction": "дорога",
            "start": 0,
            "end": 10.0,
            "entities": ["boat", "world"],
            "max_shot_seconds": 5,
        },
        {
            "id": "verse",
            "title": "Куплет",
            "direction": "едут",
            "start": 10.0,
            "end": 20.0,
            "entities": ["mira", "boat"],
            "lipsync": True,
        },
        {"id": "chorus", "title": "Припев", "direction": "застряли", "start": 20.0, "end": 40.0, "entities": ["mira"]},
    ],
}


class ScaffoldTests(unittest.TestCase):
    def test_windows_follow_lines_and_instrumental_parts(self):
        data = tool.build_scenes(TREATMENT, TIMING, TEXT, CAST, 40.0)
        ids = [(s["id"], s["start_frame"], s["end_frame_exclusive"], s["sequence"]) for s in data["scenes"]]
        self.assertEqual(
            ids,
            [
                ("M01", 0, 150, "intro"),
                ("M02", 150, 300, "intro"),
                ("M03", 300, 405, "verse"),
                ("M04", 405, 480, "verse"),
                ("M05", 480, 600, "verse"),
                ("M06", 600, 750, "chorus"),
                ("M07", 750, 975, "chorus"),
                ("M08", 975, 1200, "chorus"),
            ],
        )
        # Пауза 2 с перед третьей строкой короче порога, поэтому строка берёт начало части.
        # Хвост 15 с без вокала делится по 6 с.
        by_id = {s["id"]: s for s in data["scenes"]}
        self.assertEqual(by_id["M03"]["original"], "первая строка")
        self.assertTrue(by_id["M03"]["lipsync"])
        self.assertFalse(by_id["M05"]["lipsync"])  # хвост куплета без строки
        self.assertEqual(by_id["M01"]["original"], "Инструментал: Вступление")
        self.assertEqual(by_id["M01"]["references"], ["boat"])  # world без изображения в references не попадает
        self.assertEqual(by_id["M01"]["card"], {"primary_reference": "boat"})
        self.assertEqual(by_id["M01"]["state_from"], None)
        self.assertEqual(by_id["M02"]["state_from"], "M01")
        self.assertEqual(data["audio"]["end_seconds"], "40")
        self.assertEqual(set(data["references"]), {"mira", "boat"})
        self.assertTrue(data["scenes"][-1]["action"].startswith("ЗАПОЛНИТЬ"))

    def test_treatment_must_cover_the_track_without_gaps(self):
        broken = {
            "schema_version": 1,
            "sequences": [
                dict(TREATMENT["sequences"][0], end=9.0),
                TREATMENT["sequences"][1],
                TREATMENT["sequences"][2],
            ],
        }
        with self.assertRaisesRegex(ValueError, "не стыкуется"):
            tool.build_scenes(broken, TIMING, TEXT, CAST, 40.0)
        short = {"schema_version": 1, "sequences": TREATMENT["sequences"][:2]}
        with self.assertRaisesRegex(ValueError, "трек длится"):
            tool.build_scenes(short, TIMING, TEXT, CAST, 40.0)
        no_images = {"schema_version": 1, "properties": {}, "entities": CAST["entities"][:1]}
        with self.assertRaisesRegex(ValueError, "изображениями"):
            tool.build_scenes(TREATMENT, TIMING, TEXT, no_images, 40.0)

    def test_cli_dry_run_json_returns_complete_registry_without_writes(self):
        with tempfile.TemporaryDirectory(prefix="songframe-scaffold-") as temporary:
            root = Path(temporary)
            (root / "plan/audio").mkdir(parents=True)
            (root / "source").mkdir()
            (root / "plan/project.json").write_text(json.dumps({"schema_version": 1, "name": "Проверка"}))
            (root / "plan/treatment.json").write_text(json.dumps(TREATMENT))
            (root / "plan/audio/timing.json").write_text(
                json.dumps(dict(TIMING, duration_decoded=40.0, duration_container=40.1))
            )
            (root / "plan/cast.json").write_text(json.dumps(CAST))
            (root / "source/text.md").write_text("\n".join(TEXT), encoding="utf-8")
            registry = root / "plan/scenes.json"
            registry.write_text(json.dumps({"visual_direction": "Прежние правила"}), encoding="utf-8")
            before = {path.relative_to(root): path.read_bytes() for path in root.rglob("*") if path.is_file()}
            command = [sys.executable, "-B", str(Path(tool.__file__).resolve()), "--project", str(root)]
            result = subprocess.run(command + ["--dry-run", "--json"], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(
                json.loads(result.stdout),
                tool.build_scenes(TREATMENT, TIMING, TEXT, CAST, 40.0, {"visual_direction": "Прежние правила"}),
            )
            self.assertEqual(
                {path.relative_to(root): path.read_bytes() for path in root.rglob("*") if path.is_file()}, before
            )
            registry.unlink()
            empty_result = subprocess.run(command + ["--json", "--dry-run"], capture_output=True, text=True)
            self.assertEqual(empty_result.returncode, 0, empty_result.stderr)
            self.assertIn("scenes", json.loads(empty_result.stdout))
            self.assertFalse(registry.exists())
            written = subprocess.run(command + ["--json"], capture_output=True, text=True)
            self.assertEqual(written.returncode, 0, written.stderr)
            self.assertTrue(json.loads(written.stdout)["written"])
            current = registry.read_bytes()
            rejected = subprocess.run(command, capture_output=True, text=True)
            self.assertNotEqual(rejected.returncode, 0)
            self.assertEqual(registry.read_bytes(), current)
            forced = subprocess.run(command + ["--force", "--json"], capture_output=True, text=True)
            self.assertEqual(forced.returncode, 0, forced.stderr)
            self.assertTrue(json.loads(forced.stdout)["written"])

    def test_existing_visual_direction_is_kept(self):
        data = tool.build_scenes(TREATMENT, TIMING, TEXT, CAST, 40.0, existing={"visual_direction": "Прежние правила"})
        self.assertEqual(data["visual_direction"], "Прежние правила")


if __name__ == "__main__":
    unittest.main()
