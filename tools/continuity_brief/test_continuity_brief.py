"""Тесты врезки непрерывности: порядок сущностей, подписи из словаря, чек-лист, начальное состояние кастинга."""

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from tools.continuity_brief import continuity_brief as tool
from tools.scene_registry import scene_registry

CAST = {
    "schema_version": 1,
    "entities": [
        {
            "id": "mira",
            "kind": "character",
            "name": "Мира",
            "short_name": "Мира",
            "role": "",
            "appearance": "",
            "images": ["heroes/mira.jpg"],
            "initial_state": {"clothes_condition": "чистая куртка"},
        },
        {
            "id": "world",
            "kind": "world",
            "name": "Мир",
            "short_name": "Мир",
            "role": "",
            "appearance": "",
            "images": [],
            "initial_state": {"weather": "пасмурно", "left_side": "лес"},
        },
        {
            "id": "boat",
            "kind": "vehicle",
            "name": "Лодка",
            "short_name": "Лодка",
            "role": "",
            "appearance": "",
            "images": ["vehicles/boat.png"],
            "initial_state": {"orientation": "вдоль дороги носом вперёд"},
        },
    ],
    "properties": {
        "character": [{"key": "clothes_condition", "label": "Одежда", "checklist": "Одежда: {value}?"}],
        "world": [
            {"key": "weather", "label": "Погода", "checklist": "Погода: {value}?"},
            {"key": "left_side", "label": "Слева по ходу"},
        ],
        "vehicle": [{"key": "orientation", "label": "Ориентация", "checklist": "Транспорт стоит {value}, не поперёк?"}],
    },
}
SCENES = {
    "schema_version": 1,
    "fps": 30,
    "audio": {"path": "source/track.mp3", "end_seconds": "2"},
    "references": {
        "mira": {"name": "Мира", "path": "source/heroes/mira.jpg"},
        "boat": {"name": "Лодка", "path": "source/vehicles/boat.png"},
    },
    "visual_direction": "правила",
    "sequences": [{"id": "s", "title": "С", "direction": ""}],
    "scenes": [
        {
            "id": "M01",
            "original": "",
            "sequence": "s",
            "start_frame": 0,
            "end_frame_exclusive": 30,
            "camera": "к",
            "action": "Едут",
            "continuity": "",
            "references": ["mira"],
            "lipsync": False,
            "card": {"primary_reference": "mira"},
            "state_from": None,
            "state_changes": {
                "after": {"mira": {"clothes_condition": "брызги грязи"}, "unknown_thing": {"where": "на крыше"}}
            },
        },
        {
            "id": "M02",
            "original": "",
            "sequence": "s",
            "start_frame": 30,
            "end_frame_exclusive": 60,
            "camera": "к",
            "action": "Застряли",
            "continuity": "",
            "references": ["boat"],
            "lipsync": False,
            "card": {"primary_reference": "boat"},
            "state_from": "M01",
            "state_changes": {"before": {"boat": {"orientation": "поперёк дороги"}}},
        },
    ],
}


class BriefTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        root = Path(self.temporary.name)
        (root / "plan").mkdir()
        (root / "plan/cast.json").write_text(json.dumps(CAST, ensure_ascii=False))
        (root / "plan/scenes.json").write_text(json.dumps(SCENES, ensure_ascii=False))
        scene_registry._INITIAL_CACHE.clear()
        self.root = root

    def test_initial_state_comes_from_cast_and_brief_lists_world_first(self):
        with patch.object(scene_registry, "ROOT", self.root):
            data = scene_registry.load(self.root)
            before = scene_registry.scene_state(data, "M01")["before"]
            self.assertEqual(before["world"], {"weather": "пасмурно", "left_side": "лес"})
            self.assertEqual(before["mira"], {"clothes_condition": "чистая куртка"})
            result = tool.brief(data, CAST, "M02", "before")
        self.assertEqual(result["text"].splitlines()[2], "Мир: погода: пасмурно; слева по ходу: лес.")
        self.assertIn("Мира: одежда: брызги грязи.", result["text"])
        self.assertIn("Лодка: ориентация: поперёк дороги.", result["text"])
        self.assertIn("unknown_thing: where: на крыше.", result["text"])
        self.assertEqual(
            result["checklist"],
            [
                "Мир: Погода: пасмурно?",
                "Мира: Одежда: брызги грязи?",
                "Лодка: Транспорт стоит поперёк дороги, не поперёк?",
            ],
        )
        self.assertTrue(result["paragraph"].startswith("Состояние на первый кадр M02. Мир: погода: пасмурно"))

    def test_without_cast_state_starts_empty_and_keys_are_raw(self):
        with patch.object(scene_registry, "ROOT", self.root):
            (self.root / "plan/cast.json").unlink()
            scene_registry._INITIAL_CACHE.clear()
            data = scene_registry.load(self.root)
            self.assertEqual(scene_registry.scene_state(data, "M01")["before"], {})
            result = tool.brief(data, None, "M01", "after")
        self.assertIn("mira: clothes condition: брызги грязи.", result["text"])
        self.assertEqual(result["checklist"], [])


if __name__ == "__main__":
    unittest.main()
