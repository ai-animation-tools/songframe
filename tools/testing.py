"""Помощник тестов: временная копия проекта-образца как текущий проект инструментов; @link testdata/README.md

Импортировать до модулей инструментов в тестах, которым нужен настоящий реестр сцен и манифесты:

    import tools.testing  # noqa: F401  (создаёт копию и задаёт SONGFRAME_PROJECT)

`run_tests` делает то же для всего набора. Переменная уже заданная снаружи сохраняется,
чтобы можно было прогнать тесты на другом проекте.
"""

import atexit
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

PROJECT_ENV = "SONGFRAME_PROJECT"
SAMPLE = Path(__file__).resolve().parent / "testdata" / "sample-project"
_TEMPORARY = None


def render_placeholders(target):
    """Подставляет пути в копию шаблона, как приложение при создании проекта."""
    import json

    project = json.loads((target / "plan/project.json").read_text(encoding="utf-8"))
    values = {
        "{{project_name}}": project["name"],
        "{{animatic_video}}": project["animatic_video"],
        "{{tools_root}}": str(SAMPLE.parents[2]),
        "{{project_root}}": str(target),
    }
    for path in target.rglob("*"):
        if path.suffix not in (".md", ".json") or not path.is_file():
            continue
        text = path.read_text(encoding="utf-8")
        if "{{" not in text:
            continue
        for key, value in values.items():
            text = text.replace(key, value)
        path.write_text(text, encoding="utf-8")


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
    render_placeholders(target)
    # Представления перечисляют файлы через git ls-files; коммит не нужен, достаточно репозитория.
    subprocess.run(["git", "init", "-q", str(target)], check=True, stdin=subprocess.DEVNULL, capture_output=True)
    os.environ[PROJECT_ENV] = str(target)
    atexit.register(shutil.rmtree, _TEMPORARY, True)
    return target


ensure_sample_project()
