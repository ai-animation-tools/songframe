"""Клиент MCP-сервера Kling на стандартной библиотеке: вход OAuth, токены и вызовы инструментов; @link README.md#клиент

Протокол — stateless JSON-RPC поверх `POST <base>/mcp`, авторизация — OAuth 2.1 для публичного клиента
(discovery RFC 9728/8414, регистрация RFC 7591, PKCE S256, resource RFC 8707). Токены хранятся в каталоге
состояния SongFrame; файлы официального Kling CLI не читаются и не пишутся.
"""

import base64
import hashlib
import http.client
import json
import os
import secrets
import ssl
import sys
import threading
import time
import webbrowser
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlparse

from tools.common import local_directory, read_json, uuid7, write_json_atomic

if sys.platform == "win32":
    import msvcrt
else:
    import fcntl

TITLE = "Kling"
PROVIDER_ID = "kling"
BASE_URL = "https://kling.ai"
# Подмена адреса сервера только для тестов с локальным поддельным сервером.
BASE_URL_ENV = "SONGFRAME_KLING_BASE_URL"
DEBUG_ENV = "SONGFRAME_KLING_DEBUG_FILE"
CLIENT_NAME = "songframe"
PROTOCOL_VERSION = "2025-11-25"
DEFAULT_SCOPE = "generation.create generation.read account.credit.read"
LOGIN_PORTS = (8787, 8788, 8789, 8790)
LOGIN_TIMEOUT = 300
CALL_TIMEOUT = 60
# Платная отправка может отвечать дольше обычного вызова; обрыв по короткому таймауту дал бы неизвестный исход.
SUBMIT_TIMEOUT = 300
OAUTH_TIMEOUT = 30
DISCOVERY_TIMEOUT = 10
# Обновляем токен заранее, чтобы он не истёк по дороге к серверу.
REFRESH_MARGIN = 60
# Дополнительные заголовки MCP-запросов (например X-Kling-Cli-*), если сервер начнёт их требовать.
EXTRA_HEADERS = {}
UPLOAD_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".mp4": "video/mp4",
    ".wav": "audio/wav",
    ".mp3": "audio/mpeg",
}
UPLOAD_URL_KEYS = ("url", "file_url", "fileUrl", "resource_url", "resourceUrl")
LOGIN_REQUIRED = f"Войдите в {TITLE} на странице «Среда»."


class KlingError(Exception):
    """Общий предок ошибок клиента."""


class AuthRequired(KlingError):
    """Нет сохранённого входа или сервер отверг токен после обновления: запрос не принят."""


class NotSent(KlingError):
    """Соединение не установлено (отказ, DNS): запрос к серверу не уходил."""


class TransportError(KlingError):
    """HTTP-ошибка или обрыв после отправки; status None — ответ не получен, исход запроса неизвестен."""

    def __init__(self, status, text):
        super().__init__(f"HTTP {status}: {text}" if status is not None else text)
        self.status = status
        self.text = text


class ProtocolError(KlingError):
    """Ответ JSON-RPC с полем error или неразборчивый ответ сервера."""


class ToolError(KlingError):
    """Инструмент вернул isError: true — сервер явно отказал."""


def base_url():
    return (os.environ.get(BASE_URL_ENV) or BASE_URL).rstrip("/")


def credentials_path():
    """Записи входа живут в каталоге состояния приложения, вне проекта и вне файлов официального CLI."""
    return local_directory() / "providers" / PROVIDER_ID / "credentials.json"


def debug(event, error=None, status=None, body=None):
    """Отладка неизвестного исхода: только в явно заданный файл, без заголовков авторизации и токенов."""
    target = os.environ.get(DEBUG_ENV)
    if not target:
        return
    with open(target, "a", encoding="utf-8") as stream:
        stream.write(f"--- {event} {time.strftime('%H:%M:%S')} {type(error).__name__ if error else ''}: {error}\n")
        if status is not None:
            stream.write(f"status: {status}\n")
        if body is not None:
            stream.write(f"body: {body if isinstance(body, str) else body.decode('utf-8', 'replace')}\n")


def http_request(method, url, body=None, headers=None, timeout=CALL_TIMEOUT):
    """Один HTTP-запрос: (status, content_type, bytes).

    Сбой установки соединения — NotSent; сбой после начала отправки — TransportError без статуса.
    """
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise ValueError("Недопустимый адрес сервера.")
    if parsed.scheme == "https":
        connection = http.client.HTTPSConnection(
            parsed.hostname, parsed.port, timeout=timeout, context=ssl.create_default_context()
        )
    else:
        connection = http.client.HTTPConnection(parsed.hostname, parsed.port, timeout=timeout)
    path = (parsed.path or "/") + (f"?{parsed.query}" if parsed.query else "")
    try:
        try:
            connection.connect()
        except OSError as error:
            raise NotSent(f"Нет соединения с {TITLE}: {type(error).__name__}.") from None
        try:
            connection.request(method, path, body=body, headers=headers or {})
            response = connection.getresponse()
            data = response.read()
        except (OSError, http.client.HTTPException) as error:
            message = f"Соединение с {TITLE} прервано после отправки: {type(error).__name__}."
            raise TransportError(None, message) from None
        return response.status, response.getheader("Content-Type", "") or "", data
    finally:
        connection.close()


def json_body(data):
    try:
        return json.loads(data.decode("utf-8"))
    except (ValueError, UnicodeError):
        return None


def get_json(url, timeout=DISCOVERY_TIMEOUT):
    try:
        status, _, data = http_request("GET", url, headers={"Accept": "application/json"}, timeout=timeout)
    except KlingError:
        return None
    value = json_body(data) if status == 200 else None
    return value if isinstance(value, dict) else None


def discover(timeout=DISCOVERY_TIMEOUT):
    """Адреса OAuth: метаданные сервера поверх умолчаний; недоступные метаданные не мешают входу."""
    base = base_url()
    endpoints = {
        "authorize": base + "/auth/authorize",
        "token": base + "/auth/token",
        "register": base + "/auth/register",
        "revoke": base + "/auth/revoke",
        "resource": base + "/mcp",
        "scope": DEFAULT_SCOPE,
    }
    issuer = base + "/auth"
    resource = get_json(base + "/.well-known/oauth-protected-resource", timeout)
    if resource:
        if isinstance(resource.get("resource"), str):
            endpoints["resource"] = resource["resource"]
        servers = resource.get("authorization_servers")
        if isinstance(servers, list) and servers and isinstance(servers[0], str):
            issuer = servers[0].rstrip("/")
    parsed = urlparse(issuer)
    origin = f"{parsed.scheme}://{parsed.netloc}"
    metadata = get_json(origin + "/.well-known/oauth-authorization-server" + parsed.path, timeout)
    if metadata is None and parsed.path:
        metadata = get_json(issuer + "/.well-known/oauth-authorization-server", timeout)
    names = {
        "authorize": "authorization_endpoint",
        "token": "token_endpoint",
        "register": "registration_endpoint",
        "revoke": "revocation_endpoint",
    }
    for key, name in names.items():
        if metadata and isinstance(metadata.get(name), str):
            endpoints[key] = metadata[name]
    scopes = (metadata or {}).get("scopes_supported") or (resource or {}).get("scopes_supported")
    if isinstance(scopes, list) and scopes and all(isinstance(item, str) for item in scopes):
        endpoints["scope"] = " ".join(scopes)
    return endpoints


def oauth_post(url, fields, timeout=OAUTH_TIMEOUT):
    """POST формы к OAuth; ответ — (status, JSON или None). Тело ответа не журналируется: в нём токены."""
    headers = {"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"}
    status, _, data = http_request("POST", url, urlencode(fields).encode(), headers, timeout)
    value = json_body(data)
    return status, value if isinstance(value, dict) else None


def register(endpoints, timeout=OAUTH_TIMEOUT):
    """Динамическая регистрация публичного клиента SongFrame; секрета у клиента нет."""
    redirects = [f"http://{host}:{port}/callback" for port in LOGIN_PORTS for host in ("127.0.0.1", "localhost")]
    payload = {
        "client_name": CLIENT_NAME,
        "application_type": "native",
        "redirect_uris": redirects,
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "none",
    }
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    status, _, data = http_request("POST", endpoints["register"], json.dumps(payload).encode(), headers, timeout)
    value = json_body(data)
    if status not in (200, 201) or not isinstance(value, dict) or not isinstance(value.get("client_id"), str):
        raise TransportError(status, f"Регистрация клиента в {TITLE} не удалась.")
    return value["client_id"]


def read_credentials():
    value = read_json(credentials_path())
    return value if isinstance(value, dict) and value.get("access_token") else None


def write_credentials(record):
    """Атомарная замена; временный файл mkstemp создаётся с правами 0600 там, где ОС их поддерживает."""
    path = credentials_path()
    write_json_atomic(path, record)
    if sys.platform != "win32":
        os.chmod(path, 0o600)


@contextmanager
def credentials_lock(wait=60):
    """Межпроцессная блокировка обновления: ротируемый refresh token должен обновлять ровно один процесс."""
    path = credentials_path().with_name("credentials.lock")
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+b") as stream:
        if sys.platform == "win32":
            stream.seek(0, os.SEEK_END)
            if stream.tell() == 0:
                stream.write(b"\0")
                stream.flush()
            deadline = time.monotonic() + wait
            while True:
                stream.seek(0)
                try:
                    msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
                    break
                except OSError:
                    if time.monotonic() >= deadline:
                        raise
                    time.sleep(0.1)
        else:
            fcntl.flock(stream, fcntl.LOCK_EX)
        try:
            yield
        finally:
            if sys.platform == "win32":
                stream.seek(0)
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(stream, fcntl.LOCK_UN)


def token_record(previous, answer, now=None):
    """Новая запись по ответу token endpoint; без нового refresh token сохраняется прежний."""
    if not isinstance(answer.get("access_token"), str) or not answer["access_token"]:
        raise ProtocolError(f"{TITLE} не выдал токен доступа.")
    now = time.time() if now is None else now
    expires = answer.get("expires_in")
    record = dict(previous)
    record["access_token"] = answer["access_token"]
    if isinstance(answer.get("refresh_token"), str) and answer["refresh_token"]:
        record["refresh_token"] = answer["refresh_token"]
    record["expires_at"] = int(now + expires) if type(expires) in (int, float) and expires > 0 else 0
    if isinstance(answer.get("scope"), str):
        record["scope"] = answer["scope"]
    return record


def expiring(record):
    return bool(record.get("expires_at")) and record["expires_at"] - time.time() < REFRESH_MARGIN


def refresh(stale_token=None):
    """Обновляет токен под блокировкой; если другой процесс уже обновил его, берёт свежую запись из файла."""
    with credentials_lock():
        record = read_credentials()
        if record is None:
            raise AuthRequired(LOGIN_REQUIRED)
        if record["access_token"] != stale_token and not expiring(record):
            return record
        if not record.get("refresh_token") or not record.get("client_id"):
            raise AuthRequired(LOGIN_REQUIRED)
        fields = {
            "grant_type": "refresh_token",
            "client_id": record["client_id"],
            "refresh_token": record["refresh_token"],
        }
        if record.get("resource"):
            fields["resource"] = record["resource"]
        try:
            status, answer = oauth_post(record.get("token_endpoint") or discover()["token"], fields)
        except TransportError as error:
            # Обновление токена не отправляло вызов инструмента: для MCP-запроса это «не отправлено».
            raise NotSent(f"Не удалось обновить вход в {TITLE}: {error}") from None
        if status in (400, 401):
            raise AuthRequired(LOGIN_REQUIRED)
        if status != 200 or answer is None:
            raise NotSent(f"Не удалось обновить вход в {TITLE}: HTTP {status}.")
        record = token_record(record, answer)
        write_credentials(record)
        return record


def revoke(record):
    """Отзыв прежнего refresh token при повторном входе; сбой отзыва не мешает новому входу."""
    if not record or not record.get("refresh_token") or not record.get("client_id"):
        return
    try:
        url = record.get("revocation_endpoint") or discover()["revoke"]
        token = record["refresh_token"]
        oauth_post(url, {"token": token, "token_type_hint": "refresh_token", "client_id": record["client_id"]})
    except (KlingError, ValueError):
        pass


def pkce():
    verifier = base64.urlsafe_b64encode(secrets.token_bytes(32)).rstrip(b"=").decode()
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    return verifier, challenge


class CallbackServer(HTTPServer):
    """Loopback-сервер одного входа: ждёт /callback с тем же state."""

    # Занятый порт пропускаем: на Windows SO_REUSEADDR позволил бы занять чужой слушающий порт.
    allow_reuse_address = False

    def __init__(self, port, state):
        super().__init__(("127.0.0.1", port), CallbackHandler)
        self.state = state
        self.result = None
        self.done = threading.Event()


class CallbackHandler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        # Строка запроса содержит код авторизации; в журнал её не пишем.
        pass

    def reply(self, status, text):
        body = f"<!doctype html><meta charset='utf-8'><title>SongFrame</title><p>{text}</p>".encode()
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        url = urlparse(self.path)
        if url.path != "/callback":
            return self.reply(404, "Не найдено.")
        query = {key: values[0] for key, values in parse_qs(url.query).items()}
        if query.get("state") != self.server.state:
            return self.reply(400, "Неверный state: начните вход заново из SongFrame.")
        if query.get("error"):
            self.server.result = {"error": query.get("error_description") or query["error"]}
            self.reply(400, f"Вход в {TITLE} отменён. Вернитесь в SongFrame.")
        elif query.get("code"):
            self.server.result = {"code": query["code"]}
            self.reply(200, f"Вход в {TITLE} выполнен. Вернитесь в SongFrame.")
        else:
            return self.reply(400, "Ответ без кода авторизации.")
        self.server.done.set()


def listen(state):
    for port in LOGIN_PORTS:
        try:
            return CallbackServer(port, state)
        except OSError:
            continue
    raise NotSent("Порты входа 8787–8790 заняты: закройте программу, которая их использует, и повторите вход.")


def login(open_browser=True, timeout=LOGIN_TIMEOUT, report=None):
    """Вход в браузере: регистрация клиента, loopback, PKCE, обмен кода и замена сохранённой записи."""
    report = report or (lambda line: print(line, file=sys.stderr, flush=True))
    endpoints = discover()
    client_id = register(endpoints)
    verifier, challenge = pkce()
    state = secrets.token_urlsafe(16)
    server = listen(state)
    redirect = f"http://127.0.0.1:{server.server_address[1]}/callback"
    query = {
        "response_type": "code",
        "client_id": client_id,
        "redirect_uri": redirect,
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "scope": endpoints["scope"],
        "resource": endpoints["resource"],
    }
    url = endpoints["authorize"] + "?" + urlencode(query)
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.2}, daemon=True)
    thread.start()
    try:
        # Адрес авторизации не секретен (без кода и verifier): приложение показывает его, если браузер не открылся.
        report("AUTHORIZE_URL " + url)
        opened = False
        if open_browser:
            try:
                opened = webbrowser.open(url)
            except webbrowser.Error:
                opened = False
        if not opened:
            report("BROWSER_NOT_OPENED")
        if not server.done.wait(timeout):
            raise AuthRequired(f"Вход в {TITLE} не подтверждён в браузере за отведённое время.")
    finally:
        server.shutdown()
        server.server_close()
    if "error" in server.result:
        raise AuthRequired(f"{TITLE} отклонил вход: {server.result['error']}")
    exchange = {
        "grant_type": "authorization_code",
        "client_id": client_id,
        "code": server.result["code"],
        "code_verifier": verifier,
        "redirect_uri": redirect,
        "resource": endpoints["resource"],
    }
    status, answer = oauth_post(endpoints["token"], exchange)
    if status != 200 or answer is None:
        raise TransportError(status, f"{TITLE} не обменял код авторизации на токен.")
    client = {
        "client_id": client_id,
        "token_endpoint": endpoints["token"],
        "revocation_endpoint": endpoints["revoke"],
        "resource": endpoints["resource"],
        "scope": endpoints["scope"],
    }
    record = token_record(client, answer)
    with credentials_lock():
        previous = read_credentials()
        write_credentials(record)
    if previous and previous.get("refresh_token") != record.get("refresh_token"):
        revoke(previous)
    return record


def sse_messages(text):
    """JSON-сообщения из потока text/event-stream: строки data: одного события склеиваются."""
    messages, lines = [], []
    for line in [*text.splitlines(), ""]:
        if line.startswith("data:"):
            lines.append(line[5:].removeprefix(" "))
        elif not line and lines:
            value = json_body("\n".join(lines).encode())
            if value is not None:
                messages.append(value)
            lines = []
    return messages


def tool_body(result):
    """Тело результата tools/call: JSON из content[0].text, иначе строка; isError — отказ сервера."""
    if not isinstance(result, dict):
        raise ProtocolError(f"{TITLE} вернул неверный результат инструмента.")
    content = result.get("content")
    text = None
    if isinstance(content, list) and content and isinstance(content[0], dict):
        text = content[0].get("text")
    if result.get("isError") is True:
        raise ToolError(str(text if text is not None else "отказ без пояснения").strip()[:500])
    if "structuredContent" in result:
        return result["structuredContent"]
    if not isinstance(text, str):
        raise ProtocolError(f"{TITLE} вернул результат инструмента без текста.")
    value = json_body(text.encode())
    return text if value is None else value


def find_upload_url(value):
    if isinstance(value, dict):
        for key in UPLOAD_URL_KEYS:
            item = value.get(key)
            if isinstance(item, str) and urlparse(item).scheme in ("http", "https"):
                return item
        values = value.values()
    elif isinstance(value, list):
        values = value
    else:
        return None
    for item in values:
        found = find_upload_url(item)
        if found:
            return found
    return None


def upload_type(path):
    content_type = UPLOAD_TYPES.get(Path(path).suffix.lower())
    if content_type is None:
        raise ValueError(f"{TITLE} принимает загрузку только PNG, JPEG, MP4, WAV и MP3: {Path(path).name}.")
    return content_type


def multipart(fields, file_field, filename, content_type, data):
    boundary = "songframe-" + secrets.token_hex(16)
    quoted = filename.replace("\\", "_").replace('"', "_")
    parts = [
        f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode()
        for name, value in fields.items()
    ]
    parts.append(
        f'--{boundary}\r\nContent-Disposition: form-data; name="{file_field}"; filename="{quoted}"\r\n'
        f"Content-Type: {content_type}\r\n\r\n".encode() + data + b"\r\n"
    )
    parts.append(f"--{boundary}--\r\n".encode())
    return b"".join(parts), f"multipart/form-data; boundary={boundary}"


class Session:
    """Один initialize на экземпляр; далее вызовы инструментов по той же договорённости о протоколе."""

    def __init__(self, timeout=CALL_TIMEOUT, trace_id=None):
        self.timeout = timeout
        self.trace_id = trace_id or uuid7()
        self.protocol = None
        self.next_id = 0
        self.url = base_url() + "/mcp"

    def headers(self, token):
        headers = {
            "Authorization": "Bearer " + token,
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            **EXTRA_HEADERS,
        }
        if self.protocol:
            headers["mcp-protocol-version"] = self.protocol
        return headers

    def post(self, payload, timeout):
        """POST JSON-RPC с одним обновлением токена при 401: такой ответ означает, что запрос не принят."""
        record = read_credentials()
        if record is None:
            raise AuthRequired(LOGIN_REQUIRED)
        if expiring(record):
            record = refresh(record["access_token"])
        body = json.dumps(payload, ensure_ascii=False).encode()
        for attempt in range(2):
            headers = self.headers(record["access_token"])
            status, content_type, data = http_request("POST", self.url, body, headers, timeout)
            if status != 401:
                break
            if attempt:
                raise AuthRequired(LOGIN_REQUIRED)
            record = refresh(record["access_token"])
        if not 200 <= status < 300:
            raise TransportError(status, data.decode("utf-8", "replace").strip()[:500])
        return content_type, data

    def request(self, method, params=None, timeout=None):
        if self.protocol is None and method != "initialize":
            self.initialize()
        identifier = self.next_id
        self.next_id += 1
        payload = {"jsonrpc": "2.0", "id": identifier, "method": method, "params": params or {}}
        content_type, data = self.post(payload, timeout or self.timeout)
        if content_type.split(";")[0].strip().lower() == "text/event-stream":
            messages = sse_messages(data.decode("utf-8", "replace"))
        else:
            value = json_body(data)
            messages = value if isinstance(value, list) else [value]
        answer = next((m for m in messages if isinstance(m, dict) and m.get("id") == identifier), None)
        if answer is None:
            raise ProtocolError(f"{TITLE} не вернул ответ JSON-RPC на запрос {method}.")
        if "error" in answer:
            error = answer["error"] if isinstance(answer["error"], dict) else {}
            raise ProtocolError(f"{TITLE}: {method}: {error.get('message', 'ошибка JSON-RPC')} ({error.get('code')}).")
        return answer.get("result")

    def initialize(self):
        client = {"name": CLIENT_NAME, "version": CLIENT_NAME}
        params = {"protocolVersion": PROTOCOL_VERSION, "capabilities": {}, "clientInfo": client}
        result = self.request("initialize", params)
        version = result.get("protocolVersion") if isinstance(result, dict) else None
        self.protocol = version if isinstance(version, str) and version else PROTOCOL_VERSION
        self.post({"jsonrpc": "2.0", "method": "notifications/initialized"}, self.timeout)
        return result

    def tools(self):
        result = self.request("tools/list")
        tools = result.get("tools") if isinstance(result, dict) else None
        if not isinstance(tools, list):
            raise ProtocolError(f"{TITLE} вернул неверный список инструментов.")
        return tools

    def call(self, name, arguments=None, timeout=None, trace_id=None):
        arguments = {**(arguments or {}), "taskTraceId": trace_id or self.trace_id}
        return tool_body(self.request("tools/call", {"name": name, "arguments": arguments}, timeout))

    def upload(self, path, trace_id=None):
        """Загрузка локального файла по одноразовому тикету; результат — URL файла у сервиса."""
        path = Path(path)
        content_type = upload_type(path)
        data = path.read_bytes()
        request = {"filename": path.name, "contentType": content_type, "size": len(data)}
        ticket = self.call("file_upload", request, trace_id=trace_id)
        target = ticket.get("uploadUrl", ticket.get("upload_url")) if isinstance(ticket, dict) else None
        if not isinstance(ticket, dict) or not isinstance(ticket.get("ticket"), str) or not isinstance(target, str):
            raise ProtocolError(f"{TITLE} не выдал тикет загрузки.")
        body, multipart_type = multipart({"ticket": ticket["ticket"]}, "file", path.name, content_type, data)
        # Авторизует одноразовый тикет: токен на адрес загрузки не отправляется.
        timeout = 120 + -(-len(data) // 65536)
        status, _, answer = http_request("POST", target, body, {"Content-Type": multipart_type}, timeout)
        url = find_upload_url(json_body(answer))
        if not 200 <= status < 300 or url is None:
            raise TransportError(status, f"загрузка файла {path.name} не принята")
        return url

