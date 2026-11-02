"""Тесты выравнивания текста по распознаванию: строки, пропуски, части, сохранение подтверждённых строк."""

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

    def test_transcribe_forwards_explicit_ready_vocal(self):
        with TemporaryDirectory() as folder:
            root = Path(folder)
            output = root / "recognition.json"
            output.write_text('{"segments": []}', encoding="utf-8")
            with patch.object(tool.subprocess, "run") as run:
                run.return_value.returncode = 0
                tool.transcribe(root, root / "whisper", output, "cpu", root / "ctc", root / "result.json")
                argv = run.call_args.args[0]
                self.assertEqual(argv[argv.index("--vocal-result") + 1], str(root / "result.json"))
                self.assertEqual(argv[argv.index("--song-models") + 1], str(root / "ctc"))

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

    def test_unrecognized_lines_remain_unassigned(self):
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
        self.assertEqual([line["source_line"] for line in lines], [2, 7])
        self.assertEqual([(line["start"], line["end"]) for line in lines], [(10.0, 11.9), (33.0, 35.0)])
        self.assertIn("Не найдено строк: 2", timing["status"])

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
        self.assertEqual(len(lines), 2)
        self.assertEqual([line["source_line"] for line in lines], [1, 3])
        self.assertEqual(lines[1]["start"], 11.95)

    def test_verified_lines_survive_and_segments_without_words_are_not_split(self):
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
            timing["lines"],
            [{"id": 1, "source_line": 3, "start": 12.5, "end": 14.0, "verified": True, "note": "подтверждено на слух"}],
        )
        self.assertEqual(tool.recognized_words(rec), [])
        self.assertIn("1 из 4", timing["status"])
        with self.assertRaises(ValueError):
            tool.build_timing("[Припев]\n", rec, 60.0)
        with self.assertRaises(ValueError):
            tool.build_timing(TEXT, {"segments": []}, 60.0)
        json.dumps(timing, ensure_ascii=False)

    def test_missing_first_line_does_not_become_intro(self):
        text = "Этой строки нет\nРеальная вторая строка\n"
        found = recognition([("реальная", 12, 13), ("вторая", 13, 14), ("строка", 14, 16)])
        value = tool.build_timing(text, found, 30)
        self.assertEqual([(line["source_line"], line["start"], line["end"]) for line in value["lines"]], [(2, 12, 16)])

    def test_no_matches_is_error_and_verified_line_is_preserved(self):
        empty = {"segments": []}
        with self.assertRaisesRegex(ValueError, "ни одной строки"):
            tool.build_timing("Нужные слова", empty, 30)
        prior = {
            "lines": [{"id": 8, "source_line": 1, "start": 12, "end": 16, "verified": True, "note": "Моя заметка"}],
            "sections": [{"name": "Мой куплет", "start": 0, "end": 30}],
        }
        value = tool.build_timing("Нужные слова\nНе найдено", empty, 30, prior)
        self.assertEqual(value["lines"], [{**prior["lines"][0], "id": 1}])
        self.assertEqual(value["sections"], prior["sections"])
        self.assertIn("Не найдено строк: 1", value["status"])
        self.assertNotEqual(value["status"], "Разметка подтверждена на слух.")

    def test_ctc_line_uses_acoustic_boundaries_and_manual_note(self):
        value = {
            "alignment": "wav2vec2-large-xlsr-53-russian ONNX CTC",
            "segments": [{"source_line": 1, "start": 12.123, "end": 16.456, "text": "Известная строка"}],
        }
        prior = {"lines": [{"source_line": 1, "note": "Проверить согласную"}]}
        timing = tool.build_timing("Известная строка", value, 30, prior)
        self.assertEqual((timing["lines"][0]["start"], timing["lines"][0]["end"]), (12.123, 16.456))
        self.assertEqual(timing["lines"][0]["note"], "Проверить согласную")

    def test_manual_notes_with_system_prefix_or_added_tail_survive(self):
        rec = {
            "alignment": "wav2vec2-large-xlsr-53-russian ONNX CTC",
            "segments": [{"source_line": 1, "start": 2, "end": 3, "text": "Поём песню"}],
        }
        notes = [
            "Границы уточнены вручную: не срезать согласную",
            "Совпало всё кроме последнего слова",
            "Совпали все слова, но проверить начало",
            "Слова не распознаны из-за эффекта",
            f"Совпали все 2 слов; {tool.UNVERIFIED}. Проверить согласную",
        ]
        for note in notes:
            with self.subTest(note=note):
                previous = {"lines": [{"source_line": 1, "note": note}]}
                self.assertEqual(tool.build_timing("Поём песню", rec, 10, previous)["lines"][0]["note"], note)
        previous = {"lines": [{"source_line": 1, "note": f"Совпали все 2 слов; {tool.UNVERIFIED}."}]}
        self.assertTrue(tool.build_timing("Поём песню", rec, 10, previous)["lines"][0]["note"].startswith("Границы"))

    def test_exact_300_ms_ctc_and_verified_intervals_are_accepted_but_299_ms_is_not(self):
        rec = {
            "alignment": "wav2vec2-large-xlsr-53-russian ONNX CTC",
            "segments": [{"source_line": 1, "start": 2, "end": 2.3, "text": "Поём песню"}],
        }
        self.assertEqual(tool.build_timing("Поём песню", rec, 10)["lines"][0]["end"], 2.3)
        previous = {"lines": [{"source_line": 1, "start": 2, "end": 2.3, "verified": True}]}
        self.assertTrue(tool.build_timing("Поём песню", {"segments": []}, 10, previous)["lines"][0]["verified"])
        rec["segments"][0]["end"] = 2.299
        with self.assertRaisesRegex(ValueError, "конфликтуют"):
            tool.build_timing("Поём песню", rec, 10)
        # Обычные опоры Whisper используют тот же порог до построения карты.
        ordinary = recognition([("поём", 2, 2.1), ("песню", 2.1, 2.3)])
        self.assertEqual(tool.build_timing("Поём песню", ordinary, 10)["lines"][0]["end"], 2.3)

    def test_overlapping_candidates_stay_separate_from_accepted_lines_and_sections(self):
        candidates = [
            {"source_line": 2, "start": 14.98, "end": 18, "reason": "Слабое сходство", "acoustic_score": 0.7},
            {"source_line": 3, "start": 17.98, "end": 20, "reason": "Слабая вероятность"},
        ]
        rec = {
            "alignment": "wav2vec2-large-xlsr-53-russian ONNX CTC",
            "candidates": candidates,
            "segments": [{"source_line": 1, "start": 10, "end": 15, "text": "Первая строка"}],
        }
        timing = tool.build_timing("Первая строка\nВторая строка\nТретья строка", rec, 30)
        self.assertEqual(len(timing["lines"]), 1)
        self.assertEqual(timing["candidates"], candidates)
        self.assertFalse(timing["lines"][0]["verified"])
        self.assertEqual(timing["sections"][1]["end"], 20)
        self.assertTrue(all(part["origin"] == "auto" for part in timing["sections"]))
        self.assertFalse(any(part.get("note") in ("без вокала", "до конца трека") for part in timing["sections"]))

    def test_short_candidate_only_is_draft_and_verified_previous_wins(self):
        candidate = {"source_line": 1, "start": 10, "end": 10.02, "reason": "Короткий акустический путь"}
        rec = {"segments": [], "candidates": [candidate]}
        timing = tool.build_timing("Нужная строка", rec, 30)
        self.assertEqual(timing["lines"], [])
        self.assertEqual(timing["candidates"], [candidate])
        self.assertIn("подтверждено на слух 0 из 1", timing["status"])
        prior = {"lines": [{"id": 3, "source_line": 1, "start": 12, "end": 16, "verified": True, "note": "Вручную"}]}
        timing = tool.build_timing("Нужная строка", rec, 30, prior)
        self.assertEqual(timing["candidates"], [])
        self.assertEqual(timing["lines"], [{**prior["lines"][0], "id": 1}])

    def test_candidate_notes_survive_weak_roundtrip_and_move_to_accepted_lines(self):
        text = "Первая строка\nВторая строка\nТретья строка\nЧетвёртая строка"
        first = {"source_line": 1, "start": 10, "end": 15, "text": "Первая строка"}
        candidates = [
            {"source_line": 2, "start": 14.98, "end": 18, "reason": "Слабое сходство"},
            {"source_line": 3, "start": 17.98, "end": 20, "reason": "Слабая вероятность"},
        ]
        rec = {"alignment": "wav2vec2-large-xlsr-53-russian ONNX CTC", "segments": [first], "candidates": candidates}
        previous = tool.build_timing(text, rec, 30)
        previous["lines"][0]["verified"] = True
        previous["candidates"][0]["note"] = "Проверить согласную"
        previous["candidates"][1]["note"] = "Не обрезать протяжную гласную"
        weak = tool.build_timing(text, rec, 30, previous)
        self.assertEqual(
            [item["note"] for item in weak["candidates"]], ["Проверить согласную", "Не обрезать протяжную гласную"]
        )
        self.assertEqual(len(weak["lines"]), 1)
        self.assertLess(weak["candidates"][0]["start"], weak["lines"][0]["end"])
        self.assertIn("подтверждено на слух 1 из 4", weak["status"])
        self.assertIn("Предложений для ручной проверки: 2.", weak["status"])
        self.assertIn("Не найдено строк: 1;", weak["status"])
        # Повторный ASR принимает новые непересекающиеся границы, сохраняя заметки отдельно от подтверждения.
        accepted_rec = {
            **rec,
            "candidates": [],
            "segments": [
                first,
                {"source_line": 2, "start": 15, "end": 18, "text": "Вторая строка"},
                {"source_line": 3, "start": 18, "end": 20, "text": "Третья строка"},
            ],
        }
        weak["lines"].append(
            {
                "id": 2,
                "source_line": 2,
                "start": 15,
                "end": 18,
                "verified": False,
                "note": "Ручная заметка строки важнее",
            }
        )
        accepted = tool.build_timing(text, accepted_rec, 30, weak)
        self.assertEqual(accepted["candidates"], [])
        self.assertEqual(
            [item["note"] for item in accepted["lines"][1:]],
            ["Ручная заметка строки важнее", "Не обрезать протяжную гласную"],
        )
        self.assertFalse(any(item["verified"] for item in accepted["lines"][1:]))
        self.assertNotIn("Предложений для ручной проверки", accepted["status"])
        all_proposed = tool.build_timing(
            "Вторая строка\nТретья строка",
            {"segments": [], "candidates": [{**candidates[0], "source_line": 1}, {**candidates[1], "source_line": 2}]},
            30,
        )
        self.assertIn("Предложений для ручной проверки: 2.", all_proposed["status"])
        self.assertNotIn("Не найдено строк", all_proposed["status"])
        self.assertNotEqual(all_proposed["status"], "Разметка подтверждена на слух.")

    def test_candidate_validation_rejects_invalid_numbers_and_reason(self):
        candidate = {"source_line": 1, "start": 10, "end": 12, "reason": "Проверить"}
        for change in (
            {"start": float("nan")},
            {"end": float("inf")},
            {"start": -1},
            {"end": 10},
            {"source_line": True},
            {"source_line": 2},
            {"reason": ""},
            {"note": 123},
            {"acoustic_score": float("nan")},
        ):
            with self.subTest(change=change), self.assertRaises(ValueError):
                tool.build_timing("Нужная строка", {"segments": [], "candidates": [{**candidate, **change}]}, 30)

    def test_auto_sections_refresh_while_manual_map_and_overrides_survive(self):
        text = "[Куплет]\nПервая строка"
        rec = {
            "alignment": "wav2vec2-large-xlsr-53-russian ONNX CTC",
            "segments": [{"source_line": 2, "start": 10, "end": 15, "text": "Первая строка"}],
        }
        auto = [
            {"name": "Вступление", "start": 0, "end": 20, "note": "без вокала"},
            {"name": "Куплет", "start": 20, "end": 25, "note": "строки 1–1"},
        ]
        manual = {"name": "Мой переход", "start": 18, "end": 19, "note": "Музыкальный акцент"}
        timing = tool.build_timing(text, rec, 30, {"sections": auto + [manual]})
        self.assertIn(manual, timing["sections"])
        self.assertEqual(next(part for part in timing["sections"] if part["name"] == "Вступление")["end"], 10)
        explicit = {**auto[1], "origin": "manual"}
        timing = tool.build_timing(text, rec, 30, {"sections": [auto[0], explicit]})
        self.assertEqual([part for part in timing["sections"] if part["name"] == "Куплет"], [explicit])
        custom = [{"name": "Куплет", "start": 3, "end": 25, "note": "Моя карта"}]
        self.assertEqual(tool.build_timing(text, rec, 30, {"sections": custom})["sections"], custom)

    def test_legacy_auto_requires_system_name_and_note_together(self):
        parts = tool.text_sections("[Куплет]\nСтрока")
        for section in (
            {"name": "Особая часть", "note": "строки 1–2"},
            {"name": "Вступление", "note": "Моя заметка"},
            {"name": "Моя кода", "note": "до конца трека"},
            {"name": "Куплет", "note": "строки 1–2", "origin": "manual"},
        ):
            with self.subTest(section=section):
                self.assertFalse(tool.is_auto_section(section, parts))
        self.assertTrue(tool.is_auto_section({"name": "Куплет", "note": "строки 1–2"}, parts))

    def test_line_order_preserves_valid_queue_and_appends_new_lyrics(self):
        rec = recognition(
            [("загорелись", 10, 11), ("у", 11, 11.2), ("реки", 11.2, 11.5), ("яркие", 11.5, 12), ("огни", 12, 13)]
        )
        timing = tool.build_timing(TEXT, rec, 60, {"line_order": [7, True, 2, 7, 999, 6]})
        self.assertEqual(timing["line_order"], [7, 2, 6, 3])

    def test_invalid_recognition_cannot_publish_nan(self):
        value = {"segments": [{"start": float("nan"), "end": 5, "text": "Строка"}]}
        with self.assertRaisesRegex(ValueError, "неверные границы"):
            tool.build_timing("Строка", value, 30)

    def test_invalid_duration_and_nonfinite_manual_section_keep_previous_json(self):
        with TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "source").mkdir()
            (root / "source/track.mp3").write_bytes(b"audio")
            (root / "source/text.md").write_text("Первая строка", encoding="utf-8")
            output = root / "plan/audio/timing.json"
            output.parent.mkdir(parents=True)
            original = b'{"lines": [], "status": "old"}'
            result = root / "recognition.json"
            good = recognition([("первая", 2, 3), ("строка", 3, 4)])
            with (
                patch.object(tool, "ROOT", root),
                patch.object(tool, "track_duration", return_value=30),
                patch.object(sys, "argv", ["align", "--recognition", str(result), "--json"]),
            ):
                for value in (float("nan"), float("inf"), -1, 0, True, None, "30"):
                    with self.subTest(duration=value):
                        output.write_bytes(original)
                        result.write_text(json.dumps({**good, "decoded_duration": value}), encoding="utf-8")
                        with self.assertRaises(SystemExit):
                            tool.main()
                        self.assertEqual(output.read_bytes(), original)
                result.write_text(json.dumps(good), encoding="utf-8")
                prior = {"sections": [{"name": "Ручная карта", "start": 0, "end": float("nan")}]}
                original = json.dumps(prior).encode()
                output.write_bytes(original)
                with self.assertRaises(SystemExit):
                    tool.main()
                self.assertEqual(output.read_bytes(), original)
                self.assertEqual(list(output.parent.glob("*.tmp")), [])

    def test_default_recognition_is_unique_per_attempt_and_explicit_keep_is_preserved(self):
        with TemporaryDirectory() as folder:
            roots = [Path(folder) / side / "clip" for side in ("a", "b")]
            for root in roots:
                (root / "source").mkdir(parents=True)
                (root / "source/track.mp3").write_bytes(b"audio")
                (root / "source/text.md").write_text("Первая строка", encoding="utf-8")
            outputs = []

            def recognize(_root, _model, output, *_args):
                self.assertTrue(output.parent.is_dir())
                self.assertFalse(output.exists())
                outputs.append(output)
                value = recognition([("первая", 2, 3), ("строка", 3, 4)])
                output.write_text(json.dumps(value), encoding="utf-8")
                return value

            with (
                patch.object(tool, "track_duration", return_value=30),
                patch.object(tool, "missing_model_files", return_value=[]),
                patch.object(tool, "transcribe", side_effect=recognize),
            ):
                for root in [*roots, roots[0]]:
                    with patch.object(tool, "ROOT", root), patch.object(sys, "argv", ["align", "--dry-run", "--json"]):
                        tool.main()
                self.assertEqual(len(set(outputs)), 3)
                self.assertTrue(all(not output.parent.exists() for output in outputs))
                keep = Path(folder) / "kept.json"
                with (
                    patch.object(tool, "ROOT", roots[0]),
                    patch.object(sys, "argv", ["align", "--dry-run", "--json", "--keep-recognition", str(keep)]),
                ):
                    tool.main()
                self.assertEqual(outputs[-1], keep)
                self.assertTrue(keep.is_file())

    def test_atomic_publication_and_changed_source_keep_previous_file(self):
        with TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "source").mkdir()
            (root / "plan/audio").mkdir(parents=True)
            (root / "source/track.mp3").write_bytes(b"audio")
            (root / "source/text.md").write_text("Первая строка", encoding="utf-8")
            output = root / "plan/audio/timing.json"
            original = json.dumps({"lines": [], "status": "Прежняя разметка"}).encode()
            output.write_bytes(original)
            data = recognition([("первая", 12, 13), ("строка", 13, 16)])
            result = root / "recognition.json"
            result.write_text(json.dumps(data), encoding="utf-8")
            argv = ["align", "--recognition", str(result), "--json"]
            with (
                patch.object(tool, "ROOT", root),
                patch.object(tool, "track_duration", return_value=30),
                patch.object(sys, "argv", argv),
            ):
                with patch.object(Path, "replace", side_effect=OSError("Отказ замены")):
                    with self.assertRaisesRegex(OSError, "Отказ замены"):
                        tool.main()
                self.assertEqual(output.read_bytes(), original)
                self.assertEqual(list(output.parent.glob("*.tmp")), [])
                build = tool.build_timing

                def change(*args, **kwargs):
                    value = build(*args, **kwargs)
                    (root / "source/track.mp3").write_bytes(b"changed")
                    return value

                with patch.object(tool, "build_timing", side_effect=change):
                    with self.assertRaises(SystemExit):
                        tool.main()
                self.assertEqual(output.read_bytes(), original)

    def test_zero_duration_asr_words_are_skipped_without_stretching(self):
        value = recognition([("первая", 10, 10), ("строка", 10, 12)])
        value["segments"].append({"start": 15, "end": 15, "text": "Галлюцинация"})
        self.assertEqual(tool.recognized_words(value), [("строка", 10.0, 12.0)])
        for start, end in ((12, 10), (-1, 10), (float("nan"), 10)):
            value = recognition([("строка", start, end)])
            with self.assertRaisesRegex(ValueError, "неверные границы"):
                tool.recognized_words(value)

    def test_segment_without_word_times_cannot_invent_line_boundaries(self):
        value = {"segments": [{"start": 10, "end": 20, "text": "Первая строка Вторая строка"}]}
        with self.assertRaisesRegex(ValueError, "ни одной строки"):
            tool.build_timing("Первая строка\nВторая строка", value, 30)

    def test_ctc_cannot_publish_a_different_source_text(self):
        value = {
            "alignment": "wav2vec2-large-xlsr-53-russian ONNX CTC",
            "segments": [{"source_line": 1, "start": 10, "end": 15, "text": "Чужой текст"}],
        }
        with self.assertRaisesRegex(ValueError, "ни одной строки"):
            tool.build_timing("Нужная строка", value, 30)

    def test_failed_asr_stale_recognition_and_changed_timing_keep_previous(self):
        with TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "source").mkdir()
            (root / "source/track.mp3").write_bytes(b"audio")
            (root / "source/text.md").write_text("Первая строка", encoding="utf-8")
            output = root / "plan/audio/timing.json"
            output.parent.mkdir(parents=True)
            original = b'{"lines": [], "status": "old"}'
            output.write_bytes(original)
            with (
                patch.object(tool, "ROOT", root),
                patch.object(tool, "track_duration", return_value=30),
                patch.object(tool, "missing_model_files", return_value=[]),
                patch.object(sys, "argv", ["align", "--json"]),
            ):
                with patch.object(tool, "transcribe", side_effect=ValueError("Сбой ASR")):
                    with self.assertRaisesRegex(SystemExit, "1"):
                        tool.main()
                self.assertEqual(output.read_bytes(), original)
                stale = {**recognition([("первая", 10, 11), ("строка", 11, 13)]), "sha256": "other"}
                with patch.object(tool, "transcribe", return_value=stale):
                    with self.assertRaises(SystemExit):
                        tool.main()
                self.assertEqual(output.read_bytes(), original)
                build = tool.build_timing

                def edit_timing(*args, **kwargs):
                    value = build(*args, **kwargs)
                    output.write_bytes(b"manual change")
                    return value

                stale.pop("sha256")
                with (
                    patch.object(tool, "transcribe", return_value=stale),
                    patch.object(tool, "build_timing", side_effect=edit_timing),
                ):
                    with self.assertRaises(SystemExit):
                        tool.main()
                self.assertEqual(output.read_bytes(), b"manual change")

    def test_output_arguments_cannot_overwrite_sources(self):
        with TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "source").mkdir()
            track = root / "source/track.mp3"
            text = root / "source/text.md"
            track.write_bytes(b"audio")
            text.write_text("Первая строка", encoding="utf-8")
            cases = [
                ("--output", track),
                ("--output", text),
                ("--keep-recognition", track),
                ("--keep-recognition", root / tool.TIMING_PATH),
            ]
            for option, destination in cases:
                with (
                    self.subTest(option=option, destination=destination),
                    patch.object(tool, "ROOT", root),
                    patch.object(sys, "argv", ["align", option, str(destination)]),
                ):
                    with self.assertRaises(SystemExit):
                        tool.main()
                self.assertEqual(track.read_bytes(), b"audio")
                self.assertEqual(text.read_text(encoding="utf-8"), "Первая строка")


if __name__ == "__main__":
    unittest.main()
