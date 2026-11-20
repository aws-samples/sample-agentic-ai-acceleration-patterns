<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# Runner

The program that runs inside every sandbox (spec §3.5, ADR-0010). Python
standard library only, Python 3.9 or later (the `microvm` image runs the
AL2023 `python3` package). The wire protocol is in [PROTOCOL.md](PROTOCOL.md).

| File | Holds |
|---|---|
| `runner.py` | entry point: reads `RUNNER_BACKEND` (ADR-0037), sets up the backend, serves |
| `server.py` | the state machine (nonce adoption order, refusals, `bootId`) and the HTTP surface per backend |
| `wire.py` | encodings, `jobAuth` and proofs, job parsing, the output cut |
| `job.py` | the job child as uid 1001, timeouts, the `microvm` floor and the `nitro` watchdog, the sweep and reaping, the `agentcore` cgroups |
| `sizing.py` | M, L, A and N per backend, and the `/proc` and cgroup file parsers |
| `seccomp.py` | the `microvm` and `nitro` filters, one table per architecture, installed with `ctypes` |
| `Dockerfile` | the `nitro` and `agentcore` image (COPY only) |
| `microvm/Dockerfile` | the `microvm` image code artifact |

| Backend | Ports | Becomes one tenant's |
|---|---|---|
| `microvm` | 8080 `GET /ping`, `POST /run`; 9000 lifecycle hooks `/run`, `/suspend`, `/resume` | at the first valid `/run` hook |
| `nitro` | 8443 TLS: `GET /ping`, `POST /hello`, `POST /run` | at start, from `RUNNER_NONCE_HASH` |
| `agentcore` | 8080 `GET /ping`, `POST /invocations` | at the first job whose session id is the tenant's and whose `jobAuth` holds |

## Tests

`npx projen build` runs every test under `runner/tests/` (ADR-0026).
`test_linux.py` needs root and Linux privileges; outside Docker it is
skipped and unittest reports the skips. Run it with
`scripts/test-runner-docker.sh` on an x86_64 Docker host: one fresh
privileged container per test class, on the image `runner/Dockerfile`
builds (Python 3.13) and on AL2023 minimal with the pinned `python3`
package (Python 3.9).

| Behaviour | Where it is checked |
|---|---|
| `jobAuth`, nonce hash, session id, proofs, refused encodings, refusal statuses | unit tests against `protocol/vectors.json` |
| Job parsing, output cut, sizing (A, N, L), cgroup parsers | unit tests |
| Adoption order, `busy`, `dirty`, `tool_failed`, hook rules, `/invocations` always 200, chunked bodies, TLS `/hello` and the job on one connection | unit tests, fake executor |
| Filter logic, both architectures | unit tests, a BPF interpreter over each program |
| Syscall numbers | unit tests against the host's kernel headers (`asm/unistd_64.h`, `asm-generic/unistd.h`) |
| uid 1001, own session and process group, every rlimit soft = hard, `oom_score_adj`, job environment, input written as uid 1001 through a planted link | Docker, x86_64 |
| `microvm` filter on x86_64: blocked calls `EPERM`, `clone3` fallback, threads, `subprocess` and `fork` work; `/dev/shm` locked; an allow-all filter fails closed | Docker, x86_64, Python 3.13 and 3.9 |
| `nitro` filter (SysV `EPERM`), the watchdog marks then kills | Docker, x86_64 |
| `agentcore` job group: setup, a kernel kill in the group is marked and the runner lives | Docker, x86_64, cgroup v2 |
| SysV, `/tmp` and `/dev/shm` sweep, `/work` kept, zombies reaped, survivors killed, timeout, exit codes | Docker, x86_64 |
| Runner entry per backend (`microvm` hook then job, `nitro` TLS, `agentcore` session) | Docker, x86_64 |

Not checked here: the aarch64 table in a kernel (only against the generic
header), the `microvm` floor firing, the `agentcore` `dirty` threshold
after a real job, the real platforms' cgroup layout and ports, and the
runner as PID 1. Those wait for the integration test.
