"""Численная геометрия MDX/CTC без загрузок моделей и реального распознавания. @link README.md"""

import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import Mock, patch

import numpy as np

from tools.song_timing.ctc import emissions, force_align, refine_lines, tokenize
from tools.song_timing.mdx import CHUNK, STRIDE, istft, separate, stft
from tools.song_timing.models import missing_files, require_models


class SongTimingTests(unittest.TestCase):
    def test_stft_inverse_preserves_signal_length_and_silence(self):
        signal = np.random.default_rng(4).normal(0, 0.03, (2, CHUNK)).astype(np.float32)
        signal[:, :20000] = 0
        restored = istft(stft(signal), CHUNK)
        self.assertEqual(restored.shape, signal.shape)
        np.testing.assert_allclose(restored, signal, atol=1e-6)

    def test_chunk_context_does_not_trim_intro_or_tail(self):
        class Identity:
            def get_inputs(self):
                return [SimpleNamespace(name="input")]

            def run(self, _, feed):
                return [feed["input"]]

        signal = np.zeros((2, CHUNK + 1000), dtype=np.float32)
        result = separate(signal, Identity(), lambda _: None)
        self.assertEqual(result.shape, signal.shape)
        self.assertTrue(np.isfinite(result).all())
        self.assertEqual(np.count_nonzero(result), 0)

    def test_per_model_spectrum_gain_and_instrumental_subtraction(self):
        class HalfSpectrum:
            def get_inputs(self):
                return [SimpleNamespace(name="input")]

            def run(self, _, feed):
                self.shape = feed["input"].shape
                return [feed["input"] * 0.5]

        # Тон строго внутри FFT-бинов проверяет амплитуду и спектр, а не только длину тишины.
        recipe = dict(fft=1024, hop=256, bins=513, frames=24, compensate=1.2, primary_stem="Vocals")
        count = 18000
        tone = np.sin(np.arange(count) * 2 * np.pi * 32 / 1024).astype(np.float32) * 0.2
        signal = np.stack([tone, -tone * 0.5])
        model = HalfSpectrum()
        vocal = separate(signal, model, lambda _: None, recipe)
        self.assertEqual(model.shape, (1, 4, 513, 24))
        np.testing.assert_allclose(vocal[:, 1024:-1024], signal[:, 1024:-1024] * 0.6, atol=3e-4)
        instrumental = separate(signal, model, lambda _: None, dict(recipe, primary_stem="Instrumental"))
        np.testing.assert_allclose(instrumental, signal - vocal, atol=1e-7)
        self.assertEqual(int(np.argmax(abs(np.fft.rfft(vocal[0, 1024:9216])))), 256)

    def test_ctc_finds_phrase_after_intro_with_repeated_letters(self):
        probabilities = np.full((80, 3), 0.005, dtype=np.float32)
        probabilities[:, 0] = 0.99
        for frame, token in [(60, 1), (62, 1), (65, 2)]:
            probabilities[frame] = 0.005
            probabilities[frame, token] = 0.99
        result = force_align(np.log(probabilities), [1, 1, 2])
        self.assertIsNotNone(result)
        self.assertEqual(result[:2], (60, 65))
        self.assertGreater(result[2], 0.9)

    def test_absent_phrase_is_not_assigned_to_silence(self):
        probabilities = np.tile([0.99, 0.005, 0.005], (100, 1))
        self.assertIsNone(force_align(np.log(probabilities), [1, 2]))
        self.assertIsNone(force_align(np.log(probabilities), []))

    def test_ctc_does_not_join_letters_across_foreign_speech_instead_of_a_real_phrase(self):
        # Сравнение только с blank склеивало сильные крайние буквы через чужую речь,
        # затем отклоняло всю строку по greedy-проверке, хотя дальше есть полноценная фраза.
        probabilities = np.tile([0.996, 0.001, 0.001, 0.001, 0.001], (100, 1))
        for begin, end, token in ((10, 14, 1), (14, 24, 3), (24, 34, 4), (34, 38, 2)):
            probabilities[begin:end] = 0.0025
            probabilities[begin:end, token] = 0.99
        for begin, token in ((70, 1), (74, 2)):
            probabilities[begin : begin + 3] = 0.0125
            probabilities[begin : begin + 3, token] = 0.95
        result = force_align(np.log(probabilities), [1, 2])
        self.assertIsNotNone(result)
        self.assertEqual(result[:2], (70, 76))

    def test_foreign_speech_cannot_supply_an_absent_phrase(self):
        # Уверенные чужие символы не становятся доказательством букв исходного текста,
        # даже когда у blank ещё меньшая вероятность.
        probabilities = np.tile([0.0001, 0.0399, 0.01, 0.95], (100, 1))
        self.assertIsNone(force_align(np.log(probabilities), [1, 2]))

    def test_weak_path_is_candidate_but_silence_has_no_editor_candidate(self):
        with TemporaryDirectory() as folder:
            directory = Path(folder)
            (directory / "vocab.json").write_text(json.dumps({"<pad>": 0, "а": 1, "б": 2}), encoding="utf-8")
            for singing in (True, False):
                probabilities = np.tile([0.99, 0.005, 0.005], (100, 1))
                if singing:
                    probabilities[10:25] = [0.005, 0.99, 0.005]
                    probabilities[28:45] = [0.45, 0.49, 0.06]
                with (
                    patch("tools.song_timing.ctc.session"),
                    patch(
                        "tools.song_timing.ctc.emissions", return_value=(np.log(probabilities), np.arange(100) * 0.02)
                    ),
                ):
                    result = refine_lines([(1, "аб")], [{"start": 0, "end": 2}], {}, np.zeros(2 * 16000), directory)
                self.assertEqual(result["segments"], [])
                self.assertEqual(len(result["candidates"]), int(singing))
                self.assertIsNone(force_align(np.log(probabilities), [1, 2]))
                self.assertEqual(len(result["unmatched"]), 1)
                if singing:
                    candidate = result["candidates"][0]
                    self.assertEqual(candidate["source_line"], 1)
                    self.assertGreater(candidate["end"], candidate["start"])
                    self.assertIn("порога", candidate["reason"])
                    self.assertGreaterEqual(candidate["acoustic_score"], 0.45)

    def test_russian_and_unsupported_characters(self):
        vocab = {"ё": 6, "ж": 13, "|": 4, "е": 12}
        self.assertEqual(tokenize("Ёж, е!", vocab), [6, 13, 4, 12])
        self.assertIsNone(tokenize("Ёж 123", vocab))

    def test_emission_chunks_keep_original_time_without_duplicate_frames(self):
        class Acoustic:
            def get_inputs(self):
                return [SimpleNamespace(name="input_values")]

            def run(self, _, feed):
                count = (feed["input_values"].shape[-1] - 400) // 320 + 1
                return [np.zeros((1, count, 4), dtype=np.float32)]

        values, times = emissions(np.zeros(40 * 16000, dtype=np.float32), Acoustic(), lambda _: None)
        self.assertEqual(len(values), len(times))
        self.assertGreater(times[-1], 39.9)
        np.testing.assert_allclose(np.diff(times), 0.02, atol=1e-6)
        self.assertAlmostEqual(times[0], 0.0125)

    def test_missing_or_truncated_models_explain_the_setup_action(self):
        with TemporaryDirectory() as folder:
            directory = Path(folder)
            self.assertEqual(missing_files(directory), ["alignment.onnx", "vocab.json"])
            (directory / "vocals.onnx").write_bytes(b"incomplete model")
            self.assertIn("vocals.onnx", missing_files(directory, component="voc-ft"))
            with self.assertRaisesRegex(ValueError, "Откройте окно.*скачайте"):
                require_models(directory)

    def test_ctc_does_not_trim_a_sustained_initial_or_final_letter(self):
        probabilities = np.tile([0.99, 0.005, 0.005], (80, 1))
        probabilities[10:25] = [0.005, 0.99, 0.005]
        probabilities[28:45] = [0.005, 0.005, 0.99]
        result = force_align(np.log(probabilities), [1, 2])
        self.assertIsNotNone(result)
        self.assertEqual(result[:2], (10, 44))

    def test_unsupported_unicode_letters_are_not_silently_dropped(self):
        vocab = {"ж": 1, "е": 2, "|": 3}
        self.assertIsNone(tokenize("Їж", vocab))
        self.assertIsNone(tokenize("éж", vocab))
        self.assertIsNone(tokenize("你好", vocab))

    def test_exact_300_ms_ctc_path_is_accepted_and_shorter_path_stays_candidate(self):
        with TemporaryDirectory() as folder:
            directory = Path(folder)
            (directory / "vocab.json").write_text(json.dumps({"<pad>": 0, "а": 1}), encoding="utf-8")
            for final, accepted in ((2.29, True), (2.289, False)):
                with (
                    self.subTest(end=final),
                    patch("tools.song_timing.ctc.session"),
                    patch("tools.song_timing.ctc.emissions", return_value=(np.zeros((2, 2)), np.array([2.01, final]))),
                    patch(
                        "tools.song_timing.ctc.alignment_path",
                        return_value={
                            "first": 0,
                            "last": 1,
                            "acoustic_score": 0.9,
                            "reason": "",
                        },
                    ),
                ):
                    result = refine_lines(
                        [(1, "а")],
                        [{"start": 2, "end": 3}],
                        {},
                        np.zeros(4 * 16000),
                        directory,
                    )
                self.assertEqual(bool(result["segments"]), accepted)
                self.assertEqual(bool(result["candidates"]), not accepted)

    def test_short_audio_and_invalid_logits_do_not_receive_times(self):
        model = Mock()
        values, times = emissions(np.zeros(100, dtype=np.float32), model)
        self.assertEqual(len(values), 0)
        self.assertEqual(len(times), 0)
        model.run.assert_not_called()
        model.get_inputs.return_value = [SimpleNamespace(name="input_values")]
        for invalid in (np.full((1, 2, 4), np.nan), np.zeros((2, 2, 4)), np.zeros((1, 0, 4))):
            with self.subTest(shape=invalid.shape):
                model.run.return_value = [invalid]
                with self.assertRaisesRegex(ValueError, "неверные вероятности"):
                    emissions(np.zeros(16000, dtype=np.float32), model)

    def test_nonzero_impulses_keep_their_positions_across_mdx_join(self):
        class Identity:
            def get_inputs(self):
                return [SimpleNamespace(name="input")]

            def run(self, _, feed):
                return [feed["input"]]

        signal = np.zeros((2, STRIDE * 2 + 1000), dtype=np.float32)
        positions = [20000, STRIDE - 30, STRIDE + 30, STRIDE * 2 + 500]
        signal[0, positions] = 1
        signal[1, positions] = -0.5
        result = separate(signal, Identity(), lambda _: None)
        self.assertEqual(result.shape, signal.shape)
        for position in positions:
            window = result[0, position - 10 : position + 11]
            self.assertEqual(int(np.argmax(window)) + position - 10, position)
            self.assertGreater(result[0, position], 0.5)
            self.assertLess(result[1, position], -0.25)

    def test_mdx_invalid_prediction_is_a_terminal_error(self):
        model = Mock()
        model.get_inputs.return_value = [SimpleNamespace(name="input")]
        model.run.return_value = [np.zeros((1, 4, 1, 1), dtype=np.float32)]
        with self.assertRaisesRegex(ValueError, "неверный спектр"):
            separate(np.zeros((2, 1000), dtype=np.float32), model, lambda _: None)

    def test_refinement_keeps_missing_first_line_unassigned_and_repeated_lines_distinct(self):
        vocab = {"<pad>": 0, "а": 1, "б": 2, "в": 3, "г": 4, "д": 5, "е": 6}
        probabilities = np.full((180, 7), 0.005 / 6, dtype=np.float32)
        probabilities[:, 0] = 0.995
        for begin in (60, 120):
            for offset, token in ((0, 4), (7, 5), (14, 6)):
                probabilities[begin + offset : begin + offset + 5] = 0.005 / 6
                probabilities[begin + offset : begin + offset + 5, token] = 0.995
        times = np.arange(180) * 0.02 + 0.0125
        with TemporaryDirectory() as folder:
            directory = Path(folder)
            (directory / "vocab.json").write_text(json.dumps(vocab), encoding="utf-8")
            estimates = [{"start": None, "end": None}, {"start": 1.2, "end": 1.7}, {"start": 2.4, "end": 2.9}]
            with (
                patch("tools.song_timing.ctc.session"),
                patch("tools.song_timing.ctc.emissions", return_value=(np.log(probabilities), times)),
            ):
                result = refine_lines(
                    [(1, "абв"), (2, "где"), (3, "где")], estimates, {"model": "test"}, np.zeros(4 * 16000), directory
                )
            self.assertEqual([line["source_line"] for line in result["segments"]], [2, 3])
            self.assertEqual([line["source_line"] for line in result["unmatched"]], [1])
            self.assertLess(result["segments"][0]["end"], result["segments"][1]["start"])
            self.assertGreater(result["segments"][0]["start"], 1)


if __name__ == "__main__":
    unittest.main()
