<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# Untrusted code sandboxes for agentic applications: specification

Status: draft, not built. Spikes in §7 run before the first ADR is accepted.

## 1. Problem statement

Agents write code, and tenants upload it. Either way one tenant's code runs
next to the vendor's platform and next to other tenants' code. This sample
puts that code behind one `run_code` tool and runs it in a virtual machine
per tenant, on any of three AWS boundaries:

| Backend | Boundary | Who runs the machine |
|---|---|---|
| `microvm` | a Lambda MicroVM per tenant | AWS; no servers |
| `nitro` | a Nitro Sandbox task per tenant on Amazon ECS Managed Instances | AWS runs the instances; the vendor owns the capacity provider |
| `agentcore` | a session per tenant on a second AgentCore Runtime (platform version V2) with a narrow role | AWS; no servers |

The tool is the only component that knows the tenant. It reads the tenant
from the signed tenant context the tools gateway hands it, fetches the
input with the tenant's own credentials, starts or reuses that tenant's
sandbox, passes in the code and the bytes, and returns the output. The
sandbox sees one tenant's bytes, holds no AWS credentials, and has no route
out (ADR-0003).

The sample is the runnable companion to the Builder Center article "Where
to run one tenant's untrusted code: Nitro Sandboxes, Lambda MicroVMs or
AgentCore Runtime". Its integration test runs the article's "one bad
script" case on all three backends and checks that each refuses the same
two things.

### Frame

| | |
|---|---|
| Decision | Which boundary a vendor should run tenant or agent-written code in |
| Options | Lambda MicroVM, Nitro Sandbox on ECS, a second AgentCore Runtime, or the agent's own session |
| Evidence that settles it | The same hostile script, run on each backend, with what it reached; cold and warm run latency; idle cost; deploy and destroy time |
| Success criteria | 1/ tenant B's data and sandbox are unreachable from tenant A's code on every backend. 2/ No backend lets the code reach an AWS API or the internet. 3/ A runaway script is stopped within its cap. 4/ One `run_code` contract, the backend a deploy-time choice |
| Risks | MicroVMs and Nitro Sandboxes are new (2026-06 and 2026-11): CDK has only L1 support, and some behaviour is documented in one line or not at all (§7). ECS Managed Instances bill for idle instances. |
| The unasked question | Does the code need a second machine at all? Short snippets that may hold what the agent holds can run in the agent's own session with `InvokeAgentRuntimeCommand`. The sample says when that is enough (§1.2) and does not build it. |

### Requirements

- R-1: One tool, `run_code`, with one input and output shape for every backend.
- R-2: The tenant comes only from the verified tenant context; the caller
  never names it.
- R-3: The input is fetched with credentials that reach only the caller's
  tenant prefix, before the sandbox is involved.
- R-4: One sandbox per tenant per backend, reused across calls while it
  lives, never shared between tenants.
- R-5: Code in the sandbox holds no AWS credentials and has no network path
  except the reply to the tool.
- R-6: Every run is capped in wall time and output size.
- R-7: Every run is attributable to a tenant in logs and cost.
- R-8: The backend is a deploy-time choice; a deployment may enable several.

### 1.1 Deployment model

Pool for the tool and the registry; silo for compute. One `run_code` tool
target and one sandbox registry serve every tenant. Each tenant gets its
own sandbox per enabled backend: its own MicroVM, its own ECS task, or its
own AgentCore session. The MicroVM image, the task definition and the
second runtime are shared definitions; only running instances are
per-tenant.

### 1.2 What this sample does not do yet

- Egress allowlists. Egress is `none` on every backend; a sandbox that must
  reach one host is a later option (ADR-0003).
- Confidential mode and attestation (`CONFIDENTIAL_SANDBOX`, KMS key release
  on image measurement). The `nitro` backend runs `ISOLATED_SANDBOX` only.
- EKS. Nitro Sandboxes on EKS need a 1.36 cluster and a node group; the
  sample uses ECS Managed Instances for the same boundary (ADR-0004).
- Languages other than Python 3.
- GPU work. Nitro Sandboxes have no GPU passthrough.
- Session storage across stop and resume on `agentcore`, and suspend and
  resume on `microvm` beyond the platform defaults. State lives for the
  sandbox's life only.
- Per-tenant sandbox sizing or tiers. Every tenant gets the same size.
- The agent's own session. Running trusted snippets with
  `InvokeAgentRuntimeCommand` in the agent's session is a valid choice when
  the code may hold what the agent holds; the README names it, the sample
  does not build it.

### 1.3 What this sample is NOT

- Not an agent. The tool is called by whatever agent the vendor runs behind
  `agentic-runtime-isolation`'s tools gateway; the demo calls it directly
  through the gateway.
- Not a code interpreter product. AgentCore Code Interpreter exists and is
  the managed choice for Python, JavaScript and TypeScript; this sample shows
  the boundary underneath, so a vendor can choose and own it.
- Not a policy on what code is allowed. The sample contains code; it does not
  judge it.
- Not tenant identity or ingress. Both come from the consumed samples.

## 2. Guiding principles

**P-1. The sandbox is handed bytes, never access.** The tool fetches the
input with tenant-scoped credentials and passes the bytes in. The sandbox
has nothing to fetch with. This rules out mounting tenant buckets, passing
presigned URLs, or giving the sandbox a role "just for logs" that could be
widened later.

**P-2. The tenant is chosen once, by the tool, from the signed context.**
The sandbox does not know which tenant it serves beyond a label the tool
gives it for logs. No argument the caller passes selects a sandbox, a
prefix or a session.

**P-3. Code in a sandbox can reach nothing but its reply.** No AWS
credentials, no instance or task metadata, no internet, no VPC peer. Where a
backend cannot prove one of these, the sample measures it in §7 and says so
in the threat model; it never assumes.

**P-4. One sandbox per tenant, never per call and never shared.** Reuse
keeps calls fast and lets a tenant keep files across turns; sharing would
make the VM boundary meaningless. A sandbox is created for one tenant and
destroyed, never handed to another.

**P-5. The backend is a plug, the contract is fixed.** `run_code` has one
input and output shape. A backend implements start, find, run and stop. A
vendor swaps the boundary without the agent or the caller noticing.

**P-6. Enforce with IAM where AWS offers a key; say so where it does not.**
The registry and the input bucket are reached with tenant-scoped
credentials (enforced). Starting and calling sandboxes uses the tool's own
role where the service has no tenant condition key (filtered). §3.4 lists
which is which, per backend.

**P-7. Every run has three caps.** The runner kills the process at the run
timeout, the tool abandons the call a little later, and the platform ends
the sandbox at its maximum life. A script that defeats one cap meets the
next.

**P-8. Measure the boundary, do not describe it.** The integration test runs
the hostile script on every enabled backend and asserts each refusal. A
claim in the README without a test row behind it is a defect.

## 3. System shape

### 3.1 Components

| Component | Service | Pattern | Holds |
|---|---|---|---|
| `run_code` tool | Lambda, a `ToolTarget` of `agentic-runtime-isolation` | Signed tenant context, tool-side TVM | the tool role (start and call sandboxes) |
| Tool tenant role | IAM | ABAC on `TenantId` | `inputs/<tenant>/*`, `outputs/<tenant>/*`, registry rows `TENANT#<tenant>` |
| Input bucket | S3 | Tenant prefix | tenant files the code reads |
| Sandbox registry | DynamoDB | Tenant-keyed registry, conditional create | one row per tenant per backend |
| Runner | Python HTTP server in every sandbox | Bytes-in, bytes-out | nothing |
| `microvm` backend | Lambda MicroVMs | VM per tenant, no execution role | a MicroVM image |
| `nitro` backend | ECS Managed Instances, `ISOLATED_SANDBOX` | VM per task, no task role | a cluster, a capacity provider, a task definition, isolated subnets |
| `agentcore` backend | AgentCore Runtime V2 | Session per tenant on a narrow runtime | a runtime whose role reaches only its own logs |
| Reaper | Lambda on a schedule | Idle stop | stops `nitro` tasks idle past the limit (the other backends stop themselves) |

### 3.2 Caller and identity model

1. A tenant user calls an agent through `agentic-runtime-isolation`'s
   ingress. The ingress mints a transaction token for one tenant.
2. The agent calls `run_code` through the tools gateway. The REQUEST
   interceptor checks the tool against the grant and signs a tenant context
   into the call.
3. The tool verifies the context with `toolHandler` and vends the tool
   tenant role with the `TenantId` session tag.
4. With those credentials it reads the input and the tenant's registry row.
5. With its own role it starts or calls the tenant's sandbox.

Nothing downstream of step 3 accepts a tenant id from the arguments.

### 3.3 Deployment inputs (construct props)

`UntrustedCodeSandboxes` (one construct, the pattern):

| Prop | Type | Default | Meaning |
|---|---|---|---|
| `ingress` | `SharedIngress \| SharedIngressRef` | required | the tools gateway the tool joins |
| `gateway` | `string` | `default` | the tools gateway name |
| `backends` | `('microvm' \| 'nitro' \| 'agentcore')[]` | `['microvm']` | the boundaries to deploy; at least one |
| `defaultBackend` | one of `backends` | first entry | used when the call names none |
| `runTimeout` | `Duration` | 30 s | runner kill time; 1 s to 120 s |
| `maxOutputBytes` | `number` | 262144 | stdout plus stderr cap; the rest is cut and flagged |
| `maxInputBytes` | `number` | 5242880 | refuse larger inputs before any sandbox starts |
| `sandboxIdle` | `Duration` | 15 min | idle time before a sandbox is stopped |
| `sandboxMaxLife` | `Duration` | 8 h | hard life cap; MicroVM `maximumDurationInSeconds` |
| `inputBucket` | `s3.IBucket` | created | the bucket with `inputs/<tenant>/` |
| `nitro.instanceTypes` | `string[]` | `['m7g.large']` | capacity provider instance requirements |
| `nitro.minInstances` | `number` | 0 | 0 keeps idle cost at zero and makes the first run slow |
| `agentcore.sessionFiles` | `boolean` | `false` | grant the runtime role `sessions/${aws:AgentCoreRuntimeSourceSid}/*` on the input bucket (ADR-0007) |

Validation at synth: unknown backend, empty `backends`, `defaultBackend` not
enabled, `runTimeout` at or above the tool Lambda timeout less 5 s,
`sandboxMaxLife` above 8 h.

Read-only properties: `toolTarget`, `registryTable`, `inputBucket`,
`toolRole`, `toolTenantRole`, and per backend the image ARN, cluster ARN or
runtime ARN.

### 3.4 Backend interface and enforcement per backend

```ts
interface SandboxBackend {
  readonly name: 'microvm' | 'nitro' | 'agentcore';
  start(tenantId: string): Promise<SandboxHandle>;      // creates; never reuses
  ready(handle: SandboxHandle): Promise<SandboxHandle>; // waits until it serves
  run(handle: SandboxHandle, job: RunJob): Promise<RunResult>;
  stop(handle: SandboxHandle): Promise<void>;
}
```

The tool, not the backend, decides reuse from the registry row (§4.1).

| Step | `microvm` | `nitro` | `agentcore` |
|---|---|---|---|
| Start | `RunMicrovm` with no `executionRoleArn`, no egress connector, `HTTP_INGRESS` only, `maximumDurationInSeconds` = `sandboxMaxLife`, idle policy from `sandboxIdle` | `RunTask` on the capacity provider, task definition with no `taskRoleArn`, isolated subnets, a security group with ingress from the tool only, tags `TenantId` | none; a session starts on first invoke |
| Address | MicroVM endpoint plus a fresh auth token per call, port 8080 only, 5-minute expiry | task ENI private IP, port 8080; the tool Lambda runs in the same VPC | runtime ARN plus `runtimeSessionId` = `rc-<tenant>-<sha256(tenant)[:24]>` (≥ 33 characters) |
| Run | `POST /run` with `X-aws-proxy-auth` | `POST /run` over the VPC | `InvokeAgentRuntime`, payload is the job |
| Stop | idle policy suspends; `TerminateMicrovm` on offboard or max life | reaper `StopTask` after `sandboxIdle`; nothing stops it otherwise | AgentCore stops idle sessions at 15 min; `StopRuntimeSession` on offboard |
| Start, call: enforced or filtered | filtered: the tool role may run and call any MicroVM of the image (§7 S-3 checks for a tag condition) | enforced on start: `ecs:RunTask` requires `aws:RequestTag/TenantId`; call is filtered by registry lookup | filtered: one runtime, the session id is derived by code (§7 S-8) |
| Code holds | nothing; no role | nothing; no task role, execution role used by the ECS agent only (§7 S-5) | the runtime role: logs only, plus its own session prefix when `sessionFiles` |
| Egress | none (§7 S-2) | none: no NAT, no internet route, security group egress only to the CloudWatch Logs interface endpoint (§7 S-6) | VPC network mode, a security group with no egress rule (§7 S-9) |

### 3.5 The runner

One Python program, packaged twice: as a MicroVM image code artifact on the
AL2023 base image, and as an arm64 container image for `nitro` and
`agentcore`. It listens on 8080 and serves:

- `GET /ping`: `{"status":"Healthy"}` (AgentCore contract).
- `POST /run` (and `POST /invocations` for AgentCore): runs one job.

A job writes the input to `/work/input`, runs `python3 -I -S` on the code
with `/work` as the working directory, a `RLIMIT_CPU` and wall timer at
`runTimeout`, `RLIMIT_AS` at the sandbox memory less 128 MiB, and returns
`exitCode`, `stdout`, `stderr` (each cut at `maxOutputBytes`, `truncated`
flag), `durationMs` and `timedOut`. Files in `/work` persist for the
sandbox's life, so a tenant's second call can read what the first wrote.
The runner never logs the code, the input or the output: only sizes, exit
code and duration.

## 4. Data model

### 4.1 Sandbox registry (ADR-0005)

One DynamoDB table, PITR on, `DESTROY`.

| Attribute | Value |
|---|---|
| `PK` | `TENANT#<tenantId>` |
| `SK` | `SANDBOX#<backend>` |
| `handle` | MicroVM id, task ARN, or session id |
| `address` | MicroVM endpoint, task private IP, or runtime ARN |
| `state` | `STARTING` \| `READY` \| `STOPPING` |
| `createdAt`, `lastUsedAt` | epoch ms |
| `expiresAt` | `createdAt + sandboxMaxLife`; TTL attribute |
| `version` | number, for conditional updates |

Reads and writes use the tool tenant role, whose policy allows only
`dynamodb:LeadingKeys` = `TENANT#${aws:PrincipalTag/TenantId}`. The reaper
uses its own role, which may read every row and update `state`, and may not
read the input bucket.

Reuse rule, per call:

1. Get the row. `READY` and not expired: run on it.
2. Missing, expired, or the run fails with "not found": put a `STARTING`
   row with `attribute_not_exists(PK) OR expiresAt < :now OR state = STOPPING`.
   The winner starts the sandbox and sets `READY`; a loser waits up to
   20 s for `READY`, then fails with `sandbox_busy`.
3. After the run, update `lastUsedAt`.

Two concurrent calls of one tenant may both run on one sandbox; the runner
runs jobs one at a time and queues at most four, refusing the rest with
`sandbox_busy`.

### 4.2 Input and output objects

| Key | Written by | Read by |
|---|---|---|
| `inputs/<tenantId>/<name>` | the vendor or the tenant (the demo seeds it) | the tool, with the tool tenant role |
| `outputs/<tenantId>/<runId>.json` | the tool, when `saveOutput` is set | the tenant |
| `sessions/<sessionId>/*` | `agentcore` code, only with `sessionFiles` | the same session |

## 5. API surface

### 5.1 Tool `run_code`

Input, after the gateway strips the tenant context:

| Field | Type | Required | Rule |
|---|---|---|---|
| `code` | string | yes | ≤ 64 KiB, UTF-8 Python |
| `input` | string | no | object name under the tenant's `inputs/` prefix; `[A-Za-z0-9._/-]{1,256}`, no `..`, no leading `/` |
| `backend` | string | no | one of the enabled backends; default `defaultBackend` |
| `saveOutput` | boolean | no | also write the result to `outputs/` |

Output:

```json
{ "runId": "…", "backend": "microvm", "exitCode": 0, "stdout": "…", "stderr": "",
  "truncated": false, "timedOut": false, "durationMs": 412, "sandbox": "reused" }
```

`sandbox` is `started` or `reused`, so a caller can see a cold start.

Errors (tool error `code`, no stack, no tenant data):

| Code | When |
|---|---|
| `context_invalid` | the gateway context failed verification (from `toolHandler`) |
| `invalid_argument` | a field breaks its rule |
| `input_not_found` | no such object under the tenant's prefix |
| `input_too_large` | the object exceeds `maxInputBytes` |
| `backend_disabled` | `backend` names one not deployed |
| `sandbox_busy` | §4.1 step 2 or a full runner queue |
| `sandbox_failed` | the sandbox did not become ready, or died mid-run |

A script that exits non-zero, times out or is killed is not a tool error: it
returns a result with `exitCode`, `timedOut` and its output.

## 6. Contracts

### 6.1 What the deployer supplies

- An `agentic-runtime-isolation` ingress with a tools gateway, in the same
  app or through its published `ingress` parameter.
- A Region where all enabled backends exist. Lambda MicroVMs, ECS Managed
  Instances with Nitro Sandboxes and AgentCore Runtime V2 are all in
  eu-central-1; the sample defaults there.
- For `nitro`: a VPC, or let the construct create one with isolated subnets
  and a CloudWatch Logs interface endpoint.
- A grant for `run_code` in the entitlement store for each tenant that may use
  it (agentic-runtime-isolation spec §4.5).

### 6.2 What the sample promises

- C-1: Code run for tenant A never runs in a sandbox started for tenant B.
- C-2: Code in a sandbox gets no AWS credentials on any backend, unless
  `agentcore.sessionFiles` is set, and then only for its own session prefix.
- C-3: Code in a sandbox cannot open a connection to the internet or to
  another sandbox.
- C-4: A run ends within `runTimeout` plus 5 s, or the tool reports
  `timedOut`.
- C-5: The tool reads inputs only under the caller's tenant prefix; IAM
  refuses any other key even if the code of the tool is wrong.
- C-6: Teardown leaves no sandbox, task, MicroVM, session, log group or
  instance behind.

### 6.3 Composition (standard §1.1)

Consumes:

| Producer | Interface | Why |
|---|---|---|
| `agentic-runtime-isolation` | construct `ToolTarget` (local dependency `file:../agentic-runtime-isolation`), `toolHandler` from its tools package, parameter `/application-plane/shared/agent-runtime/ingress` | the tools gateway, the signed tenant context, the tool-side TVM |
| `tenant-identity` `shared-pool` | its parameters, through `agentic-runtime-isolation` only | users and tenants for the integration test |

Publishes:

| Parameter | Value |
|---|---|
| `/application-plane/shared/code-sandbox/sandboxes` | one JSON document: `version`, `toolTarget`, `backends`, `defaultBackend`, `registryTableName`, `inputBucketName`, and per backend `imageArn`, `clusterArn` or `runtimeArn` |

Construct: `UntrustedCodeSandboxes` and its props, from `src/index.ts`.

## 7. Spikes to run before acceptance

Each spike runs in a non-production test account in eu-central-1, measures
deploy and destroy time, and cleans up on exit.

| Id | Question | Decides |
|---|---|---|
| S-1 | Does `AWS::Lambda::MicrovmImage` build from a zip in CloudFormation, and how long does `CREATING` take? Does stack delete wait for running MicroVMs? | `microvm` packaging, deploy time |
| S-2 | With no egress connector, can code in a MicroVM reach the internet, `169.254.169.254`, or another MicroVM's endpoint? | C-3 on `microvm` |
| S-3 | Do `RunMicrovm` and `CreateMicrovmAuthToken` accept tags or tag conditions, so the tool role can be limited per tenant? | enforced or filtered start (§3.4) |
| S-4 | Cold `RunMicrovm` to first `/run`, and resume after suspend: P50 and P90 over 20 runs | defaults, README latency |
| S-5 | In an `ISOLATED_SANDBOX` task with no task role, can code read the execution role's credentials, the ECS task metadata endpoint, or IMDS? | C-2 on `nitro` |
| S-6 | With no NAT and security group egress only to the Logs endpoint, can code reach the internet or the endpoint's other services? Do `awslogs` logs still arrive? | C-3 on `nitro` |
| S-7 | `RunTask` to `RUNNING` on a warm instance, and from zero instances; idle instance cost | `nitro.minInstances` default |
| S-8 | Does `InvokeAgentRuntime` support a condition on the session id, so the tool role can be limited per tenant? | enforced or filtered call (§3.4) |
| S-9 | Does a V2 runtime in VPC mode with no security group egress still start, pull its image and log? Can its code reach the internet? | C-3 on `agentcore` |
| S-10 | With a logs-only runtime role, what can code read from the metadata endpoint, and does `aws:AgentCoreRuntimeSourceSid` scope the `sessionFiles` grant to one session? | C-2 on `agentcore`, ADR-0007 |
| S-11 | Does the tools gateway allow a tool Lambda timeout of 60 s, and what does the agent see past it? | `runTimeout` maximum |
| S-12 | Can the integration test call `run_code` through the tools gateway with a transaction token without an agent in between, as a consumer could? | §8 drive path |

## 8. Integration test outline

Driver: the CDK CLI in `scripts/integ.sh` (several stacks; standard §5.2).
It reuses a deployed `agentic-runtime-isolation` ingress and the
`TenantIdentity-shared-pool` fixture when their parameters exist, and
deploys only its own stack with all three backends enabled.

| Step | Checks |
|---|---|
| seed | tenants `A` and `B`, each with `inputs/<t>/invoice.csv` (synthetic) and a `run_code` grant |
| parse | A runs a script that parses its invoice; output matches; `sandbox` = `started` |
| reuse | A writes `/work/marker`; A's next call reads it; `sandbox` = `reused` |
| apart | B's call on the same backend cannot see A's marker; B's `sandbox` = `started` |
| prefix | the tool refuses `input` = `../B/invoice.csv` and any name outside A's prefix (`invalid_argument` or `input_not_found`) |
| no-credentials | A's script tries IMDS, the ECS and AgentCore metadata endpoints, `boto3` default credentials, and a `GetObject` on B's invoice; every attempt fails |
| no-egress | A's script tries HTTPS to `example.com` and TCP to B's sandbox address; both fail within 5 s |
| runaway | A's script loops; result has `timedOut` = true within `runTimeout` + 5 s; A's next call still works |
| forged | a call with a tampered tenant context returns `context_invalid` and starts nothing |
| session-files | `agentcore` only, on a second runtime with `sessionFiles`: A's session writes and reads its own `sessions/<sid>/` prefix; a `GetObject` on B's session prefix is denied |
| teardown | stop every sandbox; destroy; no MicroVM, task, session, instance or log group left |

Every behaviour step runs once per backend. The run records cold and warm
latency per backend and the deploy and destroy time of the stack.
