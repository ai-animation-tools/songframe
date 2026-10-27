"""Проверка выбора режима без реальной GPU и загрузки её библиотек. @link README.md"""

import subprocess
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from tools.transcribe_local import hardware


class HardwareTests(unittest.TestCase):
    def test_cpu_without_nvidia_or_on_weak_gpu(self):
        with patch.object(hardware.subprocess, "run", side_effect=FileNotFoundError()):
            self.assertEqual(hardware.detect_hardware()["device"], "cpu")
        with patch.object(hardware.subprocess, "run", return_value=SimpleNamespace(stdout="NVIDIA, 1024\n")):
            self.assertIn("меньше 2 ГБ", hardware.detect_hardware()["reason"])
        with patch.object(hardware.subprocess, "run", side_effect=subprocess.TimeoutExpired("nvidia-smi", 4)):
            self.assertFalse(hardware.detect_hardware()["cudaReady"])

    def test_cuda_needs_runtime_libraries_not_just_nvidia(self):
        ct2 = SimpleNamespace(
            get_cuda_device_count=lambda: 1, get_supported_compute_types=lambda *args, **kwargs: {"int8_float16"}
        )
        with (
            patch.object(hardware.subprocess, "run", return_value=SimpleNamespace(stdout="NVIDIA, 8192\n")),
            patch.dict(sys.modules, {"ctranslate2": ct2}),
            patch.object(hardware.ctypes, "CDLL", side_effect=OSError("missing")),
        ):
            result = hardware.detect_hardware()
            self.assertEqual(result["gpuName"], "NVIDIA")
            self.assertEqual(result["vramMiB"], 8192)
            self.assertFalse(result["cudaReady"])
            self.assertEqual(result["device"], "cpu")
            self.assertIn("cuDNN 9", result["reason"])
        with (
            patch.object(hardware.subprocess, "run", return_value=SimpleNamespace(stdout="NVIDIA, 8192\n")),
            patch.dict(sys.modules, {"ctranslate2": ct2}),
            patch.object(hardware.ctypes, "CDLL"),
        ):
            result = hardware.detect_hardware()
            self.assertTrue(result["cudaReady"])
            self.assertEqual(result["device"], "cuda")
            self.assertEqual(result["computeType"], "int8_float16")

    def test_old_driver_and_cpu_threads(self):
        ct2 = SimpleNamespace(get_cuda_device_count=lambda: 0)
        with (
            patch.object(hardware.subprocess, "run", return_value=SimpleNamespace(stdout="NVIDIA, 8192\n")),
            patch.dict(sys.modules, {"ctranslate2": ct2}),
        ):
            self.assertIn("драйвер", hardware.detect_hardware()["reason"])
        with patch.object(hardware.os, "cpu_count", return_value=2):
            self.assertEqual(hardware.cpu_threads(), 2)


if __name__ == "__main__":
    unittest.main()
