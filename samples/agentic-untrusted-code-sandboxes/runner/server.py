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
import ssl
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Callable, Optional, Tuple

from runner import wire
from runner.job import ToolFailed, log

BACKENDS = ("microvm", "nitro", "agentcore")
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

    # Becoming one tenant's.

    def claim(self) -> None:
        """microvm and nitro: set the executor and bootId (nitro at start, microvm in the hook)."""
        self.executor = self._become()
        self.boot_id = os.urandom(16).hex()

    def hook(self, body: bytes) -> Answer:
        """microvm port 9000 /run: the first valid hook sets nonceHash; every later one changes nothing."""
        with self._state:
            if self.nonce_hash is not None:
                return 200, {}
            try:
                obj = json.loads(body.decode("utf-8"))
            except (UnicodeDecodeError, ValueError):
                return 400, {}
            if not isinstance(obj, dict):
                return 400, {}
            nonce_hash, tenant = obj.get("nonceHash"), obj.get("tenant")
            if not isinstance(nonce_hash, str) or not wire.HEX64.match(nonce_hash) \
                    or not isinstance(tenant, str) or not wire.TENANT_ID.match(tenant):
                return 400, {}
            try:
                self.claim()
            except Exception as e:  # the hook answers; jobs then refuse with tool_failed
                log("claim_failed", error=type(e).__name__)
                self.executor = None
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
        """nitro /hello: HMAC(nonce, challenge ‖ certFingerprint)."""
        try:
            obj = wire.parse_object(body)
        except wire.Malformed:
            return self._refuse("tool_failed", wire.MALFORMED_JOB_STATUS)
        nonce, challenge = wire.decode_32(obj.get("nonce")), wire.decode_32(obj.get("challenge"))
        if self.backend != "nitro" or self.fingerprint is None or nonce is None or challenge is None:
            return self._refuse("wrong_sandbox")
        with self._state:
            if not self._may_adopt(nonce, None, None):
                return self._refuse("wrong_sandbox")
            self.nonce = nonce
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
            result = None
            try:
                result = self.executor.run(job)
            except ToolFailed:
                return self._refuse("tool_failed")
            finally:
                self._after_job(result is None or result["clean"])
        finally:
            self._job.release()
        stdout, stderr, truncated = wire.cut_output(result["stdout"], result["stderr"], job.max_output, result["cut"])
        return 200, {"v": wire.PROTOCOL_VERSION, "runId": job.run_id, "exitCode": result["exitCode"],
                     "stdout": stdout, "stderr": stderr, "truncated": truncated,
                     "durationMs": result["durationMs"], "timedOut": result["timedOut"],
                     "memoryExceeded": result["memoryExceeded"], "bootId": self.boot_id,
                     "proof": wire.result_proof(nonce, job.run_id)}

    def _after_job(self, swept: bool) -> None:
        """Dirty when the sweep left uid 1001 processes, or the agentcore job group did not drain."""
        try:
            if not swept or self.executor.dirty():
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


def read_body(handler: BaseHTTPRequestHandler) -> Optional[bytes]:
    """The request body, Content-Length or chunked, at most MAX_BODY_BYTES; None when broken or too large."""
    if handler.headers.get("Transfer-Encoding", "").lower() == "chunked":
        data = bytearray()
        while True:
            line = handler.rfile.readline(64)
            try:
                size = int(line.split(b";")[0].strip(), 16)
            except ValueError:
                return None
            if size == 0:
                while handler.rfile.readline(1024) not in (b"\r\n", b"\n", b""):
                    pass
                return bytes(data)
            if len(data) + size > wire.MAX_BODY_BYTES:
                return None
            chunk = handler.rfile.read(size)
            if len(chunk) != size:
                return None
            data += chunk
            handler.rfile.readline(4)
    try:
        length = int(handler.headers.get("Content-Length", ""))
    except ValueError:
        return None
    if not 0 <= length <= wire.MAX_BODY_BYTES:
        return None
    body = handler.rfile.read(length)
    return body if len(body) == length else None


def make_handler(sandbox: Sandbox, port_role: str):
    """port_role: 'jobs' (8080 or 8443) or 'hooks' (microvm 9000)."""
    backend = sandbox.backend

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        timeout = 30
        server_version = "runner"
        sys_version = ""

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
            body = read_body(self)
            if body is None:
                self.close_connection = True
                if port_role == "jobs":
                    status, answer = sandbox._refuse("tool_failed", wire.MALFORMED_JOB_STATUS)
                    self._send(200 if backend == "agentcore" else status, answer)
                else:
                    self._send(400, {})
                return
            try:
                if port_role == "hooks":
                    if path == "/run":
                        status, answer = sandbox.hook(body)
                    elif path in ("/suspend", "/resume"):
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

    def handle_error(self, request, client_address):
        # A failed TLS handshake or a dropped connection: one line, no traceback.
        log("connection_failed")


def serve(sandbox: Sandbox, port: int, port_role: str, host: str = "0.0.0.0",
          tls: Optional[ssl.SSLContext] = None) -> Server:
    server = Server((host, port), make_handler(sandbox, port_role))
    if tls is not None:
        # The handshake runs in the connection's own thread, on its first read.
        server.socket = tls.wrap_socket(server.socket, server_side=True, do_handshake_on_connect=False)
    threading.Thread(target=server.serve_forever, name="serve-%d" % port, daemon=True).start()
    return server
