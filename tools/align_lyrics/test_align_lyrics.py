"""Тесты выравнивания текста по распознаванию: строки, интерполяция, части, сохранение подтверждённых строк."""

import json
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from tools.align_lyrics import align_lyrics as tool

TEXT = (
    "[Куплет 1]\nЗагорелись у реки, яркие огни,\nТихий ветер качает наши листья.\n\n"
    "[Припев]\nСветит, светит маленький фонарь вдали.\nМы смотрели на звёзды, и мечтали до утра.\n"
)


def recognition(words):
    """JSON в духе transcribe_local: один сегмент со словами (слово, начало, конец)."""
    return {
        "model": "test",
        "decoded_duration": 60.0,
        "segments": [
            {
                "start": words[0][1],
                "end": words[-1][2],
                "text": " ".join(w for w, _, _ in words),
                "words": [{"word": w, "start": s, "end": e} for w, s, e in words],
            }
        ],
    }


class AlignTests(unittest.TestCase):
    def test_transcribe_uses_same_python_without_unshare(self):
        """Запрет uid_map не мешает приложению: unshare вообще не вызывается. @link README.md"""
        with TemporaryDirectory(prefix="Клип с пробелами ") as folder:
            root = Path(folder)
            output = root / "recognition.json"
            output.write_text('{"segments": []}', encoding="utf-8")
            with patch.object(tool.subprocess, "run") as run:
                run.return_value.returncode = 0
                self.assertEqual(tool.transcribe(root, root / "model", output), {"segments": []})
                argv = run.call_args.args[0]
                self.assertEqual(argv[0], sys.executable)
                self.assertIn("--allow-network", argv)
                self.assertEqual(argv[argv.index("--device") + 1], "auto")
                self.assertNotIn("unshare", argv)
                self.assertEqual(argv[argv.index("--project") + 1], str(root))
                self.assertEqual(argv[argv.index("--model") + 1], str(root / "model"))
                self.assertEqual(argv[argv.index("--output") + 1], str(output))
                run.return_value.returncode = 1
                with self.assertRaisesRegex(ValueError, "кодом 1"):
                    tool.transcribe(root, root / "model", output)

    def test_model_dictionary_may_be_txt_or_json(self):
        """Medium и large-v3 проверяются одинаково, пустые веса не считаем готовой моделью."""
        with TemporaryDirectory() as directory:
            model = Path(directory)
            for name in ("model.bin", "config.json", "tokenizer.json"):
                (model / name).write_text("fixture")
            self.assertEqual(tool.missing_model_files(model), ["vocabulary.txt или vocabulary.json"])
            for vocabulary in ("vocabulary.txt", "vocabulary.json"):
                (model / vocabulary).write_text("fixture")
                self.assertEqual(tool.missing_model_files(model), [])
                (model / vocabulary).unlink()
            (model / "model.bin").write_bytes(b"")
            self.assertIn("model.bin", tool.missing_model_files(model))

    def test_headers_bom_and_invalid_section_syntax(self):
        """Заголовки не становятся словами даже у UTF-8-файла с BOM; ошибку формата объясняем до ASR."""
        self.assertEqual(
            tool.lyric_lines("\ufeff[Припев]\r\nСлова\r\n[Припев]\r\nПовтор"), [(2, "Слова"), (4, "Повтор")]
        )
        self.assertEqual(tool.lyric_lines("[Соло гитары]\n[Разговор у костра]\nСлова\n[Outro 2]"), [(3, "Слова")])
        for bad in ("[Припев", "[]", "[ ]", "[Припев] слова", "# Припев", "- строка", "1. строка", "Припев:"):
            with self.subTest(bad=bad), self.assertRaisesRegex(ValueError, "Строка 2"):
                tool.lyric_lines("Верная строка\n" + bad)

    def test_lines_and_sections_from_text(self):
        self.assertEqual([n for n, _ in tool.lyric_lines(TEXT)], [2, 3, 6, 7])
        self.assertEqual(
            tool.text_sections(TEXT),
            [{"name": "Куплет 1", "first": 2, "last": 3}, {"name": "Припев", "first": 6, "last": 7}],
        )
        self.assertEqual(tool.tokens("Светит, Светит — ёлки!"), ["светит", "светит", "елки"])

    def test_alignment_tolerates_recognition_errors_and_extra_words(self):
        words = [
            ("загорелись", 10.0, 10.5),
            ("уреки", 10.5, 10.9),
            ("яркие", 11.0, 11.6),
            ("огни", 11.6, 11.9),
            ("эээ", 12.5, 12.7),
            ("тихий", 13.0, 13.6),
            ("ветер", 13.6, 13.9),
            ("качает", 14.0, 14.4),
            ("наши", 14.4, 14.6),
            ("листья", 14.6, 14.9),
            ("светит", 30.0, 30.3),
            ("светит", 30.4, 30.7),
            ("маленький", 30.8, 31.1),
            ("фонарь", 31.1, 31.4),
            ("вдали", 31.5, 31.8),
            ("мы", 33.0, 33.1),
            ("смотрели", 33.1, 33.4),
            ("на", 33.4, 33.5),
            ("звёзды", 33.5, 33.9),
            ("мечтали", 34.2, 34.6),
            ("до", 34.6, 34.7),
            ("утра", 34.7, 35.0),
        ]
        timing = tool.build_timing(TEXT, recognition(words), 60.0)
        lines = timing["lines"]
        self.assertEqual([(line["id"], line["source_line"]) for line in lines], [(1, 2), (2, 3), (3, 6), (4, 7)])
        self.assertEqual((lines[0]["start"], lines[0]["end"]), (10.0, 11.9))
        self.assertEqual((lines[1]["start"], lines[1]["end"]), (13.0, 14.9))
        self.assertEqual((lines[2]["start"], lines[2]["end"]), (30.0, 31.8))
        self.assertEqual((lines[3]["start"], lines[3]["end"]), (33.0, 35.0))
        self.assertFalse(any(line["verified"] for line in lines))
        self.assertIn("Совпало 4 из 5", lines[0]["note"])  # «у реки» распознано как одно слово
        self.assertIn("Совпало 7 из 8", lines[3]["note"])  # пропущено «и»
        self.assertEqual(
            [s["name"] for s in timing["sections"]],
            ["Вступление", "Куплет 1", "Проигрыш после «Куплет 1»", "Припев", "Финал без вокала"],
        )
        self.assertEqual((timing["sections"][1]["start"], timing["sections"][1]["end"]), (10.0, 14.9))
        self.assertEqual(timing["sections"][-1]["end"], 60.0)
        self.assertIn("подтверждено на слух 0 из 4", timing["status"])

    def test_unrecognized_lines_are_interpolated_between_neighbours(self):
        words = [
            ("загорелись", 10.0, 10.5),
            ("у", 10.5, 10.6),
            ("реки", 10.6, 10.9),
            ("яркие", 11.0, 11.6),
            ("огни", 11.6, 11.9),
            ("мы", 33.0, 33.1),
            ("смотрели", 33.1, 33.4),
            ("на", 33.4, 33.5),
            ("звёзды", 33.5, 33.9),
            ("и", 34.0, 34.1),
            ("мечтали", 34.2, 34.6),
            ("до", 34.6, 34.7),
            ("утра", 34.7, 35.0),
        ]
        timing = tool.build_timing(TEXT, recognition(words), 60.0)
        lines = timing["lines"]
        self.assertEqual(lines[1]["start"], 11.9)
        self.assertEqual(lines[2]["end"], 33.0)
        self.assertLess(lines[1]["end"], lines[2]["start"] + 0.001)
        self.assertIn("не распознаны", lines[1]["note"])
        self.assertIn("не распознаны", lines[2]["note"])
        self.assertIn("Совпали все 5", lines[0]["note"])

    def test_unmatched_short_line_does_not_overlap_neighbours(self):
        # Служебные названия без скобок проверяются отдельно; здесь проверяется обычная пропущенная строка.
        text = "Загорелись у реки, яркие огни,\nСнова поём\nСветит, светит маленький фонарь вдали.\n"
        words = [
            ("загорелись", 10.0, 10.5),
            ("у", 10.5, 10.6),
            ("реки", 10.6, 10.9),
            ("яркие", 11.0, 11.6),
            ("огни", 11.6, 11.9),
            ("светит", 11.95, 12.3),
            ("светит", 12.4, 12.7),
            ("маленький", 12.8, 13.1),
            ("фонарь", 13.1, 13.4),
            ("вдали", 13.5, 13.8),
        ]
        lines = tool.build_timing(text, recognition(words), 60.0)["lines"]
        for previous, current in zip(lines, lines[1:]):
            self.assertLessEqual(previous["end"], current["start"])
            self.assertGreaterEqual(current["end"] - current["start"], 0.3 - 1e-9)
        self.assertAlmostEqual(lines[1]["end"] - lines[1]["start"], 0.3, places=6)

    def test_verified_lines_survive_rebuild_and_segments_without_words_are_split(self):
        previous = {
            "lines": [
                {
                    "id": 2,
                    "source_line": 3,
                    "start": 12.5,
                    "end": 14.0,
                    "verified": True,
                    "note": "подтверждено на слух",
                }
            ]
        }
        rec = {
            "model": "x",
            "segments": [
                {"start": 10.0, "end": 12.0, "text": "Загорелись у реки яркие огни"},
                {
                    "start": 30.0,
                    "end": 36.0,
                    "text": "Светит светит маленький фонарь вдали мы смотрели на звёзды и мечтали до утра",
                },
            ],
        }
        timing = tool.build_timing(TEXT, rec, 60.0, previous)
        self.assertEqual(
            timing["lines"][1],
            {"id": 2, "source_line": 3, "start": 12.5, "end": 14.0, "verified": True, "note": "подтверждено на слух"},
        )
        self.assertEqual((timing["lines"][0]["start"], timing["lines"][0]["end"]), (10.0, 12.0))
        self.assertEqual(timing["lines"][2]["start"], 30.0)
        self.assertEqual(timing["lines"][3]["end"], 36.0)
        self.assertIn("1 из 4", timing["status"])
        with self.assertRaises(ValueError):
            tool.build_timing("[Припев]\n", rec, 60.0)
        with self.assertRaises(ValueError):
            tool.build_timing(TEXT, {"segments": []}, 60.0)
        json.dumps(timing, ensure_ascii=False)


if __name__ == "__main__":
    unittest.main()
