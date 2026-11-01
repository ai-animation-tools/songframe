"""Адаптер Kling на поддельном MCP-сервере без сети и платных запросов; @link README.md"""

import sys
from pathlib import Path

# Полные импорты tools.* работают и при прямом запуске файла из любой папки.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))


import io
import json
import os
import subprocess
import tempfile
import unittest
import uuid
from unittest.mock import patch

from tools import media_adapters
from tools.kling_request import kling_mcp as mcp
from tools.kling_request import kling_request as job
from tools.kling_request.fake_kling_server import FakeKling, Reject, Status
from tools.media_request import attempt

PNG_ORIGINAL = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR" + b"original png bytes"
MEDIA_REQUEST = Path(__file__).resolve().parents[1] / "media_request" / "media_request.py"


class Response(io.BytesIO):
    def __init__(self, value, length=None):
        super().__init__(value)
        self.headers = {"Content-Length": str(len(value) if length is None else length)}


# Минимальный фрагмент структуры who_am_i: модели относятся только к объявленной команде.
WHO_SAMPLE = {
    "user": {"userId": 1},
    "availableModels": {
        "image_to_video": {
            "models": [
                {
                    "model": "kling-video-v3_0",
                    "arguments": [
                        {"name": "prompt", "required": True},
                        {"name": "duration", "default": "5", "allowedValues": [str(value) for value in range(3, 16)]},
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
    },
}


class KlingAdapterTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="kling-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.work = self.root / "attempt"
        (self.root / "frame.png").write_bytes(b"exact input bytes")
        self.prompt = b"--model A single take. $(touch NEVER_EXECUTE) `not a command`\r\nSecond line."
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
        self.fake = FakeKling().__enter__()
        self.addCleanup(self.fake.__exit__)
        variables = {"SONGFRAME_LOCAL_DIR": str(self.root / "state"), mcp.BASE_URL_ENV: self.fake.url}
        environment = patch.dict(os.environ, variables | {mcp.DEBUG_ENV: ""})
        environment.start()
        self.addCleanup(environment.stop)
        self.fake.tool_list = [{"name": name} for name in sorted(job.COMMANDS)]
        self.fake.tools.update(
            who_am_i=json.loads(json.dumps(WHO_SAMPLE)),
            image_to_video={"generationId": "job-123", "creditsConsumed": 12},
            image_to_image={"generationId": "job-123", "creditsConsumed": 12},
            query_tasks={
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
            query_membership_and_credits={"membership": "pro", "credits": {"total": 2000, "remaining": 1824}},
        )
        mcp.write_credentials(self.fake.credentials())

    def write_spec(self):
        self.request.write_text(json.dumps(self.spec))

    def prepare(self):
        return attempt.prepare(self.request, self.work)["request_sha256"]

    def submit(self):
        return attempt.submit(self.work, self.prepare())

    def tool_calls(self, name=None):
        return [arguments for tool, arguments in self.fake.calls if name is None or tool == name]

    def state(self):
        return json.loads((self.work / "attempt.json").read_text())

    def store(self, url, path):
        Path(path).write_bytes(b"original media bytes")

    def test_adapter_is_registered_for_kling_provider(self):
        self.assertIs(media_adapters.adapter(" Kling "), job)

    def test_prepare_keeps_stable_digest_and_watermark_free_marker(self):
        # Точные байты формата: provider, признак оригинала без логотипа и отсутствие необязательного выбора.
        (self.root / "prompt.txt").write_bytes(b"A single take. $(touch NEVER_EXECUTE) `not a command`\r\nSecond line.")
        digest = self.prepare()
        self.assertEqual(digest, "f58044814f7a9be976b3cf99b2a6006b995806482b8e4d01115bd553c2409114")
        data = json.loads((self.work / "request.json").read_bytes())
        self.assertEqual((data["provider"], data["video_without_watermark"]), ("kling", True))
        self.assertNotIn("model_selection", data)
        self.assertNotIn("task_trace_id", self.state())
        self.assertEqual(self.fake.requests, [])

    def test_kling_rules_reject_before_attempt_folder(self):
        cases = [
            ("poll", lambda spec: spec["parameters"].update(poll=60)),
            ("trace", lambda spec: spec["parameters"].update(taskTraceId="x")),
            ("command", lambda spec: spec.update(command="generate")),
            ("kind", lambda spec: spec.update(kind="image")),
            ("model", lambda spec: spec.update(model="invalid model")),
            ("outputs", lambda spec: spec.update(outputs=10)),
            ("imageCount", lambda spec: spec["parameters"].update(imageCount=2)),
            ("inputs", lambda spec: spec.update(inputs=[])),
            ("slot", lambda spec: spec["inputs"][0].update(flag="image")),
            ("flag", lambda spec: spec["inputs"][0].pop("slot") and spec["inputs"][0].update(flag="image")),
            ("preferred", lambda spec: spec.update(
                model_selection={"preferredModel": "invalid model", "selectedModel": "test-model", "reason": "r"}
            )),
        ]
        for name, change in cases:
            with self.subTest(case=name):
                spec = json.loads(json.dumps(self.spec))
                change(spec)
                self.request.write_text(json.dumps(spec))
                with self.assertRaises(ValueError):
                    self.prepare()
                self.assertFalse(self.work.exists())

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
        arguments = self.tool_calls("image_to_video")[0]["arguments"]
        self.assertIn({"name": "prefer_multi_shots", "value": "false"}, arguments)
        # Модели без объявленного флага не получают его принудительно.
        self.spec["model"] = "kling-video-v3_0_turbo"
        del self.spec["parameters"]["prefer_multi_shots"]
        self.write_spec()
        attempt.prepare(self.request, self.root / "turbo")

    def test_v4_requires_explicit_resolution_and_long_prompt_only_warns(self):
        self.spec["model"] = "kling-video-v4_0"
        del self.spec["parameters"]["resolution"]
        self.write_spec()
        with self.assertRaises(ValueError):
            self.prepare()
        self.spec["parameters"]["resolution"] = "1080p"
        self.write_spec()
        self.assertEqual(attempt.prepare(self.request, self.work)["warnings"], [])
        (self.root / "prompt.txt").write_bytes(("слово " * 600).encode())
        self.spec["shot"] = "M33"
        self.write_spec()
        result = attempt.prepare(self.request, self.root / "long")
        self.assertEqual(len(result["warnings"]), 1)
        self.assertIn("2500", result["warnings"][0])

    def test_submit_uploads_inputs_and_sends_exact_envelope(self):
        state = self.submit()
        self.assertEqual((state["generation_id"], state["credits_consumed"]), ("job-123", 12))
        trace = state["task_trace_id"]
        self.assertEqual(uuid.UUID(trace).version, 7)
        upload = self.fake.uploads[0]
        self.assertEqual((upload["filename"], upload["data"]), ("01.png", b"exact input bytes"))
        call = self.tool_calls("image_to_video")[0]
        expected = {
            "model": "test-model",
            "arguments": [
                {"name": "prompt", "value": self.prompt.decode()},
                {"name": "duration", "value": "6"},
                {"name": "enable_audio", "value": "false"},
                {"name": "imageCount", "value": "1"},
                {"name": "resolution", "value": "1080p"},
            ],
            "inputs": [{"name": "image_1", "inputType": "URL", "url": "https://cdn.test/01.png"}],
            "rationale": "",
            "taskTraceId": trace,
        }
        self.assertEqual(call, expected)
        # Загрузка, отправка и опрос одной попытки идут под одним taskTraceId.
        self.assertEqual(self.tool_calls("file_upload")[0]["taskTraceId"], trace)
        self.assertFalse((self.root / "NEVER_EXECUTE").exists())
        with patch.object(job, "fetch", side_effect=self.store) as fetch:
            result = attempt.resume(self.work)
        self.assertEqual(result["status"], "downloaded")
        self.assertEqual(result["service_status"], "completed")
        self.assertEqual(fetch.call_args.args[0], "https://example.test/video.mp4?SECRET")
        self.assertEqual(self.tool_calls("query_tasks"), [{"generationId": "job-123", "taskTraceId": trace}])
        self.assertNotIn("SECRET", (self.work / "attempt.json").read_text())

    def test_финальный_промпт_референса_передаётся_дословно_без_скрытых_описаний(self):
        # Проверяется фактический конверт MCP: подписи опор не становятся дополнительным промптом.
        self.spec.update(kind="image", command="image_to_image", parameters={"imgResolution": "1k"})
        self.spec["inputs"][0]["role"] = "Опора 1"
        self.write_spec()
        prompts = [
            "  Сохрани внешность Олега.\r\nСтиль: объёмная анимация.  ",
            "  Сохрани внешность Олега.\r\n\r\nОписания выбранных опор:\r\n1. Шрам над левой бровью.  ",
            "  Пользователь заменил весь промпт.\r\nТолько силуэт, без куртки.\n  ",
        ]
        for index, prompt in enumerate(prompts):
            with self.subTest(prompt=prompt):
                self.work = self.root / f"reference-attempt-{index}"
                (self.root / "prompt.txt").write_bytes(prompt.encode("utf-8"))
                state = self.submit()
                self.assertEqual(self.tool_calls("image_to_image")[-1], {
                    "model": "test-model",
                    "arguments": [
                        {"name": "prompt", "value": prompt},
                        {"name": "imgResolution", "value": "1k"},
                    ],
                    "inputs": [{"name": "image_1", "inputType": "URL", "url": "https://cdn.test/01.png"}],
                    "rationale": "",
                    "taskTraceId": state["task_trace_id"],
                })

    def test_text_command_sends_no_inputs(self):
        self.spec.update(kind="image", command="text_to_image", inputs=[])
        self.write_spec()
        self.fake.tools["text_to_image"] = {"generationId": "job-123"}
        self.submit()
        self.assertNotIn("inputs", self.tool_calls("text_to_image")[0])
        self.assertEqual(self.fake.uploads, [])

    def test_resent_attempt_keeps_trace_id(self):
        self.fake.tools["image_to_video"] = Reject("Invalid parameters")
        digest = self.prepare()
        with self.assertRaises(ValueError):
            attempt.submit(self.work, digest)
        first = self.state()["task_trace_id"]
        self.fake.tools["image_to_video"] = {"generationId": "job-123"}
        self.assertEqual(attempt.submit(self.work, digest)["task_trace_id"], first)

    def test_explicit_tool_error_keeps_attempt_unsent(self):
        # Kling отклоняет неверные параметры до оплаты: isError без ID задания не делает исход неизвестным.
        self.fake.tools["image_to_video"] = Reject(
            "Invalid parameters. Please fetch the latest who_am_i configuration and try again."
        )
        digest = self.prepare()
        with self.assertRaisesRegex(ValueError, "отклонил запрос до оплаты"):
            attempt.submit(self.work, digest)
        state = self.state()
        self.assertEqual(state["status"], "prepared")
        self.assertIn("Invalid parameters", state["last_rejection"])
        self.assertNotIn("generation_id", state)

    def test_upload_failure_and_missing_login_do_not_consume_attempt(self):
        cases = [
            ("ticket", lambda: self.fake.tools.update(file_upload=Reject("Kling MCP is handling too many requests"))),
            ("upload", lambda: setattr(self.fake, "upload_response", (500, {"message": "busy"}))),
            ("login", lambda: mcp.credentials_path().unlink()),
            ("network", lambda: os.environ.update({mcp.BASE_URL_ENV: "http://127.0.0.1:9"})),
        ]
        for name, damage in cases:
            with self.subTest(case=name):
                self.work = self.root / name
                digest = self.prepare()
                damage()
                with self.assertRaisesRegex(ValueError, "отправка не начиналась"):
                    attempt.submit(self.work, digest)
                self.assertEqual(self.state()["status"], "prepared")
                self.assertNotIn("last_rejection", self.state())
                self.assertEqual(self.tool_calls("image_to_video"), [])

    def test_server_error_bad_body_and_timeout_stay_unknown(self):
        debug = self.root / "debug.log"
        os.environ[mcp.DEBUG_ENV] = str(debug)
        for name, answer, delay in [
            ("5xx", Status(502, "Bad gateway"), 0),
            ("body", {"error": "https://secret.test/TOKEN"}, 0),
            ("timeout", {"generationId": "job-123"}, 1),
        ]:
            with self.subTest(case=name):
                self.work = self.root / name
                self.fake.tools["image_to_video"] = answer
                self.fake.delays["image_to_video"] = delay
                digest = self.prepare()
                with patch.object(mcp, "SUBMIT_TIMEOUT", 0.3), self.assertRaisesRegex(ValueError, "неизвестен"):
                    attempt.submit(self.work, digest)
                self.assertEqual(self.state()["status"], "submission_unknown")
                self.assertNotIn("TOKEN", (self.work / "attempt.json").read_text())
        log = debug.read_text()
        self.assertIn("TransportError", log)
        self.assertIn("status: 502", log)
        self.assertIn("Bad gateway", log)
        self.assertNotIn("access-", log)

    def test_no_watermark_free_video_url_does_not_fall_back(self):
        del self.fake.tools["query_tasks"]["works"][0]["urlWithoutWatermark"]
        self.submit()
        with patch.object(job, "fetch") as fetch:
            self.assertEqual(attempt.resume(self.work)["status"], "watermark_free_pending")
            fetch.assert_not_called()
        self.assertEqual(self.state()["generation_id"], "job-123")
        self.fake.tools["query_tasks"]["works"][0]["url_without_watermark"] = "https://example.test/original.mp4"
        with patch.object(job, "fetch", side_effect=self.store) as fetch:
            result = attempt.resume(self.work)
        self.assertEqual(result["status"], "downloaded")
        self.assertEqual(fetch.call_args.args[0], "https://example.test/original.mp4")

    def test_image_prefers_explicit_watermark_free_url_and_falls_back_to_regular_url(self):
        self.spec.update(kind="image", command="image_to_image")
        self.write_spec()
        free = "https://example.test/free"
        cases = [
            ("urlWithoutWatermark", {"urlWithoutWatermark": free}, free),
            ("url_without_watermark", {"url_without_watermark": free}, free),
            ("url", {}, "https://example.test/regular"),
        ]
        for name, fields, expected in cases:
            with self.subTest(field=name):
                self.work = self.root / name
                work = {"contentType": "image", "url": "https://example.test/regular", **fields}
                self.fake.tools["query_tasks"]["works"] = [work]
                self.submit()
                with patch.object(job, "urlopen", return_value=Response(PNG_ORIGINAL)) as fetch:
                    result = attempt.resume(self.work)
                fetch.assert_called_once_with(expected, timeout=60)
                self.assertEqual(result["status"], "downloaded")
                self.assertEqual((self.work / "original.png").read_bytes(), PNG_ORIGINAL)

    def test_query_statuses_and_errors_map_to_attempt_statuses(self):
        self.submit()
        body = self.fake.tools["query_tasks"]
        for service, expected in [("RUNNING", "running"), ("queued", "running"), ("FAILED", "failed")]:
            with self.subTest(service=service):
                self.fake.tools["query_tasks"] = body | {"status": service}
                answer = job.poll(self.work, {"kind": "video", "outputs": 1}, {"generation_id": "job-123"}, 5)
                self.assertEqual((answer["status"], answer["service_status"]), (expected, service.lower()))
        self.fake.tools["query_tasks"] = body | {"works": []}
        self.assertEqual(attempt.resume(self.work)["status"], "outputs_pending")
        for query in (Reject("PRIVATE_URL"), body | {"generationId": "x"}, "not json"):
            with self.subTest(query=query):
                self.fake.tools["query_tasks"] = query
                with self.assertRaisesRegex(ValueError, "ID сохранён"):
                    attempt.resume(self.work)
        self.assertEqual(self.state()["generation_id"], "job-123")
        self.assertNotIn("PRIVATE_URL", (self.work / "attempt.json").read_text())

    def test_opaque_generation_id_is_not_interpreted_as_path(self):
        opaque = "provider+opaque/id=="
        self.fake.tools["image_to_video"] = {"generationId": opaque}
        self.fake.tools["query_tasks"]["generationId"] = opaque
        self.submit()
        with patch.object(job, "fetch", side_effect=self.store):
            result = attempt.resume(self.work)
        self.assertEqual(result["generation_id"], opaque)
        self.assertEqual(self.tool_calls("query_tasks")[-1]["generationId"], opaque)

    def test_fetch_requires_https_and_complete_body(self):
        destination = self.root / "download.part"
        with self.assertRaisesRegex(ValueError, "недопустимый адрес"):
            job.fetch("http://example.test/video", destination)
        with patch.object(job, "urlopen", return_value=Response(b"short", length=30)):
            with self.assertRaisesRegex(ValueError, "не завершена"):
                job.fetch("https://example.test/video", destination)
        with patch.object(job, "urlopen", return_value=Response(b"complete")):
            job.fetch("https://example.test/video", destination)
        self.assertEqual(destination.read_bytes(), b"complete")

    def test_capabilities_parse_declarations_and_filter_by_model(self):
        report = job.capabilities("video")
        self.assertEqual([entry["command"] for entry in report["reports"]], ["image_to_video"])
        self.assertEqual(
            [entry["command"] for entry in report["problems"]], ["text_to_video", "omni_ref_video", "motion_control"]
        )
        models = report["reports"][0]["models"]
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
        tools, body = job.capability_catalog(60)
        filtered = job.command_capabilities("image_to_video", "kling-video-v4_0", tools, body)
        self.assertEqual(set(filtered["models"]), {"kling-video-v4_0"})
        with self.assertRaises(ValueError):
            job.command_capabilities("image_to_video", "kling-video-v9", tools, body)
        methods = self.fake.methods()[:4]
        self.assertEqual(methods, ["initialize", "notifications/initialized", "tools/list", "tools/call"])
        self.assertEqual(self.tool_calls("who_am_i")[0]["tools"], job.KIND_COMMANDS["video"])

    def test_image_kind_reads_only_image_commands(self):
        available = self.fake.tools["who_am_i"]["availableModels"]
        available["text_to_image"] = available["image_to_video"]
        report = job.capabilities("image")
        self.assertEqual([entry["command"] for entry in report["reports"]], ["text_to_image"])
        self.assertEqual([entry["command"] for entry in report["problems"]], ["image_to_image"])
        self.assertEqual(self.tool_calls("who_am_i")[0]["tools"], job.KIND_COMMANDS["image"])

    def test_legacy_input_flags_map_to_declared_slots_before_freeze(self):
        # Снимок прежнего CLI с флагами image/tailImage повторяется: флаги раскрываются в объявленные слоты модели.
        spec = {
            "command": "image_to_video",
            "model": "kling-video-v3_0",
            "inputs": [{"flag": "image", "path": "a.png"}, {"flag": "tailImage", "path": "b.png"}],
        }
        job.normalize_inputs(spec)
        slots = [(item["flag"], item["slot"]) for item in spec["inputs"]]
        self.assertEqual(slots, [("input", "first_image"), ("input", "tail_image")])
        calls = len(self.fake.methods())
        self.assertIs(job.normalize_inputs(spec), spec)
        self.assertEqual(len(self.fake.methods()), calls, "именованные слоты не требуют обращения к сервису")
        broken = {"command": "image_to_video", "model": "kling-video-v3_0", "inputs": [{"flag": "video", "path": "c"}]}
        with self.assertRaisesRegex(ValueError, "не объявляет подходящего слота"):
            job.normalize_inputs(broken)

    def test_capabilities_requires_advertised_tool_and_account_models(self):
        self.fake.tool_list = [{"name": "text_to_video"}]
        problems = {entry["command"]: entry["message"] for entry in job.capabilities("video")["problems"]}
        self.assertIn("Команда не объявлена в tool_list", problems["image_to_video"])
        self.fake.tool_list = [{"name": "image_to_video"}]
        self.fake.tools["who_am_i"]["availableModels"]["image_to_video"]["models"] = []
        problems = {entry["command"]: entry["message"] for entry in job.capabilities("video")["problems"]}
        self.assertIn("who_am_i не объявил модели", problems["image_to_video"])
        self.assertNotIn("login", problems["image_to_video"])

    def test_catalog_reads_one_fresh_snapshot_for_all_commands(self):
        available = self.fake.tools["who_am_i"]["availableModels"]
        available["text_to_video"] = available["image_to_video"]
        report = job.capabilities("video")
        self.assertEqual([entry["command"] for entry in report["reports"]], ["text_to_video", "image_to_video"])
        self.assertEqual(len(self.fake.calls), 1)
        # Следующее обновление читает аккаунт заново, без сохранённого каталога прежнего сеанса.
        self.fake.tools["who_am_i"] = json.loads(json.dumps(self.fake.tools["who_am_i"]))
        self.fake.tools["who_am_i"]["availableModels"]["image_to_video"]["models"][0]["model"] = "new-account-model"
        self.assertIn("new-account-model", job.capabilities("video")["reports"][1]["models"])
        self.assertEqual(len(self.fake.calls), 2)

    def test_catalog_preserves_real_invalid_command_problems(self):
        self.fake.tools["who_am_i"]["availableModels"]["text_to_video"] = {"models": "invalid"}
        report = job.capabilities("video")
        self.assertEqual([entry["command"] for entry in report["reports"]], ["image_to_video"])
        problems = {entry["command"]: entry["message"] for entry in report["problems"]}
        self.assertIn("неверное объявление", problems["text_to_video"])

    def test_catalog_rejects_failed_snapshot_without_private_output(self):
        for answer in (Reject("PRIVATE identity"), "PRIVATE text", Status(500, "PRIVATE")):
            with self.subTest(answer=answer):
                self.fake.tools["who_am_i"] = answer
                with self.assertRaises(ValueError) as error:
                    job.capabilities("video")
                self.assertNotIn("PRIVATE", str(error.exception))
        mcp.credentials_path().unlink()
        with self.assertRaisesRegex(ValueError, "«Среда»"):
            job.capabilities("video")

    def test_capabilities_preserves_snake_case_values_and_declared_limits(self):
        entry = self.fake.tools["who_am_i"]["availableModels"]["image_to_video"]["models"][0]
        entry["arguments"] = [
            {"name": "enabled", "required": True, "default": False, "allowed_values": ["true", "false"], "maxItems": 2}
        ]
        entry["combinedItemCaps"] = [
            {"maxItems": 2, "arguments": [], "inputPrefixes": ["image_"], "whenAnyInputPrefixes": ["video_"]}
        ]
        entry["inputs"].append({"name": "optional_image"})
        self.fake.tools["who_am_i"] = {"available_models": {"image_to_video": [entry]}}
        model = job.capabilities("video")["reports"][0]["models"]["kling-video-v3_0"]
        self.assertEqual(
            model["arguments"]["enabled"],
            {"required": True, "default": False, "allowed": ["true", "false"], "max_items": 2},
        )
        self.assertEqual(model["limits"]["combined_item_caps"], entry["combinedItemCaps"])
        self.assertTrue(model["slots"]["first_image"]["required"])
        self.assertIn("optional_image", model["slots"])

    def test_account_prefers_remaining_and_keeps_only_number(self):
        self.assertEqual(job.account(), {"balance": 1824.0, "source": "credits.remaining"})
        self.fake.tools["query_membership_and_credits"] = Reject("no")
        self.assertIsNone(job.account()["balance"])
        self.fake.tools["query_membership_and_credits"] = {"membership": "pro"}
        self.assertIn("нет числового поля", job.account()["source"])
        mcp.credentials_path().unlink()
        self.assertIn("«Среда»", job.account()["source"])

    def test_auth_status_distinguishes_login_and_network(self):
        self.assertEqual(job.auth_status(), {"status": "authenticated"})
        self.fake.access.clear()
        self.fake.refresh.clear()
        self.assertEqual(job.auth_status()["status"], "unauthenticated")
        os.environ[mcp.BASE_URL_ENV] = "http://127.0.0.1:9"
        mcp.write_credentials(self.fake.credentials())
        self.assertEqual(job.auth_status()["status"], "unknown")
        mcp.credentials_path().unlink()
        self.assertEqual(job.auth_status()["status"], "unauthenticated")

    def test_login_reports_result_without_raising(self):
        with patch.object(mcp, "login", side_effect=mcp.AuthRequired("отменён")):
            result = job.login(open_browser=False, timeout=1)
        self.assertEqual(result, {"ok": False, "message": "Вход в Kling не завершён: отменён"})
        with patch.object(mcp, "login") as login:
            self.assertTrue(job.login(open_browser=False, timeout=5)["ok"])
        login.assert_called_once_with(open_browser=False, timeout=5)

    def test_media_request_auth_status_works_without_project(self):
        env = {key: value for key, value in os.environ.items() if key != "SONGFRAME_PROJECT"}
        command = [sys.executable, "-B", str(MEDIA_REQUEST), "auth-status", "--provider", "kling", "--json"]
        result = subprocess.run(command, cwd=self.root, env=env, capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {"status": "authenticated"})
        env["SONGFRAME_MEDIA_ADAPTERS"] = "test=tools.testing.fake_media_request"
        command = [sys.executable, "-B", str(MEDIA_REQUEST), "login", "--provider", "test", "--no-browser"]
        result = subprocess.run(command, cwd=self.root, env=env, capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 1)
        self.assertIn("не поддерживает", result.stderr)

    def test_pricing_file_and_snapshot_warning_belong_to_adapter(self):
        self.assertEqual(json.loads(job.pricing_file().read_text())["schema_version"], 1)
        snapshot = {"model": "kling-video-v3_0", "parameters": {"duration": 5}}
        self.assertEqual([where for where, _ in job.snapshot_warnings(snapshot)], ["parameters"])
        self.assertEqual(job.snapshot_warnings(snapshot | {"parameters": {"prefer_multi_shots": False}}), [])


if __name__ == "__main__":
    unittest.main()
