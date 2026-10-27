"""Локальный запуск всех или выбранных наборов тестов; @link README.md."""

import argparse
import importlib
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

import tools.testing  # noqa: E402,F401  Копия проекта-образца как SONGFRAME_PROJECT до импорта инструментов.


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--only", nargs="+", help="Имена наборов, например test_build_review.")
    args = parser.parse_args()
    available = {p.stem: p for p in (ROOT / "tools").glob("*/test_*.py")}
    selected = args.only or sorted(available)
    if not selected or len(set(selected)) != len(selected) or set(selected) - set(available):
        parser.error("Неизвестный, повторный или пустой набор тестов.")
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
