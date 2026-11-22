<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# Implemented architecture

**Status:** Implemented; verified except the teardown step. Last
integration run: **2026-11-21, `eu-central-1`, run 14**, on commit
`5e8c213` (`npx projen integ`). Every step of the spec §8 integration test passed on all three
backends except `teardown`. Deploy took 1132 s. The teardown ended
`DELETE_FAILED` on two leftover Lambda network interfaces in the tool
subnets, which hold the subnets and the tool security group; the README's
Known limitations section gives the symptom and the commands that finish
the delete. The one clean teardown was run 9 (`eu-central-1`, destroy
2422 s).

| Coverage of run 14 | Result |
| --- | --- |
| Build, synth, seed (`standalone-build`, `synth`, `seed`) | The packed core installs, compiles and synthesises with no `agentic-runtime-isolation` in its tree; two construct instances in one stack have unique names; the seed data is in place |
| Cold and warm runs (`parse`, `reuse`) | All three backends. Cold: `microvm` 10.6 s, `nitro` 31.7 s, `agentcore` 7.5 s. Warm: 406 to 568 ms. `parse` also ran once through the sample agent on `microvm` |
| Tenant separation (`apart`, `race`, `prefix`, `iam-wall`) | B does not see A's files; two concurrent first calls start one sandbox; path-escape names are refused; IAM simulation denies another tenant's object, row and task |
| Limits and boundary (`limits`, `no-credentials`, `no-egress`, `dns`, `runaway`) | All three backends. `agentcore` is included in `runaway` |
| Session files (`session-files`) | `agentcore` with `sessionFiles`: own prefix allowed, another tenant's denied |
| Entries (`standalone`, `forged`) | The standalone function with and without an invoke grant; a forged tenant context returns `context_invalid` |
| Lifecycle (`dead-handle`, `recycled-address`, `idle`, `max-life`, `microvm-stop`, `cold-from-zero`, `failed-start`, `offboard`) | Dead handle on all three; the others on the backend each names. `nitro` start from zero instances took 37 s against the 300 s cap; `microvm` ended out of band reads `TERMINATED` |
| Telemetry (`telemetry`, `dns-platform`) | One tool line per call with the fixed fields; no blocked lookup of a platform name outside the allow list |
| `teardown` | Failed: `DELETE_FAILED` on two Lambda network interfaces (above) |

Runs 12 and 13 cover the other two Regions. Run 12 (`us-east-1`, commit
`9702bf0`) passed every step except the teardown, a `no-credentials`
lookup on `microvm` that had no answer and did not repeat in runs 13 and
14, and `runaway` on `agentcore`, where the session after the `memfd`
kill was marked dirty by reclaimable slab, which the dirty read at
`5e8c213` leaves out; its DNS Firewall steps `dns` and
`dns-platform` passed there. Run 13 (`eu-west-1`, commit `4795e7e`) passed
every step except one check in `runaway` (the boot id baseline, read in
the test after the session had idled out); run 14 on the final code commit
passes that check. Run 13 also ended
`DELETE_FAILED` on the same two interfaces. Deploys of the integration
stack took 1123 to 1328 s across runs 5 to 14.

The demo stack (`src/main.ts`, `backends=microvm`, `standalone=true`) was
deployed on 2026-11-22 in `eu-west-1` in 635 s; `scripts/demo.sh` passed
its seven steps, the published parameter read back with every field, and
the stack deleted cleanly in 1374 s.

## Purpose

One `run_code` tool runs Python that an agent or a tenant wrote, for one
tenant at a time, in a virtual machine that belongs to that tenant. The
vendor chooses the boundary at deploy time: a Lambda MicroVM (`microvm`), a
Nitro Sandbox task on Amazon ECS Managed Instances (`nitro`), or a session
on a second AgentCore Runtime (`agentcore`) (ADR-0001, ADR-0002). A
deployment enables one or more; the tool contract is the same on each.

The tool, not the sandbox, chooses the tenant. It fetches the input with
the tenant's own credentials, starts or reuses the tenant's sandbox, hands
it the code and the input bytes, and returns the output. The sandbox sees
one tenant's bytes, has no route to the internet, and holds no AWS
credentials except, on `agentcore`, the narrow runtime role the service
requires (ADR-0003, ADR-0006).

Pool for the tool, the registry and the capacity; bridge for compute. Each
tenant gets its own VM per enabled backend on shared infrastructure. The
MicroVM image, the task definition and the second runtime are shared
definitions; only running instances belong to a tenant (ADR-0005).

The sample does not provide egress allowlists, confidential mode, EKS, GPU,
languages other than Python 3, per-tenant sandbox sizes, or deletion of a
tenant's input, output and session objects on offboarding. With
`dnsFirewall` off, DNS lookups resolve public names from every sandbox
(threats T-29, T-91).

## Actors and identity

| Actor | Role |
| --- | --- |
| Vendor | Deploys the construct, owns the AWS account and the tools gateway, and calls `offboardTenant` from its tenant delete script |
| Tenant | Owns `inputs/<tenant>/` and `outputs/<tenant>/` and one sandbox per backend; reaches the tool through the vendor's agent or API |
| Tenant's code | Runs inside the sandbox as uid 1001; reaches only its reply to the tool and the paths listed under Network |

Two entries lead to the same run logic, `runCode` in `src/tool/run-code.ts`
(ADR-0017):

| Entry | Import | Where the tenant id comes from |
| --- | --- | --- |
| Gateway entry | `RunCodeToolTarget` from the `gateway` subpath; depends on `agentic-runtime-isolation` as an optional peer dependency | The signed tenant context that the tools gateway attaches and `toolHandler` verifies. The handler refuses a `tenantId` argument and any argument the tool does not declare, and refuses a verified id that breaks the tenant id rule with `context_invalid` (ADR-0055) |
| Core entry | `UntrustedCodeSandboxes` from the package root; imports nothing from the producer | The vendor's own API calls `runCodeFunction` with IAM (`standalone: true`) and passes a `tenantId` it verified with its own identity provider. Who may invoke the function is the vendor's to limit (T-82) |

A core construct with neither `standalone` nor a bound `RunCodeToolTarget`
fails synth, so a gateway-only deployment has no unsigned entry. A lint rule
and `test/import-graph.test.ts` fail the build if the core entry reaches a
producer module.

Credentials follow the tenant. After validation, `runCode` assumes the tool
tenant role once per tenant with `sts:AssumeRole` and `sts:TagSession`,
carrying the session tag `TenantId` (900 s sessions, cached in the warm
function until two minutes before expiry). That role reads `inputs/<t>/*`,
writes `outputs/<t>/*`, reads and writes only `TENANT#<t>` registry rows
(`dynamodb:LeadingKeys`), and on `nitro` starts and stops only tasks tagged
`<t>` (ADR-0014, ADR-0030, ADR-0048). The `microvm` and `agentcore` start,
call and stop actions take no tenant condition key, so the tool role holds
them on the image or runtime and the tenant filter is code (ADR-0040,
ADR-0050).

## Components

| Component | Resource | Notes |
| --- | --- | --- |
| Tool function | Lambda, Node.js 24, arm64, 512 MiB | The gateway function (`RunCodeToolTarget`) and, with `standalone`, `runCodeFunction`. Both run as the one shared tool role, in the tool subnets, with the construct's environment and a log group the construct owns. Timeout = 5 s + `startWait` + `runTimeout` + 10 s (60 s with the defaults), at most 120 s for the core function and 90 s behind the gateway (ADR-0056) |
| Registry | DynamoDB, on-demand, point-in-time recovery, TTL on `ttlAt` | One row per tenant per backend (ADR-0005) |
| Input bucket | S3, SSE-S3, TLS only, public access blocked | `inputs/<tenant>/`, `outputs/<tenant>/`, and `sessions/<id>/` with `agentcore.sessionFiles`. A supplied `inputBucket` replaces it |
| Runner repository | ECR, immutable tags, scan on push | Present with `nitro` or `agentcore`. The construct copies the runner image into it for each architecture a backend asks for (ADR-0024, ADR-0037) |
| Backends | One `BackendConstruct` and one run-time `SandboxBackend` per name | The core writes no backend-specific action; each backend contributes resources, statements, environment, endpoints and drain order (ADR-0025, ADR-0002) |
| Runner | Python program in every sandbox | See Runner below |
| Reaper | Lambda, 256 MiB, 4 min, EventBridge `rate(5 minutes)` | Runs as the reaper role (ADR-0011, ADR-0034) |
| Offboard | Lambda `offboardTenant`, 256 MiB, 2 min | Runs as the reaper role (ADR-0035) |
| Drain | Lambda, 15 min, behind a custom resource provider | Runs as the drain role; the only role with instance actions (ADR-0011, ADR-0049) |
| Log drain, log cleanup | Custom resources | Wait 90 s on delete before log groups go; delete groups the services create (ADR-0029, ADR-0054) |
| Contributor Insights | Three `CfnInsightRule`s | Runs by tenant, sandbox seconds by tenant, and with the firewall blocked lookups by source address (ADR-0031) |
| DNS Firewall | Optional, see Network | `dnsFirewall` (ADR-0016) |

The construct's read-only properties are `runCodeFunction` (with
`standalone`), `registryTable`, `inputBucket`, `runnerRepository`,
`toolRole`, `toolTenantRole`, `offboardFunction`, `vpc`, `dnsFirewall`,
`environment`, `config`, `backends`, and per backend the image, cluster,
task definition or runtime ARN in `backendOutputs`. The construct writes no
SSM parameter; the demo stack writes one JSON parameter,
`/application-plane/shared/code-sandbox/sandboxes`, from these properties
(ADR-0069, spec §6.3).

### Roles

| Role | Holds | Does not hold |
| --- | --- | --- |
| Tool role | `sts:AssumeRole` and `sts:TagSession` on the tool tenant role; per backend: MicroVM run, get, terminate and auth token on the image, `lambda:PassNetworkConnector` on `HTTP_INGRESS` and the sample's connector only; `ecs:DescribeTasks` on the cluster's tasks; `InvokeAgentRuntime` and `StopRuntimeSession` on the runtime | Direct access to the bucket or the registry; `ecs:RunTask` and `ecs:StopTask` |
| Tool tenant role | `inputs/${TenantId}/*` read, `outputs/${TenantId}/*` write, registry `GetItem`, `PutItem`, `UpdateItem` on `TENANT#${TenantId}` rows; `nitro`: `RunTask` on the pinned task definition revision with the request tag and cluster conditions, `TagResource` at `RunTask`, `StopTask` with the resource tag condition, `PassRole` on the execution role | Any key without its own tag; `DeleteItem` |
| Reaper role | Registry `GetItem`, `Scan`, `UpdateItem`, `DeleteItem`; stop actions per backend (`ListTasks`, `DescribeTasks`, `StopTask`; `ListMicrovms`, `GetMicrovm`, `TerminateMicrovm`; `StopRuntimeSession`) | The input bucket; every instance action |
| Drain role | The reaper role, plus `ecs:ListContainerInstances`, `DeregisterContainerInstance`, `DescribeContainerInstances` and `ec2:DescribeInstances` | The input bucket |
| Task execution role (`nitro`) | ECR token and pull on the runner repository, Logs write on the task log group | Anything reachable by sandboxed code (the task has no task role) |
| Runtime role (`agentcore`) | ECR token and pull, own log group prefix `/aws/bedrock-agentcore/runtimes/<runtimeName>-*`; with `sessionFiles`, `sessions/${aws:AgentCoreRuntimeSourceSid}/*` | Everything else (ADR-0051) |
| Image copy role (the ECR deployment library's provider) | The library's ECR write and S3 read, to copy the runner image into the runner repository | ECR write outside the runner repositories, the input bucket, log group creation (explicit denies) |
| MicroVM image build role, connector operator role | Read the runner artifact and write the build log; create and tag the connector's network interfaces in the sandbox subnets (ADR-0068) | Everything else |

### Backends

| | `microvm` | `nitro` | `agentcore` |
| --- | --- | --- | --- |
| Boundary | A Lambda MicroVM per tenant, from one ARM_64 image on base `al2023-1` at a fixed base version, built from a staged artifact (ADR-0042) | An ECS task per tenant with `IsolationMode: ISOLATED_SANDBOX` on a Managed Instances capacity provider with Nitro Enclaves enabled; task definition in L1, no task role (ADR-0046) | One session per tenant on one AgentCore Runtime V2 container runtime in VPC mode (ADR-0053) |
| Start | `RunMicrovm` with no execution role, the sample's VPC connector as the only egress connector, `HTTP_INGRESS` as ingress, `maximumDurationInSeconds` = `sandboxMaxLife`, an idle policy that suspends at `sandboxIdle` and ends 1800 s later, logging disabled, and a `runHookPayload` with the nonce hash and tenant (ADR-0041) | `RunTask` with the tool tenant role, sandbox subnets, the task security group, no public address, tag `TenantId`, and a container override carrying `RUNNER_NONCE_HASH` | None. The session starts on the first `InvokeAgentRuntime`; the handle is made in code |
| Idempotency | `clientToken` = first 32 hex characters of SHA-256(`"start"` and the nonce) | The same token | not applicable |
| Address | MicroVM endpoint on the platform domain, a fresh auth token per call (5 minutes, port 8080 only) | Task private IP from the task's ENI, read on every probe, port 8443 over TLS | The runtime ARN; session id `rc-` + SHA-256(tenant id) (ADR-0009) |
| Ready | `GetMicrovm` then `/ping` with a `bootId` | `DescribeTasks` `RUNNING`, then `/hello` | Always ready (ADR-0052) |
| Start cap | 20 s | 300 s | 30 s |
| Idle and life | The platform suspends at `sandboxIdle` and ends it at `sandboxMaxLife` or after 30 suspended minutes | The reaper stops it after `sandboxIdle` unused and when the task's own `startedAt` is older than `sandboxMaxLife` | The runtime's `idleRuntimeSessionTimeout` = `sandboxIdle` and `maxLifetime` = `sandboxMaxLife` |
| Stop | `TerminateMicrovm` | `StopTask` (a stopping task stays listed for about a minute and counts as live, ADR-0049) | `StopRuntimeSession` |
| Tenant condition in IAM | None; filtered by code | Enforced by the `TenantId` tag | None; the session id is derived by code and refused if it is not the handle's tenant's |
| Credentials in the sandbox | None | None | The runtime role's, through the metadata service |
| Orphan sweep | `ListMicrovms` filtered by image; no tags, so an orphan's tenant is `unknown` | `ListTasks` and `DescribeTasks` with tags; tenant from the `TenantId` tag | None: no API lists sessions |

`agentcore` invokes with one attempt only, because a retried invoke could
run the code twice; a `RetryableConflictException` is read as `busy`
(ADR-0052). `nitro` treats a connection that fails after `/hello` as no
answer, never as a dead handle, for the same reason (ADR-0047).

### Runner

One Python program (`runner/`) serves all three backends; `RUNNER_BACKEND`
selects its setup and an unknown value makes it exit at start (ADR-0037).
It runs as root and never runs tenant code as root. The wire encodings are
fixed in `runner/PROTOCOL.md` and tested on both sides against one vector
file (ADR-0025).

- **Identity.** The tool makes a 32-byte nonce per start. Start calls carry
  only SHA-256(`"nonce"` and the nonce); the nonce itself travels on the
  data channel with every job (ADR-0018). Every job carries `jobAuth`, an
  HMAC over the run id, tenant id, code and input; the runner checks it
  before it writes the input or starts code and refuses a mismatch with
  `wrong_sandbox`. Every result carries HMAC(nonce, run id), which the tool
  checks. On `agentcore` the runner adopts a nonce only when the session id
  header equals the session id of the job's tenant. On `nitro` the tool
  also runs a `/hello` challenge on the same pinned TLS connection that
  carries the job (ADR-0047).
- **Code runs as uid 1001**, in a new process group, with `RLIMIT_CPU`,
  `RLIMIT_FSIZE`, `RLIMIT_NPROC`, `RLIMIT_NOFILE` and `RLIMIT_AS` set
  soft equal to hard, the address space cap last (ADR-0010, ADR-0038). One
  job runs at a time; a second is refused with `busy`.
- **After every job** the runner kills the process group and every uid
  1001 process, deletes uid 1001 files under `/tmp` and `/dev/shm`, removes
  SysV objects, and reaps children, inside one 3 s budget. A step the
  budget cuts short, or a survivor, marks the runner `dirty`, and a `dirty`
  runner refuses every later job (ADR-0021, ADR-0064).
- **Memory caps differ per backend** (ADR-0019, ADR-0022). `microvm`: each
  process has 256 MiB of address space, N = ⌊0.6 × memory ÷ 256 MiB⌋
  processes, a seccomp filter that closes the routes the rlimits do not
  count, and a free-memory floor polled every 50 ms with a 512 MiB
  threshold (ADR-0020). `nitro`: the platform's task limit, a watchdog every
  200 ms on the task group's memory less file cache, address space of L − 64
  MiB, and a smaller seccomp filter against SysV IPC (ADR-0021). `agentcore`:
  one cgroup v2 job group with the memory limit and `memory.oom.group` set,
  and a 32 MiB drain check after each sweep.
- **Ports.** 8080 (HTTP) on `microvm` and `agentcore`, 8443 (TLS) on
  `nitro`, and on `microvm` 9000 for the lifecycle hooks, which accept the
  nonce hash once and serve no jobs.

### Network

One VPC in two AZs (unless `vpc` is supplied), one NAT gateway, flow logs
for rejected traffic with one month of retention (ADR-0012).

| Subnets | Routes | Hold |
| --- | --- | --- |
| Public (`/24`) | Internet gateway | The NAT gateway only |
| Tool (`/22`) | Default route to the NAT | The tool, reaper, drain and offboard functions; the ECS instances' primary ENIs |
| Sandbox (`/22`, isolated) | Local only: no default route | `nitro` task ENIs, `agentcore` runtime ENIs, the `microvm` connector |

A supplied VPC names its subnet groups `Tool` and `Sandbox`; the construct
selects by group name (ADR-0027) and requires an explicit `createEndpoints`
choice, because the interface endpoints use private DNS for the whole VPC
(ADR-0065, T-92).

| Endpoint | Present for | Policy names |
| --- | --- | --- |
| S3 gateway (sandbox route table only) | `agentcore` | The ECR layer bucket; with `sessionFiles`, the input bucket's `sessions/` prefix |
| ECR `api` and `dkr` | `agentcore` | The runner repository |
| CloudWatch Logs | `nitro`, `agentcore` | The task log group; the runtime's log group prefix |

Every endpoint class has its own security group with no egress, admitting
443 from the client groups (ADR-0028, ADR-0067). The `microvm` connector
group has no egress at all. A `nitro` task group admits 8443 from the tool
group and has egress to the Logs endpoint only. The `agentcore` runtime
group has egress to the ECR and Logs endpoints and, on 443, to the S3
prefix list (`s3PrefixListId`) or, with the created VPC, to any address
that VPC routes only to the gateway endpoint. No group admits another
sandbox, so sandboxes cannot reach each other.

The tool reaches MicroVM endpoints, AWS APIs and the AgentCore data plane
through the NAT. The tool subnets also hold the instances that pull the
runner image; the endpoint policies admit that pull on either path.

**Optional DNS Firewall** (`dnsFirewall`, only with the created VPC,
ADR-0016). One rule group is associated with the VPC at priority 101: ALLOW
at priority 100 for `amazonaws.com`, `*.amazonaws.com`, `*.on.aws`,
`*.api.aws`, `time.aws.com`, `*.compute.internal`, `*.ec2.internal` and the
vendor's `allowDomains`; BLOCK at priority 200 for `*` with `NXDOMAIN`.
Mutation protection is off so a delete can remove the association. The
construct sets no fail-open property, so the service default (closed) holds
and a firewall fault blocks lookups (ADR-0031). Resolver query logs go to a
log group the construct owns, written under a Logs resource policy the
construct also owns. Every blocked lookup carries `srcaddr`, `query_name`
and `firewall_rule_action` = `BLOCK`.

## Data model

The registry table has partition key `PK` (`TENANT#<tenantId>`) and sort key
`SK` (`SANDBOX#<backend>`) (ADR-0005). A key of `TENANT#tenant-a` never
matches `tenant-a2`.

| Attribute | Value |
| --- | --- |
| `handle` | MicroVM id, task ARN or session id; absent on a row whose start died before it recorded one |
| `address` | MicroVM endpoint, task private IP or runtime ARN |
| `nonce` | 32 random bytes, base64url; unique per start |
| `bootId` | The runner's boot id (32 hex characters), from the first successful ready check or result |
| `state` | `STARTING`, `READY`, `STOPPING` or `FAILED` |
| `retryAt` | Epoch ms; a `FAILED` row is not taken over before it (30 s after the failure) |
| `createdAt`, `lastUsedAt`, `leaseUntil` | Epoch ms; `leaseUntil` = start + the backend's start cap while `STARTING` |
| `suspendedMs` | `microvm` only; estimated suspended time so far |
| `expiresAt` | `createdAt` + `sandboxMaxLife` |
| `ttlAt` | `expiresAt` + 1 h, epoch seconds; the TTL attribute, a backstop for a reaper that stopped |
| `version` | Incremented on every write |
| `replaces`, `replacesLined` | The handle a takeover replaced until it is stopped, and whether its stop line is written (ADR-0034) |

Every write is conditional and names the row's `version` and `nonce`, so a
row deleted and recreated is never written by a caller that read the old
row. A method that loses a race returns a value, not an exception, and the
caller reads again (ADR-0032). A row with no valid `state` is treated as
missing.

Per call, `runCode` follows these steps (`src/tool/run-code.ts`):

1. Read the row. `READY` and unexpired: run. `STARTING` with a handle:
   probe `ready`, waiting up to `startWait` once per call, else return
   `sandbox_starting`. A start that ended before its first successful check,
   or ran past its start cap, becomes `FAILED` with `retryAt`. `FAILED`
   before `retryAt`: `sandbox_failed`. Missing, expired, `STOPPING` and
   handle-less rows go to step 2.
2. Take over: write a `STARTING` row with a new nonce if the row is missing
   or still at the version read. The winner stops the replaced handle,
   starts, records the handle and probes.
3. Run. A failed identity check, a `wrong_sandbox` or `dirty` refusal, a
   missing MicroVM or a refused connection marks the handle dead and goes to
   step 2 once; a second dead handle fails the row. A different `bootId`
   means the sandbox restarted and the call reports `sandbox` = `started`.
4. Move `lastUsedAt` forward to the end of the run, only on the same `READY`
   handle and only if it is later.
5. If the runner does not answer by `runTimeout` + 5 s, set `STOPPING`,
   stop the sandbox and return `timedOut`.

The tool writes rows with the tool tenant role; the reaper, drain and
offboard function write with the reaper role.

**Objects.** `inputs/<tenantId>/<name>` is read by the tool with the tenant's
credentials after a `HeadObject` size check and with `IfMatch` on the read.
`outputs/<tenantId>/<runId>.json` is written when `saveOutput` is set.
`sessions/<sessionId>/*` belongs to `agentcore` code with `sessionFiles`; one
prefix per tenant, because the session id derives from the tenant, and it
survives offboarding (ADR-0007).

## Tool API

### `run_code`

| Field | Type | Required | Rule |
| --- | --- | --- | --- |
| `tenantId` | string | Core entry only | `[A-Za-z0-9][A-Za-z0-9_-]{0,63}`; the gateway entry takes it from the signed context and refuses an argument of that name |
| `code` | string | Yes | At most 64 KiB UTF-8; a lone surrogate is refused |
| `input` | string | No | Object name under the tenant's `inputs/`; `[A-Za-z0-9._/-]{1,256}`, no `..`, no leading `/` |
| `backend` | string | No | An enabled backend; default `defaultBackend` |
| `saveOutput` | boolean | No | Also write the result to `outputs/` |

The output carries `runId`, `backend`, `exitCode`, `stdout`, `stderr`,
`truncated`, `timedOut`, `memoryExceeded`, `durationMs` and `sandbox`
(`started` or `reused`). `stdout` and `stderr` together are at most
`maxOutputBytes` (stdout cut first); the tool also bounds their JSON-encoded
size at 5 MiB, so an answer fits the 6 MB Lambda response limit
(ADR-0063). A script that exits non-zero, times out or is killed returns a
result, not an error. A run the tool ended by stopping the sandbox returns
`exitCode` -9 and `timedOut` true.

A tool error is returned as a value, `{ error, retryAfterSeconds? }`, never
thrown, so the code reaches the caller (ADR-0032).

| Code | Retry | When |
| --- | --- | --- |
| `context_invalid` | No | Gateway entry: the signed context failed verification, or the verified tenant id breaks the tenant id rule |
| `invalid_argument` | No | A field breaks its rule, or the gateway entry sees an undeclared argument or a `tenantId` argument |
| `input_not_found` | No | No such object under the tenant's prefix; S3 answers 403 for a missing key without list rights, so both map here |
| `input_too_large` | No | The object exceeds `maxInputBytes`, decided from its size before any sandbox starts |
| `backend_disabled` | No | `backend` names a backend that is not deployed |
| `sandbox_starting` | After `retryAfterSeconds` (5 s, or 1 s when the row just moved) | The tenant's sandbox is still starting, or the call lost its races |
| `sandbox_busy` | Yes | The sandbox is running another job |
| `sandbox_failed` | After `retryAfterSeconds` (up to 30 s, the time left before `retryAt`) | The sandbox ended before it served, or died on two attempts |
| `tool_failed` | No | Any other fault |

The runner's `wrong_sandbox` and `dirty` refusals never reach a caller; the
tool treats them as a dead handle.

### `offboardTenant`

A Lambda function the vendor invokes with IAM and `{ "tenantId": "…" }`
(ADR-0035). For each enabled backend it sets the tenant's row `STOPPING`
at the version read, stops the sandbox, writes its stop line and deletes
the row; a row whose sandbox is still listed after the stop (a `nitro`
task for up to about 78 s, an `agentcore` session always) stays
`STOPPING`; the reaper deletes it once the sandbox has left the list (on
`agentcore`, once the row expires). The answer is `{ tenantId,
stopped: [{ backend, handle }] }`. It is idempotent: a repeat call stops
nothing new and returns the same shape. A bad tenant id, or a sandbox that
could not be stopped, is a Lambda error, so the vendor's script does not
go on as if the tenant were gone. It runs as the reaper role, which holds
no instance action, so it cannot end another tenant's sandbox by ending the
instance it shares. The vendor removes the tenant's `run_code` grant first,
so no call starts a new sandbox in between.

## Workflows

```mermaid
sequenceDiagram
  participant A as Tenant's agent or vendor API
  participant T as run_code (tool subnets)
  participant R as Registry
  participant S as Sandbox (runner)
  A->>T: code, input name, backend (tenant from context or vendor)
  T->>T: validate; AssumeRole with TenantId tag
  T->>T: HeadObject and GetObject on inputs/<tenant>/
  T->>R: get row; take over STARTING with a new nonce
  T->>S: start (nonce hash only); probe ready
  T->>R: row READY with handle, address, bootId
  T->>S: job: code, input bytes, nonce, jobAuth
  S->>S: check hash and jobAuth; run as uid 1001; sweep
  S-->>T: result and HMAC(nonce, runId)
  T->>R: lastUsedAt = end of run
  T-->>A: output; one run line in the log
```

**First call (cold start).** The tool finds no row, takes over with a new
nonce, and starts the sandbox. It waits up to `startWait` (15 s by default)
for the sandbox to answer; if it does not, the call returns
`sandbox_starting` with `retryAfterSeconds` 5 and the caller retries. The
retry finds the `STARTING` row, probes it, and runs. Cold times in run 14:
7.5 s on `agentcore`, 10.6 s on `microvm`, 31.7 s on `nitro`; `nitro` from
zero instances took 37 s with a 300 s cap. Concurrent first calls for one
tenant start one sandbox: one wins the conditional write and the others read
its row.

**Warm reuse.** A later call reads a `READY` row, marks `lastUsedAt`, and
sends the job on the same sandbox, so files in `/work` persist. The result
reports `sandbox` = `reused`. Warm calls took 406 to 568 ms in run 14.

**Idle and maximum life.** `microvm` and `agentcore` stop themselves: the
platform suspends a MicroVM at `sandboxIdle` and an AgentCore session ends
at its idle timeout; both end at `sandboxMaxLife`. A suspended MicroVM
resumes on the next request. `nitro` has no task life limit, so the reaper
stops a `READY` task unused for `sandboxIdle` and any task whose own
`startedAt` is older than `sandboxMaxLife`. The reaper also deletes rows past
`expiresAt`, writes the stop line for a sandbox the platform ended (`microvm`, `nitro`), marks a
failed start `FAILED`, and sweeps orphans (ADR-0011, ADR-0034): it lists
sandboxes first and scans rows second, so a sandbox of a start in flight is
never taken for an orphan, and it writes each row with the version it saw
so a call that updated the row meanwhile wins. A `FAILED` row backs off 30
s before the next takeover.

**Offboard.** The vendor removes the tenant's grant and calls
`offboardTenant`, as described under Tool API. The tenant's objects stay.

**Teardown.** A delete-time custom resource (the drain) runs before the
cluster, the runtime and the image are deleted (ADR-0011, ADR-0043,
ADR-0049). It stops every handle in the registry, then every task and
MicroVM the sweep finds, and waits up to 10 minutes until none is live. On
`nitro` it then deregisters each container instance with `force`, which on
Managed Instances terminates it, and waits until EC2 shows every one
`terminated`. A sandbox still live at the deadline fails the delete loudly.
The drain is ordered before the cluster, runtime, image, connector and
security groups, and after the tool functions, so no call starts a sandbox
during the delete. Log groups follow: the construct owns the groups it
writes to and the log drain waits 90 s before they go; the log cleanup
resource deletes the groups the services create (the runtime's groups under
its prefix and the MicroVM build group) after the resources that write
them (ADR-0029, ADR-0054). A delete with sandboxes live takes 23 to 32 minutes
on one backend (spec §7.8, S-21), and the integration stack's destroy took 3500 to
3800 s in the runs that ended `DELETE_FAILED` with a recorded time. The network interfaces of the functions in the tool
subnets release late and are the open defect named in Status.

## Observability

The tool writes one structured line per call and one per stopped sandbox,
with `process.stdout.write`, so the fields sit at the top level where Logs
Insights and Contributor Insights read them (ADR-0033). Lines carry sizes,
ids and outcomes, never code, input, output, a nonce or a proof.

**Run line** (`event` = `run`): `tenantId`, `backend`, `handle`, `runId`,
`sandbox`, `outcome` (`ok` or the tool error code), `exitCode`, `timedOut`,
`durationMs`, `startMs`, `inputBytes`, `outputBytes`, and on a failed start
`stoppedReason` (cut to 200 characters).

**Stop line** (`event` = `sandbox_stopped`): `tenantId`, `backend`,
`handle`, `sandboxSeconds`, `by` (`tool`, `reaper`, `drain` or `offboard`),
`reason` (`idle`, `expired`, `overrun`, `dead`, `failed_start`, `gone`,
`offboard`, `drain`, `orphan`, `replaced`), `stoppedReason` when the
platform gave one, `orphan` = true for a sandbox no row named, and on
`microvm` `runningSeconds`, `suspendedSeconds` and `estimated` = true.
Exactly one stop line is written per sandbox, by whoever moves its row out
of `STARTING` or `READY` with a successful conditional write. A writer that
finds the row `FAILED` or `STOPPING` writes none.

Other lines: `stop_failed`, `reaper`, `reaper_error`, `drain`, and from the
gateway handler a WARN `tool refused` line with `reason`, `tool`, `txn` and
(when valid) `tenantId`.

| Question | Answered by | Tenant field |
| --- | --- | --- |
| Which tenants run the most? | Contributor Insights `runs-by-tenant`, counting lines with `runId` over the tool functions' log groups | `tenantId` |
| Which tenants hold sandboxes longest? | Contributor Insights `sandbox-seconds-by-tenant`, summing `sandboxSeconds` over the tool, reaper, drain and offboard log groups | `tenantId` |
| Which sandbox looked up blocked names? | Contributor Insights `dns-blocked-by-source` (with `dnsFirewall`) on the query log | `srcaddr` |
| A tenant's calls, errors, latency | Logs Insights over the run lines | `tenantId` |
| Per-tenant metrics | With `perTenantMetrics`: EMF `Runs`, `Errors`, `RunDuration`, `SandboxSeconds`, namespace `UntrustedCodeSandboxes`, dimensions `TenantId` and `Backend` | `TenantId` |

`perTenantMetrics` is off by default because the custom metric count grows
with the tenant count (ADR-0013, ADR-0031). With it off, the same figures are
fields of the log lines, ranked by the two rules, which are billed per rule
and matched event, not per tenant.

**Where the tenant cannot be carried.**

- A `microvm` orphan (no row; MicroVMs take no tags) gets a stop line with
  `tenantId` = `unknown`.
- An `agentcore` orphan session gets no stop line, because no API lists
  sessions; `sandboxSeconds` ranks are incomplete for `agentcore`. A session
  the platform ended at its idle timeout shows `sandboxSeconds` counted up
  to the stop, which over-counts idle time, because the platform reports no
  session end.
- `runs-by-tenant` counts lines with a `runId`, so a call refused during
  validation (no `runId`) is in the log but not in the ranking. A call whose
  tenant id breaks the rule is logged with `tenantId` = `invalid`; a function
  that cannot read its environment logs `unknown`.
- A DNS query-log `srcaddr` names one tenant only on `nitro`, where each
  task has its own ENI. On `microvm` it is the connector's shared ENI and on
  `agentcore` the runtime's shared ENI, so a hit joins to tenants by time
  against the run lines and narrows to the tenants active in that window.
  Names the vendor lists in `allowDomains` are not blocked and are not
  logged as blocks.
- Flow logs record rejected traffic by address, with no tenant.
- The runner's own log is secondary: it records sizes, exit code and
  duration only, and on `nitro` and `agentcore` it shares a stream with
  whatever the code prints.
- The AgentCore usage-log delivery to the construct's log group is deployed,
  but no integration step reads a usage record, so the record format and the
  join through `runtimeSessionId` are not verified.
- The `microvm` running and suspended split is an estimate: the API reports
  no per-state times, and the counter assumes the MicroVM suspends exactly at
  `sandboxIdle`.

## Costs

**Per tenant.** The unit is the sandbox second from the stop line, joined to
the tool's run lines by `handle` (ADR-0013). The sample's own counters per
backend:

| Backend | Attributed by | Formula | Left unattributed |
| --- | --- | --- | --- |
| `microvm` | `runningSeconds` and `suspendedSeconds` of the stop line (MicroVMs take no tags) | Running seconds × the baseline rate for `microvm.memoryMiB`, plus suspended seconds × the suspended-storage rate | The image build |
| `nitro` | The `TenantId` task tag, with ECS split cost allocation data and the cost allocation tag turned on in the account | Cost Explorer's split of instance cost by task reservation | Idle instance capacity, including the 120 s scale-in |
| `agentcore` | AgentCore usage logs in the construct-owned log group, joined on `runtimeSessionId` = `handle` (format unverified); `sandboxSeconds` as an upper bound | Per-second vCPU and memory rates × the session's reported usage | None beyond the shared endpoints and NAT |

**Fixed.** These do not vary with a tenant:

- the NAT gateway (one) and its data processing;
- the interface endpoints (ECR `api` and `dkr`, Logs) per AZ per hour, with
  `agentcore`, and the Logs endpoint with `nitro`;
- Nitro-capable ECS Managed Instances, billed while a task or the 120 s
  scale-in lasts (the capacity provider has no warm instance, ADR-0070);
- the DNS Firewall per query processed plus query-log storage;
- Lambda, DynamoDB on-demand, CloudWatch Logs and Contributor Insights
  rules, flow logs, ECR storage;
- the AgentCore runtime and the MicroVM image, which are definitions with no
  idle charge of their own.

**Apportion.** Divide each fixed amount by each tenant's share of total
`sandboxSeconds` over the period, summed from the stop lines of every
backend (ADR-0013). For the NAT and the endpoints, whose use follows calls
more than sandbox time, a vendor may use the run-line count per tenant
instead; the sample ships neither as a report.

## Validation

**Unit tests** (`npx projen build`, with cdk-nag on the synthesised stacks):
the registry against an in-memory DynamoDB double that evaluates the real
conditions (ADR-0036); `runCode` with fake backends for each registry rule
(reuse, takeover, dead handle, failed start, overrun, races); the reaper,
drain and offboard function against the same double; the three backends
against stubbed SDK clients and a local TLS server; the gateway handler
and the signed-context wrapper; the wire encodings against
`runner/protocol/vectors.json` in TypeScript and Python (ADR-0025); the
construct synthesised per option with assertions on roles, endpoint
policies, security groups, names, the drain order and the DNS Firewall;
the import-graph test that keeps the producer out of the core; and the
Python runner tests, with Linux-only cases run in Docker by
`scripts/test-runner-docker.sh` (ADR-0026).

**Integration test** (`npx projen integ`, ADR-0008, ADR-0058, ADR-0061).
One stack deploys the construct twice (all three backends with the
standalone entry and a gateway target; `agentcore` alone with session
files), drives it as a tenant would through the tools gateway, runs the
hostile "one bad script" on every backend, and deletes the stack with
sandboxes still running. The 28 steps, the step by backend matrix, the
tenants, the test-only shortcuts and the run budget are in
`integration-test.md`.

On 2026-11-22 the build ran 1061 tests, all passing.

**Scans.** The threat model's Security review section records the scan
tools, their findings and the suppressions: on 2026-11-22, ASH with no
actionable finding and ProtoShield with no critical and every high
dispositioned. cdk-nag `AwsSolutionsChecks`
runs in the build tests; acknowledged findings sit in the construct code
with their reasons.

Known limitation: the teardown step fails on two leftover Lambda network
interfaces (README, Known limitations).
