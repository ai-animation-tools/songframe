"""Локальный запуск всех или выбранных наборов тестов; @link README.md."""

import argparse
import importlib
import subprocess
import sys
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

# Копия проекта-образца как SONGFRAME_PROJECT до импорта инструментов.
import tools.testing.sample_project  # noqa: E402,F401


def run_parallel(selected, jobs):
    """Каждый набор идёт отдельным процессом со своей копией образца; вывод печатается целиком по завершении."""

    def run(name):
        command = [sys.executable, "-B", str(Path(__file__).resolve()), "--only", name]
        result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True)
        return name, result.returncode, result.stdout + result.stderr

    failed = []
    with ThreadPoolExecutor(max_workers=jobs) as pool:
        for name, code, output in pool.map(run, selected):
            print(f"===== {name}", flush=True)
            print(output, end="" if output.endswith("\n") else "\n", flush=True)
            if code:
                failed.append(name)
    print(f"Наборов: {len(selected)}, с ошибками: {len(failed)}" + (f" ({', '.join(failed)})" if failed else ""))
    raise SystemExit(1 if failed else 0)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--only", nargs="+", help="Имена наборов, например test_build_review.")
    parser.add_argument("--jobs", type=int, default=1, help="Число наборов, выполняемых одновременно.")
    args = parser.parse_args()
    available = {p.stem: p for p in (ROOT / "tools").glob("*/test_*.py")}
    selected = args.only or sorted(available)
    if not selected or len(set(selected)) != len(selected) or set(selected) - set(available):
        parser.error("Неизвестный, повторный или пустой набор тестов.")
    if args.jobs < 1:
        parser.error("--jobs должен быть положительным.")
    if args.jobs > 1 and len(selected) > 1:
        run_parallel(selected, args.jobs)
    suite = unittest.TestSuite()
    # Тесты лежат рядом с инструментами; имя набора не зависит от имени папки.
    # Загрузка по явным именам сохраняет обычные setUp, cleanup и отчёт unittest.
    for name in selected:
        module = importlib.import_module(".".join(available[name].relative_to(ROOT).with_suffix("").parts))
        suite.addTests(unittest.defaultTestLoader.loadTestsFromModule(module))
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    raise SystemExit(0 if result.wasSuccessful() else 1)


if __name__ == "__main__":
    main()
