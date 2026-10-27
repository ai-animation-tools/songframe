"""Проверка нативных импортов и вложенного интерпретатора без модели и системного Python. @link README.md"""

import importlib
import json
import os
import subprocess
import sys
from io import BytesIO

import ctranslate2
from PIL import Image

modules = {}
if "--empty-path" in sys.argv:
    assert not os.environ.get("PATH"), "PATH дочернего процесса должен быть пустым"
for name in ("PIL", "numpy", "faster_whisper", "ctranslate2", "av", "onnxruntime", "tokenizers"):
    module = importlib.import_module(name)
    modules[name] = module.__version__

# Проверяем работу расширения Pillow, а не только наличие его Python-обёртки.
buffer = BytesIO()
Image.new("RGB", (8, 8), "red").save(buffer, format="PNG")
assert Image.open(BytesIO(buffer.getvalue())).size == (8, 8)
child = subprocess.run(
    [sys.executable, "-I", "-B", "-X", "utf8", "-c", "import sys; print(sys.executable)"],
    check=True,
    capture_output=True,
    text=True,
    encoding="utf-8",
)
assert child.stdout.strip() == sys.executable
print(
    json.dumps(
        {
            "executable": sys.executable,
            "version": sys.version.split()[0],
            "modules": modules,
            "cpu_types": sorted(ctranslate2.get_supported_compute_types("cpu")),
            "nested_executable": child.stdout.strip(),
        },
        ensure_ascii=False,
    )
)
