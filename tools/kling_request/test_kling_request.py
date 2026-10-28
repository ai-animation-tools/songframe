"""Проверка жизненного цикла без сети и платных запросов; @link README.md"""

import sys
from pathlib import Path

# После переноса точка запуска находится на два уровня ниже корня проекта.
# Полные импорты tools.* работают и при прямом запуске файла из любой папки.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))


import errno
import hashlib
import io
import json
import os
import stat
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from tools import kling_cli
from tools.kling_request import kling_request as job

# Минимальные сигнатуры контейнеров: проверка получения не декодирует и не перекодирует изображение.
PNG_ORIGINAL = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR" + b"original png bytes"
JPEG_ORIGINAL = b"\xff\xd8\xff\xe0\x00\x10JFIF\x00" + b"original jpeg bytes"
WEBP_ORIGINAL = b"RIFF\x18\x00\x00\x00WEBPVP8 " + b"original webp bytes"


class ImageResponse(io.BytesIO):
    def __init__(self, value):
        super().__init__(value)
        self.headers = {"Content-Length": str(len(value))}


# Минимальный фрагмент структуры who_am_i: модели относятся только к объявленной команде.
WHO_SAMPLE = {
    "ok": True,
    "body": {
        "availableModels": {
            "image_to_video": {
                "models": [
                    {
                        "model": "kling-video-v3_0",
                        "arguments": [
                            {"name": "prompt", "required": True},
                            {
                                "name": "duration",
                                "default": "5",
                                "allowedValues": [str(value) for value in range(3, 16)],
                            },
                            {"name": "resolution", "default": "1080p", "allowedValues": ["720p", "1080p", "4k"]},
                            {"name": "prefer_multi_shots", "default": "true", "allowedValues": ["true", "false"]},
                            {"name": "elements", "maxItems": 7},
                        ],
                        "inputs": [
                            {"name": "first_image", "required": True},
                            {"name": "tail_image", "required": False},
                        ],
                    },
                    {
                        "model": "kling-video-v4_0",
                        "arguments": [
                            {"name": "duration", "default": "10", "allowedValues": ["3", "4", "5"]},
                            {"name": "resolution", "default": "720p", "allowedValues": ["720p", "1080p"]},
                        ],
                        "inputs": [
                            {"name": "first_image", "required": True},
                            {"name": "tail_image", "required": False},
                            {"name": "keyframe_1", "required": False},
                        ],
                        "combinedItemCap": {
                            "maxItems": 10,
                            "arguments": [],
                            "inputPrefixes": ["first_image", "tail_image", "keyframe_"],
                        },
                    },
                ]
            }
        }
    },
}


class KlingRequestTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="kling-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.work = self.root / "attempt"
        (self.root / "frame.png").write_bytes(b"exact input bytes")
        self.prompt = b"A single take. $(touch NEVER_EXECUTE) `not a command`\r\nSecond line."
        (self.root / "prompt.txt").write_bytes(self.prompt)
        self.spec = {
            "schema_version": 1,
            "shot": "M32",
            "kind": "video",
            "provider": "kling",
            "command": "image_to_video",
            "model": "test-model",
            "parameters": {"duration": 6, "resolution": "1080p", "imageCount": 1, "enable_audio": False},
            "inputs": [{"flag": "input", "slot": "image_1", "path": "frame.png", "role": "first"}],
            "prompt_file": "prompt.txt",
            "outputs": 1,
        }
        self.request = self.root / "spec.json"
        self.write_spec()
        self.cli = self.root / "fake-kling"
        self.cli.write_text(
            "#!"
            + sys.executable
            + "\n"
            + """import json,sys,time
from pathlib import Path
base=Path(__file__).parent
with (base/'calls.jsonl').open('a') as stream:stream.write(json.dumps(sys.argv[1:])+'\\n')
config=json.loads((base/'fake.json').read_text())
if '--help' in sys.argv:print(config.get('help',''));raise SystemExit(0)
if sys.argv[1]=='who_am_i':
 if 'who_raw' in config:print(config['who_raw']);raise SystemExit(config.get('exit',0))
 value=config.get('who',{})
elif sys.argv[1]=='tool_list':value=config.get('tools',{})
elif sys.argv[1]=='query_tasks':value=config['query']
else:
 time.sleep(config.get('sleep',0));value=config['submit']
print(json.dumps(value));raise SystemExit(config.get('exit',0))
"""
        )
        self.cli.chmod(0o755)
        self.response = {
            "who": json.loads(json.dumps(WHO_SAMPLE)),
            "tools": {"ok": True, "body": {"tools": [{"name": name} for name in sorted(job.COMMANDS)]}},
            "submit": {"ok": True, "body": {"generationId": "job-123", "creditsConsumed": 12}},
            "query": {
                "ok": True,
                "body": {
                    "generationId": "job-123",
                    "status": "COMPLETED",
                    "works": [
                        {
                            "contentType": "video",
                            "url": "https://example.test/watermarked?SECRET",
                            "urlWithoutWatermark": "https://example.test/video.mp4?SECRET",
                        }
                    ],
                },
            },
        }
        self.write_response()

    def write_spec(self):
        self.request.write_text(json.dumps(self.spec))

    def write_response(self):
        (self.root / "fake.json").write_text(json.dumps(self.response))

    def prepare(self):
        return job.prepare(self.request, self.work)["request_sha256"]

    def submit(self):
        return job.submit(self.work, self.prepare(), str(self.cli))

    def calls(self):
        p = self.root / "calls.jsonl"
        return [json.loads(line) for line in p.read_text().splitlines()] if p.exists() else []

    def state(self):
        return json.loads((self.work / "attempt.json").read_text())

    def store(self, url, path):
        path.write_bytes(b"original media bytes")

    def test_prepare_freezes_exact_bytes_and_has_stable_digest(self):
        digest = self.prepare()
        second = job.prepare(self.request, self.root / "second")
        self.assertEqual(digest, second["request_sha256"])
        self.assertEqual((self.work / "prompt.txt").read_bytes(), self.prompt)
        (self.root / "frame.png").write_bytes(b"changed outside frozen attempt")
        frozen, _ = job.load_attempt(self.work, True)
        self.assertEqual((self.work / frozen["inputs"][0]["path"]).read_bytes(), b"exact input bytes")
        self.assertEqual(self.calls(), [])

    def test_prepare_keeps_stable_digest_without_optional_selection(self):
        # Базовая фикстура уже содержит явного провайдера. Проверка фиксирует
        # точные байты текущего контракта без необязательных метаданных выбора.
        digest = self.prepare()
        self.assertEqual(digest, "f58044814f7a9be976b3cf99b2a6006b995806482b8e4d01115bd553c2409114")
        data = (self.work / "request.json").read_bytes()
        self.assertEqual(hashlib.sha256(data).hexdigest(), digest)
        self.assertEqual(json.loads(data)["provider"], "kling")
        self.assertNotIn("model_selection", json.loads(data))

    def test_prepare_requires_provider_and_kling_adapter_rejects_other_services(self):
        # Источник провайдера — только spec: имя команды и инструмента
        # не разрешает дописывать Kling к запросу без этого поля.
        for provider in (None, "", " \n\t", 1, "OtherService"):
            with self.subTest(provider=provider):
                self.spec["provider"] = provider
                self.write_spec()
                with self.assertRaisesRegex(ValueError, "provider|провайдера"):
                    self.prepare()
                self.assertFalse(self.work.exists())
        del self.spec["provider"]
        self.write_spec()
        with self.assertRaisesRegex(ValueError, "provider"):
            self.prepare()
        self.assertFalse(self.work.exists())
        self.assertEqual(self.calls(), [])

    def test_load_submit_and_resume_reject_missing_or_other_provider_before_cli(self):
        # Пересчитываем SHA после изменения provider: отказ должен проверять
        # назначение адаптера, а не случайное несовпадение контрольной суммы.
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
                    with patch.object(job, "call_cli") as runner:
                        with self.assertRaisesRegex(ValueError, "provider"):
                            if action == "load":
                                job.load_attempt(directory, verify_inputs=True)
                            elif action == "submit":
                                job.submit(directory, digest, str(self.cli))
                            else:
                                job.resume(directory, str(self.cli))
                        runner.assert_not_called()
                    self.assertEqual(json.loads((directory / "attempt.json").read_text()), state)

    def test_prepare_preserves_selection_and_hashes_exact_reason_offline(self):
        selection = {
            "preferredModel": "preferred-model",
            "selectedModel": "test-model",
            "reason": "  Предпочитаемая модель не поддерживает нужную длительность.  ",
        }
        self.spec["model_selection"] = selection
        self.write_spec()
        with patch.object(job, "call_cli", side_effect=AssertionError("prepare не вызывает CLI")):
            prepared = job.prepare(self.request, self.work)
        frozen, state = job.load_attempt(self.work, verify_inputs=True)
        self.assertEqual(frozen["model_selection"], selection)
        self.assertEqual(prepared["model_selection"], selection)
        self.assertEqual(hashlib.sha256((self.work / "request.json").read_bytes()).hexdigest(), state["request_sha256"])
        selection["reason"] = "Другое объяснение выбора."
        self.write_spec()
        changed = job.prepare(self.request, self.root / "other-reason")
        self.assertNotEqual(changed["request_sha256"], state["request_sha256"])
        self.assertEqual(self.calls(), [])

    def test_selection_accepts_null_preference_and_rejects_invalid_metadata(self):
        selection = {"preferredModel": None, "selectedModel": "test-model", "reason": "Выбрана совместимая модель."}
        self.spec["model_selection"] = selection
        job.validate_spec(self.spec)
        invalid = [
            None,
            [],
            "selection",
            {},
            selection | {"extra": True},
            {"selectedModel": "test-model", "reason": "Причина"},
            selection | {"preferredModel": ""},
            selection | {"preferredModel": "invalid model"},
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

    def test_tampered_selection_reason_is_rejected_before_cli(self):
        self.spec["model_selection"] = {
            "preferredModel": None,
            "selectedModel": "test-model",
            "reason": "Исходная причина.",
        }
        self.write_spec()
        digest = self.prepare()
        frozen = json.loads((self.work / "request.json").read_text())
        frozen["model_selection"]["reason"] = "Подменённая причина."
        job.atomic_json(self.work / "request.json", frozen)
        with patch.object(job, "call_cli") as runner:
            with self.assertRaisesRegex(ValueError, "Подготовленный запрос изменён"):
                job.submit(self.work, digest, str(self.cli))
            runner.assert_not_called()
        self.assertEqual(self.state()["status"], "prepared")

    def test_submit_resume_keep_frozen_model_selection(self):
        self.spec["model_selection"] = {
            "preferredModel": "another-model",
            "selectedModel": "test-model",
            "reason": "Совместима с запросом.",
        }
        self.write_spec()
        digest = self.prepare()
        before = (self.work / "request.json").read_bytes()
        with patch.object(job, "capabilities", side_effect=AssertionError("Выбор модели уже заморожен")):
            job.submit(self.work, digest, str(self.cli))
            with patch.object(job, "download", side_effect=self.store):
                job.resume(self.work, str(self.cli))
        self.assertEqual((self.work / "request.json").read_bytes(), before)
        self.assertIn("--model=test-model", self.calls()[0])
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
        job.submit(saved, digest, str(self.cli))
        argv = self.calls()[0]
        self.assertEqual(argv[-1], self.prompt.decode())
        self.assertIn("--input=image_1=" + str(saved / request["inputs"][0]["path"]), argv)
        with patch.object(job, "download", side_effect=self.store):
            result = job.resume(saved, str(self.cli))
        self.assertEqual(result["status"], "downloaded")
        self.assertEqual(result["generation_id"], "job-123")
        self.assertEqual([c[0] for c in self.calls()], ["image_to_video", "query_tasks"])

    def test_input_copies_are_deduplicated_without_losing_slots(self):
        self.spec["inputs"].append({"flag": "input", "slot": "image_2", "path": "frame.png", "role": "last"})
        self.write_spec()
        self.prepare()
        request, _ = job.load_attempt(self.work)
        self.assertEqual(request["inputs"][0]["path"], request["inputs"][1]["path"])
        self.assertEqual(len(list((self.work / "inputs").iterdir())), 1)

    def test_submit_confirmation_and_immutable_inputs(self):
        digest = self.prepare()
        with self.assertRaises(ValueError):
            job.submit(self.work, "wrong", str(self.cli))
        self.assertEqual(self.calls(), [])
        (self.work / "inputs/01.png").write_bytes(b"changed")
        with self.assertRaises(ValueError):
            job.submit(self.work, digest, str(self.cli))
        self.assertEqual(self.calls(), [])

    def test_submit_resume_and_repeated_resume_never_resubmit(self):
        self.submit()
        argv = self.calls()[0]
        self.assertEqual(argv[-1], self.prompt.decode())
        self.assertIn("--enable_audio=false", argv)
        with self.assertRaises(ValueError):
            job.submit(self.work, self.state()["request_sha256"], str(self.cli))
        with patch.object(job, "download", side_effect=self.store) as fetch:
            result = job.resume(self.work, str(self.cli))
            self.assertEqual(result["status"], "downloaded")
            self.assertEqual(fetch.call_count, 1)
            job.resume(self.work, str(self.cli))
            self.assertEqual(fetch.call_count, 1)
        self.assertEqual([c[0] for c in self.calls()], ["image_to_video", "query_tasks"])
        self.assertNotIn("SECRET", (self.work / "attempt.json").read_text())
        self.assertNotIn("https://", (self.work / "attempt.json").read_text())
        self.assertNotIn("video_sha256", result)

    def test_unknown_submission_cannot_be_retried_and_can_recover_id(self):
        self.response["submit"] = {"ok": False, "body": {"error": "https://secret.test/TOKEN"}}
        self.write_response()
        digest = self.prepare()
        with self.assertRaisesRegex(ValueError, "неизвестен"):
            job.submit(self.work, digest, str(self.cli))
        self.assertEqual(self.state()["status"], "submission_unknown")
        with self.assertRaises(ValueError):
            job.submit(self.work, digest, str(self.cli))
        with patch.object(job, "download", side_effect=self.store):
            job.resume(self.work, str(self.cli), generation_id="job-123")
        self.assertEqual(self.state()["status"], "downloaded")
        self.assertEqual(len(self.calls()), 2)
        self.assertNotIn("TOKEN", (self.work / "attempt.json").read_text())

    def test_timeout_persists_unknown_state(self):
        self.response["sleep"] = 2
        self.write_response()
        digest = self.prepare()
        with self.assertRaises(ValueError):
            job.submit(self.work, digest, str(self.cli), timeout=0.03)
        self.assertEqual(self.state()["status"], "submission_unknown")

    def test_missing_cli_does_not_consume_prepared_attempt(self):
        digest = self.prepare()
        with self.assertRaises(ValueError):
            job.submit(self.work, digest, str(self.root / "missing"))
        self.assertEqual(self.state()["status"], "prepared")

    def test_bundled_cli_preserves_literal_arguments_and_changes_only_child_environment(self):
        script = self.root / "CLI с пробелами" / "cli.js"
        script.parent.mkdir()
        script.write_text(
            'import json,os,sys\nprint(json.dumps({"args":sys.argv[1:],'
            '"mode":os.environ.get("ELECTRON_RUN_AS_NODE")}))\n'
        )
        args = ["account", "--label=слова с пробелами", "$(touch NEVER_EXECUTE) `это аргумент`"]
        env = {
            "SONGFRAME_KLING_EXECUTABLE": sys.executable,
            "SONGFRAME_KLING_SCRIPT": str(script),
            "ELECTRON_RUN_AS_NODE": "parent-value",
        }
        with (
            patch.dict(os.environ, env),
            patch.object(kling_cli.subprocess, "run", wraps=kling_cli.subprocess.run) as runner,
        ):
            result = kling_cli.run(["kling", *args], 5)
            self.assertEqual(result.returncode, 0)
            self.assertEqual(json.loads(result.stdout), {"args": args, "mode": "1"})
            self.assertEqual(runner.call_args.args[0], [sys.executable, str(script), *args])
            self.assertIs(runner.call_args.kwargs["shell"], False)
            self.assertEqual(os.environ["ELECTRON_RUN_AS_NODE"], "parent-value")
        self.assertFalse((self.root / "NEVER_EXECUTE").exists())

    def test_explicit_cli_overrides_missing_bundle_without_electron_mode(self):
        self.write_response()
        env = {
            "SONGFRAME_KLING_EXECUTABLE": str(self.root / "missing-app"),
            "SONGFRAME_KLING_SCRIPT": str(self.root / "missing.js"),
            "ELECTRON_RUN_AS_NODE": "parent-value",
        }
        with (
            patch.dict(os.environ, env),
            patch.object(kling_cli.subprocess, "run", wraps=kling_cli.subprocess.run) as runner,
        ):
            self.assertIn("kling-video-v4_0", job.capabilities(str(self.cli))["models"])
            self.assertEqual(runner.call_args.args[0], [str(self.cli), "who_am_i", "--quiet"])
            self.assertEqual(runner.call_args.kwargs["env"]["ELECTRON_RUN_AS_NODE"], "parent-value")

    def test_bundled_capabilities_submit_and_watch_use_the_same_cli(self):
        script = self.root / "bundled CLI.js"
        script.write_text(self.cli.read_text())
        self.write_response()
        with patch.dict(
            os.environ, {"SONGFRAME_KLING_EXECUTABLE": sys.executable, "SONGFRAME_KLING_SCRIPT": str(script)}
        ):
            self.assertIn("kling-video-v3_0", job.capabilities()["models"])
            state = job.submit(self.work, self.prepare())
            self.assertEqual(state["generation_id"], "job-123")
            with patch.object(job, "download", side_effect=self.store):
                result = job.watch([self.work])
            self.assertEqual(result[str(self.work)]["status"], "downloaded")
        self.assertEqual([call[0] for call in self.calls()], ["tool_list", "who_am_i", "image_to_video", "query_tasks"])
        self.assertEqual(self.calls()[2][-1], self.prompt.decode())

    def test_missing_bundle_does_not_fall_back_or_consume_prepared_attempt(self):
        digest = self.prepare()
        env = {"SONGFRAME_KLING_EXECUTABLE": sys.executable, "SONGFRAME_KLING_SCRIPT": str(self.root / "missing.js")}
        with patch.dict(os.environ, env), patch.object(kling_cli.shutil, "which", return_value=str(self.cli)) as finder:
            with patch.object(job, "call_cli") as runner:
                with self.assertRaisesRegex(ValueError, "Встроенный Kling CLI недоступен"):
                    job.submit(self.work, digest)
                with self.assertRaisesRegex(ValueError, "Встроенный Kling CLI недоступен"):
                    job.capabilities()
                runner.assert_not_called()
            self.assertNotIn("kling", [call.args[0] for call in finder.call_args_list])
        self.assertEqual(self.state()["status"], "prepared")
        self.assertEqual(self.calls(), [])

    def test_lock_prevents_parallel_submission(self):
        digest = self.prepare()
        with job.locked(self.work):
            with self.assertRaises(ValueError):
                job.submit(self.work, digest, str(self.cli))
        self.assertEqual(self.calls(), [])
        self.assertEqual(job.submit(self.work, digest, str(self.cli))["status"], "submitted")

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

    def test_no_watermark_free_url_does_not_fall_back(self):
        del self.response["query"]["body"]["works"][0]["urlWithoutWatermark"]
        self.write_response()
        self.submit()
        with patch.object(job, "download") as fetch:
            result = job.resume(self.work, str(self.cli))
            self.assertEqual(result["status"], "watermark_free_pending")
            fetch.assert_not_called()
            result = job.resume(self.work, str(self.cli))
            self.assertEqual(result["status"], "watermark_free_pending")
            fetch.assert_not_called()
        self.assertEqual(self.state()["generation_id"], "job-123")
        self.response["query"]["body"]["works"][0]["url_without_watermark"] = "https://example.test/original.mp4"
        self.write_response()
        with patch.object(job, "download", side_effect=self.store) as fetch:
            result = job.resume(self.work, str(self.cli))
        self.assertEqual(result["status"], "downloaded")
        self.assertEqual(fetch.call_args.args[0], "https://example.test/original.mp4")
        self.assertEqual(
            [call[0] for call in self.calls()], ["image_to_video", "query_tasks", "query_tasks", "query_tasks"]
        )

    def test_running_failed_and_query_errors_keep_same_id(self):
        self.submit()
        self.response["query"]["body"]["status"] = "RUNNING"
        self.write_response()
        self.assertEqual(job.resume(self.work, str(self.cli))["status"], "running")
        self.response["query"] = {"ok": False, "body": {"error": "PRIVATE_URL"}}
        self.write_response()
        with self.assertRaises(ValueError):
            job.resume(self.work, str(self.cli))
        self.assertEqual(self.state()["generation_id"], "job-123")
        self.response["query"] = {"ok": True, "body": {"generationId": "job-123", "status": "FAILED"}}
        self.write_response()
        self.assertEqual(job.resume(self.work, str(self.cli))["status"], "failed")
        self.assertNotIn("PRIVATE_URL", (self.work / "attempt.json").read_text())

    def test_multiple_outputs_resume_after_download_failure(self):
        self.spec["outputs"] = 2
        self.spec["parameters"]["imageCount"] = 2
        self.write_spec()
        self.response["query"]["body"]["works"] *= 2
        self.write_response()
        self.submit()
        calls = []

        def flaky(url, path):
            calls.append(path.name)
            if len(calls) == 2:
                raise OSError("SECRET")
            self.store(url, path)

        with patch.object(job, "download", side_effect=flaky):
            with self.assertRaises(ValueError):
                job.resume(self.work, str(self.cli))
        self.assertEqual(len(self.state()["downloads"]), 1)
        with patch.object(job, "download", side_effect=self.store) as fetch:
            result = job.resume(self.work, str(self.cli))
            self.assertEqual(fetch.call_count, 1)
            self.assertEqual(result["status"], "downloaded")
        self.assertEqual([x["path"] for x in result["downloads"]], ["original-01.mp4", "original-02.mp4"])

    def test_interruption_after_atomic_download_recovers_without_second_download(self):
        self.submit()
        original = job.atomic_json

        def interrupted(path, value):
            if value.get("downloads"):
                raise KeyboardInterrupt()
            original(path, value)

        with (
            patch.object(job, "download", side_effect=self.store),
            patch.object(job, "atomic_json", side_effect=interrupted),
        ):
            with self.assertRaises(KeyboardInterrupt):
                job.resume(self.work, str(self.cli))
        self.assertTrue((self.work / "original.mp4").exists())
        self.assertEqual(self.state()["downloads"], [])
        with patch.object(job, "download") as fetch:
            result = job.resume(self.work, str(self.cli))
            fetch.assert_not_called()
        self.assertEqual(result["status"], "downloaded")

    def test_image_result_uses_original_extension_and_snake_case_id(self):
        self.spec.update(kind="image", command="image_to_image")
        self.write_spec()
        self.response["submit"]["body"] = {"generation_id": "job-123"}
        self.response["query"]["body"]["works"] = [
            {"contentType": "image", "url": "https://example.test/image.png?SECRET"}
        ]
        self.write_response()
        self.submit()
        with patch.object(job, "urlopen", return_value=ImageResponse(PNG_ORIGINAL)):
            result = job.resume(self.work, str(self.cli))
        self.assertEqual(result["downloads"][0]["path"], "original.png")
        self.assertEqual((self.work / "original.png").read_bytes(), PNG_ORIGINAL)

    def test_image_prefers_explicit_watermark_free_url_to_regular_url(self):
        self.spec.update(kind="image", command="image_to_image")
        self.write_spec()
        for field in ("urlWithoutWatermark", "url_without_watermark"):
            with self.subTest(field=field):
                self.work = self.root / field
                free_url = "https://example.test/free-original"
                self.response["query"]["body"]["works"] = [
                    {"contentType": "image", "url": "https://example.test/regular", field: free_url}
                ]
                self.write_response()
                self.submit()
                with patch.object(job, "urlopen", return_value=ImageResponse(PNG_ORIGINAL)) as fetch:
                    result = job.resume(self.work, str(self.cli))
                fetch.assert_called_once_with(free_url, timeout=60)
                self.assertEqual(result["status"], "downloaded")
                self.assertEqual((self.work / "original.png").read_bytes(), PNG_ORIGINAL)

    def image_attempt(self, url="https://example.test/opaque.image?SECRET"):
        self.spec.update(kind="image", command="image_to_image")
        self.write_spec()
        self.response["query"]["body"]["works"] = [{"contentType": "image", "url": url}]
        self.write_response()
        self.submit()

    def test_opaque_jpeg_url_saves_actual_original_bytes(self):
        self.image_attempt()
        with patch.object(job, "urlopen", return_value=ImageResponse(JPEG_ORIGINAL)):
            result = job.resume(self.work, str(self.cli))
        self.assertEqual(result["downloads"][0]["path"], "original.jpg")
        self.assertEqual((self.work / "original.jpg").read_bytes(), JPEG_ORIGINAL)
        self.assertEqual(result["downloads"][0]["sha256"], job.sha(self.work / "original.jpg"))
        self.assertNotIn("SECRET", (self.work / "attempt.json").read_text())

    def test_extensionless_png_url_saves_actual_original_bytes(self):
        self.image_attempt("https://example.test/result?SECRET")
        with patch.object(job, "urlopen", return_value=ImageResponse(PNG_ORIGINAL)):
            result = job.resume(self.work, str(self.cli))
        self.assertEqual(result["downloads"][0]["path"], "original.png")
        self.assertEqual((self.work / "original.png").read_bytes(), PNG_ORIGINAL)

    def test_opaque_webp_url_saves_actual_original_bytes(self):
        self.image_attempt()
        with patch.object(job, "urlopen", return_value=ImageResponse(WEBP_ORIGINAL)):
            result = job.resume(self.work, str(self.cli))
        self.assertEqual(result["downloads"][0]["path"], "original.webp")
        self.assertEqual((self.work / "original.webp").read_bytes(), WEBP_ORIGINAL)

    def test_mislabeled_png_url_uses_jpeg_signature_without_conversion(self):
        self.image_attempt("https://example.test/result.png?SECRET")
        with patch.object(job, "urlopen", return_value=ImageResponse(JPEG_ORIGINAL)):
            result = job.resume(self.work, str(self.cli))
        self.assertEqual(result["downloads"][0]["path"], "original.jpg")
        self.assertFalse((self.work / "original.png").exists())
        self.assertEqual((self.work / "original.jpg").read_bytes(), JPEG_ORIGINAL)

    def test_invalid_image_body_is_not_published_and_same_id_can_resume(self):
        self.image_attempt()
        response = ImageResponse(b"<html>not an original</html>")
        response.headers["Content-Type"] = "image/png"
        with patch.object(job, "urlopen", return_value=response), self.assertRaises(ValueError):
            job.resume(self.work, str(self.cli))
        self.assertEqual(self.state()["status"], "download_pending")
        self.assertEqual(self.state()["generation_id"], "job-123")
        self.assertEqual(self.state()["downloads"], [])
        self.assertEqual(list(self.work.glob("original*")), [])
        self.assertEqual(list(self.work.glob(".image-download-*")), [])
        with patch.object(job, "urlopen", return_value=ImageResponse(PNG_ORIGINAL)):
            result = job.resume(self.work, str(self.cli))
        self.assertEqual(result["status"], "downloaded")
        self.assertEqual([call[0] for call in self.calls()], ["image_to_image", "query_tasks", "query_tasks"])

    def test_image_crash_after_publication_resumes_without_redownload(self):
        self.image_attempt()
        atomic = job.atomic_json

        def interrupted(path, value):
            if value.get("downloads"):
                raise KeyboardInterrupt()
            atomic(path, value)

        with (
            patch.object(job, "urlopen", return_value=ImageResponse(JPEG_ORIGINAL)),
            patch.object(job, "atomic_json", side_effect=interrupted),
        ):
            with self.assertRaises(KeyboardInterrupt):
                job.resume(self.work, str(self.cli))
        pending = self.state()["pending_download"]
        self.assertEqual(pending["path"], "original.jpg")
        self.assertEqual(pending["bytes"], len(JPEG_ORIGINAL))
        self.assertEqual(pending["sha256"], job.sha(self.work / "original.jpg"))
        # Подписанный адрес при повторном query может измениться вместе с расширением.
        self.response["query"]["body"]["works"][0]["url"] = "https://example.test/renewed.png?SECRET"
        self.write_response()
        with patch.object(job, "urlopen") as fetch:
            result = job.resume(self.work, str(self.cli))
            fetch.assert_not_called()
        self.assertEqual(result["status"], "downloaded")
        self.assertEqual(result["generation_id"], "job-123")
        self.assertEqual([call[0] for call in self.calls()], ["image_to_image", "query_tasks", "query_tasks"])

    def test_image_pending_publication_rejects_changed_existing_original(self):
        self.image_attempt()
        atomic = job.atomic_json

        def interrupted(path, value):
            if value.get("downloads"):
                raise KeyboardInterrupt()
            atomic(path, value)

        with (
            patch.object(job, "urlopen", return_value=ImageResponse(JPEG_ORIGINAL)),
            patch.object(job, "atomic_json", side_effect=interrupted),
        ):
            with self.assertRaises(KeyboardInterrupt):
                job.resume(self.work, str(self.cli))
        changed = JPEG_ORIGINAL[:-1] + b"!"
        (self.work / "original.jpg").write_bytes(changed)
        with patch.object(job, "urlopen") as fetch, self.assertRaises(ValueError):
            job.resume(self.work, str(self.cli))
        fetch.assert_not_called()
        self.assertEqual((self.work / "original.jpg").read_bytes(), changed)

    def test_image_download_does_not_claim_or_overwrite_foreign_existing_file(self):
        self.image_attempt()
        (self.work / "original.jpg").write_bytes(JPEG_ORIGINAL)
        with patch.object(job, "urlopen", return_value=ImageResponse(JPEG_ORIGINAL)), self.assertRaises(ValueError):
            job.resume(self.work, str(self.cli))
        self.assertNotIn("pending_download", self.state())
        self.assertEqual(self.state()["downloads"], [])
        self.assertEqual((self.work / "original.jpg").read_bytes(), JPEG_ORIGINAL)

    def test_multiple_image_outputs_resume_only_missing_original(self):
        self.spec.update(kind="image", command="image_to_image", outputs=2)
        self.spec["parameters"]["imageCount"] = 2
        self.write_spec()
        self.response["query"]["body"]["works"] = [
            {"contentType": "image", "url": "https://example.test/opaque.image"}
        ] * 2
        self.write_response()
        self.submit()
        with (
            patch.object(job, "urlopen", side_effect=[ImageResponse(PNG_ORIGINAL), OSError("SECRET")]),
            self.assertRaises(ValueError),
        ):
            job.resume(self.work, str(self.cli))
        self.assertEqual([item["path"] for item in self.state()["downloads"]], ["original-01.png"])
        with patch.object(job, "urlopen", return_value=ImageResponse(JPEG_ORIGINAL)) as fetch:
            result = job.resume(self.work, str(self.cli))
        self.assertEqual(fetch.call_count, 1)
        self.assertEqual(result["status"], "downloaded")
        self.assertEqual([item["path"] for item in result["downloads"]], ["original-01.png", "original-02.jpg"])

    def test_image_crash_before_publication_resumes_same_id(self):
        self.image_attempt()
        link = job.os.link

        def interrupted(source, destination):
            if Path(destination).name == "original.png":
                raise KeyboardInterrupt()
            link(source, destination)

        with (
            patch.object(job, "urlopen", return_value=ImageResponse(PNG_ORIGINAL)),
            patch.object(job.os, "link", side_effect=interrupted),
        ):
            with self.assertRaises(KeyboardInterrupt):
                job.resume(self.work, str(self.cli))
        self.assertEqual(self.state()["pending_download"]["path"], "original.png")
        self.assertFalse((self.work / "original.png").exists())
        with patch.object(job, "urlopen", return_value=ImageResponse(PNG_ORIGINAL)):
            result = job.resume(self.work, str(self.cli))
        self.assertEqual(result["status"], "downloaded")
        self.assertEqual([call[0] for call in self.calls()], ["image_to_image", "query_tasks", "query_tasks"])

    def test_registered_image_validates_signature_and_legacy_jpeg_suffix(self):
        self.image_attempt()
        with patch.object(job, "urlopen", return_value=ImageResponse(JPEG_ORIGINAL)):
            job.resume(self.work, str(self.cli))
        (self.work / "original.jpg").rename(self.work / "original.jpeg")
        state = self.state()
        state["downloads"][0]["path"] = "original.jpeg"
        state["downloads"][0].pop("sha256")
        job.atomic_json(self.work / "attempt.json", state)
        with patch.object(job, "urlopen") as fetch:
            self.assertEqual(job.resume(self.work, str(self.cli))["status"], "downloaded")
            fetch.assert_not_called()
        (self.work / "original.jpeg").rename(self.work / "original.png")
        state["downloads"][0]["path"] = "original.png"
        job.atomic_json(self.work / "attempt.json", state)
        with patch.object(job, "urlopen") as fetch, self.assertRaisesRegex(ValueError, "Расширение"):
            job.resume(self.work, str(self.cli))
        fetch.assert_not_called()
        self.assertEqual((self.work / "original.png").read_bytes(), JPEG_ORIGINAL)

    def test_invalid_options_and_manual_id_before_submission_are_rejected(self):
        self.spec["parameters"]["poll"] = 60
        self.write_spec()
        with self.assertRaises(ValueError):
            self.prepare()
        self.assertFalse(self.work.exists())
        del self.spec["parameters"]["poll"]
        self.write_spec()
        self.prepare()
        with self.assertRaises(ValueError):
            job.resume(self.work, str(self.cli), generation_id="job-123")
        self.assertEqual(self.calls(), [])

    def test_multi_shot_models_require_explicit_prefer_multi_shots(self):
        # У v3_0 авто-раскадровка включена по умолчанию: молчание не равно единому плану.
        self.spec["model"] = "kling-video-v3_0"
        self.write_spec()
        with self.assertRaises(ValueError):
            self.prepare()
        self.assertFalse(self.work.exists())
        self.spec["parameters"]["prefer_multi_shots"] = False
        self.write_spec()
        self.submit()
        frozen = json.loads((self.work / "request.json").read_text())
        self.assertIs(frozen["parameters"]["prefer_multi_shots"], False)
        self.assertIn("--prefer_multi_shots=false", self.calls()[0])
        # Модели без объявленного флага не получают его принудительно.
        self.spec["model"] = "kling-video-v3_0_turbo"
        del self.spec["parameters"]["prefer_multi_shots"]
        self.write_spec()
        job.prepare(self.request, self.root / "turbo")

    def test_v4_requires_explicit_resolution_and_long_prompt_only_warns(self):
        self.spec["model"] = "kling-video-v4_0"
        del self.spec["parameters"]["resolution"]
        self.write_spec()
        with self.assertRaises(ValueError):
            self.prepare()
        self.spec["parameters"]["resolution"] = "1080p"
        self.write_spec()
        self.assertEqual(job.prepare(self.request, self.work)["warnings"], [])
        (self.root / "prompt.txt").write_bytes(("слово " * 600).encode())
        self.spec["shot"] = "M33"
        self.write_spec()
        result = job.prepare(self.request, self.root / "long")
        self.assertEqual(len(result["warnings"]), 1)
        self.assertIn("2500", result["warnings"][0])

    def test_capabilities_parse_declarations_and_filter_by_model(self):
        report = job.capabilities(str(self.cli))
        models = report["models"]
        self.assertEqual(set(models), {"kling-video-v3_0", "kling-video-v4_0"})
        v3 = models["kling-video-v3_0"]
        self.assertEqual(v3["arguments"]["duration"]["allowed"][0], "3")
        self.assertEqual(v3["arguments"]["prefer_multi_shots"]["default"], "true")
        self.assertEqual(v3["arguments"]["elements"]["max_items"], 7)
        self.assertTrue(v3["slots"]["first_image"]["required"])
        self.assertFalse(v3["slots"]["tail_image"]["required"])
        v4 = models["kling-video-v4_0"]
        self.assertIn("keyframe_1", v4["slots"])
        self.assertEqual(v4["limits"]["combined_item_cap"]["maxItems"], 10)
        self.assertEqual(set(job.capabilities(str(self.cli), model="kling-video-v4_0")["models"]), {"kling-video-v4_0"})
        with self.assertRaises(ValueError):
            job.capabilities(str(self.cli), model="kling-video-v9")
        table = job.capabilities_table(report)
        self.assertIn(
            (
                "| kling-video-v4_0 | 3|4|5 (по умолчанию 10) | 720p|1080p (по "
                "умолчанию 720p) | — | — | — | first_image*, tail_image, "
                "keyframe_1; всего не более 10 |"
            ),
            table,
        )
        self.assertEqual(self.calls()[0], ["tool_list", "--quiet"])
        self.assertEqual(self.calls()[1], ["who_am_i", "--quiet"])

    def test_capabilities_does_not_depend_on_static_or_localized_help(self):
        # CLI может вернуть статическую справку с exit 0 после ошибки динамической справки.
        # Подтверждённые модели читаются из JSON, а help больше не участвует в discovery.
        self.response["help"] = "Usage: kling image_to_video --model <model>"
        self.write_response()
        help_result = kling_cli.run([str(self.cli), "image_to_video", "--help"], 5)
        self.assertEqual(help_result.returncode, 0)
        self.assertNotIn(b"Model:", help_result.stdout)
        report = job.capabilities(str(self.cli))
        self.assertEqual(set(report["models"]), {"kling-video-v3_0", "kling-video-v4_0"})
        self.assertEqual([call[0] for call in self.calls()], ["image_to_video", "tool_list", "who_am_i"])

    def test_capabilities_requires_advertised_tool_and_account_models(self):
        self.response["tools"]["body"]["tools"] = [{"name": "text_to_video"}]
        self.write_response()
        with self.assertRaisesRegex(ValueError, "Команда не объявлена в tool_list"):
            job.capabilities(str(self.cli))
        self.assertEqual([call[0] for call in self.calls()], ["tool_list", "who_am_i"])
        self.response["tools"]["body"]["tools"] = [{"name": "image_to_video"}]
        self.response["who"]["body"]["availableModels"]["image_to_video"]["models"] = []
        self.write_response()
        with self.assertRaisesRegex(ValueError, "who_am_i не объявил модели") as error:
            job.capabilities(str(self.cli))
        self.assertNotIn("login", str(error.exception))

    def test_batch_reads_one_snapshot_for_all_commands(self):
        available = self.response["who"]["body"]["availableModels"]
        available["text_to_video"] = available["image_to_video"]
        self.write_response()
        report = job.capabilities_batch(str(self.cli), ["text_to_video", "image_to_video"])
        self.assertEqual([entry["command"] for entry in report["reports"]], ["text_to_video", "image_to_video"])
        self.assertEqual(report["problems"], [])
        self.assertEqual([call[0] for call in self.calls()], ["tool_list", "who_am_i"])
        # Следующее обновление читает аккаунт заново, без сохранённого каталога прежнего сеанса.
        available["image_to_video"]["models"][0]["model"] = "new-account-model"
        self.write_response()
        updated = job.capabilities_batch(str(self.cli), ["image_to_video"])
        self.assertIn("new-account-model", updated["reports"][0]["models"])
        self.assertEqual(len(self.calls()), 4)

    def test_batch_preserves_real_missing_or_invalid_command_problems(self):
        available = self.response["who"]["body"]["availableModels"]
        available["text_to_video"] = {"models": "invalid"}
        self.response["tools"]["body"]["tools"] = [{"name": "image_to_video"}, {"name": "text_to_video"}]
        self.write_response()
        report = job.capabilities_batch(str(self.cli), ["text_to_video", "image_to_video", "motion_control"])
        self.assertEqual([entry["command"] for entry in report["reports"]], ["image_to_video"])
        self.assertEqual([entry["command"] for entry in report["problems"]], ["text_to_video", "motion_control"])
        self.assertIn("неверное объявление", report["problems"][0]["message"])
        self.assertIn("не объявлена", report["problems"][1]["message"])
        self.assertEqual(len(self.calls()), 2)

    def test_batch_rejects_failed_snapshot_without_private_output(self):
        self.response["who"] = {"ok": False, "body": {"private_identity": "PRIVATE"}}
        self.write_response()
        with self.assertRaisesRegex(ValueError, "CLI не подтвердил discovery") as error:
            job.capabilities_batch(str(self.cli), ["image_to_video", "text_to_video"])
        self.assertNotIn("PRIVATE", str(error.exception))
        self.assertEqual(len(self.calls()), 2)

    def test_batch_rejects_invalid_commands_before_cli(self):
        for commands in ([], ["image_to_video", "image_to_video"], ["unknown"]):
            with self.assertRaisesRegex(ValueError, "неповторяющиеся команды"):
                job.capabilities_batch(str(self.cli), commands)
        self.assertEqual(self.calls(), [])

    def test_capabilities_preserves_snake_case_values_and_declared_limits(self):
        entry = self.response["who"]["body"]["availableModels"]["image_to_video"]["models"][0]
        entry["arguments"] = [
            {"name": "enabled", "required": True, "default": False, "allowed_values": ["true", "false"], "maxItems": 2}
        ]
        entry["combinedItemCaps"] = [
            {"maxItems": 2, "arguments": [], "inputPrefixes": ["image_"], "whenAnyInputPrefixes": ["video_"]}
        ]
        entry["inputs"].append({"name": "optional_image"})
        self.response["who"]["body"] = {"available_models": {"image_to_video": [entry]}}
        self.write_response()
        report = job.capabilities(str(self.cli))
        model = report["models"]["kling-video-v3_0"]
        self.assertEqual(
            model["arguments"]["enabled"],
            {"required": True, "default": False, "allowed": ["true", "false"], "max_items": 2},
        )
        self.assertEqual(model["limits"]["combined_item_caps"], entry["combinedItemCaps"])
        self.assertTrue(model["slots"]["first_image"]["required"])
        self.assertIn("optional_image", job.capabilities_table(report))

    def test_capabilities_reads_large_json_from_private_regular_file(self):
        self.response["who"]["body"]["private_identity"] = "PRIVATE" * 50000
        self.write_response()
        runner = kling_cli.subprocess.run

        def capture(argv, **kwargs):
            self.assertTrue(stat.S_ISREG(os.fstat(kwargs["stdout"].fileno()).st_mode))
            self.assertEqual(stat.S_IMODE(os.fstat(kwargs["stdout"].fileno()).st_mode), 0o600)
            return runner(argv, **kwargs)

        with patch.object(kling_cli.subprocess, "run", side_effect=capture):
            report = job.capabilities(str(self.cli))
        self.assertEqual(len(report["models"]), 2)
        self.assertNotIn("PRIVATE", json.dumps(report))

    def test_capabilities_rejects_truncated_or_failed_json_without_private_output(self):
        self.response["who_raw"] = '{"ok":true,"body":{"private_identity":"PRIVATE"'
        self.write_response()
        with self.assertRaisesRegex(ValueError, "неполный или неверный JSON") as error:
            job.capabilities(str(self.cli))
        self.assertNotIn("PRIVATE", str(error.exception))
        del self.response["who_raw"]
        self.response["who"] = {"ok": False, "body": {"private_identity": "PRIVATE"}}
        self.write_response()
        with self.assertRaisesRegex(ValueError, "CLI не подтвердил discovery") as error:
            job.capabilities(str(self.cli))
        self.assertNotIn("PRIVATE", str(error.exception))

    def test_watch_polls_until_terminal_and_reports_status_changes(self):
        # Подставной CLI отвечает RUNNING первые два опроса, затем COMPLETED; сон подменён.
        counter = self.root / "polls"
        self.cli.write_text(
            "#!"
            + sys.executable
            + "\n"
            + f"""import json,sys
from pathlib import Path
base=Path(__file__).parent
config=json.loads((base/'fake.json').read_text())
if sys.argv[1]=='query_tasks':
    counter=Path({str(counter)!r}); n=int(counter.read_text()) if counter.exists() else 0; counter.write_text(str(n+1))
    value=config['query'] if n>=2 else {{'ok':True,'body':{{'generationId':'job-123','status':'RUNNING'}}}}
else:value=config['submit']
print(json.dumps(value))
"""
        )
        self.submit()
        lines = []
        with patch.object(job.time, "sleep", lambda seconds: None), patch.object(job, "download", self.store):
            result = job.watch([self.work], str(self.cli), max_minutes=1, interval=5, report=lines.append)
        self.assertEqual(result[str(self.work)]["status"], "downloaded")
        self.assertEqual(lines, [f"{self.work.name}: running", f"{self.work.name}: downloaded"])
        self.assertEqual(int(counter.read_text()), 3)
        with patch.object(job.time, "sleep", lambda seconds: None):
            again = job.watch([self.work], str(self.cli), max_minutes=1, interval=5, report=lines.append)
        self.assertEqual(again[str(self.work)]["status"], "downloaded")
        self.assertEqual(int(counter.read_text()), 3)
        other = self.root / "other"
        job.prepare(self.request, other)
        with patch.object(job.time, "sleep", lambda seconds: None):
            mixed = job.watch([other], str(self.cli), max_minutes=1, interval=5, report=lines.append)
        self.assertEqual(mixed[str(other)]["status"], "error")
        with self.assertRaises(ValueError):
            job.watch([self.work], str(self.cli), max_minutes=0)

    def test_opaque_generation_id_is_not_interpreted_as_path(self):
        opaque = "provider+opaque/id=="
        self.response["submit"]["body"]["generationId"] = opaque
        self.response["query"]["body"]["generationId"] = opaque
        self.write_response()
        self.submit()
        with patch.object(job, "download", side_effect=self.store):
            result = job.resume(self.work, str(self.cli))
        self.assertEqual(result["generation_id"], opaque)
        self.assertEqual(self.calls()[-1][1], opaque)

    def test_prompt_flag_and_changed_request_are_rejected(self):
        (self.root / "prompt.txt").write_text("--model an unexpected model")
        with self.assertRaises(ValueError):
            self.prepare()
        self.assertFalse(self.work.exists())
        (self.root / "prompt.txt").write_bytes(self.prompt)
        digest = self.prepare()
        frozen = json.loads((self.work / "request.json").read_text())
        frozen["model"] = "different"
        (self.work / "request.json").write_text(json.dumps(frozen))
        with self.assertRaises(ValueError):
            job.submit(self.work, digest, str(self.cli))
        self.assertEqual(self.calls(), [])

    def test_download_is_atomic_and_does_not_overwrite(self):
        class Response(io.BytesIO):
            headers = {"Content-Length": "30"}

        destination = self.root / "download.mp4"
        with patch.object(job, "urlopen", return_value=Response(b"short")):
            with self.assertRaises(ValueError):
                job.download("https://example.test/video", destination)
        self.assertFalse(destination.exists())
        self.assertFalse(destination.with_suffix(".mp4.part").exists())
        destination.write_bytes(b"existing")
        response = Response(b"complete")
        response.headers = {}
        with patch.object(job, "urlopen", return_value=response):
            with self.assertRaises(FileExistsError):
                job.download("https://example.test/video", destination)
        self.assertEqual(destination.read_bytes(), b"existing")


if __name__ == "__main__":
    unittest.main()
