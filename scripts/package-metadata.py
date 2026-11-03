#!/usr/bin/env python3
"""Сохранить SHA и измерения ранней поставки без абсолютных путей сборочной машины."""
import hashlib
import json
import pathlib
import platform
import subprocess
import sys

image, appdir, tool = map(pathlib.Path, sys.argv[1:4])
version = sys.argv[4]


def digest(path):
    """Потоковый SHA не загружает целый AppImage в память."""
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
dirty = bool(subprocess.check_output(['git', 'status', '--porcelain'], text=True))
# Receipt не может подтвердить неподходящий GTK/WebKit даже при ручном вызове metadata.
runtime_policy = json.loads(subprocess.check_output(
    [sys.executable, 'scripts/linux_runtime_policy.py', 'check', str(appdir)], text=True))
result = {
    'version': version, 'revision': revision, 'dirty': dirty,
    'platform': 'linux/amd64', 'minimumOS': 'Ubuntu 24.04 / glibc 2.39',
    'kernel': platform.release(), 'file': image.name,
    'bytes': image.stat().st_size, 'sha256': digest(image),
    'unpackedBytes': sum(p.stat().st_size for p in appdir.rglob('*') if p.is_file() and not p.is_symlink()),
    'tool': {'wails': '3.0.0', 'linuxdeploySHA256': digest(tool)},
    'runtimePolicy': runtime_policy,
    'externalComponents': ['ffmpeg', 'ort-cpu', 'voc-ft', 'ctc-ru', 'ctc-vocab'],
}
image.with_suffix(image.suffix + '.build.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
image.with_suffix(image.suffix + '.sha256').write_text(f"{result['sha256']}  {image.name}\n")
print(json.dumps(result, ensure_ascii=False, indent=2))
