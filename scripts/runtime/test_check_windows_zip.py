"""Проверяет контракт архивной проверки на небольших ZIP без медиагенерации."""

import hashlib
import importlib.util
import json
import tempfile
import unittest
import zipfile
from pathlib import Path

SPEC = importlib.util.spec_from_file_location("check_windows_zip", Path(__file__).with_name("check-windows-zip.py"))
CHECKER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECKER)


class WindowsZipTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.archive = Path(self.temporary.name) / "songframe-1.2.3-win-x64.zip"
        self.files = {name: b"resource" for name in CHECKER.REQUIRED_FILES}
        self.files["resources/runtime/manifest.json"] = b'{"target":"win32-x64","nativeProbe":false}'
        self.files["resources/runtime/media-manifest.json"] = b'{"target":"win32-x64","nativeProbe":false}'
        self.files["check-runtime.cmd"] = b"@echo off\r\nexit /b 0\r\n"
        # Обязательные модули адаптеров вычисляются из таблицы ADAPTERS, а не задаются именем сервиса.
        self.files[CHECKER.ADAPTERS_FILE] = b'ADAPTERS = {"example": "tools.example_request.example_request"}\n'
        self.files["resources/tools/example_request/example_request.py"] = b"# adapter\n"
        # Python-библиотеки вправе иметь собственный models, он не является каталогом весов runtime.
        self.files["resources/runtime/python/Lib/site-packages/example/models/__init__.py"] = b"# models\n"

    def write_archive(self):
        with zipfile.ZipFile(self.archive, "w", compression=zipfile.ZIP_STORED) as package:
            for name, data in self.files.items():
                package.writestr(name, data)

    def test_valid_archive_writes_truthful_report_and_checksum(self):
        self.write_archive()
        result = CHECKER.check_archive(self.archive, "1.2.3")
        report = json.loads((self.archive.parent / "windows-archive-check.json").read_text())
        self.assertEqual(report, result)
        self.assertTrue(report["ok"])
        self.assertEqual(report["validation"], "archive-only")
        self.assertIs(report["nativeExecution"], False)
        digest = hashlib.sha256(self.archive.read_bytes()).hexdigest()
        self.assertEqual(report["zip"], self.archive.name)
        self.assertEqual(report["sha256"], digest)
        self.assertEqual(report["archive"]["sha256"], digest)
        self.assertEqual(self.archive.with_suffix(".zip.sha256").read_text(), f"{digest}  {self.archive.name}\n")

    def test_missing_required_resource(self):
        del self.files["resources/runtime/bin/ffprobe.exe"]
        self.write_archive()
        with self.assertRaisesRegex(ValueError, "ffprobe.exe"):
            CHECKER.check_archive(self.archive)
        self.assertFalse((self.archive.parent / "windows-archive-check.json").exists())

    def test_provider_adapter_from_table_is_required(self):
        self.write_archive()
        adapters = CHECKER.check_archive(self.archive)["checks"]["providerAdapters"]
        self.assertEqual(adapters, ["resources/tools/example_request/example_request.py"])
        del self.files["resources/tools/example_request/example_request.py"]
        self.write_archive()
        with self.assertRaisesRegex(ValueError, "example_request.py"):
            CHECKER.check_archive(self.archive)

    def test_empty_adapter_table_is_rejected(self):
        self.files[CHECKER.ADAPTERS_FILE] = b"ADAPTERS = {}\n"
        self.write_archive()
        with self.assertRaisesRegex(ValueError, "ADAPTERS"):
            CHECKER.check_archive(self.archive)

    def test_wrong_runtime_or_media_target(self):
        for manifest in ("manifest.json", "media-manifest.json"):
            with self.subTest(manifest=manifest):
                original = self.files[f"resources/runtime/{manifest}"]
                self.files[f"resources/runtime/{manifest}"] = b'{"target":"linux-x64"}'
                self.write_archive()
                with self.assertRaisesRegex(ValueError, "win32-x64"):
                    CHECKER.check_archive(self.archive)
                self.files[f"resources/runtime/{manifest}"] = original

    def test_corrupt_resource_crc(self):
        self.write_archive()
        with zipfile.ZipFile(self.archive) as package:
            entry = package.getinfo("SongFrame.exe")
        # Меняем байт содержимого, сохраняя структуру ZIP и прежний CRC центрального каталога.
        data = bytearray(self.archive.read_bytes())
        offset = entry.header_offset
        name_size = int.from_bytes(data[offset + 26 : offset + 28], "little")
        extra_size = int.from_bytes(data[offset + 28 : offset + 30], "little")
        data[offset + 30 + name_size + extra_size] ^= 1
        self.archive.write_bytes(data)
        with self.assertRaisesRegex(ValueError, "CRC"):
            CHECKER.check_archive(self.archive)

    def test_invalid_zip(self):
        self.archive.write_bytes(b"not a ZIP")
        with self.assertRaises(zipfile.BadZipFile):
            CHECKER.check_archive(self.archive)

    def test_packaged_weights_are_rejected(self):
        self.files["resources/runtime/models/model.bin"] = b"weights"
        self.write_archive()
        with self.assertRaisesRegex(ValueError, "каталог весов"):
            CHECKER.check_archive(self.archive)

    def test_cmd_requires_ascii_crlf(self):
        for cmd in (b"@echo off\n", "echo Привет\r\n".encode()):
            with self.subTest(cmd=cmd):
                self.files["check-runtime.cmd"] = cmd
                self.write_archive()
                with self.assertRaisesRegex(ValueError, "ASCII"):
                    CHECKER.check_archive(self.archive)

    def test_version_must_match(self):
        self.write_archive()
        with self.assertRaisesRegex(ValueError, "не совпадает"):
            CHECKER.check_archive(self.archive, "2.0.0")


if __name__ == "__main__":
    unittest.main()
