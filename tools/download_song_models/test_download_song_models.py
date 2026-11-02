"""Загрузчик проверяет контрольные суммы и не публикует частичные веса. @link README.md"""

import hashlib
import io
from contextlib import redirect_stderr
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase, main
from unittest.mock import patch

from tools.download_song_models import download_song_models as tool
from tools.song_timing.models import COMPONENTS, DEFINITION, files_for, missing_files, require_models, separator_model


class Response(io.BytesIO):
    def __init__(self, value, status=200, headers=None):
        super().__init__(value)
        self.status = status
        self.headers = headers or {}


class DownloadTests(TestCase):
    def setUp(self):
        self.folder = TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.directory = Path(self.folder.name)
        self.item = {
            "name": "model.onnx",
            "bytes": 6,
            "sha256": hashlib.sha256(b"abcdef").hexdigest(),
            "url": "https://example.invalid/model",
        }

    def test_publish_only_after_checksum(self):
        with patch.object(tool.urllib.request, "urlopen", return_value=Response(b"abcdef")):
            tool.download(self.item, self.directory)
        self.assertEqual((self.directory / "model.onnx").read_bytes(), b"abcdef")
        self.assertFalse((self.directory / "model.onnx.part").exists())

    def test_bad_checksum_keeps_previous_weights(self):
        target = self.directory / "model.onnx"
        target.write_bytes(b"old")
        with patch.object(tool.urllib.request, "urlopen", return_value=Response(b"broken")):
            with self.assertRaisesRegex(ValueError, "контрольная сумма"):
                tool.download(self.item, self.directory)
        self.assertEqual(target.read_bytes(), b"old")

    def test_resume_and_full_response_without_range(self):
        for response in [Response(b"def", 206, {"Content-Range": "bytes 3-5/6"}), Response(b"abcdef")]:
            target = self.directory / "model.onnx"
            target.unlink(missing_ok=True)
            (self.directory / "model.onnx.part").write_bytes(b"abc")
            with patch.object(tool.urllib.request, "urlopen", return_value=response) as request:
                tool.download(self.item, self.directory)
                self.assertEqual(request.call_args.args[0].headers["Range"], "bytes=3-")
            self.assertEqual(target.read_bytes(), b"abcdef")

    def test_ready_file_does_not_download_again(self):
        (self.directory / "model.onnx").write_bytes(b"abcdef")
        with patch.object(tool.urllib.request, "urlopen") as request:
            tool.download(self.item, self.directory)
            request.assert_not_called()

    def test_short_response_is_resumed_on_retry(self):
        # Даже короткий успешный HTTP-ответ остаётся черновиком для следующей попытки.
        with patch.object(tool.urllib.request, "urlopen", return_value=Response(b"abc")):
            with self.assertRaisesRegex(ValueError, "не полностью"):
                tool.download(self.item, self.directory)
        self.assertFalse((self.directory / "model.onnx").exists())
        self.assertEqual((self.directory / "model.onnx.part").read_bytes(), b"abc")
        with patch.object(
            tool.urllib.request, "urlopen", return_value=Response(b"def", 206, {"Content-Range": "bytes 3-5/6"})
        ):
            tool.download(self.item, self.directory)
        self.assertEqual((self.directory / "model.onnx").read_bytes(), b"abcdef")

    def test_invalid_range_preserves_partial_and_existing_weights(self):
        target = self.directory / "model.onnx"
        target.write_bytes(b"old")
        partial = self.directory / "model.onnx.part"
        partial.write_bytes(b"abc")
        for header in ("bytes 2-5/6", "bytes 3-4/6", "bytes 3-5/7", "bytes 30-5/6"):
            with (
                self.subTest(header=header),
                patch.object(
                    tool.urllib.request, "urlopen", return_value=Response(b"def", 206, {"Content-Range": header})
                ),
            ):
                with self.assertRaisesRegex(ValueError, "смещение"):
                    tool.download(self.item, self.directory)
            self.assertEqual(partial.read_bytes(), b"abc")
            self.assertEqual(target.read_bytes(), b"old")

    def test_oversized_partial_restarts_and_oversized_response_is_discarded(self):
        partial = self.directory / "model.onnx.part"
        partial.write_bytes(b"too large")
        with patch.object(tool.urllib.request, "urlopen", return_value=Response(b"abcdefg")) as request:
            with self.assertRaisesRegex(ValueError, "Размер"):
                tool.download(self.item, self.directory)
            self.assertNotIn("Range", request.call_args.args[0].headers)
        self.assertFalse(partial.exists())
        self.assertFalse((self.directory / "model.onnx").exists())

    def test_full_partial_is_published_without_network(self):
        (self.directory / "model.onnx.part").write_bytes(b"abcdef")
        with patch.object(tool.urllib.request, "urlopen") as request:
            tool.download(self.item, self.directory)
        request.assert_not_called()
        self.assertEqual((self.directory / "model.onnx").read_bytes(), b"abcdef")

    def test_cancel_preserves_partial_and_returns_130_without_traceback(self):
        class CancelResponse(Response):
            def read(self, size):
                if self.tell():
                    raise KeyboardInterrupt
                return super().read(3)

        errors = io.StringIO()
        with (
            patch.object(tool, "files_for", return_value=[self.item]),
            patch.object(tool.urllib.request, "urlopen", return_value=CancelResponse(b"abcdef")),
            redirect_stderr(errors),
        ):
            code = tool.main(["--output", str(self.directory)])
        self.assertEqual(code, 130)
        self.assertIn("прервана", errors.getvalue())
        self.assertNotIn("Traceback", errors.getvalue())
        self.assertEqual((self.directory / "model.onnx.part").read_bytes(), b"abc")
        self.assertFalse((self.directory / "model.onnx").exists())

    def test_main_returns_error_for_unwritable_output(self):
        blocked = self.directory / "file"
        blocked.write_bytes(b"keep")
        errors = io.StringIO()
        with redirect_stderr(errors):
            code = tool.main(["--output", str(blocked / "models")])
        self.assertEqual(code, 1)
        self.assertIn("не завершена", errors.getvalue())
        self.assertEqual(blocked.read_bytes(), b"keep")

    def test_replace_failure_keeps_old_weights_and_verified_partial_for_retry(self):
        target = self.directory / "model.onnx"
        target.write_bytes(b"old")
        with (
            patch.object(tool.urllib.request, "urlopen", return_value=Response(b"abcdef")),
            patch.object(tool.os, "replace", side_effect=OSError("Отказ записи")),
        ):
            with self.assertRaisesRegex(OSError, "Отказ записи"):
                tool.download(self.item, self.directory)
        self.assertEqual(target.read_bytes(), b"old")
        self.assertEqual((self.directory / "model.onnx.part").read_bytes(), b"abcdef")
        with patch.object(tool.urllib.request, "urlopen") as request:
            tool.download(self.item, self.directory)
        request.assert_not_called()
        self.assertEqual(target.read_bytes(), b"abcdef")

    def test_initial_partial_response_requires_exact_range(self):
        # Даже первый запрос не должен опубликовать неожиданный фрагмент CDN как весь файл.
        for header in (None, "bytes 1-5/6", "bytes 0-4/6", "bytes 0-5/7"):
            with (
                self.subTest(header=header),
                patch.object(
                    tool.urllib.request, "urlopen", return_value=Response(b"abcdef", 206, {"Content-Range": header})
                ),
            ):
                with self.assertRaisesRegex(ValueError, "смещение"):
                    tool.download(self.item, self.directory)
            self.assertFalse((self.directory / "model.onnx.part").exists())
        with patch.object(
            tool.urllib.request, "urlopen", return_value=Response(b"abcdef", 206, {"Content-Range": "bytes 0-5/6"})
        ):
            tool.download(self.item, self.directory)
        self.assertEqual((self.directory / "model.onnx").read_bytes(), b"abcdef")

    def test_unexpected_http_status_does_not_touch_partial(self):
        partial = self.directory / "model.onnx.part"
        partial.write_bytes(b"abc")
        with patch.object(tool.urllib.request, "urlopen", return_value=Response(b"abcdef", 204)):
            with self.assertRaisesRegex(ValueError, "HTTP-статус"):
                tool.download(self.item, self.directory)
        self.assertEqual(partial.read_bytes(), b"abc")

    def test_main_downloads_only_requested_component(self):
        for component in COMPONENTS:
            with self.subTest(component=component), patch.object(tool, "download") as download:
                self.assertEqual(tool.main(["--output", str(self.directory), "--component", component]), 0)
            self.assertEqual([call.args[0] for call in download.call_args_list], files_for(component))
        with patch.object(tool, "download") as download:
            self.assertEqual(tool.main(["--output", str(self.directory)]), 0)
        self.assertEqual([call.args[0]["name"] for call in download.call_args_list], ["alignment.onnx", "vocab.json"])

    def test_sigterm_flushes_partial_and_restores_signal_handler(self):
        import signal

        class TerminatedResponse(Response):
            def read(self, size):
                if self.tell():
                    signal.raise_signal(signal.SIGTERM)
                return super().read(3)

        previous = signal.getsignal(signal.SIGTERM)
        with (
            patch.object(tool, "files_for", return_value=[self.item]),
            patch.object(tool.urllib.request, "urlopen", return_value=TerminatedResponse(b"abcdef")),
            redirect_stderr(io.StringIO()),
        ):
            self.assertEqual(tool.main(["--output", str(self.directory)]), 130)
        self.assertEqual(signal.getsignal(signal.SIGTERM), previous)
        self.assertEqual((self.directory / "model.onnx.part").read_bytes(), b"abc")
        self.assertFalse((self.directory / "model.onnx").exists())


class ComponentTests(TestCase):
    def test_manifest_component_and_recipe_match(self):
        self.assertEqual(DEFINITION["version"], 2)
        self.assertEqual({item["component"] for item in DEFINITION["files"]}, set(COMPONENTS))
        self.assertEqual({item["name"] for item in files_for()}, {"alignment.onnx", "vocab.json"})
        for model_id in COMPONENTS[1:]:
            recipe = separator_model(model_id)
            self.assertEqual(recipe["file"], files_for(model_id)[0]["name"])
            self.assertIn(recipe["primary_stem"], ("Vocals", "Instrumental"))
            self.assertGreater(recipe["compensate"], 0)

    def test_require_is_component_specific_and_rejects_unknown_model(self):
        with TemporaryDirectory() as directory:
            self.assertEqual(missing_files(directory), ["alignment.onnx", "vocab.json"])
            self.assertEqual(missing_files(directory, "kim-vocal-2"), ["kim-vocal-2.onnx"])
            with self.assertRaisesRegex(ValueError, "Kim Vocal 2"):
                require_models(directory, "kim-vocal-2")
        with self.assertRaisesRegex(ValueError, "Неизвестный компонент"):
            files_for("unknown")
        with self.assertRaisesRegex(ValueError, "Неизвестная модель"):
            separator_model("alignment")


if __name__ == "__main__":
    main()
