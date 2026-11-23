# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""The runner: one Python HTTP server in every sandbox (spec §3.5, ADR-0010, ADR-0037).

Entry point, run as PID 1 (microvm) or the container entrypoint (nitro,
agentcore): python3 -I runner.py. RUNNER_BACKEND names the backend
(ADR-0037). Standard library only, Python 3.9 compatible.
"""

from __future__ import annotations

import ctypes
import hashlib
import os
import platform
import signal
import ssl
import subprocess
import sys
import threading
import time

if __name__ == "__main__":
    # python3 -I puts neither the script directory nor the working directory
    # on sys.path; the package is this file's directory, so add its parent.
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from runner import job, sizing, wire  # noqa: E402
from runner.seccomp import Filter  # noqa: E402
from runner.server import BACKENDS, Sandbox, serve  # noqa: E402

BACKEND_ENV = "RUNNER_BACKEND"
FAIL_AT_BOOT_ENV = "RUNNER_FAIL_AT_BOOT"
HTTP_PORT, TLS_PORT, HOOK_PORT = 8080, 8443, 9000
THREAD_STACK = 2 * 1024 * 1024  # keeps the runner's address space small: the job child is a fork of it until exec
PR_SET_CHILD_SUBREAPER = 36


def become_tenants(backend: str):
    """Measure M, set up /work, /dev/shm or the cgroups, and return the executor (spec §3.5)."""
    with open("/proc/self/cgroup", encoding="ascii") as f:
        group = job.own_cgroup_dir(f.read())
    meminfo = job.read_text("/proc/meminfo")
    job.prepare_work()
    if backend == "microvm":
        size = sizing.Sizing(backend, sizing.memory_m(backend, meminfo, None))
        job.lock_dev_shm()
        executor = job.Executor(backend, size, Filter(backend, platform.machine()))
    elif backend == "nitro":
        size = sizing.Sizing(backend, sizing.memory_m(backend, meminfo, job.task_memory_max(group)))
        executor = job.Executor(backend, size, Filter(backend, platform.machine()), task_group=group)
        executor.open_watchdog()
    else:
        size = sizing.Sizing(backend, sizing.memory_m(backend, meminfo, None))
        job_group = job.prepare_agentcore_groups(group, size.l)
        executor = job.Executor(backend, size, None, job_group=job_group)
    job.log("claimed", backend=backend, m_mib=size.m >> 20, l_mib=size.l >> 20, a_mib=size.a >> 20, n=size.n)
    return executor


def tls_context():
    """nitro: a key and self-signed certificate made at start with openssl, held only in memory.

    Returns the context and the SHA-256 of the certificate DER.
    """
    made = subprocess.run(
        ["/usr/bin/openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
         "-keyout", "-", "-subj", "/CN=runner", "-days", "30"],
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=True, timeout=30)
    pem = made.stdout.decode("ascii")
    start = pem.index("-----BEGIN CERTIFICATE-----")
    end = pem.index("-----END CERTIFICATE-----") + len("-----END CERTIFICATE-----")
    fingerprint = hashlib.sha256(ssl.PEM_cert_to_DER_cert(pem[start:end])).digest()
    # load_cert_chain reads a path; a memfd keeps the key off every filesystem.
    fd = os.memfd_create("runner-tls", os.MFD_CLOEXEC)
    try:
        os.write(fd, made.stdout)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.minimum_version = ssl.TLSVersion.TLSv1_3
        context.load_cert_chain("/proc/self/fd/%d" % fd)
    finally:
        os.close(fd)
    return context, fingerprint


def own_process_setup() -> None:
    """Orphans of a job come back to the runner, and the runner tries to stay out of the kernel's way."""
    libc = ctypes.CDLL(None, use_errno=True)
    libc.prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0)
    try:
        job.write_text("/proc/self/oom_score_adj", "-1000")
    except PermissionError:
        pass  # no CAP_SYS_RESOURCE on any backend; the design relies on neither score (spec §3.5)
    threading.stack_size(THREAD_STACK)


def main() -> int:
    backend = os.environ.get(BACKEND_ENV, "")
    nonce_hash = os.environ.pop(wire.NONCE_HASH_ENV, None)  # never handed to code
    if backend not in BACKENDS:
        job.log("bad_backend")
        return 1
    if backend != "microvm" and os.environ.get(FAIL_AT_BOOT_ENV) == "1":
        job.log("fail_at_boot")  # integration test of a failed start (ADR-0037)
        return 1
    own_process_setup()
    stop = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stop.set())

    if backend == "nitro":
        if nonce_hash is None or not wire.HEX64.match(nonce_hash):
            job.log("bad_nonce_hash")
            return 1
        sandbox = Sandbox(backend, lambda: become_tenants(backend), nonce_hash=nonce_hash)
        try:
            sandbox.claim()
            context, sandbox.fingerprint = tls_context()
            # Last, so the TLS libraries are mapped too. The task definition raises memlock; a task without it
            # does not start, rather than run a runner a memory fill can stall (ADR-0074).
            job.lock_memory()
        except Exception as e:  # a nitro task that cannot claim itself ends, and the start fails
            job.log("start_failed", error=type(e).__name__)
            return 1
        serve(sandbox, TLS_PORT, "jobs", tls=context)
    else:
        sandbox = Sandbox(backend, lambda: become_tenants(backend))
        serve(sandbox, HTTP_PORT, "jobs")
        if backend == "microvm":
            serve(sandbox, HOOK_PORT, "hooks")
    job.log("listening", backend=backend)
    while not stop.wait(0.2):
        if sandbox.boot_failed.is_set():
            time.sleep(0.5)  # lets the hook answer go out before the process ends
            return 1
    if sandbox.executor is not None:
        sandbox.executor.kill_all()
    job.log("stopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
