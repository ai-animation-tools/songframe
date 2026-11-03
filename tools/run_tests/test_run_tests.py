"""Проверяет настоящий CLI выбора наборов на отдельном дереве без проектов и медиазависимостей. @link README.md"""

import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


class RunTestsCliTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="songframe-run-tests-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / "Комплекс с пробелами"
        self.runner = self.root / "tools/run_tests/run_tests.py"
        self.runner.parent.mkdir(parents=True)
        shutil.copyfile(Path(__file__).with_name("run_tests.py"), self.runner)
        for package in ("tools", "tools/testing", "tools/first", "tools/second"):
            directory = self.root / package
            directory.mkdir(parents=True, exist_ok=True)
            (directory / "__init__.py").write_text("", encoding="utf-8")
        # Подменяется только окружение: алгоритм выбора и дочерних запусков берётся из настоящего runner.
        # Этот stub не импортирует tools.testing из checkout, не читает и не создаёт клипы.
        (self.root / "tools/testing/sample_project.py").write_text("", encoding="utf-8")
        self.cwd = Path(self.temporary.name) / "Посторонняя рабочая папка"
        self.cwd.mkdir()
        self.write_suite("first")
        self.write_suite("second", fails=True)

    def write_suite(self, name, fails=False):
        # Маркер появляется только при исполнении теста, а не при поиске файлов или импорте модуля.
        source = (
            "import os\nimport unittest\nfrom pathlib import Path\n\n"
            "class MarkerTest(unittest.TestCase):\n"
            "    def test_selected(self):\n"
            f"        (Path(__file__).resolve().parents[2] / '{name}.executed').write_text(str(os.getpid()))\n"
            f"        print('Исполнен набор {name}', flush=True)\n"
            + ("        self.fail('Сентинел выбранного набора')\n" if fails else "        self.assertTrue(True)\n")
        )
        (self.root / f"tools/{name}/test_{name}.py").write_text(source, encoding="utf-8")

    def run_cli(self, *args):
        return subprocess.run(
            [sys.executable, "-B", str(self.runner), *args],
            cwd=self.cwd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            env={**os.environ, "PYTHONUTF8": "1"},
            timeout=30,
        )

    def marker(self, name):
        return self.root / f"{name}.executed"

    def test_only_does_not_execute_failing_unselected_suite_outside_current_directory(self):
        result = self.run_cli("--only", "test_first")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue(self.marker("first").is_file())
        self.assertFalse(self.marker("second").exists())
        self.assertIn("Ran 1 test", result.stderr)
        self.assertNotIn("Сентинел", result.stdout + result.stderr)

    def test_parallel_selected_suites_run_in_distinct_processes_and_report_success(self):
        self.write_suite("second")
        result = self.run_cli("--only", "test_first", "test_second", "--jobs", "2")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertNotEqual(self.marker("first").read_text(), self.marker("second").read_text())
        for name in ("first", "second"):
            self.assertIn(f"Исполнен набор {name}", result.stdout)
        self.assertIn("Наборов: 2, с ошибками: 0", result.stdout)

    def test_parallel_failure_preserves_both_outputs_and_returns_nonzero_aggregate(self):
        result = self.run_cli("--only", "test_first", "test_second", "--jobs", "2")
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        for name in ("first", "second"):
            self.assertTrue(self.marker(name).is_file())
            self.assertIn(f"===== test_{name}", result.stdout)
            self.assertIn(f"Исполнен набор {name}", result.stdout)
        self.assertIn("Сентинел выбранного набора", result.stdout)
        self.assertIn("Наборов: 2, с ошибками: 1 (test_second)", result.stdout)

    def test_unknown_and_duplicate_suites_are_rejected_before_execution(self):
        for names in (("test_unknown",), ("test_first", "test_unknown"), ("test_first", "test_first")):
            with self.subTest(names=names):
                result = self.run_cli("--only", *names)
                self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
                self.assertIn("Неизвестный, повторный или пустой набор", result.stderr)
                self.assertFalse(self.marker("first").exists())
                self.assertFalse(self.marker("second").exists())

    def test_zero_jobs_is_rejected_before_execution(self):
        result = self.run_cli("--only", "test_first", "--jobs", "0")
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertIn("--jobs должен быть положительным", result.stderr)
        self.assertFalse(self.marker("first").exists())
        self.assertFalse(self.marker("second").exists())


if __name__ == "__main__":
    unittest.main()
