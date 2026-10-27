"""Собирает Windows Python из готовых wheels на Linux, не исполняя Windows-код. @link README.md"""

import importlib.metadata
import sys
from pathlib import Path

# installer — чистый Python в закреплённом wheel; в пользовательскую поставку он не попадает.
sys.path.insert(0, sys.argv[3])
from installer import install
from installer.destinations import SchemeDictionaryDestination
from installer.sources import WheelFile
from packaging.markers import default_environment
from packaging.requirements import Requirement
from packaging.utils import canonicalize_name

root = Path(sys.argv[1])
wheels = Path(sys.argv[2])
site_packages = root / "Lib/site-packages"
destination = SchemeDictionaryDestination(
    scheme_dict={
        "purelib": str(site_packages),
        "platlib": str(site_packages),
        "scripts": str(root / "Scripts"),
        "headers": str(root / "include"),
        "data": str(root),
    },
    interpreter="python.exe",
    script_kind="win-amd64",
    bytecode_optimization_levels=(),
)
for wheel in sorted(wheels.glob("*.whl")):
    with WheelFile.open(wheel) as source:
        install(source=source, destination=destination, additional_metadata={"INSTALLER": b"songframe\n"})

# Проверяем зависимости для Windows, не принимая Linux-маркеры сборщика за целевые.
distributions = list(importlib.metadata.distributions(path=[str(site_packages)]))
versions = {canonicalize_name(dist.metadata["Name"]): dist.version for dist in distributions}
environment = {
    **default_environment(),
    "os_name": "nt",
    "sys_platform": "win32",
    "platform_system": "Windows",
    "platform_machine": "AMD64",
    "python_version": "3.12",
    "python_full_version": sys.argv[4],
    "extra": "",
}
for dist in distributions:
    for text in dist.requires or []:
        requirement = Requirement(text)
        if requirement.marker and not requirement.marker.evaluate(environment):
            continue
        installed = versions.get(canonicalize_name(requirement.name))
        if installed is None or installed not in requirement.specifier:
            raise SystemExit(f"{dist.metadata['Name']}: не выполнено требование {text}; установлено {installed}")
for filename in ("python.exe", "python312.dll", "msvcp140.dll", "vcruntime140.dll"):
    if not (root / filename).is_file():
        raise SystemExit(f"Нет обязательного Windows-компонента: {filename}")
print(
    f"Windows runtime: установлены {len(distributions)} пакетов; зависимости и размещение DLL проверены. "
    "Нативный запуск проверяется в Windows."
)
