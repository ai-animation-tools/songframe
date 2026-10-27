"""Выбор CPU/CUDA для подсказки и самого ASR без установки драйверов. @link README.md"""

import ctypes
import os
import subprocess
import sys


def detect_hardware():
    """CUDA предлагаем лишь при видимой NVIDIA и доступных библиотеках CTranslate2."""
    result = dict(
        gpuName=None,
        vramMiB=0,
        cudaReady=False,
        device="cpu",
        computeType="int8",
        reason="Совместимая NVIDIA не обнаружена. Используется CPU; слабая, AMD или Intel GPU этому не мешает.",
    )
    try:
        probe = subprocess.run(
            ["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"],
            capture_output=True,
            text=True,
            timeout=4,
            check=True,
        )
        cards = []
        for line in probe.stdout.strip().splitlines():
            name, memory = line.rsplit(",", 1)
            cards.append((name.strip(), int(memory.strip())))
        if not cards:
            return result
        # CTranslate2 использует GPU 0; не рекомендуем ресурсы другой карты, которую ASR не выбрал.
        result.update(gpuName=cards[0][0], vramMiB=cards[0][1])
        if result["vramMiB"] < 2048:
            result["reason"] = "У NVIDIA меньше 2 ГБ видеопамяти. Для этой конфигурации предлагаем CPU."
            return result
        import ctranslate2

        if ctranslate2.get_cuda_device_count() < 1:
            result["reason"] = (
                "NVIDIA найдена, но CTranslate2 не видит CUDA. Проверьте драйвер NVIDIA; пока используется CPU."
            )
            return result
        supported = ctranslate2.get_supported_compute_types("cuda", device_index=0)
        compute = next((kind for kind in ("int8_float16", "float16") if kind in supported), None)
        if not compute:
            result["reason"] = "Видеокарта не поддерживает нужный режим CUDA. Используется CPU/int8."
            return result
        libraries = (
            ("cublas64_12.dll", "cudnn64_9.dll") if sys.platform == "win32" else ("libcublas.so.12", "libcudnn.so.9")
        )
        for library in libraries:
            try:
                ctypes.CDLL(library)
            except OSError:
                result["reason"] = (
                    f"NVIDIA найдена, но не загружается {library}. "
                    "Установите cuBLAS для CUDA 12 и cuDNN 9; пока используется CPU."
                )
                return result
        result.update(
            cudaReady=True,
            device="cuda",
            computeType=compute,
            reason=f"Доступны NVIDIA, CUDA 12 и cuDNN 9. Распознавание использует CUDA/{compute}.",
        )
    except (OSError, ValueError, subprocess.SubprocessError, ImportError, RuntimeError) as error:
        if result["gpuName"]:
            result["reason"] = f"Проверка CUDA не завершилась: {error}. Пока используется CPU."
    return result


def cpu_threads():
    """Не требуем восемь потоков от слабого компьютера и не занимаем все ядра мощного."""
    return max(1, min(8, os.cpu_count() or 1))
