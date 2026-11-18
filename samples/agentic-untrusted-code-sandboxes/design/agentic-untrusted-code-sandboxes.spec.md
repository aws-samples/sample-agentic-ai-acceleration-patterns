<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# Untrusted code sandboxes for agentic applications: specification

Status: draft, not built. Spikes S-1 to S-12 ran on 2026-11-18 (§7.1).

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
| Success criteria | 1/ Tenant B's data and sandbox are unreachable from tenant A's code on every backend. 2/ No backend lets the code open a connection to the internet (DNS lookups are the stated exception, C-3), and no backend lets it reach an AWS API beyond the per-backend limits in C-2. 3/ A runaway script is stopped within its cap. 4/ One `run_code` contract, the backend a deploy-time choice |
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
- DNS filtering. The resolver answers public names from every sandbox, so
  data can leave in DNS lookups. A Route 53 Resolver DNS Firewall on the
  VPC is the candidate fix; whether it covers the MicroVM connector's
  lookups, the `nitro` tasks' lookups and the AgentCore runtime's resolver
  is unverified on all three.
- Confidential mode and attestation (`CONFIDENTIAL_SANDBOX`, KMS key release
  on image measurement). The `nitro` backend runs `ISOLATED_SANDBOX` only.
- EKS. Nitro Sandboxes on EKS need a 1.36 cluster (a sandbox node group, or
  EKS Auto Mode); the sample uses ECS Managed Instances for the same
  boundary (ADR-0004).
- Languages other than Python 3.
- GPU work. Nitro Sandboxes have no GPU passthrough.
- AgentCore session storage across stop and resume. Files in `/work` live
  for the sandbox's life only. With `agentcore.sessionFiles` on, the
  session's S3 prefix persists across session restarts, because the
  session id is derived from the tenant (ADR-0009).
- Per-tenant sandbox sizing or tiers. Every tenant gets the same size.
- Tenant data deletion on offboarding. Offboarding stops the tenant's
  sandboxes and deletes its registry rows (§5.2); the tenant's input,
  output and session objects are the vendor's to delete.
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

**P-3. Code in a sandbox can reach nothing but its reply.** No connection
to the internet or another sandbox, no credentials and no metadata beyond
§3.4 "Code holds", and no AWS API beyond what the backend itself requires
(C-2). DNS lookups are the stated exception (C-3). Where a backend cannot prove one of these,
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
answer in time, and the sandbox ends at `sandboxMaxLife`: by the platform
on `microvm` and `agentcore`, by the reaper on `nitro`, because ECS has no
task life limit. Code runs as a user that cannot touch the runner, so it
cannot defeat the first cap (ADR-0010).

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
| `createEndpoints` | `boolean` | `true` | create the §3.7 sandbox endpoints; `false` when a supplied `vpc` already has them, which then must meet §3.7 |
| `inputBucket` | `s3.IBucket` | created | the bucket with `inputs/<tenant>/` |
| `microvm.memoryMiB` | `number` | 1024 | MicroVM image minimum memory |
| `nitro.cpu`, `nitro.memoryMiB` | `number` | 512, 1024 | task size |
| `nitro.instanceTypes` | `string[]` | `['m7i.xlarge']` | capacity provider instance requirements, and the architecture of the `nitro` runner image. The default is the one type run end to end; `m7g.large` (Graviton, 2 vCPU) reports Nitro Enclaves support and is likely cheaper, but has not been run on ECS. Synth checks each type against a static table of types with Nitro Enclaves support (Intel types need 4 vCPU or more, so `m7i.large` is refused) |
| `nitro.minInstances` | `number` | 0 | 0 keeps idle cost at zero; after scale-in a new sandbox takes about 30 s, and calls return `sandbox_starting` until it is ready. Warm starts of 11 to 18 s also often exceed `startWait` |
| `agentcore.sessionFiles` | `boolean` | `false` | grant the runtime role `sessions/${aws:AgentCoreRuntimeSourceSid}/*` on the input bucket (ADR-0007) |

Timing budget: the tool Lambda timeout is set to
`5 s + startWait + runTimeout + 10 s` (fetch, start wait, run, stop on
overrun), at most 90 s with `ingress` set and 120 s without. Through
`agentic-runtime-isolation`'s `api-gateway` ingress, the agent's whole
turn shares that ingress's fixed 120 s integration timeout, so a tool
budget above 90 s leaves the agent no time (S-11). The `+ 10 s` margin
is what makes the tool return `timedOut` itself: per the AgentCore
Gateway documentation, a Lambda error reaches the agent only as a generic
`isError` result, with no code. Validation at synth fails on: an unknown backend,
empty `backends`, `defaultBackend` not enabled, `runTimeout` outside 1 s to
60 s, a budget above the cap, `sandboxMaxLife` above 8 h, `sandboxIdle`
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
| Start | `RunMicrovm` with no `executionRoleArn`, `egressNetworkConnectors` = the sample's VPC connector only (omitting it gives the Lambda-managed `INTERNET_EGRESS`), `ingressNetworkConnectors` = `HTTP_INGRESS`, `maximumDurationInSeconds` = `sandboxMaxLife`, idle policy `{autoResumeEnabled: true, maxIdleDurationSeconds: sandboxIdle, suspendedDurationSeconds: 1800}`, `logging: {disabled: {}}`, `runHookPayload` = `{"nonce": …, "tenant": …}` (the API caps it at 4096 characters), delivered to the runner's `/run` lifecycle hook on port 9000 | `RunTask` with the tool tenant role, task definition with no `taskRoleArn`, sandbox subnets, the task security group, tags `TenantId`, container override env `RUNNER_NONCE` | none; the session starts on the first `InvokeAgentRuntime`, whose job carries the nonce; the runner adopts the first nonce it sees in that session |
| Address | MicroVM endpoint plus a fresh auth token per call, port 8080 only, 5-minute expiry | task ARN, and the ENI private IP once `ready` reads it, port 8443 | runtime ARN plus `runtimeSessionId` = `rc-` + hex SHA-256 of the tenant id (67 characters, ADR-0009) |
| Ready | `GetMicrovm` `RUNNING`, then `/ping` answers; `bootId` from `/ping` (made in the `/run` hook, so it survives suspend and resume) | `DescribeTasks` `RUNNING` gives the ENI private IP, written to `address` with a version condition; then `/hello` answers; `bootId` from `/hello` | always ready; `bootId` from each result (made at the session's first job, because every session of a runtime version starts from the same restored process) |
| Identity check | runner returns `HMAC(nonce, runId)` with the result; the tool checks it | over TLS on 8443 (ADR-0010): the tool sends `POST /hello` with a challenge; the runner answers `HMAC(nonce, challenge ‖ certFingerprint)`; the tool checks it against the connection's certificate and sends the job on the same connection | runner returns `HMAC(nonce, runId)`; a runner with no nonce adopts the job's, so a restart is detected by `bootId`, not by the nonce |
| Run | `POST /run` with `X-aws-proxy-auth`, HTTPS | `POST /run` on the checked TLS connection | `InvokeAgentRuntime`, HTTPS, payload is the job |
| Stop | idle policy suspends, then the platform ends it after 30 suspended minutes or at `sandboxMaxLife`; `TerminateMicrovm` on drain, offboard or overrun | reaper `StopTask` after `sandboxIdle` idle, or when the task's own `startedAt` is older than `sandboxMaxLife`; `StopTask` on drain, offboard or overrun | runtime `lifecycleConfiguration` `idleRuntimeSessionTimeout` = `sandboxIdle`, `maxLifetime` = `sandboxMaxLife`; `StopRuntimeSession` on drain, offboard or overrun |
| Start cap | 20 s (measured P90 2.8 s) | 5 min (measured 31–34 s from zero instances in two runs that may have used a pre-prepared instance, 11–18 s warm; the cap leaves room for a full instance launch) | 30 s (measured 2–2.5 s for a new session) |
| Start and stop: enforced or filtered | filtered: the tool role may run, call and stop any MicroVM of the image (MicroVM actions authorize against the image only; a per-tenant tag condition would need an image per tenant) | enforced: `RunTask` requires `aws:RequestTag/TenantId` = `${aws:PrincipalTag/TenantId}`, `StopTask` requires `aws:ResourceTag/TenantId` = `${aws:PrincipalTag/TenantId}` (ADR-0014) | filtered: one runtime; the session id is derived by code (the actions support no session-id condition) |
| Call: enforced or filtered | filtered by address; the nonce check rejects a wrong MicroVM | filtered by address; the nonce check rejects a wrong task before any job bytes are sent | filtered by session id; `bootId` detects a restarted session |
| Code holds | no credentials; the link-local metadata service answers with the Region, the AZ id and a per-MicroVM key, and holds no credentials without an execution role | no credentials: no task role; the execution role is used by the ECS agent outside the sandbox; the task metadata endpoint gives the task ARN, cluster, image and log group; IMDS does not answer | the runtime role's credentials from IMDSv2 (§6.2 C-2) |
| Egress | VPC connector into sandbox subnets with no route and a security group with no egress | sandbox subnets with no route; task security group egress only to the Logs endpoint (`awslogs` leaves through the task ENI; the instance pulls the image) | sandbox subnets; runtime security group egress only to the ECR, S3 and Logs endpoints, each with a scoped endpoint policy (§3.7) |
| DNS | the VPC resolver answers public names | the VPC resolver answers public names | the runtime's resolver answers public names |

A call that fails the identity check is treated as a dead handle (§4.1
step 2), never retried on the same address.

### 3.5 The runner (ADR-0010)

One Python program, packaged as a MicroVM image code artifact (a
Dockerfile on the AL2023 base image, ARM_64) and as container images: one
for `nitro`, in the architecture of `nitro.instanceTypes`, and an arm64
one for `agentcore`. Both container images come from one `COPY`-only
Dockerfile on a Python base image pinned by digest, which builds either
architecture without emulation. The `nitro` runner makes its key and
certificate with the `openssl` binary that the Python base image carries,
so no compiled wheels are copied in. The
AgentCore backend is a container runtime (ADR-0015). The runner process
runs as root inside the VM; it never runs tenant code as root.

Build-time egress. `AWS::Lambda::MicrovmImage` requires an egress
connector for the image build, and the build runs with the Lambda-managed
`INTERNET_EGRESS`: it pulls the base layer and any packages the
Dockerfile installs. This is a supply-chain surface of the build, owned by
the vendor's Dockerfile, separate from runtime egress, which never reaches
the internet. The Dockerfile pins its base image by digest and installs
only `python3` at an exact package version, which the AL2023 minimal base
lacks.

Per-sandbox values. `microvm` and `agentcore` start sandboxes from a
snapshot, so anything the runner makes at process start is shared by
every sandbox restored from that snapshot. The runner therefore makes its
`bootId` and adopts its nonce when the sandbox first becomes one tenant's:
in the `/run` lifecycle hook on `microvm`, at process start on `nitro`
(each task is a fresh container), and at the session's first job on
`agentcore`. Every random value comes from `os.urandom` or `secrets`,
never from a generator a snapshot could restore with its state. On
`nitro` it also makes a key pair and a self-signed certificate at process
start, held only in memory. The nonce comes from the `/run` hook payload,
the `RUNNER_NONCE` variable, or the first AgentCore job, and the runner
removes it from the environment it hands to code.

It reads `SANDBOX_MEMORY_MIB` (1024 on `microvm` and `nitro`, 8192 on
`agentcore`, the default session allocation) for its limits. It listens on
8080 (HTTP: MicroVM proxy, AgentCore contract) or 8443 (TLS: `nitro`), and
on `microvm` also on 9000 for the lifecycle hooks. The 9000 listener
accepts the `/run` hook's nonce once and ignores every later `/run` hook,
answers `/suspend` and `/resume`, and serves no jobs; the tool's auth
tokens allow port 8080 only, so a caller cannot reach 9000. Until the
`/run` hook has delivered the nonce, `/ping` reports no `bootId` and the
8080 job route refuses every job, and the tool treats a `/ping` without
`bootId` as not ready. No tenant code runs before the nonce is set, so
code can never post its own `/run` hook first. It serves:

- `GET /ping`: `{"status":"Healthy","bootId":…}` (AgentCore contract).
- `POST /hello` (`nitro`): returns `bootId`, the certificate fingerprint
  and `HMAC(nonce, challenge ‖ certFingerprint)`.
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
| Tool role (function) | assume the tool tenant role with a `TenantId` tag; `lambda:RunMicrovm`, `GetMicrovm`, `TerminateMicrovm`, `CreateMicrovmAuthToken` on the sample's image (every MicroVM action authorizes against the image ARN; there is no MicroVM ARN), `lambda:PassNetworkConnector` on `HTTP_INGRESS` and the sample's connector only, so a start without the connector, which would get `INTERNET_EGRESS`, is refused; `bedrock-agentcore:InvokeAgentRuntime`, `StopRuntimeSession` on the sample's runtime; `ecs:DescribeTasks` on the cluster; `kms:GetPublicKey` on the context key | read the bucket or the registry directly; `ecs:RunTask` or `StopTask` |
| Tool tenant role | `s3:GetObject` on `inputs/${TenantId}/*`, `s3:PutObject` on `outputs/${TenantId}/*`, registry items with `dynamodb:LeadingKeys` = `TENANT#${TenantId}`, `ecs:RunTask` on the pinned task definition revision ARN only, with the request tag condition and `ecs:cluster` = the sample's cluster; `ecs:TagResource` on `task/<cluster>/*` with the request tag condition and `ecs:CreateAction` = `RunTask` (the action has no `ecs:cluster` key, and this stops the role retagging existing tasks); `ecs:StopTask` with the resource tag condition and `ecs:cluster`; `iam:PassRole` on the task execution role | anything without its own tag; any other task definition or cluster |
| Task execution role | `ecr:GetAuthorizationToken` on `*` (the action takes no resource), `ecr:BatchGetImage` and `ecr:GetDownloadUrlForLayer` on the runner repository, Logs write on the task log group | everything else; never reachable by code (S-5) |
| AgentCore runtime role | `ecr:GetAuthorizationToken` on `*`, `ecr:BatchGetImage` and `ecr:GetDownloadUrlForLayer` on the runner repository, `logs:CreateLogGroup`, `CreateLogStream`, `PutLogEvents`, `DescribeLogStreams` on `/aws/bedrock-agentcore/runtimes/<runtimeName>-*` (the name is known at synth, and runtime names cannot contain `-`, so the prefix matches only this runtime; code can create extra groups under the prefix, which the cleanup resource removes); with `sessionFiles`, `s3:GetObject`, `s3:PutObject` on `sessions/${aws:AgentCoreRuntimeSourceSid}/*` and `s3:ListBucket` with an `s3:prefix` condition | everything else |
| Reaper role | read, update and delete every registry row; `ecs:ListTasks`, `DescribeTasks`, `StopTask` on the cluster; `lambda:ListMicrovms` on `*` (it takes no resource; the call filters by image), `GetMicrovm`, `TerminateMicrovm` on the image; `StopRuntimeSession` on the runtime | the input bucket |
| Drain role | the reaper role | the input bucket |
| MicroVM image build role | trust `lambda.amazonaws.com`; `s3:GetObject` on the runner code artifact; `logs:CreateLogGroup`, `CreateLogStream`, `PutLogEvents` on `/aws/lambda-microvms/<imageName>` | everything else |
| MicroVM connector operator role | trust `lambda.amazonaws.com`; `ec2:CreateNetworkInterface` on network interfaces, the sandbox subnets and the connector security group; `ec2:CreateTags` on network interfaces with `ec2:ManagedResourceOperator` = `network-connectors.lambda.amazonaws.com` | everything else |
| Log cleanup role (the log cleanup resource and the task log drain) | `logs:DescribeLogGroups`; `logs:DeleteLogGroup` on `/aws/bedrock-agentcore/runtimes/<runtimeName>-*`, on `/aws/lambda-microvms/<imageName>` and on the task log group | every other log group; everything else |

The runtime and execution roles reach no tenant data.

### 3.7 Network (ADR-0012)

One VPC in two AZs, created unless `vpc` is given.

| Subnets | Route table | Used by |
|---|---|---|
| Tool | default route to one NAT gateway | the tool Lambda, the reaper, the drain; the ECS Managed Instances' primary ENIs |
| Sandbox | local only, no default route | `nitro` task ENIs, the `agentcore` runtime ENIs, the `microvm` VPC egress connector |

Endpoints in the sandbox subnets, each with a security group and a policy.
Interface endpoints use private DNS, which applies to the whole VPC, so
anything in the tool subnets that calls ECR or Logs also reaches these
endpoints. Their security groups therefore admit the sandbox groups and
the instance group; the tool, reaper and drain call neither ECR nor Logs
APIs directly (their own logs go through the Lambda service). The policies
name only the sample's repository and log groups. The instances pull the
runner image from that repository, through these endpoints or the NAT,
and the policies admit that pull on either path.

| Endpoint | Policy allows | Present when |
|---|---|---|
| S3 gateway (sandbox route table only) | `s3:GetObject` on the ECR layer bucket `prod-<region>-starport-layer-bucket/*`; with `sessionFiles`, `s3:GetObject`, `s3:PutObject`, `s3:ListBucket` on the input bucket's `sessions/` prefix (the endpoint admits every `sessions/*` key; the role policy separates sessions) | `agentcore` |
| ECR `api` and `dkr` | `ecr:GetAuthorizationToken` on `*` (account-wide by design, useless without a pull grant); `ecr:BatchGetImage`, `ecr:GetDownloadUrlForLayer` on the runner repository | `agentcore` |
| CloudWatch Logs | `logs:CreateLogStream`, `logs:PutLogEvents` on the task log group; `logs:CreateLogGroup`, `CreateLogStream`, `PutLogEvents`, `DescribeLogStreams` on `/aws/bedrock-agentcore/runtimes/<runtimeName>-*` | `nitro`, `agentcore` |

Security groups:

| Group | Ingress | Egress |
|---|---|---|
| Tool | none | all (through the NAT) |
| ECS instance | none | 443 to all (through the NAT and the endpoints) |
| `nitro` task | 8443 from the tool group | the Logs endpoint group only |
| `agentcore` runtime | none | the ECR and Logs endpoint groups, and the S3 prefix list on 443 |
| `microvm` connector | none | none |
| Endpoints | 443 from the sandbox groups and the ECS instance group | none |

Tasks cannot reach each other: no task group admits another. The tool
reaches MicroVM endpoints, AWS APIs and the AgentCore data plane through
the NAT. The integration test tries a presigned PUT to a bucket outside
these policies through the S3 endpoint, and expects a refusal.

### 3.8 Observability and cost (ADR-0013)

The tool writes one structured line per call with `process.stdout.write`
(top-level fields, so Logs Insights and Contributor Insights can key on
them): `tenantId`, `backend`, `handle` (MicroVM id, task ARN or
`runtimeSessionId`), `runId`, `sandbox` (`started` or `reused`),
`outcome` (tool error code or `ok`), `exitCode`, `timedOut`, `durationMs`,
`startMs`, `inputBytes`, `outputBytes`, and on a failed start
`stoppedReason`. Each sandbox gets exactly one stop line, with `tenantId`,
`backend`, `handle` and `sandboxSeconds` (`stoppedAt - createdAt`). It is
written by whoever moves the sandbox's row out of `STARTING` or `READY`
with a successful conditional write: the tool (dead handle, overrun,
failed start), the reaper, the drain, or the offboard function. A writer
that finds the row already `FAILED` or `STOPPING` writes none. A sandbox
with no row (an orphan the sweep or the drain stops: a handle-less
takeover, a crashed start, or a row TTL removed while the reaper was not
running) gets its line from the stopper, marked `orphan` = true, with
`tenantId` from the task's `TenantId` tag on `nitro`, or `unknown` on
`microvm`, whose MicroVMs take no tags. An `agentcore` orphan session gets no stop
line, because no API lists it; its cost still reaches the tenant through
AgentCore's usage logs (table below), so the `sandboxSeconds` ranking is
not complete for `agentcore`. On
`microvm` the line also carries `runningSeconds` and `suspendedSeconds`.
`sandboxSeconds` comes from `GetMicrovm` `terminatedAt - startedAt` when
the MicroVM is ended. `suspendedSeconds` comes from the row's
`suspendedMs` counter. On every backend, when a call first reaches the
sandbox at time `t`, its start write sets `lastUsedAt` = `t`, conditioned
on `attribute_not_exists(lastUsedAt) OR lastUsedAt = :read` (re-reading
once on a condition failure); on `microvm` the same write adds
`max(0, t - lastUsedAt - sandboxIdle)` to `suspendedMs`, so each gap is
added once. Step 4 moves `lastUsedAt` to the end of the run with a
monotonic condition, `lastUsedAt < :end`, and adds nothing. The stop adds
the final gap up to `terminatedAt` (or the stop time on other backends).
`runningSeconds` is the difference, clamped at 0. The line carries `estimated` = true,
because the API reports no per-state times and the counter assumes the
MicroVM suspends exactly at `sandboxIdle`.
Two Contributor Insights rules rank tenants by runs and by
`sandboxSeconds`. With `perTenantMetrics`, the
tool also emits EMF metrics `Runs`, `Errors`, `RunDuration`,
`SandboxSeconds` with dimensions `TenantId` and `Backend`; it is off by
default because the custom metric count grows with tenants.

Cost attribution per backend:

| Backend | Attributable by | Formula | Unattributed |
|---|---|---|---|
| `microvm` | `sandboxSeconds` per tenant from the registry (MicroVMs take no tags) | baseline rate × seconds running + suspended storage rate × seconds suspended | the image build |
| `nitro` | `TenantId` task tag with ECS split cost allocation data turned on (account setting) | Cost Explorer split of instance cost by task reservation | idle instance capacity, NAT and endpoints, apportioned by `sandboxSeconds` |
| `agentcore` | AgentCore's session-level usage logs, joined to the tenant through `runtimeSessionId` in the tool line | per-second vCPU and memory rates × the session's reported usage (consumption billing, no configured baseline) | none beyond the shared endpoints and NAT |

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
| `bootId` | the runner's boot id, from the first successful ready check or result (§3.4 Ready) |
| `state` | `STARTING` \| `READY` \| `STOPPING` \| `FAILED` |
| `retryAt` | epoch ms; while `FAILED`, no takeover before it (now + 30 s) |
| `createdAt`, `lastUsedAt`, `leaseUntil` | epoch ms; `leaseUntil` = start + the backend's start cap (§3.4) while `STARTING` |
| `suspendedMs` | `microvm` only; estimated suspended time so far (§3.8) |
| `expiresAt` | `createdAt + sandboxMaxLife`; the expiry the tool and the reaper use |
| `ttlAt` | `expiresAt` + 1 h, in epoch seconds; the TTL attribute, a backstop for a reaper that stopped running |
| `version` | number, incremented on every write |

Reads and writes use the tool tenant role, whose policy allows only items
with `dynamodb:LeadingKeys` = `TENANT#${aws:PrincipalTag/TenantId}`.

Reuse rule, per call (the tool):

1. Get the row (`version` = v).
   - `READY` and not expired: run on it (step 3).
   - `STARTING` and `leaseUntil` not passed: probe `ready` (§3.4 Ready),
     which may fill in `address` and `bootId` with `version = v`. When
     ready, update to `READY` with the version returned by the probe
     write (or `v` when the probe wrote nothing); run. When not ready
     within `startWait`, return `sandbox_starting` with
     `retryAfterSeconds`.
   - `STARTING` whose start failed (below): set `FAILED` with `retryAt`
     and `version = v`, stop the sandbox if it still runs, write the stop
     line, and return `sandbox_failed`. Whichever call or reaper run
     notices the failure does this.
   - `FAILED` before `retryAt`: return `sandbox_failed` with
     `retryAfterSeconds` from `retryAt`. After `retryAt`: step 2.
   - Missing, expired, `STOPPING`, or a handle-less `STARTING` row (below):
     step 2.

   A start has failed when its sandbox ended before its first successful
   ready or identity check (`nitro` task `STOPPED`, MicroVM `TERMINATING`
   or `TERMINATED`, whatever the reason, including a runner that exits at
   boot after the task reached `RUNNING`), or when the start cap ran out
   with the sandbox neither ended nor ready. While a `nitro` task is
   `PROVISIONING` or `PENDING` it is still starting. The reason
   (`stoppedReason`, `stateReason`, or `start_cap`) goes in the tool line.
2. Take over: put a `STARTING` row with a new nonce if the row is missing
   (`attribute_not_exists(PK)`) or `version = v`. On a condition failure,
   another call won: go back to step 1 once. The winner stops the handle it
   replaced, if any, then starts and records `handle` (and `address` when
   the start returns it), then probes as in step 1.
3. Run. A failed identity check, "not found", or a connection refusal marks
   the row dead: go to step 2 with the version just read. A call that has
   already waited for a start in this invocation does not wait again after
   a takeover: it returns `sandbox_starting`. A changed `bootId` means the
   sandbox restarted (on `agentcore`, the session under the same id): the
   tool rewrites the row with the new `bootId` and reports
   `sandbox` = `started`.
4. After the run, set `lastUsedAt` to the run's end with
   `attribute_exists(PK) AND handle = :h AND lastUsedAt < :end`, so a row
   deleted or replaced meanwhile is not recreated and `lastUsedAt` only
   moves forward, whichever call wrote last (a `busy` call's start mark
   included).

   Every conditional write after the first in one call uses the `version`
   returned by that call's own last successful write, not the step 1
   read: the start write, the `READY` update, step 4 and step 5 each bump
   `version`.
5. If the runner does not answer by `runTimeout` + 5 s, set `STOPPING`
   with the call's current version (re-reading once if another call moved
   it, and stopping anyway if the handle is unchanged), stop the sandbox, and return a result with
   `timedOut` = true.

The reaper, every 5 minutes, writes the row before any stop with
`version = :seen`, so a call that updated the row meanwhile wins: `FAILED`
with `retryAt` when the row is a failed start (step 1), `STOPPING`
otherwise. It:

- stops `nitro` sandboxes in `READY` rows with `lastUsedAt` older than
  `sandboxIdle`; for a `STARTING` row it applies the tool's step 1 rule
  (mark a failed start `FAILED`, leave a starting one alone), and it leaves
  `FAILED` rows to the tool until `expiresAt`;
- stops every task tagged by the sample whose own `startedAt` is older than
  `sandboxMaxLife`, with or without a row (the third cap on `nitro`);
- checks each `READY` `microvm` row with `GetMicrovm`; when the MicroVM is
  gone or terminated (the platform ended it), writes the stop line and
  deletes the row (`FAILED` and `STOPPING` rows already have theirs);
- deletes rows past `expiresAt` after stopping their handle;
- sweeps orphans with no matching row: tasks tagged by the sample and
  MicroVMs of the image. AgentCore has no API that lists a runtime's
  sessions, so an orphan session (its row lost) ends at
  `idleRuntimeSessionTimeout`, at `maxLifetime`, or when the runtime is
  deleted.

DynamoDB TTL runs on `ttlAt`, an hour after `expiresAt`, so the reaper,
every 5 minutes, always handles an expired row first and writes its stop
line.

A row with no `state` (a partial write) is treated as missing. A
`STARTING` row with no `handle` older than `startWait` plus the tool
timeout is handle-less: its start died before recording what it started,
so it is taken over at once and the orphan sweep stops whatever it was.
This is the only takeover of a `STARTING` row; every other unresolved
start becomes `FAILED` and backs off. Starts pass an idempotency token
derived one way from the nonce, the first 32 hex characters of
SHA-256(`"start" ‖ nonce`) (`RunTask` `clientToken`, `RunMicrovm`
`clientToken`), so a retried start call launches nothing new and
CloudTrail, which records the token, never sees the nonce. The tool runs a
pinned task definition revision ARN, never the family's latest, and the
tool tenant role allows `RunTask` on that ARN only (§3.6).

### 4.2 Input and output objects

| Key | Written by | Read by |
|---|---|---|
| `inputs/<tenantId>/<name>` | the vendor or the tenant (the demo seeds it) | the tool, with the tool tenant role |
| `outputs/<tenantId>/<runId>.json` | the tool, when `saveOutput` is set | the tenant |
| `sessions/<sessionId>/*` | `agentcore` code, only with `sessionFiles`; one prefix per tenant, because the session id is derived from the tenant (ADR-0009), and it persists across session restarts and offboarding | the same tenant's session |

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
| `sandbox_failed` | yes, after `retryAfterSeconds` | the sandbox ended before it served, or died mid-run (§4.1 failed starts) |
| `tool_failed` | no | any other fault (from `toolHandler`) |

A script that exits non-zero, times out or is killed is not a tool error: it
returns a result with `exitCode`, `timedOut` and its output.

### 5.2 `offboardTenant`

A Lambda function the vendor invokes with IAM (`lambda:InvokeFunction`),
input `{ "tenantId": … }`. It sets each of the tenant's rows `STOPPING`
with a version condition, stops the sandbox, deletes the row, and returns
the stopped handles. It is idempotent: a repeat call stops nothing and
returns the same shape. The caller removes the tenant's `run_code` grant
first, so no call can start a new sandbox in between. The control plane's
tenant delete script is the intended caller.

### 5.3 Teardown

A delete-time custom resource (the drain) runs before the cluster, the
runtime and the image are deleted, and the order matters. It stops every
handle in the registry, then every task and MicroVM the orphan sweep
finds, and waits until `ListTasks` shows every task `STOPPED` and
`ListMicrovms` shows every MicroVM of the image `TERMINATED` (at most 10
minutes). A MicroVM image cannot be deleted while MicroVMs of it are live
(running or suspended), and a capacity provider cannot be deleted while a
task is still stopping; in both cases CloudFormation fails the delete, the
second after a 20-minute stall. A `StopTask` takes 45 to 78 s, so the runner
exits at once on `SIGTERM`. AgentCore sessions in rows are stopped with
`StopRuntimeSession`; sessions with no row end within about 20 s of the
runtime's delete, which takes about 200 s.

Log groups. The construct owns the task log group and a log drain waits
90 s on delete before it goes, as agentic-runtime-isolation ADR-0019 does.
AgentCore creates the runtime's groups itself, after deploy, under
`/aws/bedrock-agentcore/runtimes/<runtimeName>-`, so the construct cannot
own them. Instead a cleanup custom resource, on which the runtime depends,
takes that prefix as a property (known at synth, no reference to the
runtime), is deleted after the runtime, and then deletes every group under
the prefix. The session usage logs that §3.8 uses for `agentcore`
cost are delivered (`AWS::Logs::DeliverySource`, `DeliveryDestination`,
`Delivery`) to a log group the construct owns. AgentCore names its groups
`/aws/bedrock-agentcore/runtimes/<runtimeName>-<10-character id>-DEFAULT`,
and code with the runtime role can add more under the same prefix; the
cleanup resource deletes them all. The MicroVM image build writes to
`/aws/lambda-microvms/<imageName>`, which the service creates; the same
cleanup resource takes that name as a second property (known at synth),
is ordered after the image, and deletes it once the image is gone.

Names. Every resource with an explicit name gets it from the construct
path through one sanitiser per service, which keeps the service's charset,
truncates, and appends 8 hex characters of a hash of the path:

| Resource | Charset and length |
|---|---|
| AgentCore runtime | `[a-zA-Z][a-zA-Z0-9_]{0,47}` |
| ECR repository (`emptyOnDelete` on) | lowercase, `[a-z0-9._/-]`, 256 |
| ECS cluster and capacity provider | `[a-zA-Z0-9_-]`, 255 |
| MicroVM image and network connector | `[a-zA-Z0-9_-]`, 64 (the connector's ARN uses a generated `nc-` id, so reference it with `GetAtt Arn`) |
| Task log group, usage-log group | `[\w./#-]`, 512 |
| Usage-log `DeliverySource` and `DeliveryDestination` | `[\w-]`, 60, unique per account and Region |
| Two Contributor Insights rules | `RuleName`, 128 |

The `synth` unit test asserts that every one of these names is unique and
matches its charset when two instances share a stack.

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
- For `microvm`: a quota increase on "maximum allocated ARM_64 MicroVM memory" (one quota per architecture; the runner image is ARM_64)
  (2048 MiB per Region by default, running and suspended MicroVMs both
  count), which fits only two 1024 MiB sandboxes. A tenant holds
  `microvm.memoryMiB` of quota from its first call until 30 suspended
  minutes after `sandboxIdle`, so size the quota as `memoryMiB` × the
  tenants active within `sandboxIdle` + 30 minutes. `RunMicrovm` is
  limited to 5 calls per second per account.
- For `nitro`: nothing beyond the stack; the instance role is named
  `ecsInstanceRole*`, because the managed infrastructure policy passes only
  roles with that name.
- For per-tenant cost on `nitro`: ECS split cost allocation data and the
  `TenantId` cost allocation tag turned on in the account.

### 6.2 What the sample promises

- C-1: Code run for tenant A never runs in a sandbox started for tenant B.
- C-2: On `microvm` and `nitro`, code gets no AWS credentials. On
  `agentcore`, code can read the runtime role's credentials, which reach
  only ECR pull on the runner repository and Logs writes on the runtime's
  log group, plus its own session prefix when `sessionFiles` is set.
- C-3: Code cannot open a connection to the internet or to another sandbox.
  Its only network paths are the reply to the tool, the scoped endpoints of
  §3.7 (the Logs endpoint on `nitro`; ECR, S3 and Logs on `agentcore`),
  the backend's metadata service (§3.4 "Code holds"), and DNS lookups
  through the resolver. DNS resolves public names on every
  backend, so a script can encode data in lookups; the sample does not
  close that channel (§1.2, threat model).
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

The demo stack writes the parameter from the construct's read-only
properties; the construct writes no parameter (standard §4.5), and the
integration stack publishes nothing (agentic-runtime-isolation ADR-0042), so
its two construct instances cannot collide on it.

Construct: `UntrustedCodeSandboxes` and its props, plus the exports in §3.3.
The `ARCHITECTURE.md` namespace row and samples-map row are added in the
pull request that ships the sample.

## 7. Spikes

Each spike runs in a non-production test account in eu-central-1, measures
deploy and destroy time, and cleans up on exit.

| Id | Question | Decides |
|---|---|---|
| S-1 | Do `AWS::Lambda::MicrovmImage` and `AWS::Lambda::NetworkConnector` deploy from a zip in CloudFormation, how long does `CREATING` take, and does stack delete wait for running MicroVMs? | `microvm` packaging, deploy time, drain order |
| S-2 | With only a VPC egress connector into a dead-end subnet, can code reach the internet, `169.254.169.254`, or another MicroVM's endpoint? Contrast row: no connector at all (expected: internet reachable) | C-3 on `microvm` |
| S-3 | Do `RunMicrovm` and `CreateMicrovmAuthToken` accept tags or tag conditions, so the tool role can be limited per tenant? | enforced or filtered start (§3.4), cost tag |
| S-4 | Cold `RunMicrovm` to first `/run`, and resume after suspend: P50 and P90 over 20 runs. Does the runner as root and code as uid 1001 work on the AL2023 base image? | `startWait`, runner model |
| S-5 | In an `ISOLATED_SANDBOX` task with no task role, can code read the execution role's credentials, the ECS task metadata endpoint, or IMDS? Does the container start as root and may the runner drop code to uid 1001? | C-2 on `nitro`, runner model |
| S-6 | Does the task pull its image through its own ENI or the instance's? With sandbox subnets and a task group open only to the Logs endpoint, can code reach the internet or another task? Do `awslogs` logs arrive? | C-3 on `nitro`, endpoint set |
| S-7 | `RunTask` to `RUNNING` on a warm instance, and from zero instances; idle instance cost; is a stopped task's private IP reused within an hour? | `nitro.minInstances`, ADR-0010 |
| S-8 | Does `InvokeAgentRuntime` support a condition on the session id, so the tool role can be limited per tenant? | enforced or filtered call (§3.4) |
| S-9 | Does a V2 runtime in VPC mode with the §3.7 endpoints and policies start, pull, refresh and log? Can its code reach the internet or PUT to another bucket through the S3 endpoint? Does deleting the runtime end its live sessions, and how long does the delete take? | C-3 on `agentcore`, drain |
| S-10 | With the §3.6 runtime role, what can code do with the metadata endpoint's credentials, and does `aws:AgentCoreRuntimeSourceSid` scope the `sessionFiles` grant to one session? Does the container start as root and may the runner drop code to uid 1001? | C-2 on `agentcore`, ADR-0007, runner model |
| S-11 | Does the tools gateway allow a tool Lambda timeout of 120 s, and what does the agent see past it? | timing budget |
| S-12 | Can the integration test call `run_code` through the tools gateway with a transaction token without an agent in between, as a consumer could? | §8 drive path |

### 7.1 Spike results, S-1 to S-12 (2026-11-18, a non-production test account, eu-central-1)

S-1 to S-10 ran against throwaway stacks on one shared VPC laid out as
§3.7. S-11 and S-12 were answered from the AgentCore documentation and
`agentic-runtime-isolation`'s code, because no ingress was deployed.
Every stack was removed; only service-created log groups were left (the
AgentCore runtime groups and the MicroVM image build group), which the
sample's log cleanup resource deletes (§5.3). The decisions are recorded
in ADR-0015. The last column names what each spike did not test; the §8
step that covers a gap is in brackets.

| Id | Result | Changed | Not tested |
|---|---|---|---|
| S-1 | `AWS::Lambda::MicrovmImage` and `AWS::Lambda::NetworkConnector` deploy from a zip. Stack create 308 s (image 120 s, connector 254 s, in parallel); a code update 157 s. The image delete fails at once while a MicroVM of it runs or is suspended; the connector delete succeeds even with MicroVMs on it. After the MicroVMs were terminated, the delete took 92 s. Names: `[a-zA-Z0-9_-]`, 64; the connector ARN uses a generated id. A security group with no egress needs a placeholder rule in CloudFormation | §5.3 drain order, §5.3 names | which of a RUNNING or a SUSPENDED MicroVM blocks the image delete (the drain waits for both to end); what a running MicroVM's network does after its connector is deleted |
| S-2 | With only the VPC connector, code reached no internet host, no peer MicroVM and no interface endpoint. With no egress connector the MicroVM got `INTERNET_EGRESS` and reached the internet. Still open with the connector: DNS to the VPC resolver (public names resolve), and the link-local metadata service (Region, AZ id, a per-MicroVM key; no credentials without an execution role). The hook port 9000 answers only to a token that allows it | §3.4 Code holds, Egress, DNS; C-3; §1.2 | an actual DNS-tunnel exfiltration; only resolution and TCP 53 reach were checked |
| S-3 | `RunMicrovm` and `CreateMicrovmAuthToken` take no tags and no request-tag condition. Every MicroVM action authorizes against the image ARN; there is no MicroVM ARN, and the only key is the image's `aws:ResourceTag`. `lambda:PassNetworkConnector` is needed for every connector passed, including `HTTP_INGRESS`, and for `INTERNET_EGRESS` when the egress connector is omitted | §3.4 start filtered; §3.6 tool role; §3.8 no MicroVM tag | `TerminateMicrovm` was checked only in the allowed case |
| S-4 | Cold start to first `/run` P50 2.50 s, P90 2.82 s (n = 20, the connector adds nothing measurable). Resume P50 0.56 s, auto-resume by request 0.62 s (n = 5). The runner is PID 1 as root; a child drops to uid 1001 and cannot regain root or signal the runner. `bootId` survives suspend and resume. `runHookPayload` reaches the `/run` hook, capped at 4096 characters. `GetMicrovm` reports `startedAt`, `terminatedAt`, `stateReason`, no suspend times and no tags. Default memory quota 2048 MiB per Region | §3.4 start cap and Start; §6.1 quota | idle auto-suspend after `maxIdleDurationSeconds` and expiry at `maximumDurationInSeconds` [`microvm-stop`, `max-life`]; the execution-role path |
| S-5 | In an `ISOLATED_SANDBOX` task with no task role: no credential variables, the credentials endpoint returns 404, IMDS v1 and v2 do not answer (timeout), the task metadata endpoint returns only task, cluster, image and log fields. The container starts as root; a child drops to uid 1001 | C-2 holds | the `ECS_AGENT_URI` address; vsock and other host channels; `CONFIDENTIAL_SANDBOX` |
| S-6 | The instance pulls the image: a task with no security group egress at all pulled a new digest and started. `awslogs` leaves through the task ENI (logs were held 48 s until 443 to the Logs endpoint was allowed). Code reached only the endpoint addresses; no internet, no other task | §3.4 Egress; §3.7 `nitro` group and endpoints | the scoped §3.7 endpoint policies (the shared network's policies were used) [`no-egress`]; which path the instance used for ECR |
| S-7 | `RunTask` to `RUNNING`: 31 to 34 s from zero instances, 11 to 18 s warm (median 13.4 s). Scale-in 131 s after the last task with `ScaleInAfter` 120. `m7i.large` does not support Nitro Sandboxes; `m7i.xlarge` does, at $0.27 per instance-hour including the management fee. `StopTask` 45 to 78 s. Twelve tasks got twelve distinct IPs (reuse not seen, not ruled out). The same `clientToken` returned the same task. A capacity provider delete fails while a task is still stopping, after a 20-minute stall | §3.3 `nitro.instanceTypes`; §3.4 start cap; §5.3 drain order | `m7g.large` on ECS (EC2 reports it supported, but the probe image was amd64); cold starts under load or in another Region, since the two cold starts may have used a pre-prepared instance; `clientToken` reuse after the task stopped; whether a still-running idle instance blocks the capacity provider delete [`teardown`]; multi-AZ placement (every run used one sandbox subnet) |
| S-8 | `InvokeAgentRuntime` and `StopRuntimeSession` support only `aws:ResourceTag`; a session-id condition never matched. No API lists a runtime's sessions | §3.4 call filtered (ADR-0009) | an `aws:ResourceTag` condition on invoke and stop |
| S-9 | A V2 container runtime in the §3.7 network reached `READY` in 201 to 204 s; an update took 200 s. Direct code deployment failed under the §3.7 S3 endpoint policy and needed about 9 minutes when it worked. HTTPS out failed; a presigned PUT to a bucket outside the endpoint policy returned 403. Public DNS names resolve. A new session answers in 2.0 to 2.5 s, a warm one in 0.5 to 0.7 s. Deleting the runtime takes about 200 s; a live session stops 17 to 21 s after the call. Log groups `/aws/bedrock-agentcore/runtimes/<name>-<id>-DEFAULT` stay after the delete | §3.5 container only; C-3; §5.3 | CloudFormation deployment of the runtime (the CLI was used); runtime logging with the Logs endpoint removed (log delivery did not use the customer ENI); which AWS bucket direct code deployment reads |
| S-10 | Credentials come from IMDSv2. The runtime role reached only its own repository, its log prefix and, with `sessionFiles`, its own session prefix; session X was refused `sessions/Y/`. `logs:DescribeLogGroups` at the prefix is refused and not needed. A container starts as root and drops a child to uid 1001; a direct-code runtime runs as uid 991 and cannot. Sessions of one runtime version report the same process start state | §3.4 Ready; §3.5; §3.6 runtime role | P50 and P90 over 20 runs (5 samples each); IMDS `tags/`; whether code in one AgentCore session can reach another session's address [`no-egress`, recorded as unverified in the threat model if no address can be found] |
| S-11 | The gateway allows a 15-minute invocation; a tool Lambda timeout reaches the caller as a generic `isError` result. `agentic-runtime-isolation`'s `api-gateway` ingress cuts every turn at a fixed 120 s | §3.3 timing budget | a tool Lambda that times out (the error shape is from the documentation's access-denied example) [`runaway`] |
| S-12 | A direct `tools/call` works with a token minted by a test-only Lambda that the producer's own test grants `kms:Sign`. A consumer cannot sign for an ingress it does not own | §8 driver | whether a minted token naming an agent that is not deployed is accepted |

## 8. Integration test outline

Driver: the CDK CLI in `scripts/integ.sh` (ADR-0008). It reuses the
`TenantIdentity-shared-pool` fixture and never destroys it. It always
deploys its own `SharedIngress` in the integration app, with a test-only
token mint granted `tokenSigner.grantSign` (copied from
`agentic-runtime-isolation`'s integration test, a stated shortcut),
because no consumer can sign a transaction token for an ingress it does
not own (S-12). Behaviour steps call `run_code` directly on the tools
gateway (`tools/call`, bearer = a minted token). The `parse` step also
runs once through the producer's sample agent with its deterministic
`tool <target>/<tool> {json}` probe, so the grant and the 120 s ingress
path are exercised as a consumer would. It deploys one integration stack with two
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
| no-credentials | A's script tries IMDS, the ECS and AgentCore metadata endpoints, and `boto3` default credentials, then `GetObject` on B's invoice. `microvm` and `nitro`: no credentials are returned (the MicroVM metadata service answers but its `iam/security-credentials/` path gives 404; the ECS credentials path gives 404; IMDS on `nitro` gives no answer within the script's own 3 s timeout), and the `GetObject` fails. `agentcore`: credentials load, and every call outside C-2 is denied |
| no-egress | A's script tries HTTPS to `example.com`, TCP to B's sandbox address, and a presigned PUT to a test bucket outside the endpoint policy; all fail within 5 s |
| runaway | a loop, a `setsid` child that sleeps past the job, a kill of PID 1 and of the runner, and a disk fill: each returns `timedOut` or a non-zero exit, nothing of the job survives into A's next call, and A's next call works |
| dead-handle | stop A's sandbox out of band; A's next call returns `sandbox` = `started` |
| recycled-address | `nitro`: point A's row at B's live task address (test-only shortcut standing in for an IP that ECS reassigned), then call A: the identity check fails, nothing is sent to B's task, and A gets a fresh task |
| idle | after `sandboxIdle` (2 min) idle the driver invokes the reaper; A's `nitro` task is stopped, and the stop line carries `sandboxSeconds` |
| cold-from-zero | `nitro`: with no instance running, a new tenant `D`'s first call returns `sandbox_starting`; retries reuse the same task until it is `READY`, and no second task starts |
| max-life | `nitro`: the driver invokes the reaper with `maxLifeSeconds` of 60 while A's task runs a long job; the task is stopped and A's next call gets a fresh one. Test-only shortcut: the reaper honours `maxLifeSeconds` only when its environment has `RC_INTEG_OVERRIDES=1`, which the integration stack sets through a CDK escape hatch and no prop exposes |
| failed-start | `nitro` and `microvm`: for tenant `E` the tool passes the runner an exit-at-boot flag (test-only shortcut, honoured only with `RC_INTEG_OVERRIDES=1`); the driver retries `E`'s call until the first `sandbox_failed`, bounded by the backend's start cap; a reaper run then leaves the `FAILED` row alone and writes no stop line; a call before `retryAt` returns `sandbox_failed` and starts nothing (checked with `ListTasks` or `ListMicrovms`); a call after `retryAt` starts again; the tool line carries the reason, and exactly one stop line exists for the failed sandbox |
| microvm-stop | A's MicroVM, idle past `sandboxIdle` (2 min in the integration stack), shows `SUSPENDED`; the driver then ends it with `TerminateMicrovm` out of band and invokes the reaper; a stop line for A's MicroVM carries `sandboxSeconds`, `runningSeconds`, `suspendedSeconds` and `estimated` |
| synth | a unit test synthesises two construct instances in one stack and asserts that every §5.3 name is unique and matches its charset |
| session-files | `run-code-files`: A's session writes and reads its own `sessions/<sid>/`; a `GetObject` on B's session prefix is denied |
| telemetry | Logs Insights finds one tool line per call with the §3.8 fields and the right `tenantId` |
| forged | a direct Lambda invoke with a tampered tenant context returns `context_invalid` and starts nothing (test-only shortcut: only the gateway role may invoke the function in a real deployment) |
| offboard | after `C`'s grant is removed, `offboardTenant` for `C` stops its sandboxes and deletes its rows; a second call returns the same result with nothing stopped |
| teardown | `cdk destroy` with sandboxes still running for A and B; afterwards no MicroVM, task, instance or log group of the sample is left (the task and usage-log groups, `/aws/lambda-microvms/<imageName>`, and every `/aws/bedrock-agentcore/runtimes/<runtimeName>-*` group), and the runtime is gone (AgentCore lists no sessions, so "runtime gone" is the `agentcore` check) |

Preconditions, checked by the driver before it deploys: the account's
"maximum allocated ARM_64 MicroVM memory" quota (Service Quotas, looked up
by quota code, not by name) is at least
5 × `microvm.memoryMiB` (tenants A, B, C and E, plus a restart), and the
driver fails early naming the quota if not. Every behaviour step runs
once per backend unless it names one. `cold-from-zero` records the
`nitro` start time and fails if it comes within half of the start cap. The run
records cold and warm latency per backend and the deploy and destroy time.
