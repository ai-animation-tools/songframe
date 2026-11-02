"""Локальная модель и честное описание сети без ASR и сетевых обращений. @link README.md"""

import json
import os
import sys
import unittest
from contextlib import ExitStack, contextmanager
from dataclasses import asdict, dataclass, field
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import Mock, patch

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from tools.transcribe_local import transcribe_local as tool


@dataclass
class Word:
    start: float
    end: float
    word: str
    probability: float = 0.99


@dataclass
class Segment:
    start: float = 0
    end: float = 1
    text: str = "Проба"
    words: list = field(default_factory=list)
    no_speech_prob: float = 0.95


class Audio:
    """Минимальный массив для проверки запуска, не имитирует качество распознавания."""

    def __len__(self):
        return 16000

    def __getitem__(self, key):
        return self


@contextmanager
def runtime(segments, vocals=False, duration=1):
    """Проверяем публикацию с подменой ASR, но с настоящим файловым состоянием временного проекта."""
    with TemporaryDirectory() as folder, ExitStack() as stack:
        root = Path(folder)
        (root / "source").mkdir()
        source = root / "source/track.mp3"
        text = root / "source/text.md"
        source.write_bytes(b"local audio")
        text.write_text("Первая строка", encoding="utf-8")
        output = root / "recognition.json"
        output.write_bytes(b"previous recognition")
        model = Mock()
        model.return_value.transcribe.return_value = (segments, SimpleNamespace(language="ru"))
        stack.enter_context(patch.dict(sys.modules, {"faster_whisper": SimpleNamespace(WhisperModel=model)}))
        stack.enter_context(patch.object(tool, "ROOT", root))
        stack.enter_context(
            patch.object(
                tool.subprocess,
                "run",
                return_value=SimpleNamespace(stdout=np.zeros(16000 * duration, dtype=np.float32).tobytes()),
            )
        )
        argv = [
            "transcribe",
            "--model",
            str(root / "model"),
            "--output",
            str(output),
            "--allow-network",
            "--device",
            "cpu",
        ]
        if vocals:
            argv += ["--song-models", str(root / "song-models"), "--vocal-result", str(root / "result.json")]
            stack.enter_context(patch("tools.song_timing.models.require_models"))
            stack.enter_context(patch("tools.song_timing.vocal_result.load_audio", return_value=Audio()))
            stack.enter_context(
                patch(
                    "tools.song_timing.vocal_result.validate_result",
                    return_value={"modelId": "voc-ft", "audioSha256": "checked"},
                )
            )
        stack.enter_context(patch.object(sys, "argv", argv))
        yield SimpleNamespace(root=root, output=output, source=source, text=text, model=model)


class TranscribeTests(unittest.TestCase):
    def test_local_only_and_actual_network_metadata(self):
        with TemporaryDirectory(prefix="Локальная модель ") as directory:
            root = Path(directory)
            (root / "source").mkdir()
            (root / "source/track.mp3").write_bytes(b"local audio")
            output = root / "recognition.json"
            model = Mock()
            model.return_value.transcribe.return_value = ([Segment()], SimpleNamespace(language="ru"))
            modules = {
                "faster_whisper": SimpleNamespace(WhisperModel=model),
                "numpy": SimpleNamespace(frombuffer=lambda *args, **kwargs: Audio(), float32="float32"),
            }
            # Без --allow-network прежняя ручная команда всё ещё требует изолированную сеть.
            with (
                patch.object(tool.socket, "if_nameindex", return_value=[(1, "lo"), (2, "eth0")]),
                patch.object(
                    sys, "argv", ["transcribe_local", "--model", str(root / "model"), "--output", str(output)]
                ),
            ):
                with self.assertRaisesRegex(SystemExit, "изолированную сеть|unshare"):
                    tool.main()
            with (
                patch.object(tool, "ROOT", root),
                patch.dict(sys.modules, modules),
                patch.object(
                    tool,
                    "detect_hardware",
                    return_value=dict(device="cuda", computeType="int8_float16", reason="Проверка теста"),
                ),
                patch.dict(os.environ, {}, clear=False),
                patch.object(
                    sys,
                    "argv",
                    ["transcribe_local", "--model", str(root / "model"), "--output", str(output), "--allow-network"],
                ),
                patch.object(tool.subprocess, "run", return_value=SimpleNamespace(stdout=b"pcm")),
            ):
                tool.main()
                self.assertTrue(model.call_args.kwargs["local_files_only"])
                self.assertEqual(model.call_args.kwargs["device"], "cuda")
                self.assertEqual(model.call_args.kwargs["compute_type"], "int8_float16")
                self.assertEqual(model.call_args.args[0], str((root / "model").resolve()))
                self.assertEqual(os.environ["HF_HUB_OFFLINE"], "1")
                self.assertEqual(os.environ["HF_HUB_DISABLE_TELEMETRY"], "1")
                self.assertEqual(os.environ["TRANSFORMERS_OFFLINE"], "1")
                result = json.loads(output.read_text(encoding="utf-8"))
                self.assertIn("local process", result["network"])
                self.assertIn("cuda int8_float16", result["method"])
                self.assertNotIn("only loopback", result["network"])
                self.assertEqual(result["segments"][0]["text"], "Проба")

    def test_empty_asr_publishes_an_empty_complete_result(self):
        with runtime([], duration=40) as state:
            tool.main()
            result = json.loads(state.output.read_text())
            self.assertEqual(result["segments"], [])
            self.assertEqual(result["raw_segments"], [])
            self.assertEqual(result["candidates"], [])
            self.assertEqual(result["rejected_segments"], [])
            self.assertEqual(result["decoded_duration"], 40)
            self.assertTrue(state.model.return_value.transcribe.call_args.kwargs["vad_filter"])

    def test_song_policy_is_applied_and_recorded_without_implicit_lyrics_prompt(self):
        with runtime([]) as state:
            state.text.write_text("Текст не должен становиться скрытой подсказкой ASR", encoding="utf-8")
            tool.main()
            options = state.model.return_value.transcribe.call_args.kwargs
            self.assertTrue(options["vad_filter"])
            self.assertTrue(options["word_timestamps"])
            self.assertEqual(options["vad_parameters"], {"min_silence_duration_ms": 2000, "speech_pad_ms": 400})
            self.assertEqual(options["hallucination_silence_threshold"], 2.0)
            self.assertEqual(options["temperature"], (0.0, 0.2, 0.4, 0.6))
            self.assertEqual(options["compression_ratio_threshold"], 2.4)
            self.assertEqual(options["log_prob_threshold"], -1.0)
            self.assertEqual(options["no_speech_threshold"], 0.6)
            self.assertFalse(options["condition_on_previous_text"])
            self.assertIsNone(options["initial_prompt"])
            # Метаданные обязаны описывать именно вызванный режим, включая JSON-представление температур.
            result = json.loads(state.output.read_text())
            recorded = dict(options)
            recorded.pop("initial_prompt")
            self.assertEqual(result["asr_options"], json.loads(json.dumps(recorded)))

    def test_vad_times_and_words_receive_only_requested_offset(self):
        # faster-whisper уже вернул время после внутреннего восстановления пауз.
        # Сегмент 12–14 с обрезка с 10 с должна перенести в 22–24 с полного трека.
        segment = Segment(12, 14, "Настоящий вокал", [Word(12, 13, "Настоящий"), Word(13, 14, "вокал")])
        with runtime([segment], duration=40) as state:
            sys.argv += ["--start", "10"]
            tool.main()
            self.assertEqual(len(state.model.return_value.transcribe.call_args.args[0]), 30 * 16000)
            result = json.loads(state.output.read_text())
            self.assertEqual(result["decoded_duration"], 40)
            self.assertEqual(result["offset"], 10)
            self.assertEqual((result["segments"][0]["start"], result["segments"][0]["end"]), (22, 24))
            self.assertEqual(
                [(word["start"], word["end"]) for word in result["segments"][0]["words"]], [(22, 23), (23, 24)]
            )
            self.assertEqual(result["segments"], result["raw_segments"])

    def test_ctc_receives_good_repeated_lines_and_raw_keeps_collapsed_hallucination(self):
        refrain = Segment(
            1, 4, "Снова звучит припев", [Word(1, 2, "Снова"), Word(2, 3, "звучит"), Word(3, 4, "припев")]
        )
        repeated = Segment(
            20, 23, refrain.text, [Word(20, 21, "Снова"), Word(21, 22, "звучит"), Word(22, 23, "припев")]
        )
        # Семь слов за 20 мс воспроизводят сбой без привязки фильтра к имени или фразе.
        phantom = Segment(
            30,
            30.02,
            "Любые слова здесь не должны определять фильтрацию",
            [
                Word(30, 30.02, "Любые"),
                *[Word(30.02, 30.02, word) for word in "слова здесь не должны определять фильтрацию".split()],
            ],
        )
        with runtime([refrain, phantom, repeated], vocals=True) as state:

            def refine(lines, estimates, result, *rest):
                self.assertEqual([item["text"] for item in result["segments"]], [refrain.text, refrain.text])
                self.assertEqual(result["raw_segments"], [asdict(refrain), asdict(phantom), asdict(repeated)])
                self.assertEqual([item["raw_index"] for item in result["rejected_segments"]], [1])
                # После CTC segments принадлежит исходным строкам, raw_segments остаётся доказательством ASR.
                result["segments"] = [{"start": 1, "end": 4, "text": lines[0][1], "source_line": 1}]
                return result

            with patch("tools.song_timing.ctc.refine_lines", side_effect=refine):
                tool.main()
            result = json.loads(state.output.read_text())
            self.assertEqual(result["raw_segments"], [asdict(refrain), asdict(phantom), asdict(repeated)])
            self.assertEqual(result["segments"][0]["source_line"], 1)
            self.assertEqual(result["rejected_segments"][0]["raw_index"], 1)
            self.assertTrue(result["rejected_segments"][0]["reason"])

    def test_ctc_candidates_publish_separately_and_nonfinite_score_keeps_previous_json(self):
        candidate = {"source_line": 1, "start": 0.2, "end": 0.8, "reason": "Слабое сходство", "acoustic_score": 0.7}
        for score in (0.7, float("nan")):
            with runtime([], vocals=True) as state:

                def refine(lines, estimates, result, *rest):
                    return {**result, "candidates": [{**candidate, "acoustic_score": score}]}

                with patch("tools.song_timing.ctc.refine_lines", side_effect=refine):
                    if score == score:
                        tool.main()
                        result = json.loads(state.output.read_text())
                        self.assertEqual(result["segments"], [])
                        self.assertEqual(result["candidates"], [candidate])
                    else:
                        with self.assertRaisesRegex(ValueError, "нечисловые значения"):
                            tool.main()
                        self.assertEqual(state.output.read_bytes(), b"previous recognition")

    def test_midstream_asr_failure_keeps_previous_json(self):
        def fail():
            yield Segment()
            raise RuntimeError("Сбой ASR после сегмента")

        with runtime(fail()) as state:
            with self.assertRaisesRegex(RuntimeError, "после сегмента"):
                tool.main()
            self.assertEqual(state.output.read_bytes(), b"previous recognition")

    def test_ready_vocal_is_reused_without_loading_separator(self):
        with (
            runtime([Segment()], vocals=True) as state,
            patch("tools.song_timing.mdx.session") as separator,
            patch("tools.song_timing.ctc.refine_lines", side_effect=lambda lines, estimates, result, *rest: result),
        ):
            tool.main()
            separator.assert_not_called()
            self.assertEqual(json.loads(state.output.read_text())["vocalResult"]["modelId"], "voc-ft")

    def test_song_models_without_selected_vocal_refuse_before_asr(self):
        with runtime([]) as state:
            sys.argv += ["--song-models", str(state.root / "models")]
            with self.assertRaisesRegex(ValueError, "Сначала выделите"):
                tool.main()
            state.model.assert_not_called()
            self.assertEqual(state.output.read_bytes(), b"previous recognition")

    def test_changed_vocal_during_asr_keeps_previous_result(self):
        with (
            runtime([Segment()], vocals=True) as state,
            patch(
                "tools.song_timing.vocal_result.validate_result",
                side_effect=[{"modelId": "voc-ft", "audioSha256": "checked"}, ValueError("Вокал изменился")],
            ),
            patch("tools.song_timing.ctc.refine_lines", side_effect=lambda lines, estimates, result, *rest: result),
        ):
            with self.assertRaisesRegex(ValueError, "изменился"):
                tool.main()
            self.assertEqual(state.output.read_bytes(), b"previous recognition")

    def test_failed_ctc_does_not_publish_raw_segments(self):
        with (
            runtime([Segment()], vocals=True) as state,
            patch("tools.song_timing.ctc.refine_lines", side_effect=ValueError("Сбой CTC")),
        ):
            with self.assertRaisesRegex(ValueError, "Сбой CTC"):
                tool.main()
            self.assertEqual(state.output.read_bytes(), b"previous recognition")

    def test_failed_atomic_write_keeps_previous_json_and_cleans_temporary(self):
        with runtime([Segment()]) as state, patch.object(Path, "replace", side_effect=OSError("Отказ записи")):
            with self.assertRaisesRegex(OSError, "Отказ записи"):
                tool.main()
            self.assertEqual(state.output.read_bytes(), b"previous recognition")
            self.assertEqual(list(state.root.glob("*.tmp")), [])

    def test_nonfinite_raw_timestamp_keeps_previous_json_before_publication(self):
        # Исключение из пригодных сегментов не удаляет NaN из raw; такой результат нельзя публиковать.
        with runtime([Segment(start=float("nan"))]) as state, patch.object(tool, "write_json_atomic") as publish:
            with self.assertRaisesRegex(ValueError, "нечисловые значения.*не записан"):
                tool.main()
            publish.assert_not_called()
            self.assertEqual(state.output.read_bytes(), b"previous recognition")
            self.assertEqual(list(state.root.glob("*.tmp")), [])

    def test_changed_source_cannot_publish_a_stale_hash(self):
        with runtime([]) as state:

            def change(*args, **kwargs):
                state.source.write_bytes(b"changed audio")
                return [], SimpleNamespace(language="ru")

            state.model.return_value.transcribe.side_effect = change
            with self.assertRaisesRegex(ValueError, "изменились"):
                tool.main()
            self.assertEqual(state.output.read_bytes(), b"previous recognition")

    def test_ctc_uses_initial_text_and_preserves_output_if_text_changes(self):
        with runtime([Segment()], vocals=True) as state:

            def change(lines, estimates, result, audio, directory):
                self.assertEqual(lines, [(1, "Первая строка")])
                state.text.write_text("Другой текст", encoding="utf-8")
                return result

            with patch("tools.song_timing.ctc.refine_lines", side_effect=change):
                with self.assertRaisesRegex(ValueError, "изменились"):
                    tool.main()
            self.assertEqual(state.output.read_bytes(), b"previous recognition")

    def test_recognition_output_cannot_overwrite_source(self):
        with runtime([]) as state:
            for destination in (state.source, state.text, state.root / "plan/audio/timing.json"):
                with patch.object(
                    sys,
                    "argv",
                    [
                        "transcribe",
                        "--model",
                        str(state.root),
                        "--output",
                        str(destination),
                        "--allow-network",
                        "--device",
                        "cpu",
                    ],
                ):
                    with self.assertRaisesRegex(ValueError, "поверх исходного"):
                        tool.main()
            self.assertEqual(state.source.read_bytes(), b"local audio")
            self.assertEqual(state.text.read_text(encoding="utf-8"), "Первая строка")


if __name__ == "__main__":
    unittest.main()
