"""Общий запуск официального Kling CLI из приложения или явно выбранного внешнего файла; @link README.md"""

import os
import shutil
import subprocess
from pathlib import Path


def resolve(cli="kling"):
    """Явный --cli имеет приоритет; неполный встроенный комплект не подменяется глобальной командой."""
    if cli == "kling" and any(name in os.environ for name in ("SONGFRAME_KLING_EXECUTABLE", "SONGFRAME_KLING_SCRIPT")):
        executable = os.environ.get("SONGFRAME_KLING_EXECUTABLE")
        script = os.environ.get("SONGFRAME_KLING_SCRIPT")
        if not executable or not script or shutil.which(executable) is None or not Path(script).is_file():
            raise FileNotFoundError("Встроенный Kling CLI недоступен: проверьте комплект приложения.")
        return [executable, script]
    executable = shutil.which(cli)
    if executable is None:
        raise FileNotFoundError("CLI не найден")
    return [executable]


def run(argv, timeout, *, stdout=None):
    """Electron исполняет только дочерний CLI как Node; окружение Python и приложения не меняется."""
    prefix = resolve(argv[0])
    env = dict(os.environ)
    if len(prefix) == 2:
        env["ELECTRON_RUN_AS_NODE"] = "1"
    return subprocess.run(
        [*prefix, *argv[1:]],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE if stdout is None else stdout,
        stderr=subprocess.PIPE,
        timeout=timeout,
        shell=False,
        env=env,
    )
