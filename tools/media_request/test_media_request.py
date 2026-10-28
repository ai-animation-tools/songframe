"""Общий жизненный цикл попытки на тестовом провайдере без сети и платных запросов; @link README.md"""

import sys
from pathlib import Path

# Полные импорты tools.* работают и при прямом запуске файла из любой папки.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))


import errno
import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from tools import media_adapters
from tools.media_request import attempt as job
from tools.testing import fake_media_request as fake

# Минимальные сигнатуры контейнеров: проверка получения не декодирует и не перекодирует изображение.
PNG_ORIGINAL = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR" + b"original png bytes"
JPEG_ORIGINAL = b"\xff\xd8\xff\xe0\x00\x10JFIF\x00" + b"original jpeg bytes"
WEBP_ORIGINAL = b"RIFF\x18\x00\x00\x00WEBPVP8 " + b"original webp bytes"
MP4_ORIGINAL = b"\x00\x00\x00\x18ftypmp42" + b"original video bytes"


class MediaRequestTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="media-request-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.work = self.root / "attempt"
        self.service = fake.enable(self)
        (self.root / "frame.png").write_bytes(b"exact input bytes")
        self.prompt = b"A single take. $(touch NEVER_EXECUTE) `not a command`\r\nSecond line."
        (self.root / "prompt.txt").write_bytes(self.prompt)
        self.spec = {
            "schema_version": 1,
            "shot": "M32",
            "kind": "video",
            "provider": "test",
            "command": "image_to_video",
            "model": "test-video",
            "parameters": {"duration": 6, "resolution": "1080p", "enable_audio": False},
            "inputs": [{"flag": "input", "slot": "first_image", "path": "frame.png", "role": "first"}],
            "prompt_file": "prompt.txt",
            "outputs": 1,
        }
        self.request = self.root / "spec.json"
        self.write_spec()
        self.result("video.mp4", MP4_ORIGINAL)

    def write_spec(self):
        self.request.write_text(json.dumps(self.spec))

    def result(self, name, data, kind="video"):
        (self.service.directory / name).write_bytes(data)
        results = json.loads(self.service.path.read_text()).get("results", {})
        self.service.configure(results=results | {kind: name})

    def image(self, data=PNG_ORIGINAL, outputs=1):
        self.spec.update(kind="image", command="image_to_image", outputs=outputs, model="test-image")
        self.spec["inputs"][0]["slot"] = "image_1"
        self.write_spec()
        self.result("image.result", data, "image")
        self.submit()

    def prepare(self):
        return job.prepare(self.request, self.work)["request_sha256"]

    def submit(self):
        return job.submit(self.work, self.prepare())

    def actions(self):
        return [entry["action"] for entry in self.service.calls()]

    def state(self):
        return json.loads((self.work / "attempt.json").read_text())

    def interrupt_on_downloads(self):
        original = job.atomic_json

        def interrupted(path, value):
            if value.get("downloads"):
                raise KeyboardInterrupt()
            original(path, value)

        return patch.object(job, "atomic_json", side_effect=interrupted)

    def test_adapter_table_normalizes_provider_and_reads_test_hook(self):
        self.assertIs(media_adapters.adapter(" TeSt "), fake)
        self.assertTrue(media_adapters.known("test"))
        for provider in (None, "", " ", "unknown"):
            with self.subTest(provider=provider):
                self.assertFalse(media_adapters.known(provider))
                with self.assertRaisesRegex(ValueError, "нет адаптера"):
                    media_adapters.adapter(provider)
        with patch.dict(os.environ, {media_adapters.TEST_HOOK: "broken"}), self.assertRaises(ValueError):
            media_adapters.table()
        with patch.dict(os.environ, {media_adapters.TEST_HOOK: ""}):
            self.assertFalse(media_adapters.known("test"))

    def test_prepare_freezes_exact_bytes_and_has_stable_digest(self):
        digest = self.prepare()
        second = job.prepare(self.request, self.root / "second")
        self.assertEqual(digest, second["request_sha256"])
        self.assertEqual((self.work / "prompt.txt").read_bytes(), self.prompt)
        (self.root / "frame.png").write_bytes(b"changed outside frozen attempt")
        frozen, _ = job.load_attempt(self.work, True)
        self.assertEqual((self.work / frozen["inputs"][0]["path"]).read_bytes(), b"exact input bytes")
        data = (self.work / "request.json").read_bytes()
        self.assertEqual(hashlib.sha256(data).hexdigest(), digest)
        self.assertEqual(json.loads(data)["provider"], "test")
        self.assertNotIn("model_selection", json.loads(data))
        self.assertEqual(self.service.calls(), [])

    def test_prepare_requires_provider_with_connected_adapter(self):
        # Источник провайдера — только spec; неизвестный сервис не получает общую подготовку молча.
        for provider in (None, "", " \n\t", 1, "OtherService"):
            with self.subTest(provider=provider):
                self.spec["provider"] = provider
                self.write_spec()
                with self.assertRaisesRegex(ValueError, "provider"):
                    self.prepare()
                self.assertFalse(self.work.exists())
        del self.spec["provider"]
        self.write_spec()
        with self.assertRaisesRegex(ValueError, "provider"):
            self.prepare()
        self.assertFalse(self.work.exists())
        self.assertEqual(self.service.calls(), [])

    def test_load_submit_and_resume_reject_missing_or_unknown_provider_before_service(self):
        # Пересчитываем SHA после изменения provider: отказ проверяет таблицу адаптеров, а не контрольную сумму.
        for provider in (None, "", " \n\t", "CustomProvider"):
            for action in ("load", "submit", "resume"):
                with self.subTest(provider=provider, action=action):
                    directory = self.root / f"guard-{action}-{len(list(self.root.glob('guard-*')))}"
                    job.prepare(self.request, directory)
                    frozen = json.loads((directory / "request.json").read_text())
                    if provider is None:
                        del frozen["provider"]
                    else:
                        frozen["provider"] = provider
                    job.atomic_json(directory / "request.json", frozen)
                    digest = hashlib.sha256((directory / "request.json").read_bytes()).hexdigest()
                    state = json.loads((directory / "attempt.json").read_text())
                    state["request_sha256"] = digest
                    if action == "resume":
                        state.update(status="submitted", generation_id="saved-id")
                    job.atomic_json(directory / "attempt.json", state)
                    with self.assertRaisesRegex(ValueError, "provider"):
                        if action == "load":
                            job.load_attempt(directory, verify_inputs=True)
                        elif action == "submit":
                            job.submit(directory, digest)
                        else:
                            job.resume(directory)
                    self.assertEqual(json.loads((directory / "attempt.json").read_text()), state)
        self.assertEqual(self.service.calls(), [])

    def test_prepare_preserves_selection_and_hashes_exact_reason_offline(self):
        selection = {
            "preferredModel": "preferred-model",
            "selectedModel": "test-video",
            "reason": "  Предпочитаемая модель не поддерживает нужную длительность.  ",
        }
        self.spec["model_selection"] = selection
        self.write_spec()
        prepared = job.prepare(self.request, self.work)
        frozen, state = job.load_attempt(self.work, verify_inputs=True)
        self.assertEqual(frozen["model_selection"], selection)
        self.assertEqual(prepared["model_selection"], selection)
        self.assertEqual(hashlib.sha256((self.work / "request.json").read_bytes()).hexdigest(), state["request_sha256"])
        selection["reason"] = "Другое объяснение выбора."
        self.write_spec()
        changed = job.prepare(self.request, self.root / "other-reason")
        self.assertNotEqual(changed["request_sha256"], state["request_sha256"])
        self.assertEqual(self.service.calls(), [])

    def test_selection_accepts_null_preference_and_rejects_invalid_metadata(self):
        selection = {"preferredModel": None, "selectedModel": "test-video", "reason": "Выбрана совместимая модель."}
        invalid = [
            None,
            [],
            "selection",
            {},
            selection | {"extra": True},
            {"selectedModel": "test-video", "reason": "Причина"},
            selection | {"preferredModel": ""},
            selection | {"preferredModel": 1},
            selection | {"selectedModel": "another-model"},
            selection | {"selectedModel": None},
            selection | {"reason": ""},
            selection | {"reason": " \n\t "},
            selection | {"reason": 1},
        ]
        for metadata in invalid:
            with self.subTest(metadata=metadata):
                self.spec["model_selection"] = metadata
                self.write_spec()
                with self.assertRaises(ValueError):
                    self.prepare()
                self.assertFalse(self.work.exists())
        self.spec["model_selection"] = selection
        self.write_spec()
        self.prepare()

    def test_tampered_selection_reason_is_rejected_before_service(self):
        self.spec["model_selection"] = {"preferredModel": None, "selectedModel": "test-video", "reason": "Исходная."}
        self.write_spec()
        digest = self.prepare()
        frozen = json.loads((self.work / "request.json").read_text())
        frozen["model_selection"]["reason"] = "Подменённая причина."
        job.atomic_json(self.work / "request.json", frozen)
        with self.assertRaisesRegex(ValueError, "Подготовленный запрос изменён"):
            job.submit(self.work, digest)
        self.assertEqual(self.state()["status"], "prepared")
        self.assertEqual(self.service.calls(), [])

    def test_submit_resume_keep_frozen_model_selection(self):
        self.spec["model_selection"] = {
            "preferredModel": "another-model",
            "selectedModel": "test-video",
            "reason": "Совместима с запросом.",
        }
        self.write_spec()
        digest = self.prepare()
        before = (self.work / "request.json").read_bytes()
        with patch.object(fake, "capabilities", side_effect=AssertionError("Выбор модели уже заморожен")):
            job.submit(self.work, digest)
            job.resume(self.work)
        self.assertEqual((self.work / "request.json").read_bytes(), before)
        self.assertEqual(self.service.calls("submit")[0]["model"], "test-video")
        self.assertEqual(self.state()["request_sha256"], digest)

    def test_awaiting_accepts_attempt_but_not_queue_root_or_protected_sources(self):
        # Очередь допускает вложенный запрос, сохраняя защиту корней и исходников.
        with (
            patch.object(job, "ROOT", self.root),
            patch.object(job.tempfile, "gettempdir", return_value=str(self.root / "temporary")),
        ):
            saved = self.root / "plan/awaiting/M32/request"
            self.assertEqual(job.work_path(saved), saved)
            for name in ["plan/awaiting", "plan/batches", "source/clip", "assets/M32", "plan/animatic/latest"]:
                with self.subTest(path=name), self.assertRaises(ValueError):
                    job.work_path(self.root / name)

    def test_moved_awaiting_package_submits_same_bytes_and_recovers_same_job(self):
        # Сохранённый пакет должен пережить удаление прежней рабочей папки и входов.
        digest = self.prepare()
        saved = self.root / "plan/awaiting/M32/request"
        saved.parent.mkdir(parents=True)
        self.work.rename(saved)
        (self.root / "prompt.txt").unlink()
        (self.root / "frame.png").unlink()
        request, state = job.load_attempt(saved, verify_inputs=True)
        self.assertEqual(state["request_sha256"], digest)
        job.submit(saved, digest)
        sent = self.service.calls("submit")[0]
        self.assertEqual(sent["prompt"], self.prompt.decode())
        self.assertEqual(sent["work_dir"], str(saved))
        self.assertEqual(sent["inputs"][0]["sha256"], request["inputs"][0]["sha256"])
        result = job.resume(saved)
        self.assertEqual(result["status"], "downloaded")
        self.assertEqual(result["generation_id"], "test-generation-1")
        self.assertEqual(self.actions(), ["submit", "poll", "fetch"])

    def test_input_copies_are_deduplicated_without_losing_slots(self):
        self.spec["inputs"].append({"flag": "input", "slot": "tail_image", "path": "frame.png", "role": "last"})
        self.write_spec()
        self.prepare()
        request, _ = job.load_attempt(self.work)
        self.assertEqual(request["inputs"][0]["path"], request["inputs"][1]["path"])
        self.assertEqual(len(list((self.work / "inputs").iterdir())), 1)

    def test_submit_confirmation_and_immutable_inputs(self):
        digest = self.prepare()
        with self.assertRaises(ValueError):
            job.submit(self.work, "wrong")
        (self.work / "inputs/01.png").write_bytes(b"changed")
        with self.assertRaises(ValueError):
            job.submit(self.work, digest)
        self.assertEqual(self.service.calls(), [])
        self.assertEqual(self.state()["status"], "prepared")

    def test_submit_resume_and_repeated_resume_never_resubmit(self):
        self.service.configure(submit={"generation_id": "job-123", "credits_consumed": 12})
        state = self.submit()
        self.assertEqual(
            (state["status"], state["generation_id"], state["credits_consumed"]), ("submitted", "job-123", 12)
        )
        with self.assertRaisesRegex(ValueError, "уже отправлялась"):
            job.submit(self.work, self.state()["request_sha256"])
        result = job.resume(self.work)
        self.assertEqual(result["status"], "downloaded")
        self.assertEqual(result["downloads"], [{"number": 1, "path": "original.mp4", "bytes": len(MP4_ORIGINAL)}])
        self.assertEqual((self.work / "original.mp4").read_bytes(), MP4_ORIGINAL)
        job.resume(self.work)
        self.assertEqual(self.actions(), ["submit", "poll", "fetch"])
        self.assertNotIn(str(self.service.directory), (self.work / "attempt.json").read_text())
        self.assertNotIn("video_sha256", result)

    def test_task_trace_id_is_saved_once_per_attempt_only_for_declaring_adapter(self):
        captured = []
        original = fake.submit

        def submit(directory, request, state, timeout):
            captured.append(state.get("task_trace_id"))
            return original(directory, request, state, timeout)

        self.service.configure(submit={"generation_id": "job-1"})
        with patch.object(fake, "submit", side_effect=submit):
            self.submit()
            self.assertNotIn("task_trace_id", self.state())
            self.work = self.root / "traced"
            self.service.configure(submit="unknown")
            with patch.object(fake, "TASK_TRACE_ID", True, create=True):
                digest = self.prepare()
                with self.assertRaisesRegex(ValueError, "неизвестен"):
                    job.submit(self.work, digest)
                first = self.state()["task_trace_id"]
                job.not_created(self.work)
                self.service.configure(submit={"generation_id": "job-2"})
                # Повторная отправка той же попытки после not-created сохраняет её идентификатор.
                self.assertEqual(job.submit(self.work, digest)["task_trace_id"], first)
        self.assertEqual(captured, [None, first, first])
        self.assertRegex(first, r"^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")

    def test_unknown_submission_cannot_be_retried_and_can_recover_id(self):
        self.service.configure(submit="unknown")
        digest = self.prepare()
        with self.assertRaisesRegex(ValueError, "неизвестен"):
            job.submit(self.work, digest)
        self.assertEqual(self.state()["status"], "submission_unknown")
        with self.assertRaisesRegex(ValueError, "повтор запрещён"):
            job.submit(self.work, digest)
        job.resume(self.work, generation_id="job-123")
        self.assertEqual(self.state()["status"], "downloaded")
        self.assertEqual(self.state()["generation_id"], "job-123")
        self.assertEqual(self.actions(), ["submit", "poll", "fetch"])

    def test_invalid_generation_id_from_service_is_unknown_outcome(self):
        self.service.configure(submit={"generation_id": "https://example.test/id"})
        with self.assertRaisesRegex(ValueError, "неизвестен"):
            self.submit()
        self.assertEqual(self.state()["status"], "submission_unknown")
        self.assertNotIn("generation_id", self.state())

    def test_explicit_rejection_keeps_attempt_unsent(self):
        self.service.configure(submit={"reject": "HTTP 400: неверная длина звука"})
        digest = self.prepare()
        with self.assertRaisesRegex(job.RejectedRequest, "отклонил запрос до оплаты: HTTP 400"):
            job.submit(self.work, digest)
        state = self.state()
        self.assertEqual(state["status"], "prepared")
        self.assertEqual(state["last_rejection"], "HTTP 400: неверная длина звука")
        self.assertNotIn("generation_id", state)
        self.service.configure(submit={})
        self.assertEqual(job.submit(self.work, digest)["status"], "submitted")

    def test_service_unavailable_before_submission_keeps_attempt_prepared(self):
        self.service.configure(submit="not_submitted")
        digest = self.prepare()
        with self.assertRaisesRegex(job.NotSubmitted, "отправка не начиналась"):
            job.submit(self.work, digest)
        self.assertEqual(self.state()["status"], "prepared")
        self.assertNotIn("last_rejection", self.state())

    def test_invalid_timeout_and_manual_id_before_submission_are_rejected(self):
        digest = self.prepare()
        for timeout in (0, -1, float("nan")):
            with self.subTest(timeout=timeout), self.assertRaises(ValueError):
                job.submit(self.work, digest, timeout=timeout)
        with self.assertRaisesRegex(ValueError, "только после неизвестной отправки"):
            job.resume(self.work, generation_id="job-123")
        with self.assertRaises(ValueError):
            job.resume(self.work, wait_seconds=61)
        self.assertEqual(self.service.calls(), [])

    def unknown(self):
        self.service.configure(submit="unknown")
        digest = self.prepare()
        with self.assertRaises(ValueError):
            job.submit(self.work, digest)
        self.service.configure(submit={})
        return digest

    def test_not_created_returns_unknown_attempt_to_single_new_submit(self):
        # Пользователь не нашёл генерацию в истории сервиса: попытку можно отправить снова, но только один раз.
        digest = self.unknown()
        with self.assertRaisesRegex(ValueError, "повтор запрещён"):
            job.submit(self.work, digest)
        state = job.not_created(self.work)
        self.assertEqual(state["status"], "prepared")
        self.assertEqual([item["resolution"] for item in state["unknown_outcomes"]], ["not_created"])
        self.assertEqual(job.submit(self.work, digest)["generation_id"], "test-generation-2")
        with self.assertRaisesRegex(ValueError, "неизвестным исходом"):
            job.not_created(self.work)
        self.assertEqual(self.actions(), ["submit", "submit"])

    def test_manual_video_result_replaces_lost_id_without_new_submit(self):
        self.unknown()
        video = self.root / "from gallery.mp4"
        video.write_bytes(b"\x00\x00\x00\x18ftypmp42 video bytes")
        state = job.attach(self.work, [video])
        self.assertEqual(state["status"], "downloaded")
        self.assertTrue(state["manual_result"])
        self.assertIsNone(state.get("generation_id"))
        self.assertEqual(state["downloads"], [{"number": 1, "path": "original.mp4", "bytes": video.stat().st_size}])
        self.assertEqual((self.work / "original.mp4").read_bytes(), video.read_bytes())
        self.assertEqual([item["resolution"] for item in state["unknown_outcomes"]], ["manual_result"])
        # Продолжение получения не обращается к сервису и не требует ID.
        self.assertEqual(job.resume(self.work)["status"], "downloaded")
        self.assertEqual(self.actions(), ["submit"])
        with self.assertRaisesRegex(ValueError, "неизвестным исходом"):
            job.attach(self.work, [video])

    def test_manual_result_checks_format_count_and_state(self):
        picture = self.root / "picture.png"
        picture.write_bytes(b"\x89PNG\r\n\x1a\n image")
        self.prepare()
        with self.assertRaisesRegex(ValueError, "неизвестным исходом"):
            job.attach(self.work, [picture])
        shutil.rmtree(self.work)
        self.unknown()
        with self.assertRaisesRegex(ValueError, "MP4"):
            job.attach(self.work, [picture])
        with self.assertRaisesRegex(ValueError, "Нужно файлов результата: 1"):
            job.attach(self.work, [picture, picture])
        self.assertEqual(self.state()["status"], "submission_unknown")
        self.assertFalse((self.work / "original.mp4").exists())

    def test_manual_image_result_keeps_original_bytes_and_hash(self):
        self.spec.update(kind="image", command="image_to_image")
        self.write_spec()
        self.unknown()
        picture = self.root / "kandidat.webp"
        picture.write_bytes(b"RIFF\x10\x00\x00\x00WEBPVP8 data")
        state = job.attach(self.work, [picture])
        self.assertEqual(state["downloads"][0]["path"], "original.webp")
        self.assertEqual(state["downloads"][0]["sha256"], hashlib.sha256(picture.read_bytes()).hexdigest())

    def test_lock_prevents_parallel_submission(self):
        digest = self.prepare()
        with job.locked(self.work):
            with self.assertRaisesRegex(ValueError, "другой процесс"):
                job.submit(self.work, digest)
        self.assertEqual(self.service.calls(), [])
        self.assertEqual(job.submit(self.work, digest)["status"], "submitted")

    def test_windows_lock_uses_one_byte_and_releases_after_exception(self):
        self.prepare()
        calls = []

        def locking(descriptor, mode, length):
            calls.append((mode, length, os.lseek(descriptor, 0, os.SEEK_CUR), os.fstat(descriptor).st_size))

        adapter = SimpleNamespace(LK_NBLCK=1, LK_UNLCK=2, locking=locking)
        with patch.object(job.sys, "platform", "win32"), patch.object(job, "msvcrt", adapter, create=True):
            with self.assertRaisesRegex(RuntimeError, "остановка"):
                with job.locked(self.work):
                    raise RuntimeError("остановка")
            self.assertEqual(calls, [(1, 1, 0, 1), (2, 1, 0, 1)])
            with patch.object(adapter, "locking", side_effect=OSError(errno.EACCES, "занято")) as busy:
                with self.assertRaisesRegex(ValueError, "другой процесс"):
                    with job.locked(self.work):
                        self.fail("Занятая блокировка не должна пропускать обработку.")
                self.assertEqual(busy.call_count, 1)

    def test_pending_failed_and_poll_errors_keep_same_id(self):
        self.submit()
        for status in ("running", "outputs_pending", "watermark_free_pending"):
            with self.subTest(status=status):
                self.service.configure(poll={"status": status})
                self.assertEqual(job.resume(self.work)["status"], status)
        self.service.configure(poll="error")
        with self.assertRaisesRegex(ValueError, "ID сохранён"):
            job.resume(self.work)
        self.service.configure(poll={"status": "unexpected"})
        with self.assertRaisesRegex(ValueError, "ID сохранён"):
            job.resume(self.work)
        self.assertEqual(self.state()["generation_id"], "test-generation-1")
        self.service.configure(poll={"status": "failed", "service_status": "https://secret.test/x"})
        result = job.resume(self.work)
        self.assertEqual((result["status"], result["service_status"]), ("failed", "unknown"))
        self.assertEqual(job.resume(self.work)["status"], "failed")
        self.assertNotIn("secret", (self.work / "attempt.json").read_text())

    def test_completed_with_wrong_output_count_waits_without_download(self):
        self.submit()
        self.service.configure(poll={"status": "completed", "outputs": []})
        self.assertEqual(job.resume(self.work)["status"], "outputs_pending")
        self.assertNotIn("fetch", self.actions())

    def test_wait_seconds_polls_until_completion(self):
        self.submit()
        self.service.configure(poll=[{"status": "running"}, {"status": "completed"}])
        with patch.object(job.time, "sleep", lambda seconds: None):
            result = job.resume(self.work, wait_seconds=30, interval=1)
        self.assertEqual(result["status"], "downloaded")
        self.assertEqual(self.actions(), ["submit", "poll", "poll", "fetch"])

    def test_multiple_outputs_resume_after_download_failure(self):
        self.spec["outputs"] = 2
        self.write_spec()
        self.submit()
        copy = fake.fetch
        calls = []

        def flaky(output, destination):
            calls.append(destination)
            if len(calls) == 2:
                raise OSError("SECRET")
            copy(output, destination)

        with patch.object(fake, "fetch", side_effect=flaky), self.assertRaises(ValueError):
            job.resume(self.work)
        self.assertEqual(len(self.state()["downloads"]), 1)
        self.assertEqual(self.state()["status"], "download_pending")
        result = job.resume(self.work)
        self.assertEqual(result["status"], "downloaded")
        self.assertEqual([x["path"] for x in result["downloads"]], ["original-01.mp4", "original-02.mp4"])
        self.assertEqual(self.actions().count("fetch"), 2)

    def test_interruption_after_atomic_download_recovers_without_second_download(self):
        self.submit()
        with self.interrupt_on_downloads(), self.assertRaises(KeyboardInterrupt):
            job.resume(self.work)
        self.assertTrue((self.work / "original.mp4").exists())
        self.assertEqual(self.state()["downloads"], [])
        with patch.object(fake, "fetch") as fetch:
            result = job.resume(self.work)
            fetch.assert_not_called()
        self.assertEqual(result["status"], "downloaded")

    def test_publish_is_atomic_and_does_not_overwrite(self):
        destination = self.root / "download.mp4"
        empty = SimpleNamespace(fetch=lambda output, path: Path(path).write_bytes(b""))
        with self.assertRaisesRegex(ValueError, "пустой"):
            job.publish(empty, "source", destination)
        self.assertFalse(destination.exists())
        self.assertFalse(destination.with_suffix(".mp4.part").exists())
        destination.write_bytes(b"existing")
        complete = SimpleNamespace(fetch=lambda output, path: Path(path).write_bytes(b"complete"))
        with self.assertRaises(FileExistsError):
            job.publish(complete, "source", destination)
        self.assertEqual(destination.read_bytes(), b"existing")
        self.assertFalse(destination.with_suffix(".mp4.part").exists())

    def test_existing_video_without_intent_is_not_overwritten(self):
        self.submit()
        (self.work / "original.mp4").write_bytes(b"foreign")
        with self.assertRaisesRegex(ValueError, "не будет перезаписан"):
            job.resume(self.work)
        self.assertEqual((self.work / "original.mp4").read_bytes(), b"foreign")
        self.assertNotIn("fetch", self.actions())

    def test_image_result_uses_original_signature_for_extension(self):
        for name, data, extension in [
            ("png", PNG_ORIGINAL, ".png"),
            ("jpeg", JPEG_ORIGINAL, ".jpg"),
            ("webp", WEBP_ORIGINAL, ".webp"),
        ]:
            with self.subTest(format=name):
                self.work = self.root / name
                self.image(data)
                result = job.resume(self.work)
                self.assertEqual(result["downloads"][0]["path"], "original" + extension)
                self.assertEqual((self.work / ("original" + extension)).read_bytes(), data)
                self.assertEqual(result["downloads"][0]["sha256"], job.sha(self.work / ("original" + extension)))

    def test_invalid_image_body_is_not_published_and_same_id_can_resume(self):
        self.image(b"<html>not an original</html>")
        with self.assertRaisesRegex(ValueError, "PNG/JPEG/WebP"):
            job.resume(self.work)
        self.assertEqual(self.state()["status"], "download_pending")
        self.assertEqual(self.state()["generation_id"], "test-generation-1")
        self.assertEqual(self.state()["downloads"], [])
        self.assertEqual(list(self.work.glob("original*")), [])
        self.assertEqual(list(self.work.glob(".image-download-*")), [])
        self.result("image.result", PNG_ORIGINAL, "image")
        self.assertEqual(job.resume(self.work)["status"], "downloaded")
        self.assertEqual(self.actions().count("submit"), 1)

    def test_image_crash_after_publication_resumes_without_refetch(self):
        self.image(JPEG_ORIGINAL)
        with self.interrupt_on_downloads(), self.assertRaises(KeyboardInterrupt):
            job.resume(self.work)
        pending = self.state()["pending_download"]
        self.assertEqual(pending["path"], "original.jpg")
        self.assertEqual(pending["bytes"], len(JPEG_ORIGINAL))
        self.assertEqual(pending["sha256"], job.sha(self.work / "original.jpg"))
        # Повторный опрос может отдать другой адрес результата, но опубликованный оригинал принимается.
        self.result("renewed.result", PNG_ORIGINAL, "image")
        with patch.object(fake, "fetch") as fetch:
            result = job.resume(self.work)
            fetch.assert_not_called()
        self.assertEqual(result["status"], "downloaded")
        self.assertEqual(result["downloads"][0]["path"], "original.jpg")

    def test_image_pending_publication_rejects_changed_existing_original(self):
        self.image(JPEG_ORIGINAL)
        with self.interrupt_on_downloads(), self.assertRaises(KeyboardInterrupt):
            job.resume(self.work)
        changed = JPEG_ORIGINAL[:-1] + b"!"
        (self.work / "original.jpg").write_bytes(changed)
        with patch.object(fake, "fetch") as fetch, self.assertRaises(ValueError):
            job.resume(self.work)
        fetch.assert_not_called()
        self.assertEqual((self.work / "original.jpg").read_bytes(), changed)

    def test_image_download_does_not_claim_or_overwrite_foreign_existing_file(self):
        self.image(JPEG_ORIGINAL)
        (self.work / "original.jpg").write_bytes(JPEG_ORIGINAL)
        with self.assertRaises(ValueError):
            job.resume(self.work)
        self.assertNotIn("pending_download", self.state())
        self.assertEqual(self.state()["downloads"], [])
        self.assertEqual((self.work / "original.jpg").read_bytes(), JPEG_ORIGINAL)

    def test_multiple_image_outputs_resume_only_missing_original(self):
        self.image(PNG_ORIGINAL, outputs=2)
        copy = fake.fetch

        def flaky(output, destination):
            if (self.work / "original-01.png").exists():
                raise OSError("SECRET")
            copy(output, destination)

        with patch.object(fake, "fetch", side_effect=flaky), self.assertRaises(ValueError):
            job.resume(self.work)
        self.assertEqual([item["path"] for item in self.state()["downloads"]], ["original-01.png"])
        self.result("image.result", JPEG_ORIGINAL, "image")
        result = job.resume(self.work)
        self.assertEqual(result["status"], "downloaded")
        self.assertEqual([item["path"] for item in result["downloads"]], ["original-01.png", "original-02.jpg"])

    def test_image_crash_before_publication_resumes_same_id(self):
        self.image(PNG_ORIGINAL)
        link = job.os.link

        def interrupted(source, destination):
            if Path(destination).name == "original.png":
                raise KeyboardInterrupt()
            link(source, destination)

        with patch.object(job.os, "link", side_effect=interrupted), self.assertRaises(KeyboardInterrupt):
            job.resume(self.work)
        self.assertEqual(self.state()["pending_download"]["path"], "original.png")
        self.assertFalse((self.work / "original.png").exists())
        self.assertEqual(job.resume(self.work)["status"], "downloaded")
        self.assertEqual(self.actions().count("submit"), 1)

    def test_registered_image_validates_signature_and_legacy_jpeg_suffix(self):
        self.image(JPEG_ORIGINAL)
        job.resume(self.work)
        (self.work / "original.jpg").rename(self.work / "original.jpeg")
        state = self.state()
        state["downloads"][0]["path"] = "original.jpeg"
        state["downloads"][0].pop("sha256")
        job.atomic_json(self.work / "attempt.json", state)
        self.assertEqual(job.resume(self.work)["status"], "downloaded")
        (self.work / "original.jpeg").rename(self.work / "original.png")
        state["downloads"][0]["path"] = "original.png"
        job.atomic_json(self.work / "attempt.json", state)
        with self.assertRaisesRegex(ValueError, "Расширение"):
            job.resume(self.work)
        self.assertEqual((self.work / "original.png").read_bytes(), JPEG_ORIGINAL)
        self.assertEqual(self.actions().count("fetch"), 1)

    def test_watch_polls_until_terminal_and_reports_status_changes(self):
        self.submit()
        self.service.configure(poll=[{"status": "running"}, {"status": "running"}, {"status": "completed"}])
        lines = []
        with patch.object(job.time, "sleep", lambda seconds: None):
            result = job.watch([self.work], max_minutes=1, interval=5, report=lines.append)
        self.assertEqual(result[str(self.work)]["status"], "downloaded")
        self.assertEqual(lines, [f"{self.work.name}: running", f"{self.work.name}: downloaded"])
        self.assertEqual(self.actions().count("poll"), 3)
        with patch.object(job.time, "sleep", lambda seconds: None):
            again = job.watch([self.work], max_minutes=1, interval=5, report=lines.append)
        self.assertEqual(again[str(self.work)]["status"], "downloaded")
        self.assertEqual(self.actions().count("poll"), 3)
        other = self.root / "other"
        job.prepare(self.request, other)
        with patch.object(job.time, "sleep", lambda seconds: None):
            mixed = job.watch([other], max_minutes=1, interval=5, report=lines.append)
        self.assertEqual(mixed[str(other)]["status"], "error")
        with self.assertRaises(ValueError):
            job.watch([self.work], max_minutes=0)

    def test_watch_timeout_keeps_job_for_next_watch(self):
        self.submit()
        self.service.configure(poll={"status": "running"})
        clock = iter([0, 0, 0, 120, 120, 120])
        with patch.object(job.time, "monotonic", lambda: next(clock)), patch.object(job.time, "sleep", lambda _: None):
            result = job.watch([self.work], max_minutes=1, interval=5, report=lambda line: None)
        self.assertEqual(result[str(self.work)]["status"], "running")
        self.assertIn("повторите watch", result[str(self.work)]["detail"])

    def test_opaque_generation_id_is_kept_literally(self):
        opaque = "provider+opaque/id=="
        self.service.configure(submit={"generation_id": opaque})
        self.submit()
        result = job.resume(self.work)
        self.assertEqual(result["generation_id"], opaque)
        self.assertEqual(self.service.calls("poll")[0]["generation_id"], opaque)

    def test_changed_request_is_rejected(self):
        digest = self.prepare()
        frozen = json.loads((self.work / "request.json").read_text())
        frozen["model"] = "different"
        (self.work / "request.json").write_text(json.dumps(frozen))
        with self.assertRaises(ValueError):
            job.submit(self.work, digest)
        self.assertEqual(self.service.calls(), [])


class MediaRequestCliTests(unittest.TestCase):
    """Действия и JSON-вывод, которыми пользуется приложение."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="media-request-cli-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.service = fake.enable(self)
        (self.root / "prompt.txt").write_text("Тестовый план.", encoding="utf-8")
        spec = {
            "schema_version": 1,
            "shot": "M01",
            "kind": "video",
            "provider": "test",
            "command": "text_to_video",
            "model": "test-video",
            "parameters": {"duration": 5},
            "prompt_file": "prompt.txt",
        }
        (self.root / "spec.json").write_text(json.dumps(spec), encoding="utf-8")
        self.work = self.root / "attempt"

    def run_tool(self, *args, code=0):
        result = subprocess.run(
            [sys.executable, "-B", str(Path(__file__).with_name("media_request.py")), *map(str, args)],
            capture_output=True,
            text=True,
            env={**os.environ, "SONGFRAME_PROJECT": str(self.root)},
            timeout=60,
        )
        self.assertEqual(result.returncode, code, result.stderr)
        return result

    def prepare(self):
        result = self.run_tool("prepare", "--request", self.root / "spec.json", "--work-dir", self.work)
        return json.loads(result.stdout)

    def test_lifecycle_prints_json_states(self):
        report = json.loads(self.run_tool("capabilities", "--provider", "test", "--kind", "video", "--json").stdout)
        self.assertEqual([entry["command"] for entry in report["reports"]], ["text_to_video", "image_to_video"])
        self.assertEqual(report["problems"], [])
        prepared = self.prepare()
        self.assertEqual(prepared["provider"], "test")
        self.assertEqual(prepared["work_dir"], str(self.work))
        digest = prepared["request_sha256"]
        self.assertIn("SHA-256", self.run_tool("submit", "--work-dir", self.work, "--confirm", "wrong", code=1).stderr)
        submitted = json.loads(self.run_tool("submit", "--work-dir", self.work, "--confirm", digest).stdout)
        self.assertEqual((submitted["status"], submitted["generation_id"]), ("submitted", "test-generation-1"))
        self.assertEqual(json.loads(self.run_tool("status", "--work-dir", self.work).stdout)["status"], "submitted")
        watched = self.run_tool("watch", "--work-dir", self.work, "--max-minutes", "1").stdout
        self.assertEqual(watched.splitlines()[0], "attempt: downloaded")
        watched = json.loads(watched.split("\n", 1)[1])
        self.assertEqual(watched[str(self.work)]["status"], "downloaded")
        actions = [entry["action"] for entry in self.service.calls()]
        self.assertEqual(actions, ["capabilities", "submit", "poll", "fetch"])

    def test_rejection_and_unknown_outcome_messages(self):
        digest = self.prepare()["request_sha256"]
        self.service.configure(submit={"reject": "HTTP 400: проверьте параметры"})
        stderr = self.run_tool("submit", "--work-dir", self.work, "--confirm", digest, code=1).stderr
        self.assertIn("отклонил запрос до оплаты: HTTP 400: проверьте параметры", stderr)
        self.service.configure(submit="unknown")
        stderr = self.run_tool("submit", "--work-dir", self.work, "--confirm", digest, code=1).stderr
        self.assertIn("Исход отправки неизвестен", stderr)
        self.assertEqual(json.loads(self.run_tool("not-created", "--work-dir", self.work).stdout)["status"], "prepared")
        stderr = self.run_tool("capabilities", "--provider", "x", "--kind", "image", code=1).stderr
        self.assertIn("нет адаптера", stderr)


if __name__ == "__main__":
    unittest.main()
