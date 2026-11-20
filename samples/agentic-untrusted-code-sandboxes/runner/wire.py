# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""Wire protocol of the runner (runner/PROTOCOL.md): encodings, proofs, job parsing.

Pure functions only. Python 3.9 compatible, because the microvm image runs
the AL2023 python3 package.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import re
import struct
from typing import Optional, Tuple

PROTOCOL_VERSION = 1
NONCE_BYTES = 32
SESSION_HEADER = "x-amzn-bedrock-agentcore-runtime-session-id"
NONCE_HASH_ENV = "RUNNER_NONCE_HASH"

# Spec §5.1 and PROTOCOL.md RunJob.
TENANT_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}\Z")
HEX64 = re.compile(r"[0-9a-f]{64}\Z")
B64URL = re.compile(r"[A-Za-z0-9_-]*\Z")
MAX_RUN_ID_BYTES = 128
MAX_CODE_BYTES = 65536
TIMEOUT_MIN_MS = 1000
TIMEOUT_MAX_MS = 60000
# shortcut: a job the runner keeps whole in memory; the tool refuses inputs
# above its own limit first (spec §5.1), so this only bounds a broken caller.
MAX_INPUT_BYTES = 6 * 1024 * 1024
MAX_OUTPUT_BYTES = 16 * 1024 * 1024
MAX_BODY_BYTES = 9 * 1024 * 1024

REFUSAL_STATUS = {"wrong_sandbox": 403, "busy": 409, "dirty": 410, "tool_failed": 500}
MALFORMED_JOB_STATUS = 400


class Malformed(ValueError):
    """The body breaks the schema: tool_failed with HTTP 400."""


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def b64url_decode(text: object) -> Optional[bytes]:
    """Strict base64url without padding; None for anything PROTOCOL.md says to refuse."""
    if not isinstance(text, str) or not B64URL.match(text) or len(text) % 4 == 1:
        return None
    raw = base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))
    return raw if b64url(raw) == text else None


def decode_32(text: object) -> Optional[bytes]:
    raw = b64url_decode(text)
    return raw if raw is not None and len(raw) == NONCE_BYTES else None


def framed(data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + data


def nonce_hash(nonce: bytes) -> str:
    return hashlib.sha256(b"nonce" + nonce).hexdigest()


def session_id(tenant_id: str) -> str:
    return "rc-" + hashlib.sha256(tenant_id.encode("utf-8")).hexdigest()


def job_auth(nonce: bytes, run_id: str, tenant_id: str, code: bytes, input_bytes: bytes) -> str:
    digest = hashlib.sha256(framed(code) + framed(input_bytes)).digest()
    message = framed(run_id.encode("utf-8")) + framed(tenant_id.encode("utf-8")) + digest
    return b64url(hmac.new(nonce, message, hashlib.sha256).digest())


def result_proof(nonce: bytes, run_id: str) -> str:
    return b64url(hmac.new(nonce, run_id.encode("utf-8"), hashlib.sha256).digest())


def hello_proof(nonce: bytes, challenge: bytes, fingerprint: bytes) -> str:
    return b64url(hmac.new(nonce, challenge + fingerprint, hashlib.sha256).digest())


def same(a: str, b: object) -> bool:
    """Constant-time comparison of two ASCII proofs."""
    return isinstance(b, str) and hmac.compare_digest(a.encode("ascii"), b.encode("ascii", "replace"))


class Job:
    """A parsed RunJob. The nonce stays text until the may-adopt check decodes it."""

    __slots__ = ("run_id", "tenant_id", "nonce_text", "code", "input", "timeout_ms", "max_output", "job_auth")

    def __init__(self, run_id, tenant_id, nonce_text, code, input_bytes, timeout_ms, max_output, job_auth_text):
        self.run_id: str = run_id
        self.tenant_id: str = tenant_id
        self.nonce_text: str = nonce_text
        self.code: bytes = code
        self.input: bytes = input_bytes
        self.timeout_ms: int = timeout_ms
        self.max_output: int = max_output
        self.job_auth: str = job_auth_text

    def auth_ok(self, nonce: bytes) -> bool:
        return same(job_auth(nonce, self.run_id, self.tenant_id, self.code, self.input), self.job_auth)


def _int(value: object, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise Malformed(name)
    return value


def parse_object(body: bytes) -> dict:
    try:
        obj = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as e:
        raise Malformed("json") from e
    if not isinstance(obj, dict) or obj.get("v") != PROTOCOL_VERSION:
        raise Malformed("v")
    return obj


def parse_job(body: bytes) -> Job:
    """Step 1 of PROTOCOL.md: schema only. Raises Malformed."""
    obj = parse_object(body)
    run_id, tenant_id, nonce, code = obj.get("runId"), obj.get("tenantId"), obj.get("nonce"), obj.get("code")
    auth = obj.get("jobAuth")
    if not isinstance(run_id, str) or not 1 <= len(run_id.encode("utf-8", "surrogatepass")) <= MAX_RUN_ID_BYTES:
        raise Malformed("runId")
    if not isinstance(tenant_id, str) or not TENANT_ID.match(tenant_id):
        raise Malformed("tenantId")
    if not isinstance(nonce, str) or not isinstance(auth, str):
        raise Malformed("nonce")
    if not isinstance(code, str):
        raise Malformed("code")
    try:
        run_id.encode("utf-8")
        code_bytes = code.encode("utf-8")
    except UnicodeEncodeError as e:  # lone surrogates from \ud800 escapes
        raise Malformed("utf-8") from e
    if len(code_bytes) > MAX_CODE_BYTES:
        raise Malformed("code")
    input_bytes = b""
    if "input" in obj:
        text = obj["input"]
        if not isinstance(text, str):
            raise Malformed("input")
        try:
            input_bytes = base64.b64decode(text.encode("ascii"), validate=True)
        except (UnicodeEncodeError, binascii.Error) as e:
            raise Malformed("input") from e
        if len(input_bytes) > MAX_INPUT_BYTES:
            raise Malformed("input")
    timeout_ms = clamp(_int(obj.get("timeoutMs"), "timeoutMs"), TIMEOUT_MIN_MS, TIMEOUT_MAX_MS)
    max_output = _int(obj.get("maxOutputBytes"), "maxOutputBytes")
    if not 0 <= max_output <= MAX_OUTPUT_BYTES:
        raise Malformed("maxOutputBytes")
    return Job(run_id, tenant_id, nonce, code_bytes, input_bytes, timeout_ms, max_output, auth)


def clamp(value: int, low: int, high: int) -> int:
    return max(low, min(high, value))


def cut_output(stdout: bytes, stderr: bytes, limit: int, cut_before: bool = False) -> Tuple[str, str, bool]:
    """stdout and stderr together at most limit bytes, stdout cut first; then UTF-8 with replacement.

    cut_before is true when a stream was already cut while it was read.
    """
    truncated = cut_before
    if len(stdout) + len(stderr) > limit:
        truncated = True
        keep_err = min(len(stderr), limit)
        stdout = stdout[: limit - keep_err]
        stderr = stderr[:keep_err]
    return stdout.decode("utf-8", "replace"), stderr.decode("utf-8", "replace"), truncated


def refusal(error: str, boot_id: Optional[str]) -> dict:
    body = {"v": PROTOCOL_VERSION, "error": error}
    if boot_id:
        body["bootId"] = boot_id
    return body
