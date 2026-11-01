"""Тесты кастинга: создание из исходников, карта references, проверка, синхронизация с реестром сцен."""

import json
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
from unittest.mock import patch

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

    def test_init_preserves_selected_subset_order_and_primary_image(self):
        manifest = json.loads(json.dumps(MANIFEST))
        manifest["references"][0]["files"].append({"path": "heroes/mira-profile.jpg"})
        cast = tool.from_sources(manifest)
        selected = ["heroes/mira-profile.jpg", "heroes/mira-2.jpg"]
        cast["entities"][1]["images"] = selected.copy()
        manifest["references"][0]["files"].reverse()
        manifest["references"][0]["files"].append({"path": "heroes/mira-new.jpg"})

        result = tool.from_sources(manifest, cast)

        self.assertEqual(result["entities"][1]["images"], selected)
        self.assertEqual(tool.references(result)["mira"]["path"], "source/heroes/mira-profile.jpg")
        self.assertEqual(result["entities"][2]["images"], ["vehicles/boat.png"])

    def test_init_preserves_explicit_empty_selection_after_source_images_added(self):
        cast = tool.from_sources(MANIFEST)
        cast["entities"][1]["images"] = []
        manifest = json.loads(json.dumps(MANIFEST))
        manifest["references"][0]["files"].append({"path": "heroes/mira-new.jpg"})

        for _ in range(2):
            cast = tool.from_sources(manifest, cast)
            self.assertEqual(cast["entities"][1]["images"], [])
            self.assertNotIn("mira", tool.references(cast))
            self.assertIn("boat", tool.references(cast))

    def test_repeated_init_adds_new_reference_without_reset_and_force_resets_explicitly(self):
        cast = tool.from_sources(MANIFEST)
        cast["entities"][1]["images"] = ["heroes/mira-2.jpg"]
        tool.write_cast(self.root, cast)
        manifest = json.loads(json.dumps(MANIFEST))
        manifest["references"].append(
            {
                "id": "lena",
                "kind": "character",
                "name": "Лена",
                "files": [{"path": "heroes/lena-front.jpg"}, {"path": "heroes/lena-side.jpg"}],
            }
        )
        (self.root / "source").mkdir()
        (self.root / tool.SOURCE_MANIFEST).write_text(json.dumps(manifest), encoding="utf-8")

        # Проверяем настоящий путь init: чтение сохранённого кастинга, дополнение и повторная запись.
        for _ in range(2):
            with patch.object(tool, "ROOT", self.root), patch.object(sys, "argv", ["cast_registry.py", "init"]):
                with redirect_stdout(StringIO()):
                    tool.main()
            entities = {entity["id"]: entity for entity in tool.load_cast(self.root)["entities"]}
            self.assertEqual(entities["mira"]["images"], ["heroes/mira-2.jpg"])
            self.assertEqual(entities["lena"]["images"], ["heroes/lena-front.jpg", "heroes/lena-side.jpg"])
            self.assertEqual(len(entities), 4)

        with patch.object(tool, "ROOT", self.root), patch.object(sys, "argv", ["cast_registry.py", "init", "--force"]):
            with redirect_stdout(StringIO()):
                tool.main()
        entities = {entity["id"]: entity for entity in tool.load_cast(self.root)["entities"]}
        self.assertEqual(entities["mira"]["images"], ["heroes/mira.jpg", "heroes/mira-2.jpg"])

    def write_source_manifest(self, manifest):
        (self.root / "source").mkdir(exist_ok=True)
        path = self.root / tool.SOURCE_MANIFEST
        path.write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
        return path

    def test_source_description_replaces_stale_appearance_including_explicit_empty(self):
        manifest = json.loads(json.dumps(MANIFEST))
        cast = tool.from_sources(manifest)
        cast["entities"][1]["images"] = ["heroes/mira-2.jpg", "heroes/mira.jpg"]
        cast["entities"][1]["role"] = "рассказчик"
        for description in ["Новое общее описание", ""]:
            with self.subTest(description=description):
                manifest["references"][0]["description"] = description
                cast = tool.from_sources(manifest, cast)
                mira = cast["entities"][1]
                self.assertEqual(mira["appearance"], description)
                self.assertEqual(mira["images"], ["heroes/mira-2.jpg", "heroes/mira.jpg"])
                self.assertEqual(mira["role"], "рассказчик")

    def test_load_projects_source_description_without_writes_and_keeps_unbound_appearance(self):
        cast = tool.from_sources(MANIFEST)
        cast["entities"][0]["appearance"] = "Мир без связанного референса"
        cast["entities"][1]["images"] = ["heroes/mira-2.jpg"]
        cast["entities"][2]["appearance"] = "Лодка без связанного референса"
        path = tool.write_cast(self.root, cast)
        manifest = json.loads(json.dumps(MANIFEST))
        manifest["references"] = manifest["references"][:1]
        manifest["references"][0]["description"] = "Актуальная внешность из исходников"
        source = self.write_source_manifest(manifest)
        before = {file: (file.read_bytes(), file.stat().st_mtime_ns) for file in [path, source]}

        actual = {entity["id"]: entity for entity in tool.load_cast(self.root)["entities"]}

        self.assertEqual(actual["mira"]["appearance"], "Актуальная внешность из исходников")
        self.assertEqual(actual["mira"]["images"], ["heroes/mira-2.jpg"])
        self.assertEqual(actual["world"]["appearance"], "Мир без связанного референса")
        self.assertEqual(actual["boat"]["appearance"], "Лодка без связанного референса")
        self.assertEqual({file: (file.read_bytes(), file.stat().st_mtime_ns) for file in before}, before)
        self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["entities"][1]["appearance"], "коренастый")

    def test_write_projects_canonical_description_without_changing_source_or_callers_cast(self):
        cast = tool.from_sources(MANIFEST)
        cast["entities"][0]["appearance"] = "Самостоятельный мир"
        cast["entities"][1]["appearance"] = "Расходящееся описание из кастинга"
        cast["entities"][1]["images"] = []
        manifest = json.loads(json.dumps(MANIFEST))
        manifest["references"][0]["description"] = ""
        source = self.write_source_manifest(manifest)
        before = source.read_bytes()

        path = tool.write_cast(self.root, cast)
        actual = {entity["id"]: entity for entity in json.loads(path.read_text(encoding="utf-8"))["entities"]}

        self.assertEqual(actual["mira"]["appearance"], "")
        self.assertEqual(actual["mira"]["images"], [])
        self.assertEqual(actual["world"]["appearance"], "Самостоятельный мир")
        self.assertEqual(source.read_bytes(), before)
        self.assertEqual(cast["entities"][1]["appearance"], "Расходящееся описание из кастинга")

    def test_load_and_write_reject_present_corrupt_manifest_without_overwriting_cast(self):
        cast = tool.from_sources(MANIFEST)
        path = tool.write_cast(self.root, cast)
        before = path.read_bytes()
        source = self.write_source_manifest(MANIFEST)
        for invalid in [
            "{",
            "null",
            json.dumps({"schema_version": 2, "references": []}),
            json.dumps({"schema_version": 1, "references": [{"id": "mira", "description": None}]}),
        ]:
            with self.subTest(manifest=invalid):
                source.write_text(invalid, encoding="utf-8")
                with self.assertRaisesRegex(ValueError, "source/manifest.json"):
                    tool.load_cast(self.root)
                with self.assertRaisesRegex(ValueError, "source/manifest.json"):
                    tool.write_cast(self.root, cast)
                self.assertEqual(path.read_bytes(), before)

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
