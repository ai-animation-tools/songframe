"""Поддельный сервер Kling для тестов клиента и адаптера: OAuth, MCP и загрузка без сети; @link README.md#тесты

Сервер слушает 127.0.0.1 на свободном порту; тесты направляют клиент на него переменной SONGFRAME_KLING_BASE_URL.
Ответы инструментов задаются словарём `tools`: значение — тело результата, `Reject(текст)` — isError,
`RpcError(код, текст)` — ошибка JSON-RPC, функция — вычисляет ответ по аргументам.
"""

import base64
import hashlib
import json
import secrets
import threading
import time
from email.parser import BytesParser
from email.policy import HTTP
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlencode, urlparse


SCOPES = ["generation.create", "generation.read", "account.credit.read"]


class Reject:
    def __init__(self, text):
        self.text = text


class RpcError:
    def __init__(self, code, message):
        self.code = code
        self.message = message


class Status:
    """Ответ MCP-эндпоинта с заданным HTTP-статусом вместо JSON-RPC."""

    def __init__(self, status, text=""):
        self.status = status
        self.text = text


class Server(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        # Клиент с коротким таймаутом закрывает соединение раньше ответа: это ожидаемо в тестах таймаута.
        pass


class FakeKling:
    def __init__(self):
        self.server = Server(("127.0.0.1", 0), Handler)
        self.server.fake = self
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.lock = threading.Lock()
        self.requests = []
        self.calls = []
        self.tools = {"file_upload": lambda arguments: {"ticket": "ticket-1", "upload_url": self.url + "/upload"}}
        self.tool_list = []
        self.delays = {}
        self.uploads = []
        self.upload_response = None
        self.sse = False
        self.expires_in = 3600
        self.rotate = True
        self.token_delay = 0
        self.mcp_status = None
        self.access = set()
        self.refresh = set()
        self.codes = {}
        self.revoked = []
        self.refreshes = 0
        self.counter = 0
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *args):
        self.server.shutdown()
        self.server.server_close()

    def issue(self):
        """Новая пара токенов; прежние refresh токены при ротации перестают действовать."""
        with self.lock:
            self.counter += 1
            access, refresh = f"access-{self.counter}", f"refresh-{self.counter}"
            self.access.add(access)
            self.refresh.add(refresh)
        return access, refresh

    def credentials(self, expires_at=None):
        """Готовая запись входа для тестов, которым браузерный вход не нужен."""
        access, refresh = self.issue()
        return {
            "client_id": "client-1",
            "access_token": access,
            "refresh_token": refresh,
            "expires_at": int(time.time() + 3600) if expires_at is None else expires_at,
            "token_endpoint": self.url + "/auth/token",
            "revocation_endpoint": self.url + "/auth/revoke",
            "resource": self.url + "/mcp",
            "scope": " ".join(SCOPES),
        }

    def methods(self):
        """Методы JSON-RPC в порядке поступления на /mcp."""
        return [r["json"]["method"] for r in self.requests if r["path"] == "/mcp" and isinstance(r.get("json"), dict)]


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    @property
    def fake(self):
        return self.server.fake

    def send(self, status, body=b"", content_type="application/json", headers=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
        elif isinstance(body, str):
            body = body.encode()
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)

    def record(self, body=b""):
        url = urlparse(self.path)
        entry = {
            "method": self.command,
            "path": url.path,
            "query": parse_qs(url.query),
            "headers": {k.lower(): v for k, v in self.headers.items()},
            "body": body,
        }
        try:
            entry["json"] = json.loads(body) if body else None
        except ValueError:
            entry["json"] = None
        with self.fake.lock:
            self.fake.requests.append(entry)
        return entry

    def do_GET(self):
        entry = self.record()
        base = self.fake.url
        if entry["path"] == "/.well-known/oauth-protected-resource":
            servers = [base + "/auth"]
            resource = {"resource": base + "/mcp", "authorization_servers": servers, "scopes_supported": SCOPES}
            return self.send(200, resource)
        if entry["path"] == "/.well-known/oauth-authorization-server/auth":
            metadata = {
                "issuer": base + "/auth",
                "authorization_endpoint": base + "/auth/authorize",
                "token_endpoint": base + "/auth/token",
                "registration_endpoint": base + "/auth/register",
                "revocation_endpoint": base + "/auth/revoke",
                "scopes_supported": SCOPES,
            }
            return self.send(200, metadata)
        if entry["path"] == "/auth/authorize":
            query = {key: values[0] for key, values in entry["query"].items()}
            code = "code-" + secrets.token_hex(4)
            self.fake.codes[code] = query
            location = query["redirect_uri"] + "?" + urlencode({"code": code, "state": query["state"]})
            return self.send(302, b"", "text/plain", {"Location": location})
        self.send(404, {"error": "not found"})

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        entry = self.record(body)
        path = entry["path"]
        if path == "/auth/register":
            return self.send(201, {"client_id": "client-1", "registration_access_token": "PRIVATE-REGISTRATION"})
        if path == "/auth/token":
            return self.token({key: values[0] for key, values in parse_qs(body.decode()).items()})
        if path == "/auth/revoke":
            self.fake.revoked.append(parse_qs(body.decode())["token"][0])
            return self.send(200, b"", "text/plain")
        if path == "/upload":
            return self.upload(body)
        if path == "/mcp":
            return self.mcp(entry)
        self.send(404, {"error": "not found"})

    def token(self, form):
        fake = self.fake
        if form.get("grant_type") == "authorization_code":
            query = fake.codes.pop(form.get("code"), None)
            verifier = form.get("code_verifier", "").encode()
            challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier).digest()).rstrip(b"=").decode()
            if not query or query["code_challenge"] != challenge or query["redirect_uri"] != form.get("redirect_uri"):
                return self.send(400, {"error": "invalid_grant"})
        elif form.get("grant_type") == "refresh_token":
            time.sleep(fake.token_delay)
            with fake.lock:
                if form.get("refresh_token") not in fake.refresh:
                    return self.send(400, {"error": "invalid_grant"})
                fake.refreshes += 1
                if fake.rotate:
                    fake.refresh.discard(form["refresh_token"])
        else:
            return self.send(400, {"error": "unsupported_grant_type"})
        access, refresh = fake.issue()
        answer = {
            "access_token": access,
            "token_type": "Bearer",
            "expires_in": fake.expires_in,
            "scope": " ".join(SCOPES),
        }
        if fake.rotate or form["grant_type"] == "authorization_code":
            answer["refresh_token"] = refresh
        self.send(200, answer)

    def upload(self, body):
        message = BytesParser(policy=HTTP).parsebytes(
            b"Content-Type: " + self.headers["Content-Type"].encode() + b"\r\n\r\n" + body
        )
        parts = {part.get_param("name", header="content-disposition"): part for part in message.iter_parts()}
        upload = {
            "ticket": parts["ticket"].get_content(),
            "filename": parts["file"].get_filename(),
            "content_type": parts["file"].get_content_type(),
            "data": parts["file"].get_payload(decode=True),
            "authorization": self.headers.get("Authorization"),
        }
        self.fake.uploads.append(upload)
        if self.fake.upload_response is not None:
            status, value = self.fake.upload_response
            return self.send(status, value)
        url = "https://cdn.test/" + upload["filename"]
        self.send(200, {"status": 200, "data": {"url": url, "fileType": "image"}})

    def mcp(self, entry):
        fake = self.fake
        token = entry["headers"].get("authorization", "").removeprefix("Bearer ")
        if token not in fake.access:
            return self.send(401, b"", "text/plain", {"WWW-Authenticate": "Bearer"})
        if fake.mcp_status is not None:
            return self.send(fake.mcp_status.status, fake.mcp_status.text, "text/plain")
        message = entry["json"]
        if "id" not in message:
            return self.send(202, b"", "text/plain")
        method, params = message["method"], message.get("params", {})
        if method == "initialize":
            server = {"name": "fake-kling", "version": "1"}
            result = {"protocolVersion": params["protocolVersion"], "capabilities": {"tools": {}}, "serverInfo": server}
        elif method == "tools/list":
            result = {"tools": fake.tool_list}
        elif method == "tools/call":
            name, arguments = params["name"], params.get("arguments", {})
            with fake.lock:
                fake.calls.append((name, arguments))
            time.sleep(fake.delays.get(name, 0))
            value = fake.tools.get(name, Reject(f"unknown tool {name}"))
            if callable(value):
                value = value(arguments)
            if isinstance(value, Status):
                return self.send(value.status, value.text, "text/plain")
            if isinstance(value, RpcError):
                error = {"code": value.code, "message": value.message}
                return self.reply({"jsonrpc": "2.0", "id": message["id"], "error": error})
            if isinstance(value, Reject):
                result = {"content": [{"type": "text", "text": value.text}], "isError": True}
            else:
                text = value if isinstance(value, str) else json.dumps(value)
                result = {"content": [{"type": "text", "text": text}], "isError": False}
        else:
            return self.reply({"jsonrpc": "2.0", "id": message["id"], "error": {"code": -32601, "message": "no"}})
        self.reply({"jsonrpc": "2.0", "id": message["id"], "result": result})

    def reply(self, value):
        if self.fake.sse:
            body = "event: message\ndata: " + json.dumps(value) + "\n\n"
            return self.send(200, body, "text/event-stream")
        self.send(200, value)
