"""Тесты кастинга: создание из исходников, карта references, проверка, синхронизация с реестром сцен."""

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from tools.cast_registry import cast_registry as tool

MANIFEST = {
    "schema_version": 1,
    "references": [
        {
            "id": "mira",
            "kind": "character",
            "name": "Мира",
            "short_name": "Мира",
            "description": "коренастый",
            "files": [{"path": "heroes/mira.jpg"}, {"path": "heroes/mira-2.jpg"}],
        },
        {
            "id": "boat",
            "kind": "vehicle",
            "name": "Лодка",
            "short_name": "Лодка",
            "description": "",
            "files": [{"path": "vehicles/boat.png"}],
        },
    ],
}


class CastTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        (self.root / "plan").mkdir()

    def test_from_sources_creates_entities_and_world_and_keeps_edits(self):
        cast = tool.from_sources(MANIFEST)
        self.assertEqual([e["id"] for e in cast["entities"]], ["world", "mira", "boat"])
        self.assertEqual(cast["entities"][1]["images"], ["heroes/mira.jpg", "heroes/mira-2.jpg"])
        self.assertEqual(cast["entities"][1]["appearance"], "коренастый")
        self.assertIn("character", cast["properties"])
        cast["entities"][1]["role"] = "рассказчик"
        cast["entities"][1]["initial_state"] = {"clothes_condition": "чистая"}
        again = tool.from_sources(
            {
                "references": MANIFEST["references"][:1]
                + [{"id": "lena", "kind": "character", "name": "Лена", "files": [{"path": "heroes/lena.png"}]}]
            },
            cast,
        )
        by_id = {e["id"]: e for e in again["entities"]}
        self.assertEqual(by_id["mira"]["role"], "рассказчик")
        self.assertEqual(by_id["mira"]["initial_state"], {"clothes_condition": "чистая"})
        self.assertEqual(by_id["lena"]["short_name"], "Лена")
        with_animal = tool.from_sources(
            {"references": [{"id": "dog", "kind": "animal", "name": "Пёс", "files": [{"path": "animals/dog.png"}]}]},
            again,
        )
        dog = {e["id"]: e for e in with_animal["entities"]}["dog"]
        self.assertEqual((dog["kind"], dog["images"]), ("animal", ["animals/dog.png"]))
        self.assertEqual(
            [p["key"] for p in with_animal["properties"]["animal"]], ["position", "condition", "marks", "note"]
        )
        self.assertEqual(tool.labels(with_animal)["animal"]["marks"]["label"], "Сквозные метки")
        self.assertIn("boat", by_id)  # исчезнувший из исходников референс не удаляется молча
        self.assertEqual(tool.validate_cast(again), [])

    def test_references_initial_states_and_validation(self):
        cast = tool.from_sources(MANIFEST)
        cast["entities"][0]["initial_state"] = {"weather": "пасмурно"}
        self.assertEqual(
            tool.references(cast),
            {
                "mira": {"name": "Мира", "path": "source/heroes/mira.jpg"},
                "boat": {"name": "Лодка", "path": "source/vehicles/boat.png"},
            },
        )
        self.assertEqual(tool.initial_states(cast), {"world": {"weather": "пасмурно"}})
        self.assertEqual(tool.initial_states(None), {})
        cast["entities"].append(
            {
                "id": "mira",
                "kind": "Ghost!",
                "name": "",
                "short_name": "",
                "role": "",
                "appearance": "",
                "images": ["bad"],
                "initial_state": {"x": ""},
            }
        )
        problems = tool.validate_cast(cast)
        self.assertEqual(len(problems), 5)
        self.assertIn("character", tool.labels(cast))
        self.assertEqual(tool.labels(None)["vehicle"]["orientation"]["label"], "Ориентация")

    def test_sync_rewrites_references_and_rejects_unknown(self):
        cast = tool.from_sources(MANIFEST)
        tool.write_cast(self.root, cast)
        self.assertIsNotNone(tool.load_cast(self.root))
        scenes = {
            "schema_version": 1,
            "references": {"П": {"name": "Мира", "path": "source/heroes/mira.jpg"}},
            "scenes": [{"id": "M01", "references": ["mira", "—"], "card": {"primary_reference": "boat"}}],
        }
        (self.root / "plan/scenes.json").write_text(json.dumps(scenes, ensure_ascii=False))
        refs = tool.sync_scenes(self.root, cast)
        self.assertEqual(set(refs), {"mira", "boat"})
        self.assertEqual(json.loads((self.root / "plan/scenes.json").read_text())["references"], refs)
        scenes["scenes"][0]["references"] = ["lena"]
        (self.root / "plan/scenes.json").write_text(json.dumps(scenes, ensure_ascii=False))
        with self.assertRaisesRegex(ValueError, "lena"):
            tool.sync_scenes(self.root, cast)
        (self.root / "plan/cast.json").write_text("{")
        with self.assertRaises(ValueError):
            tool.load_cast(self.root)
        self.assertIsNone(tool.load_cast(self.root / "nowhere"))


if __name__ == "__main__":
    unittest.main()
