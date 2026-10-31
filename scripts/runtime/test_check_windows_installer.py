"""Проверяет контракт проверки Windows-установщика без настоящей сборки."""

import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location(
    "check_windows_installer", Path(__file__).with_name("check-windows-installer.py")
)
CHECKER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECKER)

SEVEN_ZIP = shutil.which("7z")


class Fixture(unittest.TestCase):
    """Минимальное дерево приложения в том виде, в каком оно лежит в архиве установщика."""

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / "app"
        self.files = {name: b"resource" for name in CHECKER.REQUIRED_FILES}
        self.files["resources/runtime/manifest.json"] = b'{"target":"win32-x64","nativeProbe":false}'
        self.files["resources/runtime/media-manifest.json"] = b'{"target":"win32-x64","nativeProbe":false}'
        self.files["check-runtime.cmd"] = b"@echo off\r\nexit /b 0\r\n"
        # Обязательные модули адаптеров вычисляются из таблицы ADAPTERS, а не задаются именем сервиса.
        self.files[CHECKER.ADAPTERS_FILE] = b'ADAPTERS = {"example": "tools.example_request.example_request"}\n'
        self.files["resources/tools/example_request/example_request.py"] = b"# adapter\n"
        # Python-библиотеки вправе иметь собственный models, он не является каталогом весов runtime.
        self.files["resources/runtime/python/Lib/site-packages/example/models/__init__.py"] = b"# models\n"

    def write_tree(self):
        shutil.rmtree(self.root, ignore_errors=True)
        for name, data in self.files.items():
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)


class WindowsInstallerTreeTests(Fixture):
    """Проверки состава выполняются на обычном каталоге, без 7z."""

    def test_valid_tree(self):
        self.write_tree()
        checks = CHECKER.check_tree(self.root)
        self.assertEqual(checks["providerAdapters"], ["resources/tools/example_request/example_request.py"])
        self.assertTrue(checks["cmdAsciiCrlf"])

    def test_missing_or_empty_required_resource(self):
        for change in ("missing", "empty"):
            with self.subTest(change=change):
                original = self.files["resources/runtime/bin/ffprobe.exe"]
                if change == "missing":
                    del self.files["resources/runtime/bin/ffprobe.exe"]
                else:
                    self.files["resources/runtime/bin/ffprobe.exe"] = b""
                self.write_tree()
                with self.assertRaisesRegex(ValueError, "ffprobe.exe"):
                    CHECKER.check_tree(self.root)
                self.files["resources/runtime/bin/ffprobe.exe"] = original

    def test_installer_documents_are_required(self):
        for name in ("check-runtime.cmd", "ПРОЧТИ.md"):
            with self.subTest(name=name):
                original = self.files.pop(name)
                self.write_tree()
                with self.assertRaisesRegex(ValueError, name):
                    CHECKER.check_tree(self.root)
                self.files[name] = original

    def test_provider_adapter_from_table_is_required(self):
        del self.files["resources/tools/example_request/example_request.py"]
        self.write_tree()
        with self.assertRaisesRegex(ValueError, "example_request.py"):
            CHECKER.check_tree(self.root)

    def test_empty_adapter_table_is_rejected(self):
        self.files[CHECKER.ADAPTERS_FILE] = b"ADAPTERS = {}\n"
        self.write_tree()
        with self.assertRaisesRegex(ValueError, "ADAPTERS"):
            CHECKER.check_tree(self.root)

    def test_wrong_runtime_or_media_target(self):
        for manifest in ("manifest.json", "media-manifest.json"):
            with self.subTest(manifest=manifest):
                original = self.files[f"resources/runtime/{manifest}"]
                self.files[f"resources/runtime/{manifest}"] = b'{"target":"linux-x64"}'
                self.write_tree()
                with self.assertRaisesRegex(ValueError, "win32-x64"):
                    CHECKER.check_tree(self.root)
                self.files[f"resources/runtime/{manifest}"] = original

    def test_packaged_weights_are_rejected(self):
        self.files["resources/runtime/models/model.bin"] = b"weights"
        self.write_tree()
        with self.assertRaisesRegex(ValueError, "каталог весов"):
            CHECKER.check_tree(self.root)

    def test_cmd_requires_ascii_crlf(self):
        for cmd in (b"@echo off\n", "echo Привет\r\n".encode()):
            with self.subTest(cmd=cmd):
                self.files["check-runtime.cmd"] = cmd
                self.write_tree()
                with self.assertRaisesRegex(ValueError, "ASCII"):
                    CHECKER.check_tree(self.root)

    def test_name_and_version_are_checked_before_extraction(self):
        wrong = Path(self.temporary.name) / "songframe-1.2.3-win-x64.zip"
        with self.assertRaisesRegex(ValueError, "setup.exe"):
            CHECKER.check_installer(wrong)
        installer = Path(self.temporary.name) / "songframe-1.2.3-win-x64-setup.exe"
        with self.assertRaisesRegex(ValueError, "не совпадает"):
            CHECKER.check_installer(installer, "2.0.0")


@unittest.skipUnless(SEVEN_ZIP, "нужен системный 7z")
class WindowsInstallerExtractionTests(Fixture):
    """Имитация установщика: внешний 7z с архивом приложения по пути PAYLOAD, как в NSIS electron-builder."""

    def setUp(self):
        super().setUp()
        self.installer = Path(self.temporary.name) / "release" / "songframe-1.2.3-win-x64-setup.exe"
        self.installer.parent.mkdir()

    def seven_zip(self, cwd: Path, *args: str):
        env = {**os.environ, "LC_ALL": "C.UTF-8"}
        subprocess.run([SEVEN_ZIP, *args], cwd=cwd, env=env, check=True, capture_output=True)

    def write_installer(self, corrupt_payload=False, uninstaller=True):
        self.write_tree()
        outer = Path(self.temporary.name) / "outer"
        shutil.rmtree(outer, ignore_errors=True)
        payload = outer / CHECKER.PAYLOAD
        payload.parent.mkdir(parents=True)
        if uninstaller:
            (outer / CHECKER.UNINSTALLER).parent.mkdir(parents=True)
            (outer / CHECKER.UNINSTALLER).write_bytes(b"MZ uninstaller")
        self.seven_zip(self.root, "a", "-t7z", str(payload), ".")
        if corrupt_payload:
            data = bytearray(payload.read_bytes())
            data[len(data) // 2] ^= 0xFF
            payload.write_bytes(data)
        self.installer.unlink(missing_ok=True)
        self.seven_zip(outer, "a", "-t7z", str(self.installer), ".")

    def test_valid_installer_writes_truthful_report_and_checksum(self):
        self.write_installer()
        result = CHECKER.check_installer(self.installer, "1.2.3")
        report = json.loads((self.installer.parent / CHECKER.REPORT).read_text())
        self.assertEqual(report, result)
        self.assertIs(report["ok"], True)
        self.assertEqual(report["validation"], "archive-only")
        self.assertIs(report["nativeExecution"], False)
        self.assertEqual(report["target"], "win32-x64")
        self.assertEqual(report["version"], "1.2.3")
        digest = hashlib.sha256(self.installer.read_bytes()).hexdigest()
        self.assertEqual(report["installer"], self.installer.name)
        self.assertEqual(report["sha256"], digest)
        self.assertEqual(
            report["installerFile"],
            {"file": self.installer.name, "bytes": self.installer.stat().st_size, "sha256": digest},
        )
        self.assertEqual(report["checks"]["providerAdapters"], ["resources/tools/example_request/example_request.py"])
        self.assertEqual(self.installer.with_suffix(".exe.sha256").read_text(), f"{digest}  {self.installer.name}\n")

    def test_missing_resource_leaves_no_report(self):
        del self.files["resources/runtime/bin/ffprobe.exe"]
        self.write_installer()
        with self.assertRaisesRegex(ValueError, "ffprobe.exe"):
            CHECKER.check_installer(self.installer)
        self.assertFalse((self.installer.parent / CHECKER.REPORT).exists())
        self.assertFalse(self.installer.with_suffix(".exe.sha256").exists())

    def test_missing_uninstaller(self):
        self.write_installer(uninstaller=False)
        with self.assertRaisesRegex(ValueError, "деинсталлятора"):
            CHECKER.check_installer(self.installer)

    def test_corrupt_payload_is_rejected_by_7z(self):
        self.write_installer(corrupt_payload=True)
        with self.assertRaisesRegex(ValueError, "7z"):
            CHECKER.check_installer(self.installer)

    def test_missing_payload(self):
        self.installer.write_bytes(b"not an installer")
        with self.assertRaisesRegex(ValueError, "7z|app-64.7z"):
            CHECKER.check_installer(self.installer)


if __name__ == "__main__":
    unittest.main()
