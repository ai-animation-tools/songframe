"""Тесты выбора текущего проекта: порядок источников, запись и очистка файла."""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from tools.common import PROJECT_ENV, local_directory, resolve_project, take_project_argument
from tools.current_project.current_project import clear_current, describe, write_current


class CurrentProjectTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.project = self.root / "clip"
        (self.project / "plan").mkdir(parents=True)
        (self.project / "plan/project.json").write_text(
            json.dumps({"schema_version": 1, "name": "Проба", "animatic_video": "proba.mp4"}), encoding="utf-8"
        )
        self.file = self.root / "local/current-project.json"

    def test_argument_is_taken_out_of_argv_and_wins(self):
        argv = ["tool.py", "--project", str(self.project), "--json"]
        root, source = resolve_project(argv, {PROJECT_ENV: str(self.root)}, current_file=self.file)
        self.assertEqual((root, source), (self.project.resolve(), "argument"))
        self.assertEqual(argv, ["tool.py", "--json"])
        argv = ["tool.py", f"--project={self.project}"]
        self.assertEqual(take_project_argument(argv), str(self.project))
        self.assertEqual(argv, ["tool.py"])

    def test_environment_then_file_then_cwd(self):
        self.assertEqual(
            resolve_project([], {PROJECT_ENV: str(self.project)}, current_file=self.file)[1], "environment"
        )
        write_current(self.project, self.file)
        root, source = resolve_project([], {}, cwd=self.root, current_file=self.file)
        self.assertEqual((root, source), (self.project.resolve(), "current_file"))
        self.assertTrue(clear_current(self.file))
        self.assertFalse(clear_current(self.file))
        self.assertEqual(
            resolve_project([], {}, cwd=self.project, current_file=self.file), (self.project.resolve(), "cwd")
        )
        self.assertEqual(resolve_project([], {}, cwd=self.root, current_file=self.file), (None, None))

    def test_write_requires_existing_directory_and_describe_reports_marker(self):
        with self.assertRaises(ValueError):
            write_current(self.root / "missing", self.file)
        data = write_current(self.project, self.file)
        self.assertEqual(data["schema_version"], 1)
        self.assertEqual(json.loads(self.file.read_text(encoding="utf-8"))["path"], str(self.project.resolve()))
        info = describe(self.file, environ={})
        self.assertEqual(
            (info["source"], info["exists"], info["is_project"], info["name"]), ("current_file", True, True, "Проба")
        )
        (self.project / "plan/project.json").unlink()
        info = describe(self.file, environ={})
        self.assertEqual((info["exists"], info["is_project"]), (True, False))
        info = describe(self.file, environ={PROJECT_ENV: str(self.root / "gone")})
        self.assertEqual((info["source"], info["exists"]), ("environment", False))

    def test_state_directory_uses_user_config_and_explicit_override(self):
        """Ручной CLI не пишет рядом с ресурсами; SONGFRAME_LOCAL_DIR совпадает с контрактом приложения."""
        self.assertEqual(local_directory({"XDG_CONFIG_HOME": str(self.root)}, home=self.root), self.root / "songframe")
        self.assertEqual(
            local_directory({"SONGFRAME_LOCAL_DIR": str(self.root / "состояние")}, home=self.root),
            self.root / "состояние",
        )
        self.assertEqual(local_directory({}, home=self.root), self.root / ".config/songframe")

    def test_failed_atomic_replace_keeps_previous_selection(self):
        write_current(self.project, self.file)
        before = self.file.read_bytes()
        with patch.object(Path, "replace", side_effect=OSError("ошибка замены")):
            with self.assertRaises(OSError):
                write_current(self.root, self.file)
        self.assertEqual(self.file.read_bytes(), before)
        self.assertEqual(list(self.file.parent.glob("*.tmp")), [])
        self.file.write_text("{", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "Файл сохранён"):
            write_current(self.project, self.file)
        self.assertEqual(self.file.read_text(), "{")

    @unittest.skipUnless(sys.platform == "linux", "Текущая приёмка относится к Linux")
    def test_current_project_writes_outside_readonly_resources(self):
        resources = self.root / "ресурсы только для чтения"
        script = resources / "tools/current_project/current_project.py"
        script.parent.mkdir(parents=True)
        source = Path(__file__).resolve().parents[2]
        shutil.copyfile(source / "tools/common.py", resources / "tools/common.py")
        shutil.copyfile(source / "tools/current_project/current_project.py", script)
        environment = dict(os.environ)
        environment.pop("SONGFRAME_LOCAL_DIR", None)
        environment.pop(PROJECT_ENV, None)
        environment["XDG_CONFIG_HOME"] = str(self.root / "конфигурация")
        resources.chmod(0o500)
        try:
            run = subprocess.run(
                [sys.executable, "-B", str(script), "--json", "set", str(self.project)],
                cwd=self.root,
                env=environment,
                capture_output=True,
                text=True,
            )
            self.assertEqual(run.returncode, 0, run.stderr)
            self.assertEqual(json.loads(run.stdout)["path"], str(self.project))
            file = self.root / "конфигурация/songframe/current-project.json"
            self.assertEqual(json.loads(file.read_text())["path"], str(self.project))
            self.assertFalse((resources / ".local").exists())
        finally:
            resources.chmod(0o700)

    def test_show_reports_project_argument(self):
        script = Path(__file__).resolve().with_name("current_project.py")
        environment = dict(os.environ)
        environment.pop(PROJECT_ENV, None)
        environment["SONGFRAME_LOCAL_DIR"] = str(self.root / "local")
        for arguments in (["--project", str(self.project)], [f"--project={self.project}"]):
            run = subprocess.run(
                [sys.executable, "-B", str(script), *arguments, "--json", "show"],
                cwd=self.root,
                env=environment,
                capture_output=True,
                text=True,
            )
            self.assertEqual(run.returncode, 0, run.stderr)
            info = json.loads(run.stdout)
            self.assertEqual(
                (info["path"], info["source"], info["is_project"]), (str(self.project.resolve()), "argument", True)
            )
        run = subprocess.run(
            [sys.executable, "-B", str(script), "--json", "show"],
            cwd=self.root,
            env=environment,
            capture_output=True,
            text=True,
        )
        self.assertEqual((run.returncode, json.loads(run.stdout)["source"]), (1, None))

    def test_damaged_file_is_ignored(self):
        self.file.parent.mkdir(parents=True)
        self.file.write_text("{", encoding="utf-8")
        self.assertEqual(resolve_project([], {}, cwd=self.root, current_file=self.file), (None, None))


if __name__ == "__main__":
    os.environ.pop(PROJECT_ENV, None)
    unittest.main()
