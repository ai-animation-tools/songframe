#!/usr/bin/env python3
"""Собрать лицензионные материалы встроенных библиотек и зависимостей приложения."""
import json
import pathlib
import shutil
import subprocess
import sys

appdir = pathlib.Path(sys.argv[1])
platform = sys.argv[2] if len(sys.argv) > 2 else 'linux'
notices = appdir / ('licenses' if platform == 'windows' else 'usr/share/doc/songframe-go')
notices.mkdir(parents=True, exist_ok=True)
shutil.copyfile('LICENSE', notices / 'LICENSE')
# Bootstrap адаптирован из Forktopus; полный MIT notice сохранён в исходнике.
if platform == 'linux':
    source = pathlib.Path('scripts/appimage-bootstrap/main_linux.go').read_text()
    (notices / 'Forktopus-MIT.txt').write_text(source.split('package main')[0])
packages = set()
# По именам файлов находим владельцев исходных Debian-библиотек; relocation не меняет их лицензию.
for path in (appdir / 'usr/lib').rglob('*'):
    if not path.is_file() or '.so' not in path.name:
        continue
    found = subprocess.run(['dpkg-query', '-S', '*/' + path.name], text=True, capture_output=True)
    for line in found.stdout.splitlines():
        if ': /' in line:
            packages.update(line.split(': /', 1)[0].split(', '))
for package in sorted(packages):
    name = package.split(':')[0]
    copyright_file = pathlib.Path('/usr/share/doc') / name / 'copyright'
    if copyright_file.is_file():
        target = notices / 'system' / name
        target.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(copyright_file, target / 'copyright')
(notices / 'system-packages.txt').write_text('\n'.join(sorted(packages)) + '\n')
# Go module cache хранит исходные лицензии; JSON-декодер читает поток объектов go list.
raw = subprocess.check_output(['go', 'list', '-m', '-json', 'all'], text=True)
decoder = json.JSONDecoder()
while raw.strip():
    module, end = decoder.raw_decode(raw.lstrip())
    raw = raw.lstrip()[end:]
    directory = module.get('Dir')
    if not directory or module.get('Main'):
        continue
    for path in pathlib.Path(directory).iterdir():
        if path.is_file() and path.name.lower().startswith(('license', 'copying', 'notice')):
            target = notices / 'go' / module['Path'] / module['Version']
            target.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, target / path.name)
# Обходим только runtime dependencies frontend, а не все dev-инструменты node_modules.
visited = set()


def frontend_notices(name, parent):
    """Разрешить dependency как Node: от ближайшего node_modules к корневому."""
    directory = parent
    while not (directory / 'node_modules' / name / 'package.json').is_file():
        if directory == directory.parent:
            raise RuntimeError(f'Не найдена frontend dependency {name}')
        directory = directory.parent
    package_dir = directory / 'node_modules' / name
    if package_dir in visited:
        return
    visited.add(package_dir)
    metadata = json.loads((package_dir / 'package.json').read_text())
    target = notices / 'frontend' / name
    target.mkdir(parents=True, exist_ok=True)
    (target / 'package.json').write_text(json.dumps({key: metadata.get(key) for key in ('name', 'version', 'license')}, indent=2) + '\n')
    for path in package_dir.iterdir():
        if path.is_file() and path.name.lower().startswith(('license', 'copying', 'notice')):
            shutil.copyfile(path, target / path.name)
    for dependency in metadata.get('dependencies', {}):
        frontend_notices(dependency, package_dir)


for name in json.loads(pathlib.Path('frontend/package.json').read_text())['dependencies']:
    frontend_notices(name, pathlib.Path('frontend').resolve())
