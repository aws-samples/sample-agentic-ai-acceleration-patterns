# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""The runner's state and HTTP surface (spec §3.5, runner/PROTOCOL.md).

Sandbox is the state machine and has no I/O of its own: the backend setup
(sizing, cgroups, /work) comes in as a callable, and the executor runs the
job. The unit tests drive it with fakes; the Docker test with the real parts.
"""

from __future__ import annotations

import hmac
import json
import os
import re
import socket
import ssl
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Callable, Optional, Tuple

from runner import wire
from runner.job import ToolFailed, log

BACKENDS = ("microvm", "nitro", "agentcore")
# The platform's lifecycle hook paths on the hook port; the short forms (/run, ...) are served too.
HOOK_PREFIX = "/aws/lambda-microvms/runtime/v1/"
Answer = Tuple[int, dict]


class Sandbox:
    """One sandbox's runner state.

    become_tenants: called once, when the sandbox becomes one tenant's
    (microvm /run hook, nitro start, agentcore first job); returns the
    executor. It raises on failure, and the sandbox stays unclaimed.
    """

    def __init__(self, backend: str, become_tenants: Callable[[], object], nonce_hash: Optional[str] = None):
        if backend not in BACKENDS:
            raise ValueError(backend)
        self.backend = backend
        self._become = become_tenants
        self.nonce_hash = nonce_hash  # microvm: from the hook; nitro: from the environment
        self.hook_tenant: Optional[str] = None
        self.nonce: Optional[bytes] = None
        self.boot_id: Optional[str] = None
        self.executor = None
        self.dirty = False
        self.fingerprint: Optional[bytes] = None  # nitro: SHA-256 of the certificate DER
        self._state = threading.Lock()
        self._job = threading.Lock()
        self.boot_failed = threading.Event()  # microvm: a hook asked the runner to fail its start

    # Becoming one tenant's.

    def claim(self) -> None:
        """microvm and nitro: set the executor and bootId (nitro at start, microvm in the hook)."""
        self.executor = self._become()
        self.boot_id = os.urandom(16).hex()

    def hook(self, body: bytes) -> Answer:
        """microvm /run hook: the first valid one sets nonceHash; every later one changes nothing.

        The platform wraps the start call's runHookPayload as a JSON string:
        {"microvmId": ..., "runHookPayload": "<payload>"} (spike S-2). A body
        without that field is read as the payload itself.
        """
        with self._state:
            if self.nonce_hash is not None or self.boot_failed.is_set():
                return 200, {}
            try:
                obj = json.loads(body.decode("utf-8"))
                if isinstance(obj, dict) and "runHookPayload" in obj:
                    inner = obj["runHookPayload"]
                    obj = json.loads(inner) if isinstance(inner, str) else None
            except (UnicodeDecodeError, ValueError, RecursionError):
                return 400, {}
            if not isinstance(obj, dict):
                return 400, {}
            nonce_hash, tenant = obj.get("nonceHash"), obj.get("tenant")
            if obj.get("failAtBoot") is True:
                # Integration test of a failed start (ADR-0037): the runner exits, nothing is claimed.
                log("fail_at_boot")
                self.boot_failed.set()
                return 200, {}
            if not isinstance(nonce_hash, str) or not wire.HEX64.match(nonce_hash) \
                    or not isinstance(tenant, str) or not wire.TENANT_ID.match(tenant):
                return 400, {}
            try:
                self.claim()
            except Exception as e:  # the hook answers, then the runner exits, so the MicroVM ends at once
                log("claim_failed", error=type(e).__name__)
                self.executor = None
                self.boot_failed.set()  # the hook still answers 200: the platform learns of the failure from `ready` (503) and the exit
            self.nonce_hash, self.hook_tenant = nonce_hash, tenant
            log("hook_accepted")
            return 200, {}

    # The data channel.

    def _refuse(self, error: str, status: Optional[int] = None) -> Answer:
        return (status or wire.REFUSAL_STATUS[error]), wire.refusal(error, self.boot_id)

    def _may_adopt(self, nonce: bytes, tenant_id: Optional[str], session: Optional[str]) -> bool:
        """Step 2: the nonce matches the hash (microvm, nitro) or the session id is the tenant's (agentcore)."""
        if self.backend == "agentcore":
            if tenant_id is None or not isinstance(session, str) or \
                    not hmac.compare_digest(session.encode("utf-8", "replace"), wire.session_id(tenant_id).encode("ascii")):
                return False
        else:
            if self.nonce_hash is None or not hmac.compare_digest(wire.nonce_hash(nonce), self.nonce_hash):
                return False
            if self.hook_tenant is not None and tenant_id is not None and tenant_id != self.hook_tenant:
                return False
        return self.nonce is None or hmac.compare_digest(nonce, self.nonce)

    def hello(self, body: bytes) -> Answer:
        """nitro /hello: HMAC(nonce, challenge ‖ certFingerprint).

        The first /hello (the tool's `ready`) delivers the nonce. A later one
        (the tool's `run`) carries only the challenge, and the runner proves
        with the nonce it holds, so a peer at a recycled address never
        learns it (ADR-0072). Without a nonce in the body and none held, the
        answer is wrong_sandbox.
        """
        try:
            obj = wire.parse_object(body)
        except wire.Malformed:
            return self._refuse("tool_failed", wire.MALFORMED_JOB_STATUS)
        challenge = wire.decode_32(obj.get("challenge"))
        if self.backend != "nitro" or self.fingerprint is None or challenge is None:
            return self._refuse("wrong_sandbox")
        if "nonce" in obj:
            nonce = wire.decode_32(obj.get("nonce"))
            if nonce is None:
                return self._refuse("wrong_sandbox")
            with self._state:
                if not self._may_adopt(nonce, None, None):
                    return self._refuse("wrong_sandbox")
                self.nonce = nonce
        else:
            with self._state:
                if self.nonce is None:
                    return self._refuse("wrong_sandbox")
                nonce = self.nonce
        return 200, {"v": wire.PROTOCOL_VERSION, "bootId": self.boot_id, "certFingerprint": self.fingerprint.hex(),
                     "proof": wire.hello_proof(nonce, challenge, self.fingerprint)}

    def run(self, body: bytes, session: Optional[str] = None) -> Answer:
        """PROTOCOL.md order: parse, may-adopt, jobAuth under the candidate nonce, adopt, busy and dirty."""
        try:
            job = wire.parse_job(body)
        except wire.Malformed:
            return self._refuse("tool_failed", wire.MALFORMED_JOB_STATUS)
        nonce = wire.decode_32(job.nonce_text)
        if nonce is None:
            return self._refuse("wrong_sandbox")
        with self._state:
            if not self._may_adopt(nonce, job.tenant_id, session):
                return self._refuse("wrong_sandbox")
        if not job.auth_ok(nonce):
            return self._refuse("wrong_sandbox")
        with self._state:
            if not self._may_adopt(nonce, job.tenant_id, session):  # another job adopted meanwhile
                return self._refuse("wrong_sandbox")
            if self.nonce is None and self.backend == "agentcore":
                try:
                    self.claim()
                except Exception as e:
                    log("claim_failed", error=type(e).__name__)
                    return self._refuse("tool_failed")
            self.nonce = nonce
        if not self._job.acquire(blocking=False):
            return self._refuse("busy")
        try:
            if self.dirty:
                return self._refuse("dirty")
            if self.executor is None:
                return self._refuse("tool_failed")
            drained_dirty = None  # the executor's own read of the job group, polled while it drains
            swept = False  # anything but a result or a ToolFailed leaves the sweep unproven
            try:
                result = self.executor.run(job)
                swept = result["clean"]
                drained_dirty = result.get("dirty")
            except ToolFailed as e:
                swept = e.clean
                return self._refuse("tool_failed")
            finally:
                self._after_job(swept, drained_dirty)
        finally:
            self._job.release()
        stdout, stderr, truncated = wire.cut_output(result["stdout"], result["stderr"], job.max_output, result["cut"])
        return 200, {"v": wire.PROTOCOL_VERSION, "runId": job.run_id, "exitCode": result["exitCode"],
                     "stdout": stdout, "stderr": stderr, "truncated": truncated,
                     "durationMs": result["durationMs"], "timedOut": result["timedOut"],
                     "memoryExceeded": result["memoryExceeded"], "bootId": self.boot_id,
                     "proof": wire.result_proof(nonce, job.run_id)}

    def _after_job(self, swept: bool, group_dirty: Optional[bool] = None) -> None:
        """Dirty when the sweep left uid 1001 processes, or the agentcore job group did not drain.

        group_dirty is the executor's polled read; without one (a job that failed) the group is read once.
        """
        try:
            if not swept or (self.executor.dirty() if group_dirty is None else group_dirty):
                self.dirty = True
                log("dirty")
        except (OSError, ValueError) as e:
            log("dirty_check_failed", error=type(e).__name__)
            self.dirty = True

    def ping(self) -> dict:
        body = {"status": "Healthy"}
        if self.boot_id:
            body["bootId"] = self.boot_id
        return body


CHUNK_SIZE = re.compile(rb"[0-9A-Fa-f]{1,8}\Z")
CONTENT_LENGTH = re.compile(r"[0-9]{1,10}\Z")
BODY_DEADLINE_S = 30.0
HEADER_DEADLINE_S = 10.0  # the request line and every header, from the first byte the handler waits for
MAX_HOOK_BODY_BYTES = 16 * 1024  # runHookPayload is at most 4096 characters
MAX_CONNECTIONS = 4  # jobs run one at a time; this bounds threads and pre-auth memory


def _timed(handler, deadline: float, read):
    """One read with the socket timeout cut to what is left of deadline; None past it or on a socket error."""
    left = deadline - time.monotonic()
    if left <= 0:
        return None
    try:
        handler.connection.settimeout(left)
        return read()
    except OSError:
        return None


def _read_line(handler, limit: int, deadline: float) -> Optional[bytes]:
    """One framing line of at most limit bytes, one byte per read, so every read sees the deadline.

    Returns what was read at EOF (b"" at once), None past the deadline.
    """
    line = bytearray()
    while len(line) < limit:
        byte = _timed(handler, deadline, lambda: handler.rfile.read1(1))
        if byte is None:
            return None
        if not byte:
            break
        line += byte
        if byte == b"\n":
            break
    return bytes(line)


def _read_exact(handler, size: int, deadline: float) -> Optional[bytes]:
    """size bytes, one socket read at a time, or None at EOF or past the deadline."""
    parts, left = [], size
    while left:
        piece = _timed(handler, deadline, lambda: handler.rfile.read1(min(left, 65536)))
        if not piece:
            return None
        parts.append(piece)
        left -= len(piece)
    return b"".join(parts)


def read_body(handler: BaseHTTPRequestHandler, limit: int = wire.MAX_BODY_BYTES) -> Optional[bytes]:
    """The request body, Content-Length or chunked, at most limit bytes within BODY_DEADLINE_S; None when broken."""
    deadline = time.monotonic() + BODY_DEADLINE_S
    try:
        return _read_body(handler, limit, deadline)
    finally:
        try:
            handler.connection.settimeout(handler.timeout)
        except OSError:
            pass


def _read_body(handler, limit: int, deadline: float) -> Optional[bytes]:
    encoding = handler.headers.get("Transfer-Encoding")
    if encoding is not None and encoding.lower() != "chunked":
        return None  # RFC 9112 section 6.3: any other framing is refused, so the bytes after it are never read as a request
    if handler.headers.get("Transfer-Encoding", "").lower() == "chunked":
        data = bytearray()
        while True:
            line = _read_line(handler, 64, deadline)
            if line is None:
                return None
            token = line.split(b";")[0].strip()
            if not CHUNK_SIZE.match(token):
                return None
            size = int(token, 16)
            if size == 0:
                for _ in range(8):  # trailer lines, then the blank line
                    end = _read_line(handler, 1024, deadline)
                    if end is None:
                        return None
                    if end in (b"\r\n", b"\n", b""):
                        return bytes(data)
                return None
            if len(data) + size > limit:
                return None
            chunk = _read_exact(handler, size, deadline)
            if chunk is None:
                return None
            data += chunk
            if _read_line(handler, 4, deadline) not in (b"\r\n", b"\n"):
                return None
    text = handler.headers.get("Content-Length")
    if text is None:
        return b""  # RFC 9112 section 6.3: a request with no framing has a body of length zero
    if not CONTENT_LENGTH.match(text):
        return None
    length = int(text)
    if length > limit:
        return None
    return _read_exact(handler, length, deadline)


def make_handler(sandbox: Sandbox, port_role: str):
    """port_role: 'jobs' (8080 or 8443) or 'hooks' (microvm 9000)."""
    backend = sandbox.backend

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        timeout = 10  # one socket read; HEADER_DEADLINE_S and BODY_DEADLINE_S bound each phase in all
        server_version = "runner"
        sys_version = ""

        def handle_one_request(self):
            # The request line and the headers must arrive within HEADER_DEADLINE_S
            # (an idle keep-alive connection is closed then too); parse_request
            # stops the clock, and the body has its own deadline.
            self._header_clock = threading.Timer(HEADER_DEADLINE_S, self._cut)
            self._header_clock.daemon = True
            self._header_clock.start()
            try:
                super().handle_one_request()
            finally:
                self._header_clock.cancel()

        def parse_request(self):
            ok = super().parse_request()
            self._header_clock.cancel()
            return ok

        def _cut(self):
            try:
                self.connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

        def log_message(self, format, *args):  # noqa: A002 - the base class names it so
            return

        def _send(self, status: int, body: dict) -> None:
            raw = json.dumps(body, ensure_ascii=True, separators=(",", ":")).encode("ascii")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def do_GET(self):
            if port_role == "jobs" and self.path == "/ping":
                self._send(200, sandbox.ping())
            else:
                self._send(404, {})

        def do_POST(self):
            path = self.path
            body = read_body(self, MAX_HOOK_BODY_BYTES if port_role == "hooks" else wire.MAX_BODY_BYTES)
            if body is None or (port_role == "jobs" and not body):  # a job always has a body
                self.close_connection = True
                if port_role == "jobs":
                    status, answer = sandbox._refuse("tool_failed", wire.MALFORMED_JOB_STATUS)
                    self._send(200 if backend == "agentcore" else status, answer)
                else:
                    self._send(400, {})
                return
            try:
                if port_role == "hooks":
                    name = path[len(HOOK_PREFIX):] if path.startswith(HOOK_PREFIX) else path[1:]
                    if name == "run":
                        status, answer = sandbox.hook(body)
                    elif name == "ready":
                        # 200 once the runner serves and can take a job (ADR-0037); runs at image build.
                        status, answer = (503, {}) if sandbox.boot_failed.is_set() else (200, {})
                    elif name in ("suspend", "resume", "terminate"):
                        status, answer = 200, {}
                    else:
                        status, answer = 404, {}
                elif backend == "agentcore" and path == "/invocations":
                    _, answer = sandbox.run(body, self.headers.get(wire.SESSION_HEADER))
                    status = 200  # every refusal is a payload on /invocations
                elif backend != "agentcore" and path == "/run":
                    status, answer = sandbox.run(body)
                elif backend == "nitro" and path == "/hello":
                    status, answer = sandbox.hello(body)
                else:
                    status, answer = 404, {}
            except Exception as e:  # a runner fault answers tool_failed, never a stack trace
                log("handler_failed", error=type(e).__name__)
                status, answer = sandbox._refuse("tool_failed")
                if backend == "agentcore":
                    status = 200
            self._send(status, answer)

    return Handler


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._slots = threading.BoundedSemaphore(MAX_CONNECTIONS)

    def process_request(self, request, client_address):
        # A connection past MAX_CONNECTIONS is closed at once, before any byte is read.
        if not self._slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self._slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._slots.release()

    def handle_error(self, request, client_address):
        # A failed TLS handshake or a dropped connection: one line, no traceback.
        log("connection_failed")


def serve(sandbox: Sandbox, port: int, port_role: str, host: str = "0.0.0.0",  # nosec B104 - the platform reaches the runner on the sandbox address (spec 3.4)
          tls: Optional[ssl.SSLContext] = None) -> Server:
    server = Server((host, port), make_handler(sandbox, port_role))
    if tls is not None:
        # The handshake runs in the connection's own thread, on its first read.
        server.socket = tls.wrap_socket(server.socket, server_side=True, do_handshake_on_connect=False)
    threading.Thread(target=server.serve_forever, name="serve-%d" % port, daemon=True).start()
    return server
