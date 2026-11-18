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

The tool is the only component that chooses the tenant. It reads the tenant
from the signed tenant context the tools gateway hands it, fetches the
input with the tenant's own credentials, starts or reuses that tenant's
sandbox, passes in the code and the bytes, and returns the output. The
sandbox sees one tenant's bytes, has no route to the internet, and holds no
AWS credentials except, on `agentcore`, the narrow runtime role that the
service requires (§6.2 C-2, ADR-0003).

The sample is the runnable companion to the Builder Center article "Where
to run one tenant's untrusted code: Nitro Sandboxes, Lambda MicroVMs or
AgentCore Runtime". Its integration test runs the article's "one bad
script" case on all three backends and checks what each one refuses.

### Frame

| | |
|---|---|
| Decision | Which boundary a vendor should run tenant or agent-written code in |
| Options | Lambda MicroVM, Nitro Sandbox on ECS, a second AgentCore Runtime, or the agent's own session |
| Evidence that settles it | The same hostile script, run on each backend, with what it reached; cold and warm run latency; idle cost; deploy and destroy time |
| Success criteria | 1/ Tenant B's data and sandbox are unreachable from tenant A's code on every backend. 2/ No backend lets the code reach the internet, and no backend lets it reach an AWS API beyond the per-backend limits in C-2. 3/ A runaway script is stopped within its cap. 4/ One `run_code` contract, the backend a deploy-time choice |
| Risks | Lambda MicroVMs launched in 2026-06 and reached eu-central-1 in 2026-08 ([What's New, 2026-08](https://aws.amazon.com/about-aws/whats-new/2026/08/lambda-microvms-5-additional-regions/)); Nitro Sandboxes launched in 2026-11 ([What's New, 2026-11](https://aws.amazon.com/about-aws/whats-new/2026/11/nitro-sandboxes-eks-ecs-ec2/)). CDK has only L1 support for both, and some behaviour is documented in one line or not at all (§7). ECS Managed Instances bill for idle instances. A NAT gateway and interface endpoints bill per hour. |
| The unasked question | Does the code need a second machine at all? Short snippets that may hold what the agent holds can run in the agent's own session with `InvokeAgentRuntimeCommand`. The sample says when that is enough (§1.2) and does not build it. |

### Requirements

- R-1: One tool, `run_code`, with one input and output shape for every backend.
- R-2: The tenant comes only from the verified tenant context; the caller
  never names it.
- R-3: The input is fetched with credentials that reach only the caller's
  tenant prefix, before the sandbox is involved.
- R-4: One sandbox per tenant per backend, reused across calls while it
  lives, never shared between tenants.
- R-5: Code in the sandbox has no route to the internet or to another
  sandbox, and holds no AWS credentials beyond the per-backend limits in C-2.
- R-6: Every run is capped in wall time and output size.
- R-7: Every run and every sandbox-second is attributable to a tenant in
  logs and cost.
- R-8: The backend is a deploy-time choice; a deployment may enable several.

### 1.1 Deployment model

Pool for the tool and the registry; bridge for compute. One `run_code` tool
target and one sandbox registry serve every tenant. Each tenant gets its
own VM per enabled backend, on shared capacity: its own MicroVM on the
Lambda fleet, its own Nitro Sandbox task on shared ECS instances, or its own
AgentCore session on one shared runtime. The MicroVM image, the task
definition and the second runtime are shared definitions; only running
instances are per-tenant.

### 1.2 What this sample does not do yet

- Egress allowlists. Code reaches no internet host on any backend; a sandbox
  that must reach one host is a later option (ADR-0003).
- Confidential mode and attestation (`CONFIDENTIAL_SANDBOX`, KMS key release
  on image measurement). The `nitro` backend runs `ISOLATED_SANDBOX` only.
- EKS. Nitro Sandboxes on EKS need a 1.36 cluster (a sandbox node group, or
  EKS Auto Mode); the sample uses ECS Managed Instances for the same
  boundary (ADR-0004).
- Languages other than Python 3.
- GPU work. Nitro Sandboxes have no GPU passthrough.
- AgentCore session storage across stop and resume. State lives for the
  sandbox's life only.
- Per-tenant sandbox sizing or tiers. Every tenant gets the same size.
- Tenant data deletion on offboarding. Offboarding stops the tenant's
  sandboxes and deletes its registry rows (§5.2); the tenant's input and
  output objects are the vendor's to delete.
- The agent's own session. Running trusted snippets with
  `InvokeAgentRuntimeCommand` in the agent's session is a valid choice when
  the code may hold what the agent holds; the README names it, the sample
  does not build it.

### 1.3 What this sample is NOT

- Not an agent. The tool is called by whatever agent the vendor runs behind
  `agentic-runtime-isolation`'s tools gateway.
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
widened later (ADR-0006).

**P-2. The tenant is chosen once, by the tool, from the signed context.**
No argument the caller passes selects a tenant, a prefix or a session. The
`backend` argument picks which of the tenant's own sandboxes runs the code,
never whose. The sandbox knows its tenant only as a label for logs.

**P-3. Code in a sandbox can reach nothing but its reply.** No internet, no
other sandbox, no instance or task metadata, and no AWS API beyond what the
backend itself requires (C-2). Where a backend cannot prove one of these,
the sample measures it in §7 and says so in the threat model; it never
assumes.

**P-4. One sandbox per tenant, never per call and never shared.** Reuse
keeps calls fast and lets a tenant keep files across turns; sharing would
make the VM boundary meaningless. A sandbox is created for one tenant,
proves which one on every call, and is destroyed, never handed to another
(ADR-0010).

**P-5. The backend is a plug, the contract is fixed.** `run_code` has one
input and output shape. A backend implements `start`, `ready`, `run` and
`stop` (§3.4). A vendor swaps the boundary without the agent or the caller
noticing.

**P-6. Enforce with IAM where AWS offers a key; say so where it does not.**
The registry and the input bucket are reached with tenant-scoped
credentials (enforced). Starting and stopping `nitro` tasks uses the same
tenant-scoped credentials with a tag condition (enforced, ADR-0014).
Starting and calling MicroVMs and AgentCore sessions uses the tool's own
role where the service has no tenant condition key (filtered). §3.4 lists
which is which, per backend.

**P-7. Every run has three caps.** The runner kills the job's whole process
group at the run timeout, the tool stops the sandbox if the runner does not
answer in time, and the platform ends the sandbox at its maximum life. Code
runs as a user that cannot touch the runner, so it cannot defeat the first
cap (ADR-0010).

**P-8. Measure the boundary, do not describe it.** The integration test runs
the hostile script on every enabled backend and asserts each refusal. A
claim in the README without a test row behind it is a defect.

## 3. System shape

### 3.1 Components

| Component | Service | Pattern | Holds |
|---|---|---|---|
| `run_code` tool | Lambda, a `ToolTarget` of `agentic-runtime-isolation` | Signed tenant context, tool-side TVM | the tool role (§3.6) |
| Tool tenant role | IAM, vended with the `TenantId` session tag | ABAC on `TenantId` | `inputs/<t>/*` read, `outputs/<t>/*` write, registry rows `TENANT#<t>`, `nitro` `RunTask` and `StopTask` on tasks tagged `<t>` |
| Input bucket | S3 | Tenant prefix | tenant files the code reads |
| Sandbox registry | DynamoDB | Tenant-keyed registry, optimistic version, start lease | one row per tenant per backend |
| Runner | Python HTTP server in every sandbox | Bytes in, bytes out; separate code user; start nonce | nothing |
| `microvm` backend | Lambda MicroVMs | VM per tenant, no execution role, VPC egress connector into a dead-end subnet | a MicroVM image, a network connector |
| `nitro` backend | ECS Managed Instances, `ISOLATED_SANDBOX` | VM per task, no task role | a cluster, a capacity provider, a task definition |
| `agentcore` backend | AgentCore Runtime V2, VPC network mode | Session per tenant on a narrow runtime | a runtime, its role, its log group |
| Network | VPC, two AZs (§3.7) | Dead-end sandbox subnets, endpoint policies | tool subnets with NAT, sandbox subnets with no route out, scoped endpoints |
| Reaper | Lambda on a 5-minute schedule | Idle stop, orphan sweep | the reaper role (§3.6) |
| Drain | CloudFormation custom resource | Stop everything on delete | the drain role (§3.6) |
| Offboard | Lambda, invoked with IAM | Stop a tenant's sandboxes | the drain role |

### 3.2 Caller and identity model

1. A tenant user calls an agent through `agentic-runtime-isolation`'s
   ingress. The ingress mints a transaction token for one tenant.
2. The agent calls `run_code` through the tools gateway. The REQUEST
   interceptor checks the tool against the grant and signs a tenant context
   into the call.
3. The tool verifies the context with `toolHandler` and vends the tool
   tenant role with the `TenantId` session tag.
4. With those credentials it reads the input and the tenant's registry row,
   and on `nitro` starts and stops the tenant's task.
5. With its own role it starts and calls the tenant's MicroVM or AgentCore
   session.

Nothing downstream of step 3 accepts a tenant id from the arguments.

Without an ingress (§3.3 `ingress` unset) the construct deploys no
`ToolTarget`. The vendor calls the exported `runCode` function from their
own tool and passes a tenant id they verified themselves; the rest of the
path is the same (ADR-0001).

### 3.3 Deployment inputs (construct props)

`UntrustedCodeSandboxes` (one construct, the pattern):

| Prop | Type | Default | Meaning |
|---|---|---|---|
| `ingress` | `SharedIngress \| SharedIngressRef` | unset | the tools gateway the tool joins; unset deploys no `ToolTarget` |
| `gateway` | `string` | `default` | the tools gateway name |
| `toolName` | `string` | `run-code` | the `ToolTarget` name |
| `backends` | `('microvm' \| 'nitro' \| 'agentcore')[]` | `['microvm']` | the boundaries to deploy; at least one |
| `defaultBackend` | one of `backends` | first entry | used when the call names none |
| `runTimeout` | `Duration` | 30 s | runner kill time; 1 s to 60 s |
| `startWait` | `Duration` | 15 s | how long one call waits for a starting sandbox before `sandbox_starting` |
| `maxOutputBytes` | `number` | 262144 | stdout and stderr together; stdout is cut first |
| `maxInputBytes` | `number` | 5242880 | refuse larger inputs before any sandbox starts |
| `sandboxIdle` | `Duration` | 15 min | idle time before a sandbox is stopped or suspended |
| `sandboxMaxLife` | `Duration` | 8 h | hard life cap on every backend |
| `perTenantMetrics` | `boolean` | `false` | emit CloudWatch metrics with a `TenantId` dimension (ADR-0013) |
| `vpc` | `ec2.IVpc` | created (§3.7) | must have subnets tagged for the tool and the sandboxes |
| `inputBucket` | `s3.IBucket` | created | the bucket with `inputs/<tenant>/` |
| `microvm.memoryMiB` | `number` | 1024 | MicroVM image minimum memory |
| `nitro.cpu`, `nitro.memoryMiB` | `number` | 512, 1024 | task size |
| `nitro.instanceTypes` | `string[]` | `['m7g.large']` | capacity provider instance requirements |
| `nitro.minInstances` | `number` | 0 | 0 keeps idle cost at zero; the first call after scale-in returns `sandbox_starting` |
| `agentcore.sessionFiles` | `boolean` | `false` | grant the runtime role `sessions/${aws:AgentCoreRuntimeSourceSid}/*` on the input bucket (ADR-0007) |

Timing budget: the tool Lambda timeout is set to
`5 s + startWait + runTimeout + 10 s` (fetch, start wait, run, stop on
overrun), at most 120 s. Validation at synth fails on: an unknown backend,
empty `backends`, `defaultBackend` not enabled, `runTimeout` outside 1 s to
60 s, a budget above 120 s, `sandboxMaxLife` above 8 h, `sandboxIdle`
below 1 min or at or above `sandboxMaxLife`, `toolName` or `gateway` set
without `ingress`.

Read-only properties: `toolTarget` (undefined without `ingress`),
`runCodeFunction`, `registryTable`, `inputBucket`, `toolRole`,
`toolTenantRole`, `offboardFunction`, `vpc`, and per backend the image ARN,
cluster ARN or runtime ARN.

Exports from `src/index.ts`: the construct and its props, `runCode`,
`offboardTenant`, the `SandboxBackend` interface and the three backend
classes, and the runner's job and result types.

### 3.4 Backend interface and enforcement per backend

```ts
interface SandboxBackend {
  readonly name: 'microvm' | 'nitro' | 'agentcore';
  start(tenantId: string, nonce: string, creds: TenantCredentials): Promise<SandboxHandle>; // creates; never reuses
  ready(handle: SandboxHandle): Promise<boolean>;  // true when the runner answers /ping
  run(handle: SandboxHandle, job: RunJob): Promise<RunResult>;
  stop(handle: SandboxHandle, creds?: TenantCredentials): Promise<void>;
}
```

The tool, not the backend, decides reuse from the registry row (§4.1).

| Step | `microvm` | `nitro` | `agentcore` |
|---|---|---|---|
| Start | `RunMicrovm` with no `executionRoleArn`, `egressNetworkConnectors` = the sample's VPC connector only, `ingressNetworkConnectors` = `HTTP_INGRESS`, `maximumDurationInSeconds` = `sandboxMaxLife`, idle policy `{autoResumeEnabled: true, maxIdleDurationSeconds: sandboxIdle, suspendedDurationSeconds: 1800}`, `logging: {disabled: {}}`, `runHookPayload` = `{"nonce": …, "tenant": …}` | `RunTask` with the tool tenant role, task definition with no `taskRoleArn`, sandbox subnets, the task security group, tags `TenantId`, container override env `RUNNER_NONCE` | none; the session starts on the first `InvokeAgentRuntime`, whose job carries the nonce; the runner adopts the first nonce it sees |
| Address | MicroVM endpoint plus a fresh auth token per call, port 8080 only, 5-minute expiry | task ARN and ENI private IP, port 8080 | runtime ARN plus `runtimeSessionId` = `rc-` + hex SHA-256 of the tenant id (67 characters, ADR-0009) |
| Identity check | runner returns `HMAC(nonce, runId)` with the result; the tool checks it | the tool sends `POST /hello` with a challenge and sends the job only when the runner answers `HMAC(nonce, challenge)` | runner returns `HMAC(nonce, runId)`; a runner with no nonce adopts the job's |
| Run | `POST /run` with `X-aws-proxy-auth` | `POST /run` over the VPC | `InvokeAgentRuntime`, payload is the job |
| Stop | idle policy suspends, then the platform ends it after 30 suspended minutes; `TerminateMicrovm` on drain, offboard or overrun | reaper `StopTask` after `sandboxIdle`; `StopTask` on drain, offboard or overrun | runtime `lifecycleConfiguration` `idleRuntimeSessionTimeout` = `sandboxIdle`, `maxLifetime` = `sandboxMaxLife`; `StopRuntimeSession` on drain, offboard or overrun |
| Start and stop: enforced or filtered | filtered: the tool role may run, call and stop any MicroVM of the image (S-3 checks for a tag condition) | enforced: `RunTask` requires `aws:RequestTag/TenantId` = `${aws:PrincipalTag/TenantId}`, `StopTask` requires `aws:ResourceTag/TenantId` = `${aws:PrincipalTag/TenantId}` (ADR-0014) | filtered: one runtime; the session id is derived by code (S-8 checks for a session condition) |
| Call: enforced or filtered | filtered by address; the nonce check rejects a wrong MicroVM | filtered by address; the nonce check rejects a wrong task | filtered by session id; the nonce check detects a restarted session |
| Code holds | no credentials | no credentials: no task role; the execution role is used by the ECS agent outside the sandbox (S-5) | the runtime role's credentials from the metadata endpoint (§6.2 C-2) |
| Egress | VPC connector into sandbox subnets with no route and a security group with no egress (S-2) | sandbox subnets with no route; task security group egress only to the Logs endpoint, and to ECR and S3 endpoints if S-6 shows the task ENI pulls the image | sandbox subnets; runtime security group egress only to the ECR, S3 and Logs endpoints, each with a scoped endpoint policy (§3.7, S-9) |

A call that fails the identity check is treated as a dead handle (§4.1
step 2), never retried on the same address.

### 3.5 The runner (ADR-0010)

One Python program, packaged twice: as a MicroVM image code artifact on the
AL2023 base image, and as an arm64 container image for `nitro` and
`agentcore`. The runner process runs as root inside the VM; it never runs
tenant code as root. It listens on 8080 and serves:

- `GET /ping`: `{"status":"Healthy","bootId":…}` (AgentCore contract).
- `POST /hello` (`nitro`): returns `HMAC(nonce, challenge)`.
- `POST /run` (and `POST /invocations` for AgentCore): runs one job.

A job runs one at a time. A second job while one runs is refused at once
with `busy`. The runner:

1. Writes the input to `/work/input`. `/work` is owned by uid 1001.
2. Starts `python3 -I -S` on the code as uid 1001 (`sandbox`), in a new
   session and process group, with `/work` as the working directory and
   these limits: `RLIMIT_CPU` = `runTimeout`, `RLIMIT_AS` = sandbox memory
   less 256 MiB, `RLIMIT_NPROC` = 64, `RLIMIT_FSIZE` = 100 MiB,
   `RLIMIT_NOFILE` = 256.
3. At `runTimeout` wall time, or when the job ends, kills the process group
   and then every remaining uid 1001 process, so nothing the code forked
   survives into the next job.
4. Returns `exitCode`, `stdout`, `stderr` (together at most
   `maxOutputBytes`, stdout cut first, `truncated` flag), `durationMs`,
   `timedOut`, `bootId` and the nonce proof.

Files in `/work` persist for the sandbox's life, so a tenant's second call
can read what the first wrote. uid 1001 cannot signal the runner, open its
file descriptors, or write outside `/work` and `/tmp`. The runner logs only
sizes, exit code and duration, never code, input or output. The tool's log
line (§3.8) is the record of a run; the runner's log is secondary, because
on `nitro` and `agentcore` it shares a stream with whatever the code prints
to its own stdout through the runner.

### 3.6 Roles

| Role | May | May not |
|---|---|---|
| Tool role (function) | assume the tool tenant role with a `TenantId` tag; `lambda:RunMicrovm`, `GetMicrovm`, `TerminateMicrovm`, `CreateMicrovmAuthToken` on the sample's image; `bedrock-agentcore:InvokeAgentRuntime`, `StopRuntimeSession` on the sample's runtime; `ecs:DescribeTasks` on the cluster; `kms:GetPublicKey` on the context key | read the bucket or the registry directly; `ecs:RunTask` or `StopTask` |
| Tool tenant role | `s3:GetObject` on `inputs/${TenantId}/*`, `s3:PutObject` on `outputs/${TenantId}/*`, registry items with `dynamodb:LeadingKeys` = `TENANT#${TenantId}`, `ecs:RunTask` and `ecs:TagResource` with the request tag condition, `ecs:StopTask` with the resource tag condition, `iam:PassRole` on the task execution role | anything without its own tag |
| Task execution role | ECR pull on the runner repository, Logs write on the task log group | everything else; never reachable by code (S-5) |
| AgentCore runtime role | ECR pull on the runner repository, Logs write on the runtime's own log group; with `sessionFiles`, `s3:GetObject`, `s3:PutObject` on `sessions/${aws:AgentCoreRuntimeSourceSid}/*` and `s3:ListBucket` with an `s3:prefix` condition | everything else |
| Reaper role | read and update every registry row; `ecs:ListTasks`, `DescribeTasks`, `StopTask` on the cluster; `lambda:ListMicrovms`, `TerminateMicrovm` on the image; `StopRuntimeSession` on the runtime | the input bucket |
| Drain role | the reaper role, plus delete registry rows | the input bucket |

The runtime and execution roles reach no tenant data.

### 3.7 Network (ADR-0012)

One VPC in two AZs, created unless `vpc` is given.

| Subnets | Route table | Used by |
|---|---|---|
| Tool | default route to one NAT gateway | the tool Lambda, the reaper, the drain; the ECS Managed Instances' primary ENIs |
| Sandbox | local only, no default route | `nitro` task ENIs, the `agentcore` runtime ENIs, the `microvm` VPC egress connector |

Endpoints in the sandbox subnets, each with a security group that admits
only the sandbox security groups, and each with a policy:

| Endpoint | Policy allows | Present when |
|---|---|---|
| S3 gateway (sandbox route table only) | `s3:GetObject` on the ECR layer bucket `prod-<region>-starport-layer-bucket/*`; with `sessionFiles`, `s3:GetObject`, `s3:PutObject`, `s3:ListBucket` on the input bucket's `sessions/` prefix | `agentcore`, or `nitro` when S-6 shows the task ENI pulls |
| ECR `api` and `dkr` | `ecr:GetAuthorizationToken`, `ecr:BatchGetImage`, `ecr:GetDownloadUrlForLayer` on the runner repository | same as above |
| CloudWatch Logs | `logs:CreateLogStream`, `logs:PutLogEvents` on the sample's task and runtime log groups | `nitro`, `agentcore` |

Security groups:

| Group | Ingress | Egress |
|---|---|---|
| Tool | none | all (through the NAT) |
| `nitro` task | 8080 from the tool group | the Logs endpoint group (plus ECR and S3 endpoints and the S3 prefix list if S-6 needs them) |
| `agentcore` runtime | none | the ECR and Logs endpoint groups, and the S3 prefix list on 443 |
| `microvm` connector | none | none |
| Endpoints | 443 from the sandbox groups | none |

Tasks cannot reach each other: no task group admits another. The tool
reaches MicroVM endpoints, AWS APIs and the AgentCore data plane through
the NAT. The integration test tries a presigned PUT to a bucket outside
these policies through the S3 endpoint, and expects a refusal.

### 3.8 Observability and cost (ADR-0013)

The tool writes one structured line per call with `process.stdout.write`
(top-level fields, so Logs Insights and Contributor Insights can key on
them): `tenantId`, `backend`, `runId`, `sandbox` (`started` or `reused`),
`outcome` (tool error code or `ok`), `exitCode`, `timedOut`, `durationMs`,
`startMs`, `inputBytes`, `outputBytes`. The reaper, the drain and the tool
write one line per stopped sandbox with `tenantId`, `backend` and
`sandboxSeconds` (`stoppedAt - createdAt`). Two Contributor Insights rules
rank tenants by runs and by `sandboxSeconds`. With `perTenantMetrics`, the
tool also emits EMF metrics `Runs`, `Errors`, `RunDuration`,
`SandboxSeconds` with dimensions `TenantId` and `Backend`; it is off by
default because the custom metric count grows with tenants.

Cost attribution per backend:

| Backend | Attributable by | Formula | Unattributed |
|---|---|---|---|
| `microvm` | `sandboxSeconds` per tenant, and a `TenantId` tag on the MicroVM if S-3 shows `RunMicrovm` takes tags | baseline rate × seconds running + suspended storage rate × seconds suspended | the image build |
| `nitro` | `TenantId` task tag with ECS split cost allocation data turned on (account setting) | Cost Explorer split of instance cost by task reservation | idle instance capacity, NAT and endpoints, apportioned by `sandboxSeconds` |
| `agentcore` | `sandboxSeconds` per tenant | per-second vCPU and memory rates × the session's measured usage, approximated by `sandboxSeconds` × the configured size | runtime idle reclaim; apportioned by `sandboxSeconds` |

## 4. Data model

### 4.1 Sandbox registry (ADR-0005)

One DynamoDB table, PITR on, `DESTROY`.

| Attribute | Value |
|---|---|
| `PK` | `TENANT#<tenantId>` |
| `SK` | `SANDBOX#<backend>` |
| `handle` | MicroVM id, task ARN, or session id |
| `address` | MicroVM endpoint, task private IP, or runtime ARN |
| `nonce` | 32 random bytes, base64url, made by the tool at start |
| `bootId` | the runner's boot id, from the first successful `/ping` |
| `state` | `STARTING` \| `READY` \| `STOPPING` |
| `createdAt`, `lastUsedAt`, `leaseUntil` | epoch ms; `leaseUntil` = start + `startWait` × 4 while `STARTING` |
| `expiresAt` | `createdAt + sandboxMaxLife`; TTL attribute |
| `version` | number, incremented on every write |

Reads and writes use the tool tenant role, whose policy allows only items
with `dynamodb:LeadingKeys` = `TENANT#${aws:PrincipalTag/TenantId}`.

Reuse rule, per call (the tool):

1. Get the row (`version` = v).
   - `READY` and not expired: run on it (step 3).
   - `STARTING` and `leaseUntil` not passed: probe `ready`. When ready,
     update to `READY` if `version = v`; run. When not ready by `startWait`,
     return `sandbox_starting` with `retryAfterSeconds`.
   - Missing, expired, `STOPPING`, or `STARTING` with the lease passed: step 2.
2. Take over: put a `STARTING` row with a new nonce if the row is missing
   (`attribute_not_exists(PK)`) or `version = v`. On a condition failure,
   another call won: go back to step 1 once. The winner stops the handle it
   replaced, if any, then starts, records `handle` and `address`, and waits
   as in step 1.
3. Run. A failed identity check, "not found", or a connection refusal marks
   the row dead: go to step 2 with the version just read. A changed `bootId`
   on `agentcore` means the session restarted: the tool rewrites the row
   with the new `bootId` and reports `sandbox` = `started`.
4. After the run, update `lastUsedAt` (no condition).
5. If the runner does not answer by `runTimeout` + 5 s, set `STOPPING`,
   stop the sandbox, and return a result with `timedOut` = true.

The reaper, every 5 minutes: stops sandboxes with `lastUsedAt` older than
`sandboxIdle` (`nitro`), deletes rows past `expiresAt`, and sweeps orphans:
tasks tagged by the sample, MicroVMs of the image, and AgentCore sessions
with no matching row are stopped.

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

| Code | Retry | When |
|---|---|---|
| `context_invalid` | no | the gateway context failed verification (from `toolHandler`) |
| `invalid_argument` | no | a field breaks its rule |
| `input_not_found` | no | no such object under the tenant's prefix |
| `input_too_large` | no | the object exceeds `maxInputBytes` (`HeadObject` before any start) |
| `backend_disabled` | no | `backend` names one not deployed |
| `sandbox_starting` | yes, after `retryAfterSeconds` | the tenant's sandbox is starting (§4.1) |
| `sandbox_busy` | yes | the tenant's sandbox is running another job |
| `sandbox_failed` | yes | the sandbox did not become ready within its lease, or died mid-run |
| `tool_failed` | no | any other fault (from `toolHandler`) |

A script that exits non-zero, times out or is killed is not a tool error: it
returns a result with `exitCode`, `timedOut` and its output.

### 5.2 `offboardTenant`

A Lambda function the vendor invokes with IAM (`lambda:InvokeFunction`),
input `{ "tenantId": … }`. It stops every sandbox in the tenant's rows,
deletes the rows, and returns the stopped handles. The control plane's
tenant delete script is the intended caller.

### 5.3 Teardown

A delete-time custom resource (the drain) runs before the cluster, the
runtime and the image are deleted: it stops every handle in the registry,
then every orphan the reaper sweep would find, and waits until none is left
(at most 10 minutes). The construct owns the AgentCore runtime's and the
task's log groups by their fixed names, and a log drain waits 90 s on delete
before they go, as agentic-runtime-isolation ADR-0019 does.

## 6. Contracts

### 6.1 What the deployer supplies

- Optionally, an `agentic-runtime-isolation` ingress with a tools gateway, in
  the same app or through its published `ingress` parameter, and a grant for
  `run_code` in its entitlement store for each tenant that may use it
  (agentic-runtime-isolation spec §4.5).
- A Region where all enabled backends exist. Lambda MicroVMs, ECS Managed
  Instances with Nitro Sandboxes and AgentCore Runtime V2 are all in
  eu-central-1; the sample defaults there.
- Optionally a VPC with tool subnets (a default route to a NAT) and sandbox
  subnets (no default route), tagged `run-code:tier` = `tool` or `sandbox`.
- For per-tenant cost on `nitro`: ECS split cost allocation data and the
  `TenantId` cost allocation tag turned on in the account.

### 6.2 What the sample promises

- C-1: Code run for tenant A never runs in a sandbox started for tenant B.
- C-2: On `microvm` and `nitro`, code gets no AWS credentials. On
  `agentcore`, code can read the runtime role's credentials, which reach
  only ECR pull on the runner repository and Logs writes on the runtime's
  log group, plus its own session prefix when `sessionFiles` is set.
- C-3: Code cannot open a connection to the internet or to another sandbox.
  Its only network paths are the reply to the tool and, on `agentcore` (and
  on `nitro` if S-6 needs them), the scoped endpoints of §3.7.
- C-4: A run ends within `runTimeout` plus 5 s with its process group
  killed, or the tool stops the sandbox and reports `timedOut`.
- C-5: The tool reads inputs only under the caller's tenant prefix and
  registry rows only under its key; IAM refuses any other key even if the
  tool's code is wrong.
- C-6: `cdk destroy` leaves no sandbox, task, MicroVM, session, instance or
  log group behind, including sandboxes started at run time.

### 6.3 Composition (standard §1.1)

Consumes:

| Producer | Interface | Why |
|---|---|---|
| `agentic-runtime-isolation` | construct `ToolTarget` and `toolHandler` from its `src/index.ts` (local dependency `file:../agentic-runtime-isolation`), parameter `/application-plane/shared/agent-runtime/ingress` | the tools gateway, the signed tenant context, the tool-side TVM; optional |
| `tenant-identity` `shared-pool` | its parameters, through `agentic-runtime-isolation` only | users and tenants for the integration test |

Publishes:

| Parameter | Value |
|---|---|
| `/application-plane/shared/code-sandbox/sandboxes` | one JSON document: `version`, `toolTarget` (or `none`), `backends`, `defaultBackend`, `registryTableName`, `inputBucketName`, `offboardFunctionArn`, and per backend `imageArn`, `clusterArn` or `runtimeArn` |

Construct: `UntrustedCodeSandboxes` and its props, plus the exports in §3.3.
The `ARCHITECTURE.md` namespace row and samples-map row are added in the
pull request that ships the sample.

## 7. Spikes to run before acceptance

Each spike runs in a non-production test account in eu-central-1, measures
deploy and destroy time, and cleans up on exit.

| Id | Question | Decides |
|---|---|---|
| S-1 | Do `AWS::Lambda::MicrovmImage` and `AWS::Lambda::NetworkConnector` deploy from a zip in CloudFormation, how long does `CREATING` take, and does stack delete wait for running MicroVMs? | `microvm` packaging, deploy time, drain order |
| S-2 | With only a VPC egress connector into a dead-end subnet, can code reach the internet, `169.254.169.254`, or another MicroVM's endpoint? Contrast row: no connector at all (expected: internet reachable) | C-3 on `microvm` |
| S-3 | Do `RunMicrovm` and `CreateMicrovmAuthToken` accept tags or tag conditions, so the tool role can be limited per tenant? | enforced or filtered start (§3.4), cost tag |
| S-4 | Cold `RunMicrovm` to first `/run`, and resume after suspend: P50 and P90 over 20 runs. Does the runner as root and code as uid 1001 work on the AL2023 base image? | `startWait`, runner model |
| S-5 | In an `ISOLATED_SANDBOX` task with no task role, can code read the execution role's credentials, the ECS task metadata endpoint, or IMDS? | C-2 on `nitro` |
| S-6 | Does the task pull its image through its own ENI or the instance's? With sandbox subnets and a task group open only to the Logs endpoint, can code reach the internet or another task? Do `awslogs` logs arrive? | C-3 on `nitro`, endpoint set |
| S-7 | `RunTask` to `RUNNING` on a warm instance, and from zero instances; idle instance cost; is a stopped task's private IP reused within an hour? | `nitro.minInstances`, ADR-0010 |
| S-8 | Does `InvokeAgentRuntime` support a condition on the session id, so the tool role can be limited per tenant? | enforced or filtered call (§3.4) |
| S-9 | Does a V2 runtime in VPC mode with the §3.7 endpoints and policies start, pull, refresh and log? Can its code reach the internet or PUT to another bucket through the S3 endpoint? | C-3 on `agentcore` |
| S-10 | With the §3.6 runtime role, what can code do with the metadata endpoint's credentials, and does `aws:AgentCoreRuntimeSourceSid` scope the `sessionFiles` grant to one session? | C-2 on `agentcore`, ADR-0007 |
| S-11 | Does the tools gateway allow a tool Lambda timeout of 120 s, and what does the agent see past it? | timing budget |
| S-12 | Can the integration test call `run_code` through the tools gateway with a transaction token without an agent in between, as a consumer could? | §8 drive path |

## 8. Integration test outline

Driver: the CDK CLI in `scripts/integ.sh` (ADR-0008). It reuses a deployed
`agentic-runtime-isolation` ingress and the `TenantIdentity-shared-pool`
fixture when their parameters exist, and otherwise deploys the ingress
through its own deploy path. It deploys one integration stack with two
construct instances: `run-code` with all three backends and
`sandboxIdle` = 2 min, and `run-code-files` with `agentcore` only and
`sessionFiles` on. Both are destroyed at the end; the shared pool is never
touched.

| Step | Checks |
|---|---|
| seed | tenants `A` and `B`, each with `inputs/<t>/invoice.csv` (synthetic) and a `run_code` grant |
| parse | A runs a script that parses its invoice; output matches; `sandbox` = `started` (or `sandbox_starting`, then retried) |
| reuse | A writes `/work/marker`; A's next call reads it; `sandbox` = `reused` |
| apart | B's call on the same backend cannot see A's marker; B's `sandbox` = `started` |
| race | two concurrent first calls for a new tenant `C` start one sandbox |
| prefix | the tool refuses `input` = `../B/invoice.csv` and any name outside A's prefix |
| iam-wall | `iam:SimulatePrincipalPolicy` on the tool tenant role with `aws:PrincipalTag/TenantId` = `A` denies `inputs/B/*`, the `TENANT#B` row, and `StopTask` on B's task |
| limits | a 6 MiB input returns `input_too_large`; a 1 MiB print returns `truncated` = true |
| no-credentials | A's script tries IMDS, the ECS and AgentCore metadata endpoints, and `boto3` default credentials, then `GetObject` on B's invoice. `microvm` and `nitro`: every attempt fails. `agentcore`: credentials load, and every call outside C-2 is denied |
| no-egress | A's script tries HTTPS to `example.com`, TCP to B's sandbox address, and a presigned PUT to a test bucket outside the endpoint policy; all fail within 5 s |
| runaway | a loop, a `setsid` child that sleeps past the job, a kill of PID 1 and of the runner, and a disk fill: each returns `timedOut` or a non-zero exit, nothing of the job survives into A's next call, and A's next call works |
| dead-handle | stop A's sandbox out of band; A's next call returns `sandbox` = `started` |
| recycled-address | `nitro`: point A's row at B's live task address (test-only shortcut standing in for an IP that ECS reassigned), then call A: the identity check fails, nothing is sent to B's task, and A gets a fresh task |
| idle | after 3 minutes idle, A's `nitro` task is stopped by the reaper, and the stop line carries `sandboxSeconds` |
| session-files | `run-code-files`: A's session writes and reads its own `sessions/<sid>/`; a `GetObject` on B's session prefix is denied |
| telemetry | Logs Insights finds one tool line per call with the §3.8 fields and the right `tenantId` |
| forged | a direct Lambda invoke with a tampered tenant context returns `context_invalid` and starts nothing (test-only shortcut: only the gateway role may invoke the function in a real deployment) |
| offboard | `offboardTenant` for `C` stops its sandboxes and deletes its rows |
| teardown | `cdk destroy` with sandboxes still running for A and B; afterwards no MicroVM, task, session, instance or log group of the sample is left |

Every behaviour step runs once per backend unless it names one. The run
records cold and warm latency per backend and the deploy and destroy time.
