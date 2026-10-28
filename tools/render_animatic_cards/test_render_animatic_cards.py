"""Карточки без обрезки опор и без ссылок на глобальный реестр; @link README.md"""

import sys
from pathlib import Path

# После переноса точка запуска находится на два уровня ниже корня проекта.
# Полные импорты tools.* работают и при прямом запуске файла из любой папки.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))


import tempfile
import unittest

from PIL import Image

from tools.render_animatic_cards.render_animatic_cards import SIZE, fit_canvas, render_card, render_keyframe_card

PROJECT = {"schema_version": 1, "name": "Тестовый клип", "animatic_video": "test.mp4"}


def shot(**extra):
    base = {
        "id": "M02",
        "title": "Технический план",
        "interval": "00:00.4–00:00.8",
        "duration": "0.4",
        "camera": "Статика, средний план",
        "action": "Герой смотрит в кадр.",
        "state": "Без изменений.",
        "refs": ["A", "B"],
        "card": {"primary_reference": "A"},
    }
    base.update(extra)
    return base


class CardTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="cards-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "frames").mkdir()
        Image.new("RGB", (1024, 576), "blue").save(self.root / "frames/K01.png")
        Image.new("RGB", (400, 400), "green").save(self.root / "frames/K02.png")
        Image.new("RGB", (300, 200), "red").save(self.root / "a.png")
        Image.new("RGB", (200, 300), "white").save(self.root / "b.png")
        self.references = {
            "A": {"path": "a.png", "name": "Референс A", "short_name": "A"},
            "B": {"path": "b.png", "name": "Референс B"},
        }

    def keyframes(self, *ids):
        return [
            {
                "id": kid,
                "role": "first" if kid == "K01" else "last",
                "time_seconds": 0.0 if kid == "K01" else 5.0,
                "path": f"frames/{kid}.png",
                "sha256": "",
            }
            for kid in ids
        ]

    def test_fonts_ship_next_to_module_with_license(self):
        from PIL import ImageFont

        from tools.render_animatic_cards import render_animatic_cards as cards

        folder = Path(cards.__file__).resolve().parent / "fonts"
        for path in (cards.FONT, cards.BOLD):
            self.assertEqual(path.parent, folder)
            self.assertTrue(path.is_file(), path)
            ImageFont.truetype(str(path), 20)
        self.assertIn("Bitstream Vera", (folder / "LICENSE").read_text(encoding="utf-8"))

    def test_fit_keeps_whole_image_without_stretching(self):
        canvas = fit_canvas(self.root / "frames/K02.png")
        self.assertEqual(canvas.size, SIZE)
        # Квадратная опора занимает центр по высоте, поля слева и справа остаются фоном.
        self.assertEqual(canvas.getpixel((640, 360)), (0, 128, 0))
        self.assertEqual(canvas.getpixel((640, 10)), (0, 128, 0))
        self.assertEqual(canvas.getpixel((10, 360)), (0x17, 0x1E, 0x24))

    def test_keyframe_card_shows_first_frame_and_writes_last_for_transition(self):
        card, last = self.root / "card.png", self.root / "last.png"
        info = render_keyframe_card(shot(), card, PROJECT, self.keyframes("K01", "K02"), self.root, last_target=last)
        self.assertEqual(info, {"keyframes": ["K01", "K02"], "has_last": True})
        with Image.open(card) as image, Image.open(last) as tail:
            self.assertEqual((image.size, tail.size), (SIZE, SIZE))
            # Середина карточки — первая опора без затемнения; последняя опора сохранена целиком, без подписей.
            self.assertEqual(image.getpixel((640, 360)), (0, 0, 255))
            self.assertEqual(tail.getpixel((640, 360)), (0, 128, 0))
            self.assertEqual(tail.getpixel((640, 10)), (0, 128, 0))

    def test_single_keyframe_has_no_transition_frame(self):
        card, last = self.root / "card.png", self.root / "last.png"
        info = render_keyframe_card(shot(), card, PROJECT, self.keyframes("K01"), self.root, last_target=last)
        self.assertEqual(info, {"keyframes": ["K01"], "has_last": False})
        self.assertTrue(card.is_file())
        self.assertFalse(last.exists())
        with self.assertRaises(ValueError):
            render_keyframe_card(shot(), card, PROJECT, [], self.root)

    def test_long_texts_are_shortened_instead_of_failing(self):
        from PIL import ImageDraw, ImageFont

        from tools.render_animatic_cards.render_animatic_cards import FONT, text_box

        # Длинная постановка настоящего проекта не должна останавливать приёмку и сборку.
        long = shot(camera="Средне-общий; неподвижная камера. " * 8, action="Герой идёт к машине. " * 30, state="Без изменений. " * 20)
        render_card(long, self.root / "card.png", PROJECT, self.references, self.root)
        render_keyframe_card(long, self.root / "keys.png", PROJECT, self.keyframes("K01", "K02"), self.root)
        self.assertTrue((self.root / "card.png").is_file() and (self.root / "keys.png").is_file())
        drawn = []
        draw = ImageDraw.Draw(Image.new("RGB", (10, 10)))
        draw.text = lambda xy, line, **_: drawn.append(line)
        point = text_box(draw, "слово " * 200, (0, 0), 300, 46, 20)
        font = ImageFont.truetype(str(FONT), point)
        self.assertEqual(len(drawn), 2)
        self.assertTrue(drawn[-1].endswith("…"))
        self.assertTrue(all(draw.textlength(line, font=font) <= 300 for line in drawn))

    def test_derived_shot_title_names_source_and_plain_title_is_unchanged(self):
        from unittest.mock import patch

        from tools.render_animatic_cards import render_animatic_cards as module

        texts = []
        original = module.text_box

        def recording(draw, text, *args, **kwargs):
            texts.append(text)
            return original(draw, text, *args, **kwargs)

        with patch.object(module, "text_box", recording):
            render_card(shot(), self.root / "plain.png", PROJECT, self.references, self.root)
            derived = shot(derived_from={"shot": "M01"})
            render_card(derived, self.root / "derived.png", PROJECT, self.references, self.root)
        self.assertIn("M02  /  Технический план", texts)
        self.assertIn("M02  /  Технический план  •  из M01", texts)

    def test_reference_card_uses_only_given_context(self):
        card = self.root / "card.png"
        info = render_card(shot(lipsync=True), card, PROJECT, self.references, self.root)
        self.assertEqual((info["primary_reference"], info["primary_image"]), ("A", "a.png"))
        self.assertFalse(info["approved_scene_still"])
        with Image.open(card) as image:
            self.assertEqual(image.size, SIZE)
            # Главный референс масштабирован целиком внутрь своей рамки.
            self.assertEqual(image.getpixel((360, 353)), (255, 0, 0))


if __name__ == "__main__":
    unittest.main()
