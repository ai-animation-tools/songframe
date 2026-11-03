"""Регрессии runtime policy на маленьких синтетических ELF, без настоящего AppDir."""

import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

import linux_runtime_policy as policy


@unittest.skipUnless(shutil.which("gcc") and shutil.which("readelf"), "Нужны gcc и readelf для синтетических ELF")
class LinuxRuntimePolicyTests(unittest.TestCase):
    """Каждый сценарий владеет только TemporaryDirectory; внешний runtime не читается и не запускается."""

    def setUp(self):
        """Создать независимый валидный GTK4/WebKit6 набор, не выполняя ни один скомпилированный ELF."""
        self.temporary = tempfile.TemporaryDirectory(prefix="songframe-runtime-policy-")
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.root = self.base / "Проверочный AppDir"
        self.root.mkdir()
        self.source = self.base / "fixture.c"
        self.source.write_text("int fixture(void) { return 0; }\n")
        for soname in policy.REQUIRED_LIBRARIES:
            self.compile_elf("usr/lib/" + soname, soname=soname)
        for name in policy.REQUIRED_HELPERS:
            self.compile_elf("usr/lib/webkitgtk-6.0/" + name)

    def compile_elf(self, relative, soname=None, needed=()):
        """Закрепить SONAME и принудительные DT_NEEDED без libc; это лишь вход анализа readelf."""
        output = self.root / relative
        output.parent.mkdir(parents=True, exist_ok=True)
        arguments = ["gcc", "-shared", "-fPIC", "-nostdlib", str(self.source), "-o", str(output)]
        if soname:
            arguments.append("-Wl,-soname," + soname)
        if needed:
            arguments.append("-Wl,--no-as-needed")
            arguments.extend(str(path) for path in needed)
        subprocess.run(arguments, check=True, capture_output=True)
        return output

    def snapshot(self):
        """Снять имена/hash только собственного дерева, чтобы отказ prune доказуемо ничего не изменял."""
        result = {}
        for relative, entry in policy.inventory(self.root).items():
            if entry.kind == "file":
                result[relative] = hashlib.sha256((self.root / relative).read_bytes()).hexdigest()
            else:
                result[relative] = (entry.kind, entry.target)
        return result

    def add_legacy(self):
        """Воспроизвести второй backend, который Wails копировал вместе с GTK4 helpers."""
        for name in ("libgtk-3.so.0", "libgdk-3.so.0", "libwebkit2gtk-4.1.so.0", "libjavascriptcoregtk-4.1.so.0"):
            self.compile_elf("usr/lib/" + name, soname=name)
        for name in (*policy.REQUIRED_HELPERS, "WebKitGPUProcess"):
            self.compile_elf("usr/lib/webkit2gtk-4.1/" + name)
        typelibs = self.root / "usr/lib/girepository-1.0"
        typelibs.mkdir(parents=True)
        for name in ("Gtk-3.0.typelib", "Gdk-3.0.typelib", "WebKit2-4.1.typelib", "WebKit2WebExtension-4.1.typelib", "JavaScriptCore-4.1.typelib"):
            (typelibs / name).write_bytes(b"synthetic typelib")

    def test_current_stack_is_ready_and_check_is_read_only(self):
        """Чистая policy пропускает общие библиотеки GTK4 и не меняет ни одного байта."""
        for name in ("libgdk_pixbuf-2.0.so.0", "libpango-1.0.so.0", "libcairo.so.2", "libsoup-3.0.so.0"):
            self.compile_elf("usr/lib/" + name, soname=name)
        before = self.snapshot()
        result = policy.execute("check", self.root)
        self.assertEqual(result["status"], "ready", result)
        self.assertEqual(result["removedFiles"], 0)
        self.assertEqual(result["checkedELF"], 9)
        self.assertEqual(self.snapshot(), before)

    def test_prune_removes_second_backend_and_passes_check(self):
        """Старый backend, GTK3/GDK3 и typelibs удаляются вместе; текущие aliases сохраняются."""
        self.add_legacy()
        # Старый GTK2 проверяет версионную границу, а не только один observed Linux filename.
        self.compile_elf("usr/lib/libgtk-x11-2.0.so.0", soname="libgtk-x11-2.0.so.0")
        (self.root / "usr/lib/gtk-2.0/modules").mkdir(parents=True)
        (self.root / "usr/lib/gtk-2.0/modules/old-module.txt").write_bytes(b"old module")
        alias = self.root / "usr/lib/libgtk-4.so"
        alias.symlink_to("libgtk-4.so.1")
        before_core = (self.root / "usr/lib/libgtk-4.so.1").read_bytes()
        contaminated = policy.execute("check", self.root)
        self.assertEqual(contaminated["status"], "error", contaminated)
        result = policy.execute("prune", self.root)
        self.assertEqual(result["status"], "ready", result)
        self.assertGreater(result["removedFiles"], 10)
        self.assertGreater(result["removedBytes"], 0)
        self.assertIn("usr/lib/webkit2gtk-4.1", result["removedPaths"])
        self.assertTrue(alias.is_symlink())
        self.assertEqual(alias.read_bytes(), before_core)
        self.assertEqual(policy.execute("check", self.root)["status"], "ready")

    def test_masked_legacy_soname_is_rejected(self):
        """Переименование файла не скрывает библиотеку со старым DT_SONAME."""
        self.compile_elf("usr/lib/unrelated-name.so", soname="libwebkit2gtk-4.1.so.0")
        result = policy.execute("check", self.root)
        self.assertEqual(result["status"], "error", result)
        self.assertIn("unrelated-name.so", result["error"])

    def test_masked_needed_dependency_is_rejected(self):
        """DT_NEEDED старого стека отклоняется, даже если его файл замаскирован или отсутствует."""
        library = self.compile_elf("usr/lib/innocent.so", soname="libgtk-3.so.0")
        self.compile_elf("usr/bin/current-app", needed=(library,))
        library.unlink()
        result = policy.execute("check", self.root)
        self.assertEqual(result["status"], "error", result)
        self.assertIn("usr/bin/current-app", result["error"])
        self.assertIn("libgtk-3.so.0", result["error"])

    def test_prune_refuses_live_dependency_without_mutation(self):
        """Старая библиотека не удаляется, пока любой остающийся ELF ещё требует её SONAME."""
        library = self.compile_elf("usr/lib/libgtk-3.so.0", soname="libgtk-3.so.0")
        self.compile_elf("usr/bin/still-needs-gtk3", needed=(library,))
        before = self.snapshot()
        result = policy.execute("prune", self.root)
        self.assertEqual(result["status"], "error", result)
        self.assertIn("usr/bin/still-needs-gtk3", result["error"])
        self.assertIn("libgtk-3.so.0", result["error"])
        self.assertEqual(result["removedFiles"], 0)
        self.assertEqual(self.snapshot(), before)

    def test_directory_symlinks_do_not_escape_appdir(self):
        """Удаление legacy directory symlink удаляет лишь ссылку; нейтральная внешняя ссылка не обходится."""
        outside = self.base / "Не AppDir"
        outside.mkdir()
        sentinel = outside / "libgtk-3.so.0"
        sentinel.write_bytes(b"external must survive")
        legacy_link = self.root / "usr/lib/webkit2gtk-4.1"
        legacy_link.symlink_to(outside, target_is_directory=True)
        neutral_link = self.root / "usr/lib/other-components"
        neutral_link.symlink_to(outside, target_is_directory=True)
        result = policy.execute("prune", self.root)
        self.assertEqual(result["status"], "ready", result)
        self.assertFalse(legacy_link.is_symlink())
        self.assertTrue(neutral_link.is_symlink())
        self.assertEqual(sentinel.read_bytes(), b"external must survive")
        self.assertEqual(result["removedBytes"], 0)
        self.assertEqual(result["removedFiles"], 1)

    def test_alias_of_masked_legacy_is_removed_without_dangling_link(self):
        """Удаление по SONAME включает нейтрально названный alias, чтобы не оставлять битую ссылку."""
        self.compile_elf("usr/lib/masked-payload.so", soname="libjavascriptcoregtk-4.1.so.0")
        alias = self.root / "usr/lib/alternate-name.so"
        alias.symlink_to("masked-payload.so")
        result = policy.execute("prune", self.root)
        self.assertEqual(result["status"], "ready", result)
        self.assertIn("usr/lib/alternate-name.so", result["removedPaths"])
        self.assertFalse(alias.is_symlink())

    def test_duplicate_current_helpers_are_rejected(self):
        """Два current backend тоже неоднозначны: одного корректного набора рядом недостаточно."""
        self.compile_elf("opt/second/webkitgtk-6.0/WebKitWebProcess")
        result = policy.execute("check", self.root)
        self.assertEqual(result["status"], "error", result)
        self.assertIn("ровно один", result["error"])

    def test_finalizer_rejects_legacy_before_touching_runtime_or_tools(self):
        """Finalizer обязан остановиться на policy до чтения original offset и создания выходного образа."""
        self.add_legacy()
        output = self.base / "must-not-exist.AppImage"
        script = Path(__file__).resolve().with_name("finalize-appimage.sh")
        result = subprocess.run(
            ["bash", str(script), str(self.root), str(self.base / "no-original.AppImage"), str(output), str(self.base / "no-linuxdeploy")],
            capture_output=True, text=True,
        )
        self.assertNotEqual(result.returncode, 0)
        report = json.loads(result.stdout)
        self.assertEqual(report["status"], "error", report)
        self.assertIn("legacy", report["error"])
        self.assertNotIn("no-original", result.stderr)
        self.assertFalse(output.exists())
        self.assertFalse((self.base / "toolchain").exists())


if __name__ == "__main__":
    unittest.main()
