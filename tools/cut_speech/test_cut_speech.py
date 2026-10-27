"""Срез речи по разметке и по границам, рецепт и его проверка на временной фикстуре; @link README.md"""

import sys
from pathlib import Path

# После переноса точка запуска находится на два уровня ниже корня проекта.
# Полные импорты tools.* работают и при прямом запуске файла из любой папки.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))


import json
import subprocess
import tempfile
import unittest
import wave

from tools.cut_speech import cut_speech as tool


def scene(sid, start, end, lipsync):
    return {
        "id": sid,
        "original": sid,
        "sequence": "s",
        "title": sid,
        "start_frame": start,
        "end_frame_exclusive": end,
        "camera": "статика",
        "action": "действие",
        "continuity": "связь",
        "references": ["П"],
        "lipsync": lipsync,
        "card": {"primary_reference": "П"},
        "state_from": None,
        "state_changes": {},
    }


class CutSpeechTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="cut-speech-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "plan/audio").mkdir(parents=True)
        (self.root / "source").mkdir()
        subprocess.run(
            [
                "ffmpeg",
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:sample_rate=44100",
                "-t",
                "6",
                "-ac",
                "2",
                "-c:a",
                "pcm_s16le",
                str(self.root / "source/track.wav"),
            ],
            check=True,
        )
        registry = {
            "schema_version": 1,
            "fps": 30,
            "audio": {"path": "source/track.wav", "end_seconds": "6"},
            "references": {"П": {"name": "Мира", "path": "source/heroes/mira.jpg"}},
            "visual_direction": "# Правила",
            "sequences": [{"id": "s", "title": "Сцена", "direction": "направление"}],
            "scenes": [scene("M01", 0, 90, False), scene("M02", 90, 180, True)],
        }
        (self.root / "plan/scenes.json").write_text(json.dumps(registry, ensure_ascii=False), encoding="utf-8")
        (self.root / "plan/audio/timing.json").write_text(
            json.dumps(
                {
                    "lines": [
                        {"id": 1, "source_line": 1, "start": 1.0, "end": 2.5, "note": "оценка"},
                        {"id": 2, "source_line": 2, "start": 3.2, "end": 4.4, "note": "сверка на слух не выполнена"},
                        {"id": 3, "source_line": 3, "start": 5.5, "end": 5.9},
                    ]
                }
            )
        )
        (self.root / "source/text.md").write_text("Первая строка\nВторая строка\nТретья\n", encoding="utf-8")

    def test_lines_in_window_and_proposal_with_margins(self):
        source, window, lines, lipsync = tool.speech_lines(self.root, "M02")
        self.assertEqual((source, window, lipsync), ("source/track.wav", (3.0, 6.0), True))
        self.assertEqual([line["id"] for line in lines], [2, 3])
        self.assertEqual(lines[0]["text"], "Вторая строка")
        self.assertEqual(tool.propose(window, lines, 0.5, 0.5, 0), (2.7, 6.4))
        self.assertEqual(tool.propose(window, lines, 0.2, 0.1, 5), (3.0, 8.0))
        with self.assertRaises(ValueError):
            tool.propose(window, [], 0.5, 0.5, 0)

    def test_cut_is_sample_exact_and_recipe_verifies(self):
        out = self.root / "out"
        recipe = tool.cut(
            self.root, "source/track.wav", 1.0, 2.5, out, "M02", [{"id": 1, "source_line": 1, "start": 1.0, "end": 2.5}]
        )
        self.assertEqual((recipe["start_sample"], recipe["end_sample_exclusive"]), (44100, 110250))
        self.assertEqual(recipe["source_interval_seconds"], [1.0, 2.5])
        with wave.open(str(out / "speech.wav")) as stream:
            self.assertEqual(
                (stream.getnchannels(), stream.getsampwidth(), stream.getframerate(), stream.getnframes()),
                (2, 2, 44100, 66150),
            )
        pcm = tool.decode(self.root / "source/track.wav")
        with wave.open(str(out / "speech.wav")) as stream:
            self.assertEqual(stream.readframes(66150), pcm[44100 * 4 : 110250 * 4])
        result = tool.verify(self.root, out / "audio-recipe.json")
        self.assertTrue(result["match"] and result["pcm_match"])
        self.assertEqual(recipe["timing_lines"][0]["id"], 1)
        with self.assertRaises(ValueError):
            tool.cut(self.root, "source/track.wav", 1.0, 2.5, out, "M02")
        with self.assertRaises(ValueError):
            tool.cut(self.root, "source/track.wav", 5.0, 7.0, self.root / "late", "M02")
        with self.assertRaises(ValueError):
            tool.cut(self.root, "source/track.wav", 2.0, 2.0, self.root / "empty", "M02")


if __name__ == "__main__":
    unittest.main()
