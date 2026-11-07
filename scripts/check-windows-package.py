#!/usr/bin/env python3
"""Проверить PE/CGO и состав NSIS без исполнения Windows-кода; сохранить SHA и build receipt."""
import hashlib
import json
import pathlib
import re
import struct
import subprocess
import sys
import tempfile

binary, installer = map(pathlib.Path, sys.argv[1:3])
version, image = sys.argv[3:5]


def digest(path):
    """Хешировать потоково: размер пакета не определяет потребление памяти проверкой."""
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def check_pe(path):
    """Не принимать консольный exe или другую архитектуру за Windows GUI amd64."""
    data = path.read_bytes()
    offset = struct.unpack_from('<I', data, 0x3c)[0]
    assert data[:2] == b'MZ' and data[offset:offset + 4] == b'PE\0\0', 'Нет PE signature'
    assert struct.unpack_from('<H', data, offset + 4)[0] == 0x8664, 'Нужен AMD64'
    optional = offset + 24
    assert struct.unpack_from('<H', data, optional)[0] == 0x20b, 'Нужен PE32+'
    assert struct.unpack_from('<H', data, optional + 68)[0] == 2, 'Нужен Windows GUI subsystem'
    sections = subprocess.check_output(['objdump', '-h', str(path)], text=True)
    assert '.rsrc' in sections, 'Отсутствуют icon/manifest resources'
    imports_text = subprocess.check_output(['objdump', '-p', str(path)], text=True)
    imports = re.findall(r'DLL Name:\s*(\S+)', imports_text)
    for name in imports:
        assert name.lower() == 'kernel32.dll' or name.lower().startswith('api-ms-win-crt-'), f'Неподтверждённая native dependency: {name}'
    assert b'tools.songframe.desktop' in data and b'asInvoker' in data, 'Нет отдельного app ID/asInvoker manifest'
    return imports


imports = check_pe(binary)
build_info = subprocess.check_output(['go', 'version', '-m', str(binary)], text=True)
for required in ['CGO_ENABLED=1', 'GOOS=windows', 'GOARCH=amd64', 'github.com/microsoft/onnxruntime/go']:
    assert required in build_info, f'Не подтверждён {required}'
# Обновление из приложения сравнивает выпуски по версии, вшитой в бинарник через -X.
# -trimpath не сохраняет ldflags в build info, поэтому ищем саму строку версии.
assert version.encode() in binary.read_bytes(), 'В exe не вшита версия packaging/VERSION'
with tempfile.TemporaryDirectory(prefix='songframe-nsis-') as directory:
    subprocess.run(['7z', 'x', '-y', '-o' + directory, str(installer)], check=True, stdout=subprocess.DEVNULL)
    root = pathlib.Path(directory)
    candidates = list(root.rglob('songframe.exe'))
    assert len(candidates) == 1 and digest(candidates[0]) == digest(binary), 'В NSIS другой exe'
    assert list(root.rglob('MicrosoftEdgeWebview2Setup.exe')), 'Нет WebView2 bootstrapper'
    assert list(root.rglob('vc_redist.x64.exe')), 'Нет VC++ prerequisite'
    assert list(root.rglob('uninstall.exe')), 'Нет uninstaller'
    assert list(root.rglob('LICENSE')), 'Нет лицензий'
    assert not list(root.rglob('*.onnx')) and not list(root.rglob('onnxruntime.dll')), 'ML попал в базовый пакет'
    payload_bytes = sum(p.stat().st_size for p in root.rglob('*') if p.is_file())
receipt = {
    'version': version, 'platform': 'windows/amd64', 'minimumOS': 'Windows 10/11 x64',
    'revision': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(),
    'dirty': bool(subprocess.check_output(['git', 'status', '--porcelain'], text=True)),
    'file': installer.name, 'bytes': installer.stat().st_size, 'sha256': digest(installer),
    'applicationBytes': binary.stat().st_size, 'applicationSHA256': digest(binary),
    'extractedPayloadBytes': payload_bytes, 'cgo': True, 'subsystem': 'Windows GUI',
    'imports': imports,
    'crossImage': subprocess.check_output(['docker', 'image', 'inspect', image, '--format', '{{.Id}}'], text=True).strip(),
    'staticCheckPassed': True, 'nativeWindowsTested': False,
    'externalComponents': ['ffmpeg', 'ort-cpu', 'voc-ft', 'ctc-ru', 'ctc-vocab'],
}
installer.with_suffix(installer.suffix + '.build.json').write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + '\n')
installer.with_suffix(installer.suffix + '.sha256').write_text(f"{receipt['sha256']}  {installer.name}\n")
print(json.dumps(receipt, ensure_ascii=False, indent=2))
