"""Проверка повреждённых и прерванных записей; @link README.md"""

import sys
from pathlib import Path

# После переноса точка запуска находится на два уровня ниже корня проекта.
# Полные импорты tools.* работают и при прямом запуске файла из любой папки.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))


import tempfile
import unittest

from tools.animatic_cache.animatic_cache import ArtifactCache


class CacheTests(unittest.TestCase):
    def test_partial_and_corrupted_entries_are_rebuilt(self):
        # Квитанция без целого файла не должна скрывать потерю производной.
        with tempfile.TemporaryDirectory() as tmp:
            cache = ArtifactCache(tmp)
            calls = []

            def producer(path):
                calls.append(path)
                path.write_bytes("готовая производная".encode())
                return {"valid": True}

            first, _ = cache.obtain("sample", {"input": "one"}, ".bin", producer)
            cache.obtain("sample", {"input": "one"}, ".bin", producer)
            self.assertEqual(len(calls), 1)
            first.write_bytes(b"broken")
            cache.obtain("sample", {"input": "one"}, ".bin", producer)
            self.assertEqual(len(calls), 2)
            _, _, receipt = cache.paths("sample", {"input": "one"}, ".bin")
            receipt.unlink()
            cache.obtain("sample", {"input": "one"}, ".bin", producer)
            self.assertEqual(len(calls), 3)

            def interrupted(path):
                path.write_bytes(b"partial")
                raise RuntimeError("Прервано")

            with self.assertRaises(RuntimeError):
                cache.obtain("sample", {"input": "two"}, ".bin", interrupted)
            self.assertIsNone(cache.lookup("sample", {"input": "two"}, ".bin"))


if __name__ == "__main__":
    unittest.main()
