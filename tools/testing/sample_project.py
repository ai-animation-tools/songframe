"""Помощник тестов: временная копия проекта-образца как текущий проект инструментов; @link ../testdata/README.md

Импортировать до модулей инструментов в тестах, которым нужен настоящий реестр сцен и манифесты:

    import tools.testing.sample_project  # noqa: F401  (создаёт копию и задаёт SONGFRAME_PROJECT)

`run_tests` делает то же для всего набора. Переменная уже заданная снаружи сохраняется,
чтобы можно было прогнать тесты на другом проекте. Без заданного снаружи `SONGFRAME_LOCAL_DIR`
каталог состояния тоже временный: тесты не пишут в userData пользователя.
"""

import atexit
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

PROJECT_ENV = "SONGFRAME_PROJECT"
LOCAL_DIR_ENV = "SONGFRAME_LOCAL_DIR"
SAMPLE = Path(__file__).resolve().parents[1] / "testdata" / "sample-project"
_TEMPORARY = None


def ensure_sample_project():
    """Создаёт копию образца с инициализированным Git и возвращает её путь; повторный вызов отдаёт ту же копию."""
    global _TEMPORARY
    if os.environ.get(PROJECT_ENV):
        return Path(os.environ[PROJECT_ENV])
    _TEMPORARY = tempfile.mkdtemp(prefix="songframe-sample-")
    target = Path(_TEMPORARY) / "sample-project"
    shutil.copytree(SAMPLE, target)
    # В образце .gitignore проекта хранится как _gitignore, иначе Git комплекса прятал бы пакет плана в plan/batches.
    (target / "_gitignore").rename(target / ".gitignore")
    # Представления перечисляют файлы через git ls-files; коммит не нужен, достаточно репозитория.
    subprocess.run(["git", "init", "-q", str(target)], check=True, stdin=subprocess.DEVNULL, capture_output=True)
    os.environ[PROJECT_ENV] = str(target)
    atexit.register(shutil.rmtree, _TEMPORARY, True)
    return target


def ensure_local_directory():
    """Временный каталог состояния, если он не задан снаружи; задаётся до импорта tools.common."""
    if not os.environ.get(LOCAL_DIR_ENV):
        os.environ[LOCAL_DIR_ENV] = tempfile.mkdtemp(prefix="songframe-test-state-")
        atexit.register(shutil.rmtree, os.environ[LOCAL_DIR_ENV], True)
    return Path(os.environ[LOCAL_DIR_ENV])


ensure_local_directory()
ensure_sample_project()
