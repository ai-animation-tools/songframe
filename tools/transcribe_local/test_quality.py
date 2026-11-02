"""Пригодность времён ASR без оценки текста песни и без модели. @link README.md"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from tools.transcribe_local.quality import unusable_reason


class TimingQualityTests(unittest.TestCase):
    def test_unusable_segment_intervals_do_not_become_timing_anchors(self):
        for start, end in [(1, 1), (2, 1), (float("nan"), 2), (1, float("inf")), (-float("inf"), 1)]:
            with self.subTest(start=start, end=end):
                self.assertTrue(unusable_reason({"start": start, "end": end, "words": []}))

    def test_sustained_singing_is_not_rejected_for_several_collapsed_words(self):
        # При пении отдельное слово действительно бывает протяжным: одних нулевых соседей недостаточно.
        words = [
            {"word": "Долго", "start": 1, "end": 3},
            {"word": "длится", "start": 3, "end": 3},
            {"word": "эта", "start": 3, "end": 3},
            {"word": "песня", "start": 3, "end": 3},
        ]
        self.assertIsNone(unusable_reason({"start": 1, "end": 3, "words": words, "no_speech_prob": 0.99}))

    def test_punctuation_is_not_counted_as_collapsed_lyric_words(self):
        words = [
            {"word": "Поём", "start": 1, "end": 1.05},
            *[{"word": mark, "start": 1.05, "end": 1.05} for mark in [",", "—", "!", "..."]],
        ]
        self.assertIsNone(unusable_reason({"start": 1, "end": 1.05, "words": words}))


if __name__ == "__main__":
    unittest.main()
