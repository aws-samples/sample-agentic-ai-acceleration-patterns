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
| `microvm` | 8080 `GET /ping`, `POST /run`; 9000 lifecycle hooks `ready`, `run`, `suspend`, `resume`, `terminate` under `/aws/lambda-microvms/runtime/v1/` and at `/<name>` | at the first valid `run` hook |
| `nitro` | 8443 TLS: `GET /ping`, `POST /hello`, `POST /run` | at start, from `RUNNER_NONCE_HASH` |
| `agentcore` | 8080 `GET /ping`, `POST /invocations` | at the first job whose session id is the tenant's and whose `jobAuth` holds |

## Tests

`npx projen build` runs every test under `runner/tests/` (ADR-0026).
`test_linux.py` needs root and Linux privileges; outside Docker it is
skipped and unittest reports the skips. A pipeline sets
`RUNNER_REQUIRE_LINUX_TESTS=1`, which turns that skip into a failure, and runs
`npx projen test:runner:linux` (`scripts/test-runner-docker.sh`) on an x86_64 Docker host: one fresh
privileged container per test class, on the image `runner/Dockerfile`
builds (Python 3.13) and on AL2023 minimal with the pinned `python3`
package (Python 3.9). The job tests drop to `RUNNER_TEST_UID` (61001),
because `RLIMIT_NPROC` counts every process of a uid on the Docker host;
the runner entry tests run their jobs as the real uid 1001.

| Behaviour | Where it is checked |
|---|---|
| `jobAuth`, nonce hash, session id, proofs, refused encodings, refusal statuses | unit tests against `protocol/vectors.json` |
| Job parsing, output cut, sizing (A, N, L), cgroup parsers | unit tests |
| Adoption order, `busy`, `dirty`, `tool_failed` (a runner fault included), hook rules, every hook path in both forms, the wrapped `runHookPayload`, `/invocations` always 200, chunked and oversized bodies, the connection cap, TLS `/hello` and the job on one connection | unit tests, fake executor |
| The `microvm` floor and the `nitro` watchdog thresholds, mark before kill, the `agentcore` 32 MiB `dirty` threshold, the timeout rule, the file walk (links removed, not followed; the deadline) | unit tests, fake cgroup files |
| Both Dockerfiles: base pinned by digest, the runner image has no `RUN`, the MicroVM image installs one package at an exact version, every module `runner.py` imports is copied | unit tests (`test_images.py`) |
| Filter logic, both architectures | unit tests, a BPF interpreter over each program |
| Syscall numbers | unit tests against the host's kernel headers (`asm/unistd_64.h`, `asm-generic/unistd.h`) |
| the job uid, own session and process group, every rlimit soft = hard, `oom_score_adj`, `NoNewPrivs` on every backend, job environment, input written as uid 1001 through a planted link | Docker, x86_64 |
| `microvm` filter on x86_64: blocked calls `EPERM`, `clone3` fallback, threads, `subprocess` and `fork` work; `/dev/shm` locked; an allow-all filter fails closed | Docker, x86_64, Python 3.13 and 3.9 |
| `nitro` filter (SysV `EPERM`), the watchdog kills a fill above L and marks it | Docker, x86_64 |
| `agentcore` job group: setup, a kernel kill in the group is marked and the runner lives | Docker, x86_64, cgroup v2 |
| SysV, `/tmp` and `/dev/shm` sweep (links to `/etc` left alone), `/work` kept, zombies reaped, survivors killed, CPU-limit and wall timeouts, exit codes | Docker, x86_64 |
| Runner entry per backend (`microvm` hook then job, `nitro` TLS, `agentcore` session) | Docker, x86_64 |
| Forced failed start: `RUNNER_FAIL_AT_BOOT=1` on `nitro` and `agentcore`, a `failAtBoot: true` hook on `microvm` (ADR-0037) | unit tests (entry exit code, hook state), Docker (`microvm` entry exits 1) |

Not checked here: the aarch64 table in a kernel (only against the generic
header), the `microvm` floor firing on a real fill, the `agentcore` `dirty`
threshold after a real job, the real platforms' cgroup layout, hook calls
and ports, and the runner as PID 1. Those wait for the integration test.
