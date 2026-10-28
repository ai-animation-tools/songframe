"""Общие для инструментов корень проекта клипа, корень комплекса, хеш файла и чтение JSON; @link README.md

Инструменты лежат в комплексе SongFrame, а данные клипа в отдельной папке проекта. Папка проекта
определяется один раз при импорте этого модуля, в таком порядке:

1. аргумент `--project ПУТЬ` или `--project=ПУТЬ` в командной строке любого инструмента (вырезается из
   `sys.argv`, поэтому argparse инструментов его не видит);
2. переменная окружения `SONGFRAME_PROJECT`;
3. файл текущего проекта `current-project.json` в постоянном каталоге состояния, который пишет приложение
   или инструмент `current_project`;
4. текущая папка, если в ней есть `plan/project.json`.

Инструменты импортируют `ROOT`; тесты подменяют `ROOT` в модуле инструмента, не трогая этот файл.
"""

import hashlib
import json
import os
import subprocess
import sys
import tempfile
import time
import uuid
from decimal import Decimal
from pathlib import Path

# Корень комплекса относительно tools/common.py: схемы, прайс и прочие ресурсы инструментов лежат здесь.
TOOLS_ROOT = Path(__file__).resolve().parents[1]


def decoded_audio_duration(path):
    """Та же шкала декодированного звука, что у разметки: start_time MP3 не вычитается из длительности."""
    result = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path), "-map", "0:a:0", "-ac", "1", "-ar", "16000", "-f", "s16le", "-"],
        capture_output=True,
    )
    if result.returncode:
        raise ValueError("Не удалось декодировать трек: " + result.stderr.decode(errors="replace")[-1200:])
    return Decimal(len(result.stdout)) / 32000


def local_directory(environ=None, home=None):
    """У приложения и ручного CLI один userData; ресурсы не используются для записей."""
    env = os.environ if environ is None else environ
    home = Path.home() if home is None else Path(home)
    if env.get("SONGFRAME_LOCAL_DIR"):
        return Path(env["SONGFRAME_LOCAL_DIR"]).expanduser().resolve()
    base = env.get("APPDATA") if sys.platform == "win32" else env.get("XDG_CONFIG_HOME")
    fallback = home / "AppData/Roaming" if sys.platform == "win32" else home / ".config"
    return Path(base or fallback) / "songframe"


LOCAL_DIR = local_directory()
CURRENT_PROJECT_FILE = LOCAL_DIR / "current-project.json"
PROJECT_ENV = "SONGFRAME_PROJECT"
PROJECT_MARKER = "plan/project.json"
# Инструменты, которым проект не нужен: запуск без выбранного проекта для них не ошибка.
PROJECT_FREE_TOOLS = {"run_tests.py", "current_project.py"}
# Действия инструментов, не связанные с проектом: вход к провайдеру выполняется со страницы «Среда» без клипа.
PROJECT_FREE_ACTIONS = {"media_request.py": {"login", "auth-status"}}
NO_PROJECT_MESSAGE = (
    "Проект клипа не выбран. Укажите `--project <папка>`, задайте переменную окружения "
    f"{PROJECT_ENV} или выберите проект: `python3 -B tools/current_project/current_project.py set <папка>`."
)


def uuid7():
    """UUID версии 7 по RFC 9562: 48 бит времени Unix в миллисекундах, версия, вариант и случайные биты."""
    value = (time.time_ns() // 1_000_000) << 80 | int.from_bytes(os.urandom(10), "big")
    value = value & ~(0xF << 76) | 0x7 << 76
    value = value & ~(0x3 << 62) | 0x2 << 62
    return str(uuid.UUID(int=value))


def sha(path):
    """SHA-256 файла потоком, без чтения всего содержимого в память."""
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def read_json(path):
    """Возвращает объект, None для отсутствующего файла и False для повреждённого."""
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except (OSError, ValueError):
        return False


def write_json_atomic(file, data):
    """Замена состояния через соседний временный файл сохраняет прежний JSON при сбое записи."""
    file = Path(file)
    file.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=file.parent, prefix=file.name + ".", suffix=".tmp", delete=False
        ) as stream:
            temporary = Path(stream.name)
            stream.write(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
        temporary.replace(file)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def take_project_argument(argv):
    """Вырезает `--project ПУТЬ` или `--project=ПУТЬ` из списка аргументов и возвращает путь либо None."""
    for index, item in enumerate(argv):
        if item == "--project" and index + 1 < len(argv):
            value = argv[index + 1]
            del argv[index : index + 2]
            return value
        if item.startswith("--project="):
            del argv[index]
            return item.split("=", 1)[1]
    return None


def read_current_project(file=CURRENT_PROJECT_FILE):
    """Путь из файла текущего проекта или None, если файла нет или он повреждён."""
    data = read_json(file)
    if data is False or (data is not None and not isinstance(data, dict)):
        print(
            f"Не удалось прочитать текущий проект: {file}. Файл сохранён; исправьте JSON или выберите проект явно.",
            file=sys.stderr,
        )
    if isinstance(data, dict) and isinstance(data.get("path"), str) and data["path"]:
        return Path(data["path"]).expanduser()
    return None


def resolve_project(argv=None, environ=None, cwd=None, current_file=CURRENT_PROJECT_FILE):
    """Определяет папку проекта и источник решения: argument, environment, current_file, cwd или None."""
    argv = sys.argv if argv is None else argv
    environ = os.environ if environ is None else environ
    value = take_project_argument(argv)
    if value:
        return Path(value).expanduser().resolve(), "argument"
    value = environ.get(PROJECT_ENV)
    if value:
        return Path(value).expanduser().resolve(), "environment"
    value = read_current_project(current_file)
    if value is not None:
        return value.resolve(), "current_file"
    here = Path.cwd() if cwd is None else Path(cwd)
    if (here / PROJECT_MARKER).is_file():
        return here.resolve(), "cwd"
    return None, None


def running_as_tool(argv=None):
    """Истина, когда процесс запущен как инструмент комплекса, которому нужен проект (не тест и не run_tests)."""
    argv = sys.argv if argv is None else argv
    if not argv or not argv[0]:
        return False
    script = Path(argv[0]).resolve()
    if not script.is_relative_to(TOOLS_ROOT / "tools"):
        return False
    if len(argv) > 1 and argv[1] in PROJECT_FREE_ACTIONS.get(script.name, ()):
        return False
    return script.name.endswith(".py") and not script.name.startswith("test_") and script.name not in PROJECT_FREE_TOOLS


ROOT, ROOT_SOURCE = resolve_project()
if ROOT is None:
    if running_as_tool():
        print(NO_PROJECT_MESSAGE, file=sys.stderr)
        raise SystemExit(2)
    # Импорт в тестах и из посторонних скриптов: заглушка, которую тесты подменяют своим каталогом.
    ROOT = LOCAL_DIR / "no-project"
elif running_as_tool() and not ROOT.is_dir():
    print(f"Папка проекта не найдена: {ROOT} (источник: {ROOT_SOURCE}).", file=sys.stderr)
    raise SystemExit(2)
