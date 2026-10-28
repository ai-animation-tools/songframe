"""Клиент MCP Kling на поддельном локальном сервере: вход, токены, вызовы и загрузка без сети; @link README.md#тесты"""

import sys
from pathlib import Path

# Полные импорты tools.* работают и при прямом запуске файла из любой папки.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))


import json
import os
import socket
import stat
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlparse
from urllib.request import urlopen

from tools.kling_request import kling_mcp as mcp
from tools.kling_request.fake_kling_server import FakeKling, Reject, RpcError, Status


def free_port():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


class ClientTestCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="kling-mcp-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.fake = FakeKling().__enter__()
        self.addCleanup(self.fake.__exit__)
        variables = {"SONGFRAME_LOCAL_DIR": str(self.root / "state"), mcp.BASE_URL_ENV: self.fake.url}
        environment = patch.dict(os.environ, variables | {mcp.DEBUG_ENV: ""})
        environment.start()
        self.addCleanup(environment.stop)
        # Ни один тест не должен открывать настоящий браузер.
        browser = patch.object(mcp.webbrowser, "open", side_effect=AssertionError("браузер не открывается в тестах"))
        browser.start()
        self.addCleanup(browser.stop)

    def store(self, **changes):
        record = self.fake.credentials() | changes
        mcp.write_credentials(record)
        return record


class LoginTests(ClientTestCase):
    def ephemeral(self):
        """Колбэк на свободном порту: зарегистрированные 8787–8790 могут быть заняты на машине разработчика."""
        return patch.object(mcp, "listen", lambda state: mcp.CallbackServer(0, state))

    def browse(self, url):
        """Имитация браузера: проходит authorize и редирект на loopback-колбэк."""
        with urlopen(url, timeout=10) as response:
            self.page = response.read().decode()
        return True

    def test_login_registers_client_uses_pkce_and_stores_private_record(self):
        lines = []
        with self.ephemeral(), patch.object(mcp.webbrowser, "open", side_effect=self.browse):
            record = mcp.login(report=lines.append, timeout=10)
        self.assertIn("выполнен", self.page)
        self.assertEqual([line.split(" ")[0] for line in lines], ["AUTHORIZE_URL"])
        register = next(r for r in self.fake.requests if r["path"] == "/auth/register")["json"]
        self.assertEqual(register["client_name"], "songframe")
        self.assertEqual(register["application_type"], "native")
        self.assertEqual(register["token_endpoint_auth_method"], "none")
        self.assertEqual(register["grant_types"], ["authorization_code", "refresh_token"])
        self.assertIn("http://127.0.0.1:8787/callback", register["redirect_uris"])
        self.assertIn("http://localhost:8790/callback", register["redirect_uris"])
        self.assertEqual(len(register["redirect_uris"]), 8)
        authorize = {k: v[0] for k, v in parse_qs(urlparse(lines[0].split(" ", 1)[1]).query).items()}
        self.assertEqual(authorize["code_challenge_method"], "S256")
        self.assertEqual(authorize["resource"], self.fake.url + "/mcp")
        self.assertEqual(authorize["scope"], "generation.create generation.read account.credit.read")
        self.assertTrue(authorize["redirect_uri"].startswith("http://127.0.0.1:"))
        self.assertEqual(record["client_id"], "client-1")
        stored = json.loads(mcp.credentials_path().read_text())
        self.assertEqual(stored, record)
        fields = {"client_id", "access_token", "refresh_token", "expires_at", "token_endpoint", "revocation_endpoint"}
        self.assertEqual(set(stored), fields | {"resource", "scope"})
        self.assertGreater(stored["expires_at"], time.time() + 3000)
        self.assertEqual(mcp.credentials_path(), self.root / "state" / "providers" / "kling" / "credentials.json")
        if sys.platform != "win32":
            self.assertEqual(stat.S_IMODE(mcp.credentials_path().stat().st_mode), 0o600)
        self.assertNotIn("PRIVATE-REGISTRATION", mcp.credentials_path().read_text())

    def test_repeated_login_revokes_previous_refresh_token(self):
        previous = self.store()
        with self.ephemeral(), patch.object(mcp.webbrowser, "open", side_effect=self.browse):
            record = mcp.login(report=lambda line: None, timeout=10)
        self.assertEqual(self.fake.revoked, [previous["refresh_token"]])
        self.assertNotEqual(mcp.read_credentials()["access_token"], previous["access_token"])
        self.assertEqual(mcp.read_credentials(), record)

    def test_browser_not_opened_reports_url_and_waits_for_manual_visit(self):
        lines = []

        def report(line):
            lines.append(line)
            if line.startswith("AUTHORIZE_URL "):
                threading.Thread(target=self.browse, args=(line.split(" ", 1)[1],), daemon=True).start()

        with self.ephemeral():
            mcp.login(open_browser=False, report=report, timeout=10)
        self.assertEqual(lines[1], "BROWSER_NOT_OPENED")
        self.assertIsNotNone(mcp.read_credentials())

    def test_login_timeout_keeps_previous_record(self):
        previous = self.store()
        with self.ephemeral():
            with self.assertRaisesRegex(mcp.AuthRequired, "не подтверждён"):
                mcp.login(open_browser=False, report=lambda line: None, timeout=0.3)
        self.assertEqual(mcp.read_credentials(), previous)

    def test_callback_skips_busy_port_and_rejects_foreign_state(self):
        busy = socket.socket()
        busy.bind(("127.0.0.1", 0))
        busy.listen()
        self.addCleanup(busy.close)
        free = free_port()
        with patch.object(mcp, "LOGIN_PORTS", (busy.getsockname()[1], free)):
            server = mcp.listen("expected")
        self.addCleanup(server.server_close)
        self.assertEqual(server.server_address[1], free)
        threading.Thread(target=server.handle_request, daemon=True).start()
        with self.assertRaises(Exception) as error:
            urlopen(f"http://127.0.0.1:{free}/callback?code=x&state=other", timeout=5)
        self.assertEqual(error.exception.code, 400)
        self.assertFalse(server.done.is_set())


class TokenTests(ClientTestCase):
    def test_missing_record_requires_login_without_network(self):
        with self.assertRaisesRegex(mcp.AuthRequired, "Kling.*«Среда»"):
            mcp.Session().call("who_am_i")
        self.assertEqual(self.fake.requests, [])

    def test_expiring_token_is_refreshed_with_rotation(self):
        old = self.store(expires_at=int(time.time() + 10))
        self.fake.tools["who_am_i"] = {"user": {"userId": 1}}
        self.assertEqual(mcp.Session().call("who_am_i"), {"user": {"userId": 1}})
        record = mcp.read_credentials()
        self.assertEqual(self.fake.refreshes, 1)
        self.assertNotEqual(record["refresh_token"], old["refresh_token"])
        self.assertNotIn(old["refresh_token"], self.fake.refresh)
        token = next(r for r in self.fake.requests if r["path"] == "/auth/token")
        form = {k: v[0] for k, v in parse_qs(token["body"].decode()).items()}
        expected = {"grant_type": "refresh_token", "client_id": "client-1", "refresh_token": old["refresh_token"]}
        self.assertEqual(form, expected | {"resource": self.fake.url + "/mcp"})

    def test_refresh_without_new_refresh_token_keeps_previous(self):
        old = self.store(expires_at=int(time.time() + 10))
        self.fake.rotate = False
        record = mcp.refresh(old["access_token"])
        self.assertEqual(record["refresh_token"], old["refresh_token"])
        self.assertNotEqual(record["access_token"], old["access_token"])
        self.assertEqual(mcp.read_credentials(), record)

    def test_parallel_sessions_refresh_once_under_lock(self):
        self.store(expires_at=int(time.time() + 10))
        self.fake.token_delay = 0.3
        self.fake.tools["who_am_i"] = {"ok": 1}
        errors = []

        def work():
            try:
                mcp.Session().call("who_am_i")
            except Exception as error:  # ошибка потока проверяется ниже
                errors.append(error)

        threads = [threading.Thread(target=work) for _ in range(3)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(10)
        self.assertEqual(errors, [])
        self.assertEqual(self.fake.refreshes, 1)

    def test_unauthorized_call_refreshes_once_and_repeats(self):
        old = self.store()
        self.fake.access.discard(old["access_token"])
        self.fake.tools["who_am_i"] = {"ok": 1}
        self.assertEqual(mcp.Session().call("who_am_i"), {"ok": 1})
        self.assertEqual(self.fake.refreshes, 1)
        self.assertEqual(self.fake.methods(), ["initialize", "initialize", "notifications/initialized", "tools/call"])

    def test_second_unauthorized_answer_requires_login(self):
        self.store()
        self.fake.access.clear()
        self.fake.issue = lambda: ("never-valid", "refresh-new")
        with self.assertRaises(mcp.AuthRequired):
            mcp.Session().call("who_am_i")
        self.assertEqual(self.fake.refreshes, 1)

    def test_rejected_refresh_token_requires_login(self):
        old = self.store(expires_at=int(time.time() + 10))
        self.fake.refresh.discard(old["refresh_token"])
        with self.assertRaises(mcp.AuthRequired):
            mcp.Session().call("who_am_i")
        self.assertNotIn("/mcp", [r["path"] for r in self.fake.requests])


class SessionTests(ClientTestCase):
    def setUp(self):
        super().setUp()
        self.store()

    def test_initialize_once_and_trace_id_in_every_call(self):
        self.fake.tools.update(who_am_i={"a": 1}, query_tasks="plain text")
        self.fake.tool_list = [{"name": "who_am_i"}]
        session = mcp.Session(trace_id="trace-1")
        self.assertEqual(session.tools(), [{"name": "who_am_i"}])
        self.assertEqual(session.call("who_am_i", {"tools": ["x"]}), {"a": 1})
        self.assertEqual(session.call("query_tasks"), "plain text")
        methods = ["initialize", "notifications/initialized", "tools/list", "tools/call", "tools/call"]
        self.assertEqual(self.fake.methods(), methods)
        calls = [("who_am_i", {"tools": ["x"], "taskTraceId": "trace-1"}), ("query_tasks", {"taskTraceId": "trace-1"})]
        self.assertEqual(self.fake.calls, calls)
        mcp_requests = [r for r in self.fake.requests if r["path"] == "/mcp"]
        initialize = mcp_requests[0]
        self.assertEqual(initialize["json"]["params"]["protocolVersion"], mcp.PROTOCOL_VERSION)
        self.assertEqual(initialize["json"]["params"]["clientInfo"]["name"], "songframe")
        self.assertNotIn("mcp-protocol-version", initialize["headers"])
        for entry in mcp_requests:
            self.assertEqual(entry["headers"]["accept"], "application/json, text/event-stream")
            self.assertEqual(entry["headers"]["content-type"], "application/json")
            self.assertFalse(any(name.startswith("x-kling") for name in entry["headers"]))
        self.assertEqual(mcp_requests[-1]["headers"]["mcp-protocol-version"], mcp.PROTOCOL_VERSION)

    def test_generated_trace_id_is_uuid7(self):
        trace = mcp.Session().trace_id
        self.assertRegex(trace, r"^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")

    def test_tool_error_and_rpc_error(self):
        self.fake.tools.update(text_to_video=Reject("Invalid parameters"), who_am_i=RpcError(-32602, "bad params"))
        session = mcp.Session()
        with self.assertRaisesRegex(mcp.ToolError, "Invalid parameters"):
            session.call("text_to_video")
        with self.assertRaisesRegex(mcp.ProtocolError, "bad params"):
            session.call("who_am_i")

    def test_event_stream_answer(self):
        self.fake.sse = True
        self.fake.tools["who_am_i"] = {"user": 1}
        self.assertEqual(mcp.Session().call("who_am_i"), {"user": 1})

    def test_http_errors_connection_and_timeout(self):
        self.fake.tools["query_tasks"] = Status(502, "Bad gateway")
        with self.assertRaises(mcp.TransportError) as error:
            mcp.Session().call("query_tasks")
        self.assertEqual(error.exception.status, 502)
        self.fake.tools["slow"] = {"ok": 1}
        self.fake.delays["slow"] = 1
        session = mcp.Session(timeout=5)
        session.initialize()
        with self.assertRaises(mcp.TransportError) as error:
            session.call("slow", timeout=0.3)
        self.assertIsNone(error.exception.status)
        with patch.dict(os.environ, {mcp.BASE_URL_ENV: f"http://127.0.0.1:{free_port()}"}):
            with self.assertRaises(mcp.NotSent):
                mcp.Session().call("who_am_i")

    def test_upload_sends_ticket_multipart_without_token(self):
        path = self.root / "кадр 01.png"
        path.write_bytes(b"\x89PNG exact bytes")
        ticket = {"ticket": "ticket-9", "uploadUrl": self.fake.url + "/upload", "expire_at": 1}
        self.fake.tools["file_upload"] = lambda arguments: ticket
        nested = {"fileType": "image", "nested": [{"fileUrl": "https://cdn.test/a.png"}]}
        self.fake.upload_response = (200, {"result": 1, "data": nested})
        session = mcp.Session(trace_id="trace-u")
        self.assertEqual(session.upload(path), "https://cdn.test/a.png")
        request = {"filename": "кадр 01.png", "contentType": "image/png", "size": 16, "taskTraceId": "trace-u"}
        self.assertEqual(self.fake.calls, [("file_upload", request)])
        upload = self.fake.uploads[0]
        sent = (upload["ticket"], upload["filename"], upload["content_type"], upload["data"])
        self.assertEqual(sent, ("ticket-9", "кадр 01.png", "image/png", b"\x89PNG exact bytes"))
        self.assertIsNone(upload["authorization"])

    def test_upload_rejects_unknown_type_and_failed_answer(self):
        path = self.root / "clip.mov"
        path.write_bytes(b"x")
        with self.assertRaisesRegex(ValueError, "PNG, JPEG, MP4, WAV и MP3"):
            mcp.Session().upload(path)
        self.assertEqual(self.fake.requests, [])
        wav = self.root / "voice.wav"
        wav.write_bytes(b"RIFF")
        self.fake.upload_response = (429, {"message": "too many"})
        with self.assertRaises(mcp.TransportError):
            mcp.Session().upload(wav)
        self.assertEqual(self.fake.uploads[0]["content_type"], "audio/wav")


if __name__ == "__main__":
    unittest.main()
