<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# Untrusted code sandboxes for agentic applications: specification

Status: built; the implemented state and its last integration run are in
[architecture.md](../architecture.md). Spikes S-1 to S-21 ran from
2026-11-18 to 2026-11-20 (§7.1 to §7.8).

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

The tool is the only component that chooses the tenant. On the gateway
entry it reads the tenant from the signed tenant context the tools gateway
hands it; on the standalone entry the vendor's own API passes a tenant id
it verified with its own identity provider (ADR-0017). The tool then fetches the
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
| Success criteria | 1/ Tenant B's data and sandbox are unreachable from tenant A's code on every backend. 2/ No backend lets the code open a connection to the internet (DNS lookups are the stated exception unless `dnsFirewall` is on, C-3), and no backend lets it reach an AWS API beyond the per-backend limits in C-2. 3/ A runaway script is stopped within its cap. 4/ One `run_code` contract, the backend a deploy-time choice |
| Risks | Lambda MicroVMs launched in 2026-06 and reached eu-central-1 in 2026-08 ([What's New, 2026-08](https://aws.amazon.com/about-aws/whats-new/2026/08/lambda-microvms-5-additional-regions/)); Nitro Sandboxes launched in 2026-11 ([What's New, 2026-11](https://aws.amazon.com/about-aws/whats-new/2026/11/nitro-sandboxes-eks-ecs-ec2/)). CDK has only L1 support for both, and some behaviour is documented in one line or not at all (§7). ECS Managed Instances bill for idle instances. A NAT gateway and interface endpoints bill per hour. |
| The unasked question | Does the code need a second machine at all? Short snippets that may hold what the agent holds can run in the agent's own session with `InvokeAgentRuntimeCommand`. The sample says when that is enough (§1.2) and does not build it. |

### Requirements

- R-1: One tool, `run_code`, with one input and output shape for every backend.
- R-2: The tenant comes only from a verified identity: the signed tenant
  context on the gateway entry, or the vendor's own verified token on the
  standalone entry. The agent and the code never name it.
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

### 1.2 What this sample does not do

- Egress allowlists. Code reaches no internet host on any backend; a sandbox
  that must reach one host is a later option (ADR-0003).
- DNS filtering by default. With `dnsFirewall` off (the default), the
  resolver answers public names from every sandbox, so data can leave in
  DNS lookups. Turning it on closes that path on all three backends
  (§3.9, ADR-0016). Narrowing the allow list to exact names, rather than
  AWS zones, is not done.
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

**P-2. The tenant is chosen once, from a verified identity.** On the
gateway entry the tool takes it from the signed context and refuses a
`tenantId` argument; on the standalone entry the vendor's API, which
holds invoke on `runCodeFunction`, passes the id it verified. No other
argument selects a tenant, a prefix or a session. The
`backend` argument picks which of the tenant's own sandboxes runs the code,
never whose. The sandbox knows its tenant only as a label for logs.

**P-3. Code in a sandbox can reach nothing but its reply.** No connection
to the internet or another sandbox, no credentials and no metadata beyond
§3.4 "Code holds", and no AWS API beyond what the backend itself requires
(C-2). DNS lookups are the stated exception unless `dnsFirewall` is on
(C-3). Where a backend cannot prove one of these,
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
| `run_code` tool | Lambda: a `ToolTarget` of `agentic-runtime-isolation` on the gateway entry, and with `standalone` the core `runCodeFunction` | Signed tenant context (gateway), verified IAM caller (standalone); tool-side TVM | the shared tool role (§3.6) |
| Tool tenant role | IAM, vended with the `TenantId` session tag | ABAC on `TenantId` | `inputs/<t>/*` read, `outputs/<t>/*` write, registry rows `TENANT#<t>`, `nitro` `RunTask` and `StopTask` on tasks tagged `<t>` |
| Input bucket | S3 | Tenant prefix | tenant files the code reads |
| Sandbox registry | DynamoDB | Tenant-keyed registry, optimistic version, start lease | one row per tenant per backend |
| Runner | Python HTTP server in every sandbox | Bytes in, bytes out; separate code user; start nonce | nothing |
| `microvm` backend | Lambda MicroVMs | VM per tenant, no execution role, VPC egress connector into a dead-end subnet | a MicroVM image, a network connector |
| `nitro` backend | ECS Managed Instances, `ISOLATED_SANDBOX` | VM per task, no task role | a cluster, a capacity provider, a task definition |
| `agentcore` backend | AgentCore Runtime V2, VPC network mode | Session per tenant on a narrow runtime | a runtime, its role, its log group |
| Network | VPC, two AZs (§3.7) | Dead-end sandbox subnets, endpoint policies | a public subnet with the NAT, tool subnets routed through it, sandbox subnets with no route out, scoped endpoints |
| DNS Firewall (optional) | Route 53 Resolver DNS Firewall | AWS-names-only DNS, blocked-lookup log | one rule group on the VPC, a query-log group (§3.9) |
| Reaper | Lambda on a 5-minute schedule | Idle stop, orphan sweep | the reaper role (§3.6) |
| Drain | CloudFormation custom resource | Stop everything on delete | the drain role (§3.6) |
| Offboard | Lambda, invoked with IAM | Stop a tenant's sandboxes | the reaper role (§3.6), which holds no instance action |
| Runner image copy (with `nitro` or `agentcore`) | CloudFormation custom resource, the ECR deployment library's provider | One copy per architecture into the construct's runner repository (ADR-0024) | the image copy role (§3.6) |

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

Nothing downstream of step 3 accepts a tenant id from the arguments; the
gateway handler refuses a `tenantId` argument with `invalid_argument`.

Standalone, with any identity provider (ADR-0017). The core construct,
`UntrustedCodeSandboxes`, needs no ingress and imports nothing from
`agentic-runtime-isolation`. With `standalone: true` it deploys
`runCodeFunction`, which the vendor's own API or tool invokes with IAM
(`lambda:InvokeFunction`),
passing `tenantId` with the §5.1 fields. The vendor takes that id only
from a token they verified with their own identity provider; nothing
else changes. The function has no resource policy, but inside the account
any principal whose identity policy allows `lambda:InvokeFunction` on it
(or on `*`) can call it and name any tenant, so the vendor keeps that
action out of broad policies (threat T-82). `runCodeFunction` vends the tool tenant role itself, with
one `sts:AssumeRole` and `sts:TagSession` carrying `TenantId`, so steps
4 and 5 above are the same on both paths. Steps 1 to 3 are the gateway
entry's (§3.3).

### 3.3 Deployment inputs (construct props)

Two entry points (ADR-0017):

| Entry | Import | Depends on `agentic-runtime-isolation` | Holds |
|---|---|---|---|
| core | the package root (`src/index.ts`) | no | `UntrustedCodeSandboxes`, the pattern |
| gateway | the `gateway` subpath (`src/gateway/index.ts`) | yes, as an optional peer dependency | `RunCodeToolTarget`, which puts the core behind the tools gateway |

`RunCodeToolTarget` props: `sandboxes` (the core construct, required),
`ingress` (`SharedIngress | SharedIngressRef`, required), `gateway`
(default `default`), `toolName` (default `run-code`). It deploys one more
Lambda whose handler wraps the same run logic in the producer's
`toolHandler`, sets `tenantId` from the verified context, and refuses a
`tenantId` argument; it registers the function as a Lambda `ToolTarget`
(which grants `kms:GetPublicKey` on the context key) and calls
`sandboxes.bindRunCode(fn)`. `bindRunCode` gives the function everything
the core function has: the tool subnets and tool security group, the
environment (table, bucket, image, connector, pinned task definition,
runtime and tenant role ARNs, limits), the timeout from the budget, the
tool role's sandbox actions, and inclusion in the §3.8 Contributor
Insights rules. A function that runs as `toolRole`, as the one
`RunCodeToolTarget` builds does, already holds the actions and the
trust. A function with a role of its own gets the same statements, a
place in the tool tenant role's trust policy, and loses the basic and VPC
managed policies, which allow log writes on every group. The role must be
in the construct's stack (`bindRunCode` refuses another), gets the
network interface actions in a policy of its own, and outlives the
function on delete behind the log drain (ADR-0073). A function built
with its own `logGroup` keeps it; otherwise the core sets a group it owns
(retention set, deleted on destroy). It names the producer, which standard §1.1
allows only in demo apps and tests; ADR-0017 records this adapter as the
exception.

`runCodeFunction` exists only with `standalone: true`. A core construct
with neither `standalone` nor a `RunCodeToolTarget` bound fails synth,
because it would have no way in. A gateway-only deployment therefore has
no unsigned entry.

`UntrustedCodeSandboxes` props:

| Prop | Type | Default | Meaning |
|---|---|---|---|
| `standalone` | `boolean` | `false` | deploy `runCodeFunction` for the vendor's own API (ADR-0017) |
| `backends` | `('microvm' \| 'nitro' \| 'agentcore')[]` | `['microvm']` | the boundaries to deploy; at least one |
| `defaultBackend` | one of `backends` | first entry | used when the call names none |
| `runTimeout` | `Duration` | 30 s | runner kill time; 1 s to 60 s |
| `startWait` | `Duration` | 15 s | how long one call waits for a starting sandbox before `sandbox_starting` |
| `maxOutputBytes` | `number` | 262144 | stdout and stderr together, at most 4 MiB; stdout is cut first. The tool also bounds the JSON-encoded answer at 5 MiB (a control byte is six bytes of JSON), so an answer fits the 6 MB Lambda response limit |
| `maxInputBytes` | `number` | 5242880 | refuse larger inputs before any sandbox starts; at most 6 MiB, the largest input the runner takes |
| `sandboxIdle` | `Duration` | 15 min | idle time before a sandbox is stopped or suspended |
| `sandboxMaxLife` | `Duration` | 8 h | hard life cap on every backend |
| `perTenantMetrics` | `boolean` | `false` | emit CloudWatch metrics with a `TenantId` dimension (ADR-0013) |
| `vpc` | `ec2.IVpc` | created (§3.7) | must have subnet groups named `Tool` and `Sandbox` (ADR-0027) |
| `s3PrefixListId` | `string` | none | id of the `com.amazonaws.<region>.s3` managed prefix list (`pl-` and hex). Required with a supplied `vpc` when the `agentcore` runtime's endpoints are created: its 443 egress to the S3 gateway endpoint names the list. With the created VPC the egress is any address on 443, which that VPC routes nowhere else (ADR-0028) |
| `dnsFirewall` | `boolean \| { allowDomains?: string[] }` | `false` | associate a Route 53 Resolver DNS Firewall rule group with the VPC that allows only the §3.9 AWS names and blocks the rest with NXDOMAIN, plus VPC query logging; `allowDomains` adds names, each of two labels or more (`example.com`, `*.example.com`; a bare top-level domain is refused, but a public suffix such as `*.co.uk` or a shared zone such as `*.s3.amazonaws.com` passes, so the vendor is responsible for listing only names it controls, T-32); refused with a supplied `vpc` (ADR-0016). With it off, DNS is the one path out of a sandbox (T-29) |
| `createEndpoints` | `boolean` | `true` with the created VPC; required with a supplied `vpc` | create the §3.7 sandbox endpoints; `false` when a supplied `vpc` already has them; those endpoints must meet §3.7, and the app opens 443 from each backend's client security groups (`backends.<name>.endpointClients()`) to them, because the construct adds no endpoint or egress rule in that case. The interface endpoints use private DNS, which applies to the whole supplied VPC (T-92) |
| `inputBucket` | `s3.IBucket` | created | the bucket with `inputs/<tenant>/` |
| `microvm.memoryMiB` | `number` | 1024 | MicroVM image `MinimumMemoryInMiB`; the guest gets about four times this (S-15: 1024 gives 3998 MiB and 2 vCPUs, 2048 gives 8016 MiB and 4). Synth warns for a value other than 1024 or 2048, the two sizes measured |
| `nitro.cpu`, `nitro.memoryMiB` | `number` | 512, 1024 | task size |
| `nitro.instanceTypes` | `string[]` | `['m7i.xlarge']` | capacity provider instance requirements, and the architecture of the `nitro` runner image. The capacity provider's launch template enables Nitro Enclaves (`NitroEnclavesEnabled`), because an `ISOLATED_SANDBOX` task launches only on such a provider (ADR-0046), so every listed type must support Nitro Enclaves. The default is the one type run end to end; `m7g.large` (Graviton, 2 vCPU) reports Nitro Enclaves support and is likely cheaper, but has not been run on ECS. Synth checks each type against a static table of types with Nitro Enclaves support (Intel types need 4 vCPU or more, so `m7i.large` is refused) and refuses a list that mixes `x86_64` and `arm64` types, because the `nitro` runner image has one architecture. The runner holds a job filter table for each architecture (§3.5) |
| `agentcore.sessionFiles` | `boolean` | `false` | grant the runtime role `sessions/${aws:AgentCoreRuntimeSourceSid}/*` on the input bucket (ADR-0007) |

Timing budget: the tool Lambda timeout is set to
`5 s + startWait + runTimeout + 10 s` (fetch, start wait, run, stop on
overrun), at most 90 s for the gateway entry and 120 s for the core function. Through
`agentic-runtime-isolation`'s `api-gateway` ingress, the agent's whole
turn shares that ingress's fixed 120 s integration timeout, so a tool
budget above 90 s leaves the agent no time (S-11). The `+ 10 s` margin
is what makes the tool return `timedOut` itself: per the AgentCore
Gateway documentation, a Lambda error reaches the agent only as a generic
`isError` result, with no code. Validation at synth fails on: an unknown
or repeated backend, empty `backends`, `defaultBackend` not enabled,
`runTimeout` outside 1 s to 60 s, a negative `startWait`, a budget above
the cap, `sandboxMaxLife` above 8 h, `sandboxIdle` below 1 min or at or
above `sandboxMaxLife`, `maxOutputBytes` above 4 MiB, `maxInputBytes`
above 6 MiB, any size or count prop that is not a positive integer, an
`s3PrefixListId` that is not `pl-` and hex, an `allowDomains` name that is
not `example.com` or `*.example.com` (two labels or more, at most 255
characters), `dnsFirewall` together with a supplied `vpc`, and a supplied
`vpc` with no `createEndpoints`. `RunCodeToolTarget` fails at synth when
the core's budget is above 90 s.

Read-only properties: `runCodeFunction` (undefined unless `standalone`),
`registryTable`, `inputBucket`, `runnerRepository` (with `nitro` or
`agentcore`), `toolRole` (the one tool role every tool function runs as),
`toolTenantRole`, `offboardFunction`, `vpc`, `dnsFirewall` (with
`dnsFirewall` on), `environment`, `config` (the resolved props),
`backends` (each enabled backend's CDK side), and `backendOutputs`: per backend
`imageArn`, `clusterArn` and `taskDefinitionArn`, or `runtimeArn`.
Methods: `bindRunCode(fn)` and `grantInvokeRunCode(principal)`.

Exports from `src/index.ts`: the construct and its props, `runCode`,
`offboardTenant`, the `SandboxBackend` interface and the three backend
classes, and the runner's job and result types; nothing that imports
`agentic-runtime-isolation`. Exports from `src/gateway/index.ts`:
`RunCodeToolTarget` and its props. In `.projenrc.ts` the producer is a
dev dependency (for the build and tests) and an optional peer dependency
(`peerDependenciesMeta.optional`), so a consumer who imports only the
core does not install it. A lint rule (`no-restricted-imports`, applied to `src/**` except
`src/gateway/**` and the demo app files `src/main.ts` and
`src/demo.cdk.ts`; the integration app under `test/` is outside it) and
a unit test that walks the import graph from `src/index.ts` fail if the
core entry reaches any producer module.

### 3.4 Backend interface and enforcement per backend

```ts
interface SandboxBackend {
  readonly name: 'microvm' | 'nitro' | 'agentcore';
  start(tenantId: string, nonce: string, creds: TenantCredentials): Promise<SandboxHandle>; // creates; never reuses
  ready(handle: SandboxHandle): Promise<boolean>;  // true when the runner answers /ping (nitro: /hello with the nonce)
  run(handle: SandboxHandle, job: RunJob): Promise<RunResult>;
  stop(handle: SandboxHandle, creds?: TenantCredentials): Promise<void>;
}
```

The tool, not the backend, decides reuse from the registry row (§4.1).
`SandboxHandle` carries the row's nonce, so `ready` and `run` can send
it.

| Step | `microvm` | `nitro` | `agentcore` |
|---|---|---|---|
| Start | `RunMicrovm` with no `executionRoleArn`, `egressNetworkConnectors` = the sample's VPC connector only (omitting it gives the Lambda-managed `INTERNET_EGRESS`), `ingressNetworkConnectors` = `HTTP_INGRESS`, `maximumDurationInSeconds` = `sandboxMaxLife`, idle policy `{autoResumeEnabled: true, maxIdleDurationSeconds: sandboxIdle, suspendedDurationSeconds: 1800}`, `logging: {disabled: {}}`, `runHookPayload` = `{"nonceHash": …, "tenant": …}` (the API caps it at 4096 characters), delivered to the runner's `/run` lifecycle hook on port 9000 | `RunTask` with the tool tenant role, task definition with no `taskRoleArn`, sandbox subnets, the task security group, tags `TenantId`, container override env `RUNNER_NONCE_HASH` | none; the session starts on the first `InvokeAgentRuntime`, whose job carries the nonce, `tenantId` and `jobAuth` (S-14: CloudTrail Event history holds no `InvokeAgentRuntime` event); the runner adopts the nonce only when the session id equals `rc-` + SHA-256(`tenantId`) (§3.5) |
| Address | MicroVM endpoint plus a fresh auth token per call, port 8080 only, 5-minute expiry | task ARN, and the ENI private IP once `ready` reads it, port 8443 | runtime ARN plus `runtimeSessionId` = `rc-` + hex SHA-256 of the tenant id (67 characters, ADR-0009) |
| Ready | `GetMicrovm` `RUNNING`, then `/ping` answers; `bootId` from `/ping` (made in the `/run` hook, so it survives suspend and resume) | `DescribeTasks` `RUNNING` gives the ENI private IP, written to `address` with a version condition; then `/hello` answers; `bootId` from `/hello` | always ready; `bootId` from each result (made at the session's first job, because every session of a runtime version starts from the same restored process) |
| Identity check | every job carries `jobAuth` (encoding in §3.5, the same on every backend); the runner checks it before it writes the input or starts code, and refuses a mismatch with `wrong_sandbox`; the result carries `HMAC(nonce, runId)`, which the tool checks | over TLS on 8443 (ADR-0010): the tool sends `POST /hello` with a challenge; the runner answers `HMAC(nonce, challenge ‖ certFingerprint)`; the tool checks it against the connection's certificate and sends the job on the same connection; the job also carries `jobAuth` | the job carries the nonce, `tenantId` and `jobAuth`; a runner with no nonce adopts it only when the session id equals `rc-` + SHA-256(`tenantId`) (a restart under the tenant's own session id, detected by `bootId`), and a runner that holds a different nonce, or whose session id does not match, refuses with `wrong_sandbox` before it writes or runs anything; the result carries `HMAC(nonce, runId)` |
| Run | `POST /run` with `X-aws-proxy-auth`, HTTPS | `POST /run` on the checked TLS connection | `InvokeAgentRuntime`, HTTPS, payload is the job |
| Stop | idle policy suspends, then the platform ends it after 30 suspended minutes or at `sandboxMaxLife`; `TerminateMicrovm` on drain, offboard or overrun | reaper `StopTask` after `sandboxIdle` idle, or when the task's own `startedAt` is older than `sandboxMaxLife`; `StopTask` on drain, offboard or overrun | runtime `lifecycleConfiguration` `idleRuntimeSessionTimeout` = `sandboxIdle`, `maxLifetime` = `sandboxMaxLife`; `StopRuntimeSession` on drain, offboard or overrun |
| Start cap | 20 s (measured P90 2.8 s) | 5 min (measured 31–34 s from zero instances in two runs that may have used a pre-prepared instance, 11–18 s warm; the cap leaves room for a full instance launch) | 30 s (measured 2–2.5 s for a new session) |
| Start and stop: enforced or filtered | filtered: the tool role may run, call and stop any MicroVM of the image (MicroVM actions authorize against the image only; a per-tenant tag condition would need an image per tenant) | enforced: `RunTask` requires `aws:RequestTag/TenantId` = `${aws:PrincipalTag/TenantId}`, `StopTask` requires `aws:ResourceTag/TenantId` = `${aws:PrincipalTag/TenantId}` (ADR-0014) | filtered: one runtime; the session id is derived by code (the actions support no session-id condition) |
| Call: enforced or filtered | filtered by address; a wrong MicroVM's runner refuses the job before any code runs or any input is written | filtered by address; the nonce check rejects a wrong task before any job bytes are sent | filtered by session id; a wrong session's runner refuses the job before any code runs; `bootId` detects a restarted session |
| Code holds | no credentials; the link-local metadata service answers with the Region, the AZ id and a per-MicroVM key, and holds no credentials without an execution role | no credentials: no task role; the execution role is used by the ECS agent outside the sandbox; the task metadata endpoint gives the task ARN, cluster, image and log group; IMDS does not answer | the runtime role's credentials from IMDSv2 (§6.2 C-2) |
| Egress | VPC connector into sandbox subnets with no route and a security group with no egress | sandbox subnets with no route; task security group egress only to the Logs endpoint (`awslogs` leaves through the task ENI; the instance pulls the image) | sandbox subnets; runtime security group egress only to the ECR, S3 and Logs endpoints, each with a scoped endpoint policy (§3.7) |
| DNS | the VPC resolver (through two local forwarders) answers public names; with `dnsFirewall`, only §3.9 names | the VPC resolver answers public names; with `dnsFirewall`, only §3.9 names | the VPC resolver (through two local forwarders) answers public names; with `dnsFirewall`, only §3.9 names |

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
runs as root inside the VM; it never runs tenant code as root. One program
serves all three backends: the environment variable `RUNNER_BACKEND`
(`microvm`, `nitro` or `agentcore`), which each backend's construct sets on
the image, the task definition or the runtime, picks the setup and the
listener, and a runner with a missing or unknown value exits at start
(ADR-0037).

Build-time egress. `AWS::Lambda::MicrovmImage` requires an egress
connector for the image build, and the build runs with the Lambda-managed
`INTERNET_EGRESS`: it pulls the base layer and any packages the
Dockerfile installs. This is a supply-chain surface of the build, owned by
the vendor's Dockerfile, separate from runtime egress, which never reaches
the internet. The Dockerfile pins its base image by digest and installs
only `python3` at an exact package version, which the AL2023 minimal base
lacks. The construct also pins the platform base image of
`AWS::Lambda::MicrovmImage` (`BaseImageArn` `al2023-1`) to a fixed
`BaseImageVersion`, the one the integration test last passed on, so a
redeploy never picks up a new VM base without a code change.

Per-sandbox values. `microvm` and `agentcore` start sandboxes from a
snapshot, so anything the runner makes at process start is shared by
every sandbox restored from that snapshot. The runner therefore makes its
`bootId` when the sandbox first becomes one tenant's, and takes its
`nonceHash` at the same moment where there is one: in the `/run`
lifecycle hook on `microvm`, at process start on `nitro` (each task is a
fresh container), and at the session's first job on `agentcore`, which
makes only `bootId` there and holds no hash (see nonce delivery). The nonce itself
is adopted later, on the data channel. Every random value comes from `os.urandom` or `secrets`,
never from a generator a snapshot could restore with its state. On
`nitro` it also makes a key pair and a self-signed certificate at process
start, held only in memory.

Nonce delivery (ADR-0018). Start calls are read back by anyone with
`ecs:DescribeTasks` or `lambda:GetMicrovm`, and a trail with data events
may record them, so they never carry the nonce. With management events
only, S-14 found no `RunMicrovm` and no `InvokeAgentRuntime` event in
CloudTrail Event history, and `RunTask` events showed the container
override `environment` as `HIDDEN_DUE_TO_SECURITY_REASONS`.
The `microvm` `/run` hook payload and the `nitro` `RUNNER_NONCE_HASH`
variable carry only `nonceHash` = SHA-256(`"nonce" ‖ nonce`). The tool
sends the nonce itself on the data channel with every job (all three
backends: the MicroVM's HTTPS endpoint, the task's TLS connection, the
`InvokeAgentRuntime` payload), because it cannot know whether a runner
has adopted it; adoption of a matching nonce is idempotent. On `nitro`
only the `ready` probe's `/hello` carries the nonce, to the address it
just read from the task's own ENI; the `/hello` before a job carries the
challenge alone, and the runner proves with the nonce it holds, so a
task that took over a recycled address never sees the nonce (ADR-0072). The runner adopts it only if it matches
`nonceHash`, and removes `RUNNER_NONCE_HASH` from the environment it
hands to code. On `agentcore`, which has no start call and so no hash,
the job also carries `tenantId`, covered by `jobAuth`, and the runner
adopts a nonce only when the runtime session id it is invoked under
(the `x-amzn-bedrock-agentcore-runtime-session-id` header, which S-14
found on every job with the caller's id unchanged; `/ping` carries none) equals `rc-` + hex SHA-256(`tenantId`); once adopted, it refuses any
other nonce. A runner that receives a nonce it may not adopt refuses with
`wrong_sandbox` and keeps nothing.

The honest-runner assumption. The nonce, and on the first message the
tenant's code and input, reach whatever answers on the sandbox's port.
That is safe only because the vendor runner is the sole listener and the
sandbox ends when it exits: it is PID 1 on `microvm` and the container
entrypoint on `nitro` and `agentcore`; it keeps nothing it refuses and
logs only sizes; uid 1001 cannot read its memory and is swept after
every job, so no tenant code is alive to bind a port between jobs. The
result `HMAC(nonce, runId)` and the `/hello` answer therefore confirm that
the peer accepted; the protection is the honest runner's hash, session
and `jobAuth` checks.

`jobAuth` encoding. Key: the 32 raw nonce bytes. Message:
`len(runId) ‖ runId ‖ len(tenantId) ‖ tenantId ‖ SHA-256(len(code) ‖ code ‖
len(input) ‖ input)`, each `len` a 4-byte big-endian count of the bytes
that follow; `code` is UTF-8, `input` is the raw object bytes (decoded
from base64 where a transport encodes it), and an absent input is zero
bytes. HMAC-SHA-256, sent base64url.

It sizes its memory limits from what the sandbox has (memory cap,
below). It listens on
8080 (HTTP: MicroVM proxy, AgentCore contract) or 8443 (TLS: `nitro`), and
on `microvm` also on 9000 for the lifecycle hooks. The 9000 listener
accepts the `/run` hook's `nonceHash` once and ignores every later `/run` hook,
answers `/ready` once it can take a job, answers `/suspend` and
`/resume`, and serves no jobs; the tool's auth
tokens allow port 8080 only, so a caller cannot reach 9000. On
`microvm`, until the `/run` hook has delivered the `nonceHash`, `/ping`
reports no `bootId` and the 8080 job route refuses every job, and the
tool treats a `/ping` without `bootId` as not ready; no tenant code runs
before the hash is set, so code can never post its own `/run` hook first.
On `agentcore` there is no hook: the session-id check above decides
adoption. On `nitro` the hash is set at process start. It serves:

- `GET /ping`: `{"status":"Healthy","bootId":…}` (AgentCore contract).
- `POST /hello` (`nitro`): returns `bootId`, the certificate fingerprint
  and `HMAC(nonce, challenge ‖ certFingerprint)`; the nonce is the one in
  the body (the first `/hello`) or the one it holds (every later one).
- `POST /run` (and `POST /invocations` for AgentCore): runs one job.

A job runs one at a time. A second job while one runs is refused at once
with `busy`. The runner:

1. Writes the input to `/work/input`. `/work` is owned by uid 1001.
2. Starts `python3 -I -S` on the code as uid 1001 (`sandbox`), in a new
   session and process group, with `/work` as the working directory and
   these limits, each with soft = hard so code cannot raise them (S-15):
   `RLIMIT_CPU` = `runTimeout`, `RLIMIT_NPROC` = N, `RLIMIT_FSIZE` =
   100 MiB and `RLIMIT_MEMLOCK` = 0 (ADR-0074), set before the drop to
   uid 1001; and `RLIMIT_NOFILE` = 256 (64 on `microvm`, which bounds
   the Unix socket buffers each process can hold) and `RLIMIT_AS` = A,
   set last, after the drop and the filter install, because the child
   is a fork of the runner and may hold more descriptors and address
   space than the job may until it execs (ADR-0038). A, N and what caps
   the job's total memory depend on the backend (memory cap, below).
   The runner sets the job's `oom_score_adj` to 1000, which needs no
   capability, and tries to set its own to -1000, ignoring `EACCES`.
   No backend grants `CAP_SYS_RESOURCE`, and S-14 found the runner
   starting at 1000 on `microvm` and `agentcore` and at -998 on
   `nitro`. The design relies on neither score on `microvm` and
   `agentcore`. On `nitro` the runner's
   survival of a kernel kill was measured only at the platform's -998,
   and only with SysV IPC filtered (S-18), and it held in all 85 S-19
   fills; the watchdog is an early warning that often, not always, acts
   before the kernel (S-19). On `microvm` the job's environment also sets
   `MALLOC_ARENA_MAX` = 2, so each thread does not reserve a 64 MiB
   allocator arena out of A.
3. At `runTimeout` wall time, or when the job ends, kills the process group
   and then every remaining uid 1001 process, so nothing the code forked
   survives into the next job. It then deletes every file uid 1001 owns
   under `/tmp` and `/dev/shm`, and removes every SysV object uid 1001
   owns, through a forked child that drops to uid 1001 and calls
   `IPC_RMID` on each id in `/proc/sysvipc/{msg,sem,shm}`: these outlive
   the job, and the root runner on `microvm`, which has no
   `CAP_SYS_ADMIN`, may not remove them (S-17, 32208 objects in 0.19 s); a
   uid 1001 child works on every backend whatever the runner holds. The
   sweep runs after every job, a killed one included, and on `nitro`,
   where the filter blocks SysV IPC, finds nothing. The runner is PID 1,
   so orphaned job processes become its children: it then calls
   `waitpid(-1, WNOHANG)` until no uid 1001 process is left. Zombies
   still count against `RLIMIT_NPROC`, and without this the next job's
   first `fork` failed with `EAGAIN` on `microvm` and `agentcore`
   (S-18). On `agentcore` the runner then reads the job group's
   `memory.current` less `file` plus `shmem` (as the `nitro` watchdog
   does, so the page cache of files in `/work` does not count), less
   `slab_reclaimable`: a disk fill leaves about 215 MiB of slab charged to
   the group (the integration test's `dirty_group` line), and the
   reclaimable part (dentries and inodes) the kernel frees under pressure. Unreclaimable slab stays counted, because SysV
   semaphores and message queues are charged as kernel memory (S-18). The read is
   repeated for the rest of the 3 s the runner allows after a job, because
   the memory the sweep freed takes a moment to leave the group's counters
   (ADR-0064).
   If it is still not below 32 MiB, the runner starts no further job and refuses every
   later one with `dirty`, which the tool treats as a dead handle
   (§4.1 step 3), so the takeover stops the session and the next start
   gets a fresh one under the same id. 32 MiB is a design value. §7 S-21
   measured a 2 GiB SysV fill draining below it inside 1 s, and 420 000
   empty files in `/work` staying above it in a run that neither polled
   nor left out reclaimable slab; the result of the current rule on that
   case is not measured. Files in `/work` stay (below).

   After a job ends, the kill, the sweep and the thread joins of the runner
   share one budget of 3 s, so the answer comes with 2 s to spare inside the
   tool's `runTimeout` + 5 s wait (§4.1 step 5). A step the budget cuts
   short, or a uid 1001 process that survives the kill, marks the runner
   `dirty` on every backend, and a `dirty` runner refuses every later job.
   On `agentcore` the job group read above polls every 0.05 s for the rest
   of that budget (ADR-0064, `runner/PROTOCOL.md`).
4. Returns `exitCode`, `stdout`, `stderr` (together at most
   `maxOutputBytes`, stdout cut first, `truncated` flag), `durationMs`,
   `timedOut`, `memoryExceeded`, `bootId` and the nonce proof.

Memory cap (ADR-0019). `RLIMIT_AS` is per process and a job may run up to
N processes, so each backend caps the job's total its own way. M is the
memory the sandbox has, read from `/proc/meminfo` when the sandbox becomes
one tenant's, and L = M less 256 MiB.

| Backend | M | Total cap | A, N | `memoryExceeded` when |
|---|---|---|---|---|
| `microvm` | `MemTotal` (about four times `microvm.memoryMiB`: 3998 MiB at the default, S-15) | the rlimits, for memory counted in address space. No cgroup is mounted and the runner cannot mount one (S-14), so N × A stays at or below 60 % of M (ADR-0020; S-15 found 70 % keeps the kernel's out-of-memory killer out of reach with no other memory held). An allocation past A fails inside the job with `MemoryError` or `ENOMEM` at once (0.09 to 0.13 s for a 512 MiB cap in S-15). Memory the rlimits do not count (an unmapped `memfd`, socket buffers, SysV semaphores and queues, `vmsplice` pages, a tmpfs in a user namespace) is closed by the job's seccomp filter (below, S-17); without it one such route ended the whole MicroVM in under 2 s (S-16). With every route left open filled at once across N processes (anonymous memory to A, pipes, Unix socket pairs, loopback TCP, and in S-19 also a loopback TCP accept queue at a backlog of 8), S-18 measured 2627 to 2653 MiB held and `MemAvailable` at 1033 to 1055 MiB, and S-19 2589 to 2659 MiB held and 1028 to 1098 MiB, at worst 516 MiB above the floor. With every descriptor on Unix datagram pairs and 80 more descriptors in flight through `SCM_RIGHTS` (a per-user limit), the estimate is 2836 MiB held, 342 MiB above the floor. A free-memory floor is the backstop | A = 256 MiB, N = ⌊0.6 × M / A⌋ (9 at the default) | the free-memory floor killed the job; a single process past A sees the error itself |
| `nitro` | the smaller of `MemTotal` and the task group's `memory.max` (the task size) | the platform's task group limit; the cgroup mount is read-only (S-14). The kernel kills only uid 1001 processes there, and the runner survived every anonymous, `memfd`, tmpfs and Unix socket fill (S-14, S-16, S-18). SysV IPC is the exception: a semaphore or shared-memory fill pinned the whole task limit in under 1 s, the objects outlived the job, and the runner died in 4 of 5 runs while it swept them, so the job filter blocks SysV IPC on `nitro` (below, S-18). The watchdog reads the task group's memory less its file cache and kills the job's processes above L, so it also sees `memfd`, tmpfs and socket memory. It is an early warning, not the cap: the 256 MiB between L and the task limit lasts only 25 to 90 ms of a fast fill, so the kernel sometimes kills first, and the runner lived in all 85 S-19 fills either way. The runner itself holds about 25 MiB of raw group memory (S-19, file cache included), and with A = L a single process at its limit reached the watchdog and was killed instead of getting `MemoryError` (S-19). So A is L less 64 MiB. With a probe runner close to §3.5 (TLS, `/hello`, `jobAuth`), the runner held 43 MiB of raw group memory but counted about 20 MiB once file cache is left out, and a single process at A got `MemoryError` or `ENOMEM` with the watchdog silent in 14 of 14 runs, about 54 MiB below L (S-20) | A = L − 64 MiB, N = 64 | the watchdog killed the job, or `oom_kill` in the runner's own scope's `memory.events` grew during the job |
| `agentcore` | `MemAvailable` (about 7625 of 8016 MiB at idle): a cap at `MemTotal` less 256 MiB lies above it, and the global killer would act first (S-14) | one cgroup v2 job group for the session's life, reused by every job, with `memory.max` = L and `memory.oom.group` = 1, so the kernel kills the whole job and nothing else, and memory one job leaves behind counts against the next, SysV objects included, until step 3 sweeps them. It also bounds SysV and Unix socket memory, so `agentcore` needs no job filter (S-18). The group is required, not hardening: without it an unmapped `memfd` or a large tmpfs fill ended the session even with the root's `memory.oom.group` at 0, because the job's resident memory was smaller than the runner's (S-16) | A = L, N = 64 | `oom_kill` in the job group's `memory.events` grew |

`RLIMIT_NPROC` counts every process and thread of uid 1001 in the
sandbox; jobs run one at a time and step 3 sweeps uid 1001, so the count
is per job, threads included. The watchdog runs on `nitro` only: every
200 ms it reads the task group's `memory.current` and `memory.stat`
(the path from `/proc/self/cgroup`), takes `memory.current` less `file`
plus `shmem`, and kills every uid 1001 process above L. Taking out
`file` drops the page cache of files written to `/work`, which is
disk-backed and mostly reclaimable and would otherwise push a legal job past
L; adding back `shmem` keeps `memfd` and tmpfs pages counted. This
correction held in S-20: 20 jobs that wrote up to 2000 MiB to `/work`,
with and without `fsync`, were never killed, the counted value peaked at
36 MiB while `memory.current` reached 870 MiB, `file_dirty` peaked at
168 MiB, and the kernel limit never acted on page cache. `memfd` and
`/dev/shm` pages still counted. The watchdog records `memoryExceeded`
before it sends the kill, so a job killed under it is always marked
(recording after the kill missed one job in S-20). A fast fill outruns it: at a
200 ms poll it fires first for certain only below about 1.3 GiB/s, the
256 MiB between L and the task limit over one poll. The watchdog does
not sum resident memory: that sum counts shared pages once per process,
so it saw 827 MiB for a 64-process Python job whose group held about
140 MiB, and it misses `memfd`, tmpfs, socket and SysV memory entirely
(S-18). In S-19 it fired before the kernel in 12 of 12 anonymous
fills (about 1.5 GiB/s, at 200 and 50 ms polls and in shared and
private memory), but late, at 852 to 1000 of the 1024 MiB limit; in
7 of 9 `memfd` writes (about 2.9 GiB/s), in
9 of 13 `memfd` `fallocate` fills (6 to 12 GiB/s), and rarely under
64-process socket load, when its polls slipped to 447 ms and once 4.8 s.
It did not kill a 64-process job that held 176 MiB. `memoryExceeded`
was right in all 85 fills. It costs about 0.06 % of one CPU at idle.

A job that fills memory from every process slot at once (64 processes,
each to A) holds the task group at its limit. With no swap, the kernel
can then reclaim only file pages, the runner's code among them. Before
ADR-0074 those pages were evicted and read back over and over: the
runner wrote no `job_done` line within `runTimeout` + 5 s in 5 of 8
such fills on a `nitro`-only stack (and in 2 of 6 integration runs of
`runaway`), the tool stopped the task as an overrun (§4.1 step 5), and
the tenant lost `/work`. So on `nitro` the runner locks its pages once
it is claimed and its TLS context is made (`mlockall(MCL_CURRENT)`,
then `MCL_FUTURE | MCL_ONFAULT`), and the task definition sets the
container's `memlock` ulimit to unlimited (a ulimit, not a
capability). Each job child and the SysV sweep set `RLIMIT_MEMLOCK` to
0 on every backend. A runner whose lock the kernel refuses ends at
start. With the lock alone, 14 fills ended but took up to 23.7 s,
because the watchdog opened its files on every poll, and an open
allocates: in the full group it waited 6 to 19 s. So the watchdog
opens `memory.current` and `memory.stat` and reads them once at claim,
before any job, keeps them open and reads them with `pread`. On one
stack, in one Region, at the default task size, 0 of 14 fills of the
final runner overran: each answered `memoryExceeded` in 0.54 to 7.4 s
on the same task with `/work` kept (0 of 58 across the runner variants
of ADR-0074). A fill that still overran would end as before (§4.1 step
5), with the tenant's `/work` lost and nothing crossing tenants.

Mounts (S-16). On every backend `/dev/shm` is the only tmpfs uid 1001
can write: 64 MiB on `microvm` and `agentcore`, 576 MiB on `nitro`
(half the task's memory; `sharedMemorySize` is refused for Managed
Instances). `/`, `/tmp`, `/var/tmp` and `/work` are one disk-backed
filesystem, so files there cost page cache only. A tmpfs file pins
memory until it is deleted, even after a kernel kill of its writer, so
step 3 deletes every file uid 1001 owns under `/dev/shm` and `/tmp`. The
job's `TMPDIR` is `/work/tmp` on every backend. On `nitro` and
`agentcore` a tmpfs file is charged to the task group or the job group.
On `microvm` no rlimit counts it; the mount bounds it at 64 MiB. So that
the 60 % budget holds without counting it, when the sandbox becomes one
tenant's the runner makes `/dev/shm` not writable by uid 1001 (it owns
it as root, which needs no capability). That takes POSIX semaphores and
shared memory away from the job on `microvm` (§5.1).

Job filter on `microvm` (ADR-0020). After the uid drop and before `exec`,
the runner sets `PR_SET_NO_NEW_PRIVS` and installs a seccomp filter in
the job, through `ctypes` with no library. It kills a process whose
architecture is not `AUDIT_ARCH_AARCH64`, returns `EPERM` for
`memfd_create`, `memfd_secret`, `shmget`, `shmat`, `shmctl`, `msgget`,
`semget`, `vmsplice`, `userfaultfd`, `io_uring_setup`, `unshare`,
`setns`, `mount`, `umount2`, `pivot_root`, `move_mount`, `open_tree`,
`fsopen`, `fsconfig`, `fsmount` and `fspick`, for `setsockopt` at
`SOL_SOCKET` with `SO_SNDBUF`, `SO_RCVBUF`, `SO_SNDBUFFORCE` or
`SO_RCVBUFFORCE`, for `socket` with `AF_UNIX` as its first argument
(`socketpair` stays allowed), for `listen` with a backlog above 8, and
for `clone` with any `CLONE_NEW*` flag in its first argument (the mask
leaves out `CLONE_NEWTIME`, which shares bits with the exit signal); it
returns `ENOSYS` for `clone3`, so the C library falls back to `clone`,
and closes user namespaces in one place. It allows the rest. The two
socket rules close routes S-18 found that need only descriptors: a
Unix accept queue (connect, send, close, repeat) filled at 10 to
11 GiB/s, and a named Unix datagram receiver at 14 to 18 GiB/s, faster
than any poll. They also stop a loopback TCP accept queue that held
1315 MiB at `listen(4096)`; at a backlog of 8 that route held about
380 MiB, inside the budget. The numbers are the aarch64 generic table. Children and `exec`ed programs inherit it, and the job
cannot remove or loosen it. It costs about 0.16 ms per job start and
22 ns per system call. Under the full setup (A, N 9, `RLIMIT_NOFILE`
64, `MALLOC_ARENA_MAX`, every entry above) 25 ordinary job checks,
`threading`, `ThreadPoolExecutor`, `subprocess`, `posix_spawn`,
`asyncio`, `socketpair` and `http.server` included, behave the same as
unfiltered, and a process can open 56 files (S-18). The first job in a
fresh MicroVM took 3.1 to 3.4 s against 0.2 s warm, from a cold page
cache, not the filter.
The child checks that `prctl(PR_GET_SECCOMP)` returns 2 after the
install and before `exec`, and raises if not. `subprocess` carries that
error back through its close-on-exec error pipe, which tenant code never
reaches, so `Popen` fails before any tenant code runs. The runner logs it
and returns `tool_failed`, because retrying cannot fix it; an exit code
is always tenant data. The check proves only that a filter is
installed (S-18: an allow-all filter passes it), so the child also
calls one blocked call (`memfd_create` on `microvm`, `semget` on
`nitro`) and raises unless it gets `EPERM`.
No list can close every route, so the runner also keeps a
free-memory floor on `microvm`: every 50 ms it reads `MemAvailable`
and, below 512 MiB, kills the job's process group, sweeps uid 1001 and
sets `memoryExceeded`. S-18 found the guest lost at about 2 to 7 MiB
available, and only for memory no process maps (`memfd`, socket
buffers); for anonymous memory the kernel kills job processes and the
runner lives at 0. So the floor has about 510 MiB of headroom, and a
kill takes 0.1 to 1.1 ms: at 200 ms it is certain only below about
2.4 GiB/s, at 50 ms below about 9.5 GiB/s. In S-18 the floor fired in
54 of 54 fills past the 70 % mark, the runner lived each time, and it
stayed silent in every fill below that mark. In S-19, against an
unmapped `memfd` fill the list was made to miss, the 50 ms floor saved
the guest in 24 of 24 runs at 4.3 to 10.2 GiB/s, with the lowest detect
at 145 MiB and wake gaps of 50 to 70 ms; two runs above the 9.5 GiB/s
bound survived because a poll happened to land early. At 200 ms the
guest was lost in 1 of 6 runs and two more detected at 2 and 0 MiB;
with no floor it was lost in 2 of 2. The floor costs about 0.05 % of
one CPU at idle. The poll gap reached 627 ms when all CPUs were busy
(S-18), so a route faster than the floor must still be in the list; the
floor is a backstop for slower routes. The child's blocked-call
self-test stopped an allow-all filter in S-19 and costs about 0.07 ms
per job start. `/proc/sys` is read-only in the guest, so the runner
cannot lower the kernel's own limits instead (S-17).

Job filter on `nitro` (ADR-0021). The runner installs the same kind of
filter in every `nitro` job, returning `EPERM` for `semget`, `msgget`,
`shmget` and `shmat`. The filter has the same child check. It takes its architecture constant and its
syscall numbers from the architecture of the runner image, which follows
`nitro.instanceTypes` (§3.3): `AUDIT_ARCH_X86_64` with the x86_64 numbers
for Intel types, `AUDIT_ARCH_AARCH64` with the aarch64 generic table for
Graviton types. A port that changed only the constant would block the
wrong calls, or kill every job. The runner holds one table per
architecture, and `synth` refuses a `nitro.instanceTypes` list that
mixes architectures. Only the x86_64 table has run (S-18, S-19).
In S-18 the three creates failed
at once, nothing was charged, and the sweep and the next job were fine.
On x86_64 the x32 ABI, whose numbers carry bit 30, is off in the `nitro`
kernel (an unfiltered x32 call returns `ENOSYS`), and the filter kills any
call with that bit set with `SIGSYS` (S-19).

On `agentcore` the
runner prepares the cgroup tree once, at the session's first job and
before any code runs: it moves itself into a `/runner` group (once a
controller is enabled the root may hold no process), writes `+memory`
to the root's `cgroup.subtree_control`, and writes 0 to the root's
`memory.oom.group`. That file is 1 by default, which makes any
out-of-memory kill end the whole session, runner included (S-14). uid
1001 can write neither file. The `nitro` task definition never adds
`SYS_ADMIN` or `SYS_RESOURCE` to get a cgroup or a lower score: the
platform's task limit already holds. After any kernel kill of a job,
ECS marks the stopped task's container `OutOfMemoryError` even when the
runner exited 0, so the tool and the reaper read the exit code, not
that reason.

Files in `/work` persist for the sandbox's life, so a tenant's second call
can read what the first wrote. uid 1001 cannot signal the runner, open its
file descriptors, or write outside `/work`, `/tmp`, `/var/tmp` (disk-backed,
kept like `/work`) and, on `nitro` and `agentcore`, `/dev/shm`. The runner logs only
sizes, exit code and duration, never code, input or output. The tool's log
line (§3.8) is the record of a run; the runner's log is secondary, because
on `nitro` and `agentcore` it shares a stream with whatever the code prints
to its own stdout through the runner.

### 3.6 Roles

| Role | May | May not |
|---|---|---|
| Tool role (function) | assume the tool tenant role with a `TenantId` tag; `lambda:RunMicrovm`, `GetMicrovm`, `TerminateMicrovm`, `CreateMicrovmAuthToken` on the sample's image (every MicroVM action authorizes against the image ARN; there is no MicroVM ARN), `lambda:PassNetworkConnector` on `HTTP_INGRESS` and the sample's connector only, so a start without the connector, which would get `INTERNET_EGRESS`, is refused; `bedrock-agentcore:InvokeAgentRuntime`, `StopRuntimeSession` on the sample's runtime and its endpoints; `ecs:DescribeTasks` on the cluster. One role, shared: `runCodeFunction` and the `RunCodeToolTarget` function run as it; a function with its own role gets the same statements through `bindRunCode`; `ToolTarget` adds `kms:GetPublicKey` on the context key when a gateway function is bound. Each role of a function in the tool subnets also holds, in a policy of its own (`VpcNetworkInterfaces`), the six network interface actions on `*` that the managed VPC access policy grants (create, describe, delete, assign and unassign addresses, describe subnets), because Lambda manages the function's interfaces with its role (ADR-0029, ADR-0073) | read the bucket or the registry directly; `ecs:RunTask` or `StopTask` |
| Standalone invokers (with `standalone`) | `lambda:InvokeFunction` on `runCodeFunction`, through `grantInvokeRunCode(principal)` in the app, or an identity policy on the published `runCodeFunctionArn` in another app | the gateway path; see T-82 for same-account identity policies |
| Tool tenant role | `s3:GetObject` on `inputs/${TenantId}/*`, `s3:PutObject` on `outputs/${TenantId}/*`, registry items with `dynamodb:LeadingKeys` = `TENANT#${TenantId}`, `ecs:RunTask` on the pinned task definition revision ARN only, with the request tag condition and `ecs:cluster` = the sample's cluster; `ecs:TagResource` on `task/<cluster>/*` with the request tag condition and `ecs:CreateAction` = `RunTask` (the action has no `ecs:cluster` key, and this stops the role retagging existing tasks); `ecs:StopTask` with the resource tag condition and `ecs:cluster`; `iam:PassRole` on the task execution role | anything without its own tag; any other task definition or cluster |
| Task execution role | trust `ecs-tasks.amazonaws.com` with `aws:SourceAccount`; `ecr:GetAuthorizationToken` on `*` (the action takes no resource), `ecr:BatchGetImage` and `ecr:GetDownloadUrlForLayer` on the runner repository, Logs write on the task log group | everything else; never reachable by code (S-5) |
| AgentCore runtime role | trust `bedrock-agentcore.amazonaws.com` with `aws:SourceAccount` and `aws:SourceArn` = this account's runtimes named `<runtimeName>-*`; `ecr:GetAuthorizationToken` on `*`, `ecr:BatchGetImage` and `ecr:GetDownloadUrlForLayer` on the runner repository, `logs:CreateLogGroup`, `CreateLogStream`, `PutLogEvents`, `DescribeLogStreams` on `/aws/bedrock-agentcore/runtimes/<runtimeName>-*` (the name is known at synth, and runtime names cannot contain `-`, so the prefix matches only this runtime; code can create extra groups under the prefix, which the cleanup resource removes); with `sessionFiles`, `s3:GetObject`, `s3:PutObject` on `sessions/${aws:AgentCoreRuntimeSourceSid}/*` and `s3:ListBucket` with an `s3:prefix` condition | everything else |
| Reaper role | read, update and delete every registry row; `ecs:ListTasks`, `DescribeTasks`, `StopTask` on the cluster; `lambda:ListMicrovms` on `*` (it takes no resource; the call filters by image), `GetMicrovm`, `TerminateMicrovm` on the image; `StopRuntimeSession` on the runtime and its endpoints; `offboardTenant` runs as this role, because it needs only the row writes and the stop actions | the input bucket; the instance actions of the drain role |
| Drain role | the reaper role, plus `ecs:ListContainerInstances` and `ecs:DeregisterContainerInstance` on the cluster (their only resource type), `ecs:DescribeContainerInstances` on `container-instance/<cluster>/*`, and `ec2:DescribeInstances` (which takes no resource) | the input bucket; the reaper role never holds the instance actions, because a forced deregister ends the instance and a live tenant's sandbox on it, so `offboardTenant`, which the vendor's tenant delete script calls at run time, does not run as this role |
| MicroVM image build role | trust `lambda.amazonaws.com` with `aws:SourceAccount`; `s3:GetObject` on the runner code artifact; `logs:CreateLogGroup`, `CreateLogStream`, `PutLogEvents` on `/aws/lambda-microvms/<imageName>` | everything else |
| MicroVM connector operator role | trust `lambda.amazonaws.com` with no source condition (ADR-0068); `ec2:CreateNetworkInterface` on network interfaces, the sandbox subnets and the connector security group; `ec2:CreateTags` on network interfaces with `ec2:ManagedResourceOperator` = `network-connectors.lambda.amazonaws.com` | everything else |
| Image copy role (the ECR deployment library's provider) | the library's grant: ECR write and S3 read, to copy the runner image from the CDK asset repository into the runner repository | ECR write outside the runner repositories, any S3 action on the input bucket, `logs:CreateLogGroup` (explicit denies; the provider logs to a group the construct owns) |
| Log cleanup role (the log cleanup resource and the task log drain) | `logs:DescribeLogGroups`; `logs:DeleteLogGroup` on `/aws/bedrock-agentcore/runtimes/<runtimeName>-*`, on `/aws/lambda-microvms/<imageName>` and on the task log group | every other log group; everything else |

The runtime and execution roles reach no tenant data.

### 3.7 Network (ADR-0012, ADR-0071)

One VPC in two AZs, created unless `vpc` is given. The reaper, the drain
and the offboard function call AWS APIs only and run outside the VPC
(ADR-0071).

| Subnets | Route table | Used by |
|---|---|---|
| Public | default route to an internet gateway | the NAT gateway only; nothing else is placed there |
| Tool | default route to one NAT gateway | the tool Lambda (the standalone run function and every bound function); the ECS Managed Instances' primary ENIs |
| Sandbox | local only, no default route | `nitro` task ENIs, the `agentcore` runtime ENIs, the `microvm` VPC egress connector |

Endpoints in the sandbox subnets, each with a security group and a policy.
Interface endpoints use private DNS, which applies to the whole VPC, so
anything in the tool subnets that calls ECR or Logs also reaches these
endpoints. Their security groups therefore admit the sandbox groups and
the instance group; the tool calls neither ECR nor Logs
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

The VPC the construct creates has flow logs for rejected traffic only, in a log
group with one month of retention that is deleted on destroy; it is how a
blocked path shows up. Tasks cannot reach each other: no task group admits another. The tool
reaches MicroVM endpoints, AWS APIs and the AgentCore data plane through
the NAT. The integration test tries a presigned PUT to a bucket outside
these policies through the S3 endpoint, and expects a refusal.

### 3.8 Observability and cost (ADR-0013)

The tool writes one structured line per call with `process.stdout.write`
(top-level fields, so Logs Insights and Contributor Insights can key on
them). Every line is one JSON object with an `event` field (`run`,
`sandbox_stopped`). The run line carries `tenantId` (`invalid` when the
id breaks its rule), `backend`, `handle` (MicroVM id, task ARN or
`runtimeSessionId`), `runId`, `sandbox` (`started` or `reused`),
`outcome` (tool error code or `ok`), `exitCode`, `timedOut`, `durationMs`,
`startMs`, `inputBytes`, `outputBytes`, and on a failed start or a fault
`stoppedReason` (the platform's reason, `start_cap`, or an error class
name, at most 200 characters). Each sandbox gets exactly one stop line,
with `tenantId`, `backend`, `handle`, `sandboxSeconds`, `by` (the writer:
`tool`, `reaper`, `drain` or `offboard`), `reason` (`idle`, `expired`,
`overrun`, `dead`, `failed_start`, `gone`, `offboard`, `drain` or
`orphan`) and, when the platform gives one, `stoppedReason`.
`sandboxSeconds` is `stoppedAt - startedAt` from the platform's facts
where it gives them, else from the row's `createdAt` and the time of the
stop. The reaper and the drain also write their own summary and error
lines (ADR-0033). The stop line is
written by whoever moves the sandbox's row out of `STARTING` or `READY`
with a successful conditional write: the tool (dead handle, overrun,
failed start), the reaper, the drain, or the offboard function. A writer
that finds the row already `FAILED` or `STOPPING` writes none. A start call
that throws before the platform returns a handle sets `FAILED` and writes no
line, because there is no sandbox to name; a sandbox the call launched anyway
is an orphan the sweep stops. A sandbox
with no row (an orphan the sweep or the drain stops: a handle-less
takeover, a crashed start, or a row TTL removed while the reaper was not
running) gets its line from the stopper, marked `orphan` = true, with
`tenantId` from the task's `TenantId` tag on `nitro`, or `unknown` on
`microvm`, whose MicroVMs take no tags. An `agentcore` orphan session gets no stop
line, because no API lists it; its cost should reach the tenant through
AgentCore's usage logs (table below), so the `sandboxSeconds` ranking is
not complete for `agentcore`. On
`microvm` the line also carries `runningSeconds` and `suspendedSeconds`.
`sandboxSeconds` comes from `GetMicrovm` `terminatedAt - startedAt` when
the MicroVM is ended. `suspendedSeconds` comes from the row's
`suspendedMs` counter. On every backend, when a call first reaches the
sandbox at time `t`, its start write sets `lastUsedAt` = `t`, conditioned
on the row still being this handle's and nonce's `READY` row and on
`attribute_not_exists(lastUsedAt) OR lastUsedAt = :read` (re-reading and
retrying up to three times); on `microvm` the same write adds
`max(0, t - lastUsedAt - sandboxIdle)` to `suspendedMs`, so each gap is
added once. Step 4 moves `lastUsedAt` to the end of the run with a
monotonic condition, `lastUsedAt < :end`, and adds nothing. The stop adds
the final gap up to `terminatedAt` (or the stop time on other backends).
`runningSeconds` is the difference, clamped at 0. The line carries `estimated` = true,
because the API reports no per-state times and the counter assumes the
MicroVM suspends exactly at `sandboxIdle`. On `agentcore` the platform
reports no session end, so a stop line written for a session the platform
already ended at its idle timeout counts up to the stop (by the drain, the
reaper or the tool) and over-counts idle time: §7.8 S-21 saw
`sandboxSeconds` of 560 to 900 s for sessions the platform ended after
60 s. For `agentcore` cost, use AgentCore's usage logs (table below), not
`sandboxSeconds`; their record format and the join through
`runtimeSessionId` are unverified (S-21 saw no usage record in 90
minutes of calls and stops).
Two Contributor Insights rules rank tenants by runs and by
`sandboxSeconds`. With `perTenantMetrics`, the
tool also emits EMF metrics `Runs`, `Errors`, `RunDuration`,
`SandboxSeconds` in the namespace `UntrustedCodeSandboxes`, with
dimensions `TenantId` and `Backend`; a stop line with `tenantId`
`unknown` emits no metric. It is off by
default because the custom metric count grows with tenants.

Cost attribution per backend:

| Backend | Attributable by | Formula | Unattributed |
|---|---|---|---|
| `microvm` | `sandboxSeconds` per tenant from the registry (MicroVMs take no tags) | baseline rate × seconds running + suspended storage rate × seconds suspended | the image build |
| `nitro` | `TenantId` task tag with ECS split cost allocation data turned on (account setting) | Cost Explorer split of instance cost by task reservation | idle instance capacity, NAT and endpoints, apportioned by `sandboxSeconds` |
| `agentcore` | AgentCore's session-level usage logs, joined to the tenant through `runtimeSessionId` in the tool line (format unverified, §7.8) | per-second vCPU and memory rates × the session's reported usage (consumption billing, no configured baseline) | none beyond the shared endpoints and NAT |

### 3.9 DNS Firewall option (ADR-0016)

With `dnsFirewall` on, the construct creates one Route 53 Resolver DNS
Firewall rule group and associates it with the whole VPC
(`MutationProtection` off, so `cdk destroy` can remove it; `FirewallFailOpen` is left at the service default, `DISABLED`, so a firewall fault blocks lookups instead of letting them through). Every backend's
lookups reach the VPC resolver, so one rule group covers all three
(S-13). The rule group applies to the tool subnets too, so the allow list
also carries the ECS Managed Instances' names.

| Priority | Action | Domains |
|---|---|---|
| 100 | ALLOW | `amazonaws.com`, `*.amazonaws.com`, `*.on.aws` (MicroVM endpoints), `*.api.aws` (ECS Managed Instances), `time.aws.com`, `*.compute.internal`, `*.ec2.internal` (the private host names in us-east-1), plus `allowDomains` |
| 200 | BLOCK, `NXDOMAIN` | `*` |

The rule group is associated with the VPC at priority 101, the first free
slot of a VPC that holds only this construct's resources.

Resolver query logging for the VPC goes to a log group the construct owns
(retention set, deleted on destroy). Every blocked lookup is logged with
`srcaddr`, `query_name` and `firewall_rule_action` = `BLOCK`; allowed
lookups carry no action. `srcaddr` names one tenant only on `nitro` (each
task has its own ENI); on `microvm` it is the shared connector ENI and on
`agentcore` the shared runtime ENI, so a hit there is joined to a tenant
by time against the tool's run lines (§3.8), which narrows a hit to the
tenants active in that window, not to one tenant. A Contributor Insights rule
ranks `srcaddr` by blocked lookups.

Every allowed zone is answered by AWS. `*.amazon.pool.ntp.org`, which
the MicroVM and AgentCore platforms look up, is a third-party zone and is
left blocked: its servers would see every label. S-13 saw no failure with
it blocked over 15 minutes; clock behaviour over hours is unverified.
Each sandbox address looks up its own reverse name (a PTR query, for
example `187.13.0.10.in-addr.arpa`) on every backend, as the integration
step `dns-platform` records: the platforms make it, the firewall leaves it blocked and it gets
NXDOMAIN. On `agentcore` the address is the shared runtime address. The
integration step `dns-platform` ignores a PTR for the querying address's own
reverse name, as it ignores the NTP zone, and fails on any other PTR.
Names a vendor adds in `allowDomains` are the vendor's own exception to
C-3.

Each instance with `dnsFirewall` on adds one account-level CloudWatch Logs
resource policy of its own, and each `agentcore` backend adds one more. The per-Region
quota for these policies is 10 (check the current quota before deploying
more instances into one Region and account).

Scope. The association covers the whole VPC. The construct creates its
own VPC, so nothing else is affected. With a supplied `vpc`, BLOCK `*`
would also refuse the vendor's private hosted zones and forwarded
domains for every other workload in it, so synth refuses `dnsFirewall`
together with `vpc`; a vendor with their own VPC associates their own
rule group with the §3.9 allow list.

Query logging to CloudWatch Logs may add to an account-level Logs
resource policy that other log deliveries in the account share. The
construct never declares that shared policy, because deploy would
overwrite it and destroy would delete it. It declares its own policy,
under a construct-path name, that lets `delivery.logs.amazonaws.com`
write to the query-log group only. The query-log configuration and its
VPC association depend on that policy, so the grant exists before
delivery starts and outlives it on delete; the `synth` test asserts the
dependency. The integration driver compares, from before deploy to after
destroy, the `DescribeResourcePolicies` statements that name the
query-log group's ARN (the group is named outside `/aws/vendedlogs/`, so delivery grants on that ARN and never on the prefix's shared wildcard), so other runs in the account do not show; any
remaining statement in a shared policy is the one known leftover of C-6.

What it does not cover: the tool Lambda, which has NAT egress and can
query a public resolver directly (it is trusted code); and names under
the allowed AWS zones, which resolve with wildcards
(`<anything>.s3.<region>.amazonaws.com`). The MicroVM image build runs on
Lambda's network, outside the VPC, so the firewall does not apply to it.

Cost: per query processed, with no fixed charge, plus query-log storage.
The S-13 network with the firewall deployed in 127 s and destroyed in
212 s; the same network without it took 157 s and 182 s.

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
| `replaces` | the handle a takeover replaced, kept until that sandbox is stopped so no sweep takes it for an orphan (ADR-0034) |
| `replacesLined` | boolean; true once the call that took the row over has stopped the replaced sandbox and written its stop line |

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
   or unreadable (no valid `state`, or no nonce, version, `createdAt` or
   `expiresAt`), or if its `version` and `nonce` are those read. On a condition failure,
   another call won: go back to step 1 once. The winner stops the handle it
   replaced, if any, then starts and records `handle` (and `address` when
   the start returns it), then probes as in step 1.
3. Run. A failed identity check, a `wrong_sandbox` or `dirty` refusal
   from the runner, "not found", a connection refusal, or a no answer (a
   proxy 502 included, which the platform also sends for a terminated MicroVM)
   from a MicroVM that `GetMicrovm` shows `TERMINATED` more than 2 s before the
   request left, marks the row dead: go to step 2 with the version just read. A call that has
   already waited for a start in this invocation does not wait again after
   a takeover: it returns `sandbox_starting`. A changed `bootId` means the
   sandbox restarted (on `agentcore`, the session under the same id): the
   tool rewrites the row with the new `bootId` and reports
   `sandbox` = `started`.
4. After the run, set `lastUsedAt` to the run's end with
   `attribute_exists(PK) AND handle = :h AND state = READY AND lastUsedAt < :end`, so a row
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
   `timedOut` = true, `exitCode` -9 (killed), and empty `stdout` and
   `stderr`. A backend may report no answer sooner, and the call
   ends the same way: on `nitro`, a connection lost, refused or cut after
   the `/hello` check passed is no answer at once, even when no job byte
   was sent (a keep-alive socket closed between `/hello` and `/run`, or the
   reaper stopping the task in that gap), because the tool cannot tell
   whether the runner read the job, and a rerun in a fresh sandbox would run
   the code twice (ADR-0047).

The reaper, every 5 minutes, writes the row before any stop with
`version = :seen`, so a call that updated the row meanwhile wins: `FAILED`
with `retryAt` when the row is a failed start (step 1), `STOPPING`
otherwise. It:

- stops `nitro` sandboxes in `READY` rows with `lastUsedAt` older than
  `sandboxIdle`; for a `STARTING` row it applies the tool's step 1 rule
  (mark a failed start `FAILED`, leave a starting one alone); for a `FAILED`
  or `STOPPING` row the reaper stops again a sandbox the platform still
  lists, writes no line (a stopped sandbox already has one; a start that
  threw has none, there being no sandbox to name), deletes a `STOPPING`
  row as soon as the sandbox has left the platform's list, and deletes a
  `FAILED` row once `expiresAt` has passed and the sandbox is gone;
- stops every task tagged by the sample whose own `startedAt` is older than
  `sandboxMaxLife`, with or without a row (the third cap on `nitro`);
- checks each `READY` row that the platform does not list with the
  backend's `isAlive` (`GetMicrovm` on `microvm`, `DescribeTasks` on
  `nitro`); when the sandbox is gone or terminated (the platform ended
  it), writes the stop line and deletes the row (`FAILED` and `STOPPING` rows already have theirs);
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

Input. On the gateway entry: after the gateway strips the tenant context,
with `tenantId` taken from the context (a `tenantId` argument is refused).
On the standalone entry: the same fields plus `tenantId`.

| Field | Type | Required | Rule |
|---|---|---|---|
| `tenantId` | string | standalone only | `[A-Za-z0-9][A-Za-z0-9_-]{0,63}`; the same rule applies to the context's tenant on the gateway entry, because the id becomes the session tag, the key prefix, the registry key and the session hash |
| `code` | string | yes | ≤ 64 KiB, UTF-8 Python |
| `input` | string | no | object name under the tenant's `inputs/` prefix; `[A-Za-z0-9._/-]{1,256}`, no `..`, no leading `/` |
| `backend` | string | no | one of the enabled backends; default `defaultBackend` |
| `saveOutput` | boolean | no | also write the result to `outputs/` |

Output:

```json
{ "runId": "…", "backend": "microvm", "exitCode": 0, "stdout": "…", "stderr": "",
  "truncated": false, "timedOut": false, "memoryExceeded": false, "durationMs": 412, "sandbox": "reused" }
```

`sandbox` is `started` or `reused`, so a caller can see a cold start.
`memoryExceeded` is true when the runner or the kernel killed the job
for its total memory (§3.5 memory cap). A single process that passes its
own limit gets `MemoryError` in `stderr` on every backend, with
`memoryExceeded` false. On `microvm` the flag is set only when the
free-memory floor killed the job (§3.5). The tool
description states the per-backend limits an agent writes code for. On
`microvm` a process has 256 MiB of address space, each thread takes
about 8 MiB of it for its stack, a job has at most N processes and
threads, and `multiprocessing` locks, queues and pools fail with
`PermissionError`, because POSIX semaphores and shared memory need
`/dev/shm`; `subprocess` and `os.fork` work. The `microvm` job filter
(§3.5) also makes `memfd_create`, SysV shared memory, semaphores and
queues, `vmsplice`, `io_uring`, `userfaultfd`, mounts, `unshare`, new
namespaces through `clone`, Unix sockets other than `socketpair`,
`listen` with a backlog above 8 (so `socket.listen()` with no argument,
which asks for 128), and socket buffer sizing fail with `EPERM`, and
each process has at most 64 open files, about 56 for the job's own use.
On `nitro` SysV IPC (`semget`, `msgget`, `shmget`) fails with `EPERM`,
and a process has L less 64 MiB of address space, 704 MiB at the
default task size.

Errors (tool error `code`, no stack, no tenant data):

| Code | Retry | When |
|---|---|---|
| `context_invalid` | no | gateway entry: the context failed verification (from `toolHandler`), or the verified tenant id breaks the §5.1 tenant id rule |
| `invalid_argument` | no | a field breaks its rule |
| `input_not_found` | no | no such object under the tenant's prefix, or S3 refused the read (S3 answers 403 for a missing key; the caller never learns which) |
| `input_too_large` | no | the object exceeds `maxInputBytes` (`HeadObject` before any start) |
| `backend_disabled` | no | `backend` names one not deployed |
| `sandbox_starting` | yes, after `retryAfterSeconds` | the tenant's sandbox is starting (§4.1) |
| `sandbox_busy` | yes | the tenant's sandbox is running another job, or, on `agentcore`, two first calls reached the session at once |
| `sandbox_failed` | yes, after `retryAfterSeconds` | the sandbox ended before it served, or died mid-run (§4.1 failed starts) |
| `tool_failed` | no | any other fault (from `toolHandler` on the gateway entry, from the core handler on the standalone entry) |

The runner's `wrong_sandbox` and `dirty` refusals never reach a caller:
the tool treats them as a dead handle (§4.1 step 3).

On the gateway entry, a `tenantId` argument, an argument the tool does not
declare (`code`, `input`, `backend`, `saveOutput` are the declared ones),
or an argument of the wrong JSON type returns `invalid_argument` with a
short fixed `message`; no value from the call appears in it.

A script that exits non-zero, times out or is killed is not a tool error: it
returns a result with `exitCode`, `timedOut` and its output.

### 5.2 `offboardTenant`

A Lambda function the vendor invokes with IAM (`lambda:InvokeFunction`),
input `{ "tenantId": … }`. It sets each of the tenant's rows `STOPPING`
with a version condition, stops the sandbox (and any sandbox a takeover
replaced), and deletes the row, or leaves it `STOPPING` while the platform
still lists the sandbox, for the reaper to delete. It returns the stopped
handles. A sandbox or row it cannot clear makes the call fail, so the
caller repeats it. It runs as the reaper role (§3.6), which holds the stop actions and
no instance action, so an offboard call cannot end another tenant's
sandbox by ending the instance it shares. It is idempotent: a repeat call
stops nothing and returns the same shape. The caller removes the tenant's `run_code` grant
first, so no call can start a new sandbox in between. The control plane's
tenant delete script is the intended caller.

### 5.3 Teardown

A delete-time custom resource (the drain) runs before the cluster, the
runtime and the image are deleted, and the order matters. It stops every
handle in the registry, then every task and MicroVM the orphan sweep
finds, and waits until `ListTasks` shows every task `STOPPED` and
`ListMicrovms` shows every MicroVM of the image `TERMINATED` (at most 10
minutes). A MicroVM image cannot be deleted while MicroVMs of it are
live (running or suspended), and a capacity provider cannot be deleted
while a task is still stopping; in both cases CloudFormation fails the
delete, the second after a 20-minute stall. It also fails while an idle
managed instance still runs (S-14), and CloudFormation does not retry
it. So once every task is `STOPPED`, the drain reads the cluster's
container instances and their EC2 instance ids, deregisters each with
`force`, which on ECS Managed Instances terminates the instance (ECS
developer guide, Managed Instances draining), and waits until
`DescribeInstances` shows every one of those ids `terminated`. It
repeats the read, deregister and wait until `ListContainerInstances` is
empty, within its 10-minute bound. In S-16 an instance reached
`terminated` 17 to 30 s after the deregister, no replacement started,
and the stack delete then succeeded first time in 38 s. Without the
drain, the capacity provider delete waits for scale-in (`ScaleInAfter`
plus about 15 s, 162 s in all at 120 s) and fails when `ScaleInAfter` is
long (S-14, 900 s). The sample sets `ScaleInAfter` to 120 s (S-7, S-16),
so instances go about two minutes after the last task (ADR-0070). The
capacity provider has no minimum-instances setting, so the sample keeps
no warm instance. The `synth` test checks that the drain role may
deregister on the cluster and the reaper role may not, and that the
offboard function runs as the reaper role. With sandboxes live, the
whole stack delete takes 23 to 32 minutes (§7 S-21). In the `nitro` and
`agentcore` runs most of it was the late release of the network
interfaces of the drain and reaper functions, which were in the VPC
then; ADR-0071 has since taken them out of it. The `microvm` run's cause
was not isolated. The run function and bound functions keep their
interfaces in the tool subnets. Lambda releases them with the function's
role after the function is gone (about 45 s in run 14, one observation),
so the log drain holds each such role and its network interface policy
for its 90 s (ADR-0073). Plan 30 to 40 minutes for a destroy. A
`StopTask` takes 45 to 78 s, so the runner exits at once on `SIGTERM`.
AgentCore sessions in rows are stopped with `StopRuntimeSession`;
sessions with no row end within about 20 s of the runtime's delete,
which takes about 200 s. Creating a runtime took 548 to 553 s in S-13
and S-14, with and without the DNS Firewall, against 201 to 204 s in
S-9, cause unknown; with `agentcore` enabled it sets the deploy time.

Log groups. The construct owns the task log group and a log drain waits
90 s on delete before it goes, as agentic-runtime-isolation ADR-0019 does.
AgentCore creates the runtime's groups itself, after deploy, under
`/aws/bedrock-agentcore/runtimes/<runtimeName>-`, so the construct cannot
own them. Instead a cleanup custom resource, on which the runtime depends,
takes that prefix as a property (known at synth, no reference to the
runtime), is deleted after the runtime, and then deletes every group under
the prefix. The session usage logs that §3.8 uses for `agentcore`
cost (format unverified, §7.8) are delivered (`AWS::Logs::DeliverySource`, `DeliveryDestination`,
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
| Three Contributor Insights rules (the third with `dnsFirewall`) | `RuleName`, 128 |
| DNS Firewall domain lists, rule group, association, query-log config and its log group | Resolver names `[\w-]`, 64; log group `[\w./#-]`, 512 |
| Query-log Logs resource policy | `[\w-]` (the sanitiser emits only these), 255, unique per account and Region |

The ECS capacity provider name gets the prefix `cp-` when it would start
with `aws`, `ecs` or `fargate`, which ECS refuses.

The `synth` unit test asserts that every one of these names is unique and
matches its charset when two instances share a stack.

## 6. Contracts

### 6.1 What the deployer supplies

- For the gateway entry only: an `agentic-runtime-isolation` ingress with a tools gateway, in
  the same app or through its published `ingress` parameter, and a grant for
  `run_code` in its entitlement store for each tenant that may use it
  (agentic-runtime-isolation spec §4.5).
- A Region where all enabled backends exist. Lambda MicroVMs, ECS Managed
  Instances with Nitro Sandboxes and AgentCore Runtime V2 are all in
  eu-central-1; the sample defaults there.
- Optionally a VPC with tool subnets (a default route to a NAT) and sandbox
  subnets (no default route), tagged `run-code:tier` = `tool` or `sandbox`.
- For `microvm`: enough of the "Max allocated ARM_64 MicroVM memory"
  quota (`L-CD1C0CC4`, one quota per architecture; the runner image is
  ARM_64). It counts the configured baseline (`microvm.memoryMiB`) of
  running and suspended MicroVMs, and defaults to 2048 GB per account
  and Region, about 2048 sandboxes at the default size (S-16). A tenant holds `microvm.memoryMiB` of quota
  from its first call until 30 suspended minutes after `sandboxIdle`.
  `RunMicrovm` is limited to 5 calls per second per account, which
  limits how fast a burst of new tenants can start.
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
  through the resolver. With `dnsFirewall` off, DNS resolves public names
  on every backend, so a script can encode data in lookups. With it on,
  only the §3.9 names resolve and every other lookup returns NXDOMAIN
  and is logged; names under the allowed AWS zones still resolve, but
  AWS, not the script's owner, answers them. Names in `allowDomains` are
  the vendor's own exception.
- C-4: A run ends within `runTimeout` plus 5 s with its process group
  killed, or the tool stops the sandbox and reports `timedOut`.
- C-5: The tool reads inputs only under the caller's tenant prefix and
  registry rows only under its key; IAM refuses any other key even if the
  tool's code is wrong.
- C-6: `cdk destroy` leaves no sandbox, task, MicroVM, session, instance,
  log group, DNS Firewall resource or construct-owned Logs resource policy
  behind, including sandboxes started at run time. An entry that query-log
  delivery adds to a shared, account-level Logs resource policy, if any,
  is the one known leftover (§3.9).

### 6.3 Composition (standard §1.1)

Consumes:

| Producer | Interface | Why |
|---|---|---|
| `agentic-runtime-isolation` | construct `ToolTarget` from its package entry and `toolHandler` from its `./tools` subpath (local `file:../agentic-runtime-isolation`, dev and optional peer dependency; the gateway entry supports only a `file:` install of the producer, ADR-0017), parameter `/application-plane/shared/agent-runtime/ingress` | the tools gateway, the signed tenant context; used only by the gateway entry |
| `tenant-identity` `shared-pool` | its parameters, through `agentic-runtime-isolation` only | users and tenants for the integration test |

Publishes (ADR-0069):

| Parameter | Value |
|---|---|
| `/application-plane/shared/code-sandbox/sandboxes` | one JSON document: `version` (1), `toolTarget` (the `RunCodeToolTarget` name, or `none`; `none` in the demo stack, which has no gateway entry), `runCodeFunctionArn` (with `standalone`, or `none`), `backends`, `defaultBackend`, `registryTableName`, `inputBucketName`, `offboardFunctionArn`, and per backend `imageArn` (`microvm`), `clusterArn` and `taskDefinitionArn` (`nitro`), or `runtimeArn` (`agentcore`) |

The demo stack (`src/demo.cdk.ts`) writes the parameter from the
construct's read-only properties; the construct writes no parameter
(standard §4.5), and the integration stack publishes nothing
(agentic-runtime-isolation ADR-0042), so its two construct instances cannot
collide on it. A parameter only names resources: a consumer in another app
still makes its grants through `grantInvokeRunCode` or `RunCodeToolTarget`
in the app that owns the construct.

Constructs: `UntrustedCodeSandboxes` from the package root and `RunCodeToolTarget` from the `gateway` subpath, with their props, plus the exports in §3.3.
The sample has a row in the `ARCHITECTURE.md` samples map and its
parameter namespace, `/application-plane/shared/code-sandbox/*`, in §5.1
there.

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
| S-7 | `RunTask` to `RUNNING` on a warm instance, and from zero instances; idle instance cost; is a stopped task's private IP reused within an hour? | a warm-instance option (dropped, ADR-0070), ADR-0010 |
| S-8 | Does `InvokeAgentRuntime` support a condition on the session id, so the tool role can be limited per tenant? | enforced or filtered call (§3.4) |
| S-9 | Does a V2 runtime in VPC mode with the §3.7 endpoints and policies start, pull, refresh and log? Can its code reach the internet or PUT to another bucket through the S3 endpoint? Does deleting the runtime end its live sessions, and how long does the delete take? | C-3 on `agentcore`, drain |
| S-10 | With the §3.6 runtime role, what can code do with the metadata endpoint's credentials, and does `aws:AgentCoreRuntimeSourceSid` scope the `sessionFiles` grant to one session? Does the container start as root and may the runner drop code to uid 1001? | C-2 on `agentcore`, ADR-0007, runner model |
| S-11 | Does the tools gateway allow a tool Lambda timeout of 120 s, and what does the agent see past it? | timing budget |
| S-12 | Can the integration test call `run_code` through the tools gateway with a transaction token without an agent in between, as a consumer could? | §8 drive path |
| S-13 | Does a VPC-wide Route 53 Resolver DNS Firewall see and block each backend's lookups, and does each backend still work with it on? | §3.9, ADR-0016 |
| S-14 | Runner checks: can code in one AgentCore session reach another session of the same runtime (by its address, by a listener on a known port, by anything the sessions share); can the runner create a cgroup v2 group and set `oom_score_adj` on each backend; do `RunTask` container overrides and `runHookPayload` appear in CloudTrail `requestParameters`, and does the `InvokeAgentRuntime` payload appear in any CloudTrail event; does the AgentCore container receive the runtime session id as a request header | C-1 and C-3 on `agentcore`, §3.5 memory cap, ADR-0018 |
| S-15 | On `microvm`, which has no cgroup: do `RLIMIT_AS` and `RLIMIT_NPROC`, set before the drop to uid 1001, cap a job's memory, can code raise them, and do common runtimes start under them? | §3.5 memory cap on `microvm` |
| S-16 | Which mounts are tmpfs on each backend; tmpfs and unmapped `memfd` fills against the §3.5 caps; the `agentcore` setup under a global out-of-memory; four threads under the `microvm` rlimits; the drain's forced deregister and the capacity provider delete; the applied MicroVM memory quota | §3.5 memory cap, §5.3 drain, §6.1 |
| S-17 | On `microvm`: does a seccomp filter installed by the runner as uid 1001 block `memfd_create` and stay on, what other routes hold memory the rlimits do not count, and what does a filter cost and break? | §3.5 job filter, ADR-0020 |
| S-18 | On `microvm`: ordinary job code under the full ADR-0020 setup, the `clone` entries, the child check, Unix sockets across N processes and in flight, every open route at once, and the free-memory floor against slow and fast fills. On `nitro` and `agentcore`: SysV and Unix socket memory against the task and job groups, and the SysV sweep | §3.5 job filters, floor, watchdog and step 3, ADR-0021 |
| S-19 | The `nitro` watchdog on `memory.current` against every fill, and the runner's share of the group; the `nitro` filter on the x32 ABI; the 50 ms `microvm` floor against an unmapped fill the list misses; the loopback TCP accept queue at a backlog of 8 with every other open route; the blocked-call self-test | §3.5 watchdog, A on `nitro`, floor, `nitro` filter, ADR-0022 |
| S-20 | On `nitro`, with a probe runner close to §3.5: the runner's share of the group; a single process at A = L − 64 MiB; `/work` file writes against the watchdog's `memory.current` less `file` plus `shmem`; the S-19 routes again; a job mixing files and anonymous memory | §3.5 watchdog, A on `nitro`, ADR-0022 |
| S-21 | One deployment per backend of the built construct (three smoke runs) through the standalone entry: the steps that run on one backend, the `agentcore` job group after a sweep against the 32 MiB `dirty` threshold, and the stack delete with live sandboxes | §3.5 step 3, §3.8 stop line, §8 run budget |

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
| S-1 | `AWS::Lambda::MicrovmImage` and `AWS::Lambda::NetworkConnector` deploy from a zip. Stack create 308 s (image 120 s, connector 254 s, in parallel); a code update 157 s. The image delete fails at once while a MicroVM of it runs or is suspended; the connector delete succeeds even with MicroVMs on it. After the MicroVMs were terminated, the delete took 92 s. Names: `[a-zA-Z0-9_-]`, 64; the connector ARN uses a generated id. A security group with no egress needs a placeholder rule in CloudFormation | §5.3 drain order, §5.3 names | which of a RUNNING or a SUSPENDED MicroVM blocks the image delete (the drain waits for both to end); what a running MicroVM's network does after its connector is deleted; a digest-pinned `FROM` in the MicroVM build (the spike used a tag) |
| S-2 | With only the VPC connector, code reached no internet host, no peer MicroVM and no interface endpoint. With no egress connector the MicroVM got `INTERNET_EGRESS` and reached the internet. Still open with the connector: DNS to the VPC resolver (public names resolve), and the link-local metadata service (Region, AZ id, a per-MicroVM key; no credentials without an execution role). The hook port 9000 answers only to a token that allows it | §3.4 Code holds, Egress, DNS; C-3; §1.2 | an actual DNS-tunnel exfiltration; only resolution and TCP 53 reach were checked |
| S-3 | `RunMicrovm` and `CreateMicrovmAuthToken` take no tags and no request-tag condition. Every MicroVM action authorizes against the image ARN; there is no MicroVM ARN, and the only key is the image's `aws:ResourceTag`. `lambda:PassNetworkConnector` is needed for every connector passed, including `HTTP_INGRESS`, and for `INTERNET_EGRESS` when the egress connector is omitted | §3.4 start filtered; §3.6 tool role; §3.8 no MicroVM tag | `TerminateMicrovm` was checked only in the allowed case |
| S-4 | Cold start to first `/run` P50 2.50 s, P90 2.82 s (n = 20, the connector adds nothing measurable). Resume P50 0.56 s, auto-resume by request 0.62 s (n = 5). The runner is PID 1 as root; a child drops to uid 1001 and cannot regain root or signal the runner. `bootId` survives suspend and resume. `runHookPayload` reaches the `/run` hook, capped at 4096 characters. `GetMicrovm` reports `startedAt`, `terminatedAt`, `stateReason`, no suspend times and no tags. Default memory quota 2048 MiB per Region (corrected by S-16: 2048 GB) | §3.4 start cap and Start; §6.1 quota | idle auto-suspend after `maxIdleDurationSeconds` and expiry at `maximumDurationInSeconds` [`microvm-stop`, `max-life`]; the execution-role path |
| S-5 | In an `ISOLATED_SANDBOX` task with no task role: no credential variables, the credentials endpoint returns 404, IMDS v1 and v2 do not answer (timeout), the task metadata endpoint returns only task, cluster, image and log fields. The container starts as root; a child drops to uid 1001 | C-2 holds | the `ECS_AGENT_URI` address; vsock and other host channels; `CONFIDENTIAL_SANDBOX` |
| S-6 | The instance pulls the image: a task with no security group egress at all pulled a new digest and started. `awslogs` leaves through the task ENI (logs were held 48 s until 443 to the Logs endpoint was allowed). Code reached only the endpoint addresses; no internet, no other task | §3.4 Egress; §3.7 `nitro` group and endpoints | the scoped §3.7 endpoint policies (the shared network's policies were used) [`no-egress`]; which path the instance used for ECR |
| S-7 | `RunTask` to `RUNNING`: 31 to 34 s from zero instances, 11 to 18 s warm (median 13.4 s). Scale-in 131 s after the last task with `ScaleInAfter` 120. `m7i.large` does not support Nitro Sandboxes; `m7i.xlarge` does, at $0.27 per instance-hour including the management fee. `StopTask` 45 to 78 s. Twelve tasks got twelve distinct IPs (reuse not seen, not ruled out). The same `clientToken` returned the same task. A capacity provider delete fails while a task is still stopping, after a 20-minute stall | §3.3 `nitro.instanceTypes`; §3.4 start cap; §5.3 drain order | `m7g.large` on ECS (EC2 reports it supported, but the probe image was amd64); cold starts under load or in another Region, since the two cold starts may have used a pre-prepared instance; `clientToken` reuse after the task stopped; whether a still-running idle instance blocks the capacity provider delete [`teardown`]; multi-AZ placement (every run used one sandbox subnet) |
| S-8 | `InvokeAgentRuntime` and `StopRuntimeSession` support only `aws:ResourceTag`; a session-id condition never matched. No API lists a runtime's sessions | §3.4 call filtered (ADR-0009) | an `aws:ResourceTag` condition on invoke and stop |
| S-9 | A V2 container runtime in the §3.7 network reached `READY` in 201 to 204 s; an update took 200 s. Direct code deployment failed under the §3.7 S3 endpoint policy and needed about 9 minutes when it worked. HTTPS out failed; a presigned PUT to a bucket outside the endpoint policy returned 403. Public DNS names resolve. A new session answers in 2.0 to 2.5 s, a warm one in 0.5 to 0.7 s. Deleting the runtime takes about 200 s; a live session stops 17 to 21 s after the call. Log groups `/aws/bedrock-agentcore/runtimes/<name>-<id>-DEFAULT` stay after the delete | §3.5 container only; C-3; §5.3 | CloudFormation deployment of the runtime (the CLI was used); runtime logging with the Logs endpoint removed (log delivery did not use the customer ENI); which AWS bucket direct code deployment reads |
| S-10 | Credentials come from IMDSv2. The runtime role reached only its own repository, its log prefix and, with `sessionFiles`, its own session prefix; session X was refused `sessions/Y/`. `logs:DescribeLogGroups` at the prefix is refused and not needed. A container starts as root and drops a child to uid 1001; a direct-code runtime runs as uid 991 and cannot. Sessions of one runtime version report the same process start state | §3.4 Ready; §3.5; §3.6 runtime role | P50 and P90 over 20 runs (5 samples each); IMDS `tags/`; whether code in one AgentCore session can reach another session's address [`no-egress`, recorded as unverified in the threat model if no address can be found] |
| S-11 | The gateway allows a 15-minute invocation; a tool Lambda timeout reaches the caller as a generic `isError` result. `agentic-runtime-isolation`'s `api-gateway` ingress cuts every turn at a fixed 120 s | §3.3 timing budget | a tool Lambda that times out (the error shape is from the documentation's access-denied example) [`runaway`] |
| S-12 | A direct `tools/call` works with a token minted by a test-only Lambda that the producer's own test grants `kms:Sign`. A consumer cannot sign for an ingress it does not own | §8 driver | whether a minted token naming an agent that is not deployed is accepted |

### 7.2 Spike result, S-13 DNS Firewall (2026-11-18, a non-production test account, eu-central-1)

One rule group on the §3.7 VPC (ALLOW `*.amazonaws.com`, `amazonaws.com`,
`*.on.aws`; BLOCK `*` with NXDOMAIN) with VPC query logging. Each backend
ran the same probe twice or more, with a unique token per run. The
decision is recorded in ADR-0016.

| Backend | Result | Blocked platform names | Not tested |
|---|---|---|---|
| `microvm` | The MicroVM's resolvers (127.0.0.2, 169.254.53.53) forward to the VPC resolver; 10.80.0.2 also answers. Every probe name, qtype (A, AAAA, TXT, ANY, MX, CNAME), case, trailing dot and TCP DNS was logged; blocked names returned NXDOMAIN, logged `BLOCK`; `logs.<region>.amazonaws.com` resolved to the endpoint. Public resolvers time out (security group). `srcaddr` is the connector ENI, shared by MicroVMs on one subnet. Start, `/run`, suspend, auto-resume, logs and terminate all worked; `RUNNING` in 1.6 to 1.8 s | `3.amazon.pool.ntp.org` (no failure in 15 min) | a customer-owned name under `on.aws`; clock drift over hours; firewall fail-open |
| `nitro` | `resolv.conf` lists only the VPC resolver. All probe names logged; blocked ones NXDOMAIN in 1 to 3 ms; `srcaddr` is the task's own ENI. Cold start 30.4 s, warm 12.7 s, logs arrived, scale-in worked: no change from S-7 | from the instance (tool subnet): `ecs-d-<az>-<id>.<region>.api.aws`, about 2,900 times over the instance's life, rising to 424 a minute, no visible failure; `time.aws.com` 20 times; its own `ip-…compute.internal` name 4 times | the run with these names allowed; exfil under `*.amazonaws.com` |
| `agentcore` | The session's resolvers (127.0.0.2, 169.254.53.53) and 10.80.0.2 all reach the VPC resolver; all probe rounds logged, blocked ones NXDOMAIN; `srcaddr` is the runtime ENI, shared by its sessions. Image pull and logs, under `*.amazonaws.com`, worked. `READY` took 548 and 549 s against 201 to 204 s in S-9; the ENI made no lookup until about 440 s, so the delay comes before DNS, cause unknown | `3.amazon.pool.ntp.org` | a control run without the firewall on the same network; clock without NTP |
| tool side | A Lambda in the tool subnets resolved and reached a MicroVM endpoint (`*.on.aws`). It could also query 8.8.8.8 and 1.1.1.1 through the NAT, unseen by the firewall. A Lambda in the VPC adds about 20 minutes to the stack delete while its ENIs release | none | |

### 7.3 Spike results, S-14 and S-15 (2026-11-19, a non-production test account, eu-central-1)

Each backend ran a probe runner as root with uid 1001 children, on the
§3.7 network without the DNS Firewall. Dummy nonces were used and
searched for in CloudTrail Event history; both trails in the account
record management events only. Every stack was removed; two AgentCore
runtime log groups and the CDK asset objects were left. The decisions
are recorded in ADR-0019.

| Check | `microvm` | `nitro` | `agentcore` |
|---|---|---|---|
| Runner cgroup v2 group with `memory.max` | No: `/sys/fs/cgroup` is empty, `mount` is `EPERM` | No: the mount is read-only, remount `EPERM`; the platform caps the task group at the task size | Yes, once the runner moves itself into a child group; a uid 1001 job filled past `memory.max` is killed and the runner lives |
| Runner's own `oom_score_adj` at start; can it set -1000 | 1000; no | -998; no (yes with `SYS_RESOURCE` in the task definition) | 1000; no |
| Out-of-memory with no cgroup of the runner's, 16 uid 1001 fills | 2 of 16 killed, runner lives (guest 3998 MiB) | 13 of 16 killed, runner lives (1 GiB task) | the whole session dies, unless the runner first writes 0 to `memory.oom.group` (then only jobs are killed) |
| Start call or job in CloudTrail Event history | `RunMicrovm` and `TerminateMicrovm` absent after 30 min | `RunTask` present within 2.5 min; override `environment` replaced by `HIDDEN_DUE_TO_SECURITY_REASONS` | `InvokeAgentRuntime` absent (0 of 42 after 18 min) |
| Nonce found in any event | no | no | no |
| Session id header | | | `x-amzn-bedrock-agentcore-runtime-session-id`, equal to the caller's id on all 42 jobs; none on `/ping` |
| One session reaches another | | | No path on the §3.7 group or on an open group: TCP, UDP and ICMP to the peer's IPv6 address and to the runtime ENI all timed out; `/tmp` and `/dev/shm` are per session. Each session sees only 169.254.0.2 and its own IPv6 address; a runtime has one ENI whatever its session count |
| Deploy and destroy | stack 306 s, delete 92 s; MicroVM `RUNNING` in 1.4 to 2.2 s | stack 187 s; delete 14.8 min, because the capacity provider delete fails until the idle instance scales in (`ScaleInAfter` was 900 s) | runtimes `READY` in 552 s without the DNS Firewall (S-13's 548 s is therefore not the firewall's); runtime delete 199 s, stack delete 514 s |

S-15 (`microvm` only, guest 3998 MiB):

| Check | Result |
|---|---|
| `RLIMIT_AS` 512 MiB | every allocation path (`bytearray`, `malloc`, private and shared `mmap`) fails with `MemoryError` or `ENOMEM` at 496 MiB, 0.09 to 0.13 s after the first allocation; the job keeps running; forks and `exec` inherit the limit |
| `RLIMIT_DATA` 512 MiB | a shared anonymous `mmap` (Python's default) bypasses it and reached 1024 MiB |
| uid 1001 raising its limits | soft up to hard only; the hard limit cannot be raised by any route tried |
| Lowest `RLIMIT_AS` that starts | `sh` 8 MiB, `python3 -c 1` 16 MiB, a 32 MiB `bytearray` 48 MiB, `node -e 1` 344 MiB |
| 16 children × 256 MiB with `RLIMIT_NPROC` 16 | one child killed in each of three runs, runner alive; 12 × 256 and 16 × 192 MiB (70 % of `MemTotal`) clean, at least 741 MiB free |
| `prlimit` on a live job | refused from the runner (`EPERM`); a helper at uid 1001 lowers it in 12 ms |
| `MinimumMemoryInMiB` | 1024 gives 3998 MiB and 2 vCPUs; 2048 gives 8016 MiB and 4 |

Not tested here (S-16 and S-17 cover the first four, §7.4): memory that `RLIMIT_AS` does
not count (tmpfs files, `memfd_create`); the `agentcore` setup as a whole
under a global out-of-memory (its two parts ran separately); threads
against the `microvm` rlimits; the applied MicroVM quota; the
`agentcore` and `microvm` checks in a 1 GiB sandbox (the sizes are fixed
by the platform); scanning
address ranges for other sessions, and whether two sessions share a host;
session ids under 33 characters; a trail with data events for any of the
three services; the 200 ms watchdog itself.

### 7.4 Spike results, S-16 and S-17 (2026-11-19, a non-production test account, eu-west-1)

These two ran in eu-west-1, because eu-central-1 was at its VPC quota.
The guest sizes, kernels and limits matched S-14 and S-15. Every stack
was removed; one AgentCore runtime log group, INACTIVE task definition
revisions and CDK asset objects were left. The decisions are recorded in
ADR-0020.

| Check | `microvm` | `nitro` | `agentcore` |
|---|---|---|---|
| tmpfs mounts uid 1001 can write | `/dev/shm`, 64 MiB | `/dev/shm`, 576 MiB | `/dev/shm`, 64 MiB |
| `/tmp`, `/work` | one ext4 disk | one overlay disk, 20 GiB | one overlay disk, 9.7 GiB |
| tmpfs fill | `ENOSPC` at 64 MiB, runner alive | `ENOSPC` at 576 MiB, no kill; a 1.5 GiB tmpfs is killed at the task limit, not at L | `ENOSPC` at 64 MiB; a 9 GiB tmpfs is killed by the job group at L, and ends the session without the group |
| Unmapped `memfd` fill | not counted by any rlimit; a fill aimed at 3840 MiB ended the whole MicroVM at about 3.6 GiB in 3 of 3 runs, 3584 MiB was survived | killed by the kernel at the task limit (about 960 MiB), runner alive; 900 MiB held with no kill | killed by the job group at L, runner alive; without the group the session ended |
| `RLIMIT_FSIZE` 100 MiB, `RLIMIT_NOFILE` 256 | cap each `memfd` at 100 MiB and the count at about 250, about 24 GiB in all | same | same |
| Watchdog on resident memory | not used | never fired: 13 MiB seen while 577 to 1010 MiB was held | not used |
| Other | 4 threads × 32 MiB under A = 256 MiB: pass with `MALLOC_ARENA_MAX` = 2 (`VmPeak` 236 MiB), fail without it; quota `L-CD1C0CC4` 2048 GB applied and default | forced deregister to `terminated` 17 to 30 s, no replacement, stack delete 38 s; no drain at `ScaleInAfter` 120 s: 162 s; no minimum-instances setting | global out-of-memory outside the job group killed the whole job group, runner alive with the same `bootId`; a larger holder outside the group was killed instead |

S-17 (`microvm`, a seccomp filter installed by the runner after the uid
drop):

| Check | Result |
|---|---|
| Install as uid 1001 with no capability | yes, `Seccomp` 2, `Seccomp_filters` 1 |
| Blocked calls | `EPERM`; children, grandchildren and `exec`ed `sh` and `python3` keep it; the job cannot remove or loosen it |
| S-16 `memfd` fill | fails at the first `memfd_create`, MicroVM alive |
| Routes left with only `memfd` and SysV shared memory blocked | Unix socket buffers, SysV semaphores, `vmsplice` pages in pipes, a tmpfs in a user namespace: 3.2 GiB or more each; SysV message queues 500 MiB. Unbounded, sockets and semaphores made the runner stop answering in about 2 s. SysV objects outlived the job and root could not remove them |
| With the §3.5 list | all of these held 55 MiB or less; pipes 63 MiB and loopback TCP 366 MiB stay as before |
| Ordinary job code (20 checks) | no difference with and without the filter |
| Cost | +0.16 to +0.18 ms per job start, +22 ns (+10 %) per system call, +1 to +2 % on file writes |
| Kernel limits | `/proc/sys` is read-only in the guest |

Not tested: the free-memory floor itself; `clone3` and a direct
`clone(CLONE_NEWUSER)` under the filter (the mount family is blocked);
an AArch32 entry; ptys, aio, `MAP_HUGETLB` and other routes not tried;
third-party packages under the filter (S-18 covers the filter on
`nitro` and `agentcore`, §7.5).

### 7.5 Spike results, S-18 (2026-11-19, a non-production test account, eu-west-1)

The guests and limits matched S-16 and S-17. Every stack was removed;
one AgentCore runtime log group and CDK asset objects were left. The
decisions are recorded in ADR-0021.

`microvm`, with the full ADR-0020 runner setup (A 256 MiB, N 9,
`RLIMIT_NOFILE` 64, the filter with the `clone` entries, the child
check, the floor):

| Check | Result |
|---|---|
| 25 ordinary job checks | same as unfiltered; `multiprocessing` fails with `EACCES` in both (the `/dev/shm` lock); 56 files can be opened |
| `clone` with a `CLONE_NEW*` flag; `clone3`; `unshare` | `EPERM`; `ENOSYS`; `EPERM`. `fork`, threads, `subprocess` and `posix_spawn` work |
| Filter install skipped or failing | `Popen` raises in under 2 ms, no job code runs, no uid 1001 process left; an allow-all filter passes the check |
| Unix pairs across 9 processes, default buffers | stream 121 MiB, datagram and seqpacket 198 MiB held |
| Descriptors in flight through `SCM_RIGHTS` | `ETOOMANYREFS` at about 80 per user; 36 to 46 MiB more |
| Unix accept queue; named Unix datagram receiver | 10 to 11 GiB/s; 14 to 18 GiB/s; both closed by the two socket rules |
| Loopback TCP accept queue | 1315 MiB at `listen(4096)`; about 380 MiB at `listen(8)` |
| Every open route at once | 2627 to 2653 MiB held, `MemAvailable` low 1033 to 1055 MiB, floor silent |
| Fills to 70 % of `MemTotal` at 0.5, 1 and 2 GiB/s | `MemAvailable` low 858 to 873 MiB, floor silent |
| Fills past it | floor fired 54 of 54, runner alive; lowest `MemAvailable` at the kill 407, 301, 210 and 0 MiB at 0.5, 1, 2 and 4 GiB/s |
| Where the guest is lost | about 2 to 7 MiB available for unmapped memory; never for anonymous memory |
| 4.4 GiB/s `memfd` fill, floor at 200 ms | guest lost in 1 of 2 runs |
| Unpaced anonymous fill, about 8 GiB/s, floor at 50 ms | caught 8 of 8, lowest `MemAvailable` 129 MiB |
| Zombies of killed job processes | count against `RLIMIT_NPROC`; the next `fork` failed with `EAGAIN` until the runner reaped |

`nitro` and `agentcore`:

| Check | `nitro` (1 GiB task, L 768 MiB) | `agentcore` (job group, L about 7.3 GiB) |
|---|---|---|
| SysV semaphores | charged to the task group as kernel memory, 963 MiB in 0.4 to 0.8 s, killed at the task limit (1023 MiB) in 0.9 to 2.2 s; the RSS watchdog saw 13 MiB | charged to the job group, killed at L in 1.9 s, runner alive |
| SysV message queues | 514 MiB at 8 KiB messages (`msgmni` 32000); 949 MiB and a global kill at 1-byte messages | 523 MiB, `msgget` `ENOSPC`, no kill |
| SysV objects after the job | stay, and stay charged; root `IPC_RMID` `EPERM` | stay, and stay charged; root `IPC_RMID` works (`CAP_SYS_ADMIN`) |
| Sweep as uid 1001 | 0.08 to 2.6 s, frees the group; after a kill at the limit the runner died in 4 of 5 semaphore runs and 1 of 3 queue runs | 0.07 to 0.46 s for up to 7.4 GiB, frees the group |
| Filter on `semget`, `msgget`, `shmget` | `EPERM` at once, nothing charged, runner fine (x86_64) | not needed |
| Unix pairs across 64 processes | charged to the task group, killed at the limit, runner alive; the RSS sum read 827 MiB for about 140 MiB held | 3502 MiB charged to the job group; killed at a 1 GiB limit, runner alive |
| Zombies after a kill | count against `RLIMIT_NPROC` | the next job's first `fork` failed with `EAGAIN` |
| Drain before the stack delete | 24 s to `terminated`, delete 38 s | |

Not tested here (S-19 covers the watchdog, the 50 ms floor, x32 and the
accept queue, §7.6): runtimes that call `clone3` without falling back
(Go, Rust, musl); why one `nitro` queue run exited 137 after it printed
its result.

### 7.6 Spike results, S-19 (2026-11-20, a non-production test account, eu-west-1)

The guests and limits matched S-18. Every stack was removed; only CDK
asset objects were left. The decisions are recorded in ADR-0022.

| Check | Result |
|---|---|
| `microvm` floor at 50 ms, unmapped `memfd` fill at 4.3 to 10.2 GiB/s (filter without `memfd_create`, random start offset) | guest saved 24 of 24, lowest detect 145 MiB, kill 0.09 to 0.17 ms, wake gaps 50 to 70 ms |
| Same at 200 ms; with no floor | guest lost 1 of 6, and two more detected at 2 and 0 MiB; lost 2 of 2 |
| `microvm` floor at 20 ms | saved 10 of 10, lowest detect 356 MiB |
| Floor CPU at idle | 0.04 to 0.07 % of one vCPU at 50 ms, 0.08 to 0.13 % at 20 ms |
| Loopback TCP accept queue at `listen(8)` with every other open route | up to 2659 MiB held, `MemAvailable` low 1028 MiB, floor silent; the queue shares `tcp_mem` with the connections, so the two do not add |
| Blocked-call self-test | an allow-all filter makes `Popen` fail in 2.2 ms with no job code run; about 0.07 ms per job start |
| `nitro` watchdog on `memory.current`, before the kernel | anonymous 12 of 12, at 852 to 1000 of 1024 MiB; `memfd` write 7 of 9; `memfd` `fallocate` 9 of 13; 64-process sockets 1 of 6 (polls slipped to 447 ms, once 4.8 s) |
| `nitro` false kill | none for a 64-process job holding 176 MiB |
| `nitro` runner, `memoryExceeded`, step 3 | runner alive in 85 of 85 fills, watchdog on or off; `memoryExceeded` right in all; nothing left after 97 of 97 jobs |
| `nitro` runner's share of the group | about 25 MiB at idle; one process at 752 MiB (inside `RLIMIT_AS` = L) was killed by the watchdog instead of getting `MemoryError` |
| `nitro` x32 | the kernel has no x32 ABI; the filter kills any x32 call with `SIGSYS` |
| `nitro` watchdog CPU at idle | about 0.06 % of one CPU at 200 ms, 0.13 % at 50 ms |
| Deploy and teardown | `nitro` stack 217 s, drain 23 s, delete 39 s; `microvm` stack 305 s, code updates about 150 s, delete 91 s |

### 7.7 Spike results, S-20 (2026-11-20, a non-production test account, eu-west-1)

`nitro` only, 1 GiB task, L 768 MiB, A 704 MiB, with a probe runner close
to §3.5 (TLS on 8443, `/hello`, `jobAuth`, the SysV filter, step 3) and
the watchdog on `memory.current` less `file` plus `shmem`. The stack was
removed; one INACTIVE task definition revision was left.

| Check | Result |
|---|---|
| Runner's share of the group | about 20 MiB counted (`memory.current` 43 MiB, 24 MiB of it file cache); `VmRSS` 31 to 33 MiB |
| One process at A | `MemoryError` or `ENOMEM`, watchdog silent, `memoryExceeded` false, 14 of 14; counted peak 714 MiB, 54 MiB below L |
| `/work` writes up to 2000 MiB, with and without `fsync` | no kill in 20 of 20; counted peak 36 MiB against `memory.current` 870 MiB; `file_dirty` up to 168 MiB, `file_writeback` 196 MiB; kernel limit never hit |
| S-19 routes again | `memfd` write: watchdog first 5 of 7; `memfd` `fallocate`: 3 of 7; `/dev/shm` then anonymous: 3 of 3; 8-process anonymous: 8 of 8; 64-process Unix sockets: 2 of 4; the kernel killed in the rest. `/dev/shm` alone stops at 611 MiB with no kill. Runner alive and `memoryExceeded` true in 29 of 29 kills |
| 600 or 1500 MiB of files, then 500 MiB anonymous | counted 538 MiB, no kill, 7 of 7 |
| 600 or 1500 MiB of files, then 800 MiB anonymous in two processes | watchdog kill at 771 to 835 MiB counted, 11 of 11 |
| Watchdog marking order | marking after the kill missed `memoryExceeded` once; marking first, 12 of 12 right |
| Deploy and teardown | stack 217 s, drain 19 s, delete 40 s |

### 7.8 Spike results, S-21 (2026-11-20, a non-production test account, eu-west-1)

Three single-backend deployments of the construct (`standalone` on,
`sandboxIdle` 2 min, 1 min on `agentcore`, `runTimeout` 20 s; `dnsFirewall`
off on `nitro` and `agentcore`), driven through `runCodeFunction` with the
steps of §8 that need no gateway and no other backend. The `agentcore` run
had two stacks, `sessionFiles` off and on, and ran its SysV case again
after a redeploy on the build with the 1 s poll. Every stack was removed; no stack, runtime,
task, function or log group of the runs was left.

| Check | Result |
|---|---|
| `agentcore` job group after a sweep | 1000 SysV semaphore arrays (2 GiB) are swept and the group drains below 32 MiB inside the 1 s poll: no `dirty`; the 2 GiB case ran once, and five SysV jobs from 20 MiB to a fill-to-kill kept the session. 420 000 empty files in `/work` kept the group above 32 MiB (slab memory charged to it; seen before the poll existed and before reclaimable slab was left out of the read, not run again since), so the runner marked itself `dirty` and the next start gets a fresh session, which is the §3.5 rule |
| `agentcore` stop line | for sessions the platform already ended at its idle timeout, the drain's stop lines carry `sandboxSeconds` of 560 to 900 s: the session's end is not known, so the line counts to the drain (§3.8). No AgentCore usage-log record arrived in 90 minutes of calls and stops, only the delivery's validation stream |
| Stack delete with live sandboxes | `nitro` 27 min (the drain 80 s; the VPC-attached `RunCodeDrain` function 21 min, its network interfaces release late); `microvm` 23 min (cause not isolated); `agentcore`, two stacks, 31.7 min (the VPC-attached Reaper and Drain functions 19.5 min each). A delete of stacks that never ran a sandbox took 15 s |

## 8. Integration test outline

Driver: `test/integ/driver.ts`, called by name from `scripts/integ.sh`
(ADR-0008, ADR-0058). It deploys with the CDK CLI and deletes the stack
through the CloudFormation API. It reuses the
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
construct instances, each with its own VPC: `run-code` with all three
backends, `sandboxIdle` = 2 min, `runTimeout` = 20 s, `dnsFirewall` on, `standalone` on,
`maxInputBytes` and `maxOutputBytes` at their caps (6 MiB and 4 MiB, so
`limits` sends both through every platform), and a
`RunCodeToolTarget` named `run-code`; and `run-code-files` with
`agentcore` only, `sessionFiles` on, `dnsFirewall` off, and a
`RunCodeToolTarget` named `run-code-files`. Every step runs through the
gateway entry except `standalone`; `session-files` uses `run-code-files`. The stack with both is deleted at the end; the shared pool is never
touched.

| Step | Checks |
|---|---|
| seed | tenants `A` and `B`, each with `inputs/<t>/invoice.csv` (synthetic) and grants for the `run-code` and `run-code-files` tools; on `run-code` an input for A of exactly `maxInputBytes` and one a byte over |
| parse | A runs a script that parses its invoice; output matches; `sandbox` = `started` (or `sandbox_starting`, then retried) |
| reuse | A writes `/work/marker`; A's next call reads it; `sandbox` = `reused` |
| apart | B's call on the same backend cannot see A's marker; B's `sandbox` = `started` |
| race | two concurrent first calls for a new tenant `C` start one sandbox |
| prefix | the tool refuses `input` = `../B/invoice.csv` and any name outside A's prefix |
| iam-wall | `iam:SimulatePrincipalPolicy` on the tool tenant role with `aws:PrincipalTag/TenantId` = `A` denies `inputs/B/*`, the `TENANT#B` row, and `StopTask` on B's task |
| limits | an input one byte over `maxInputBytes` returns `input_too_large`; an input of exactly `maxInputBytes` is read back whole (size and SHA-256 match); a print of `maxOutputBytes` `0x01` bytes (six bytes each in JSON) returns `truncated` = true with a result under the 6 MB Lambda response limit; `multiprocessing.Lock()` raises `PermissionError` on `microvm` and works on `nitro` and `agentcore`, where a file the job leaves in `/dev/shm` is gone at its next call; on `microvm` `os.memfd_create`, `semget`, `setsockopt(SO_SNDBUF)`, `socket(AF_UNIX)` and `listen(128)` raise `PermissionError`, `socketpair` and `listen(5)` work, and the job's `/proc/self/status` shows `Seccomp: 2`; on `nitro` `semget` raises `PermissionError` |
| no-credentials | A's script tries IMDS, the ECS and AgentCore metadata endpoints, and `boto3` default credentials, then `GetObject` on B's invoice. `microvm` and `nitro`: no credentials are returned (the MicroVM metadata service answers but its `iam/security-credentials/` path gives 404; the ECS credentials path gives 404; IMDS on `nitro` gives no TCP connection within the script's own 2 s), and the `GetObject` makes no connection. `agentcore`: credentials load, and every call outside C-2 is denied; the `GetObject` on B's invoice reaches S3 and is refused with 403. The `GetItem` on B's row makes no connection on any backend |
| no-egress | A's script first sends a positive control with the same request code and deadline to the sandbox's own allowed address (the metadata service on `microvm` and `agentcore`, the ECS credentials path on `nitro`), which must answer with a status; it proves the request code and its deadline, not a name lookup or a route. It then tries HTTPS to `example.com`, a TCP connect to a public IP address on port 443 with no name lookup (so the route and security group are tested even when the firewall answers the name first), TCP to B's sandbox address, and a presigned PUT to a test bucket outside the endpoint policy. Every request fails before its TCP connect completes (a name that does not exist, or a connect that fails or takes over 2 s on each of up to four addresses of the name, IPv4 first; the driver checks 14 s, a 5 s lookup included), except the presigned PUT on `agentcore`, which reaches the S3 gateway endpoint and must be refused with 403. A request whose connect completes counts as open, however slow or broken its answer, and so does a lookup with no answer in 5 s or a resolver failure, so a slow but open path cannot pass. For the IP-literal probe the TCP connect itself must not complete |
| runaway | a loop, a `setsid` child that sleeps past the job, a kill of PID 1 and of the runner, a disk fill, and the job plus N − 1 children that each allocate up to their `RLIMIT_AS` (on `nitro` and `agentcore` a total far above the sandbox memory), whose N-th fork fails with `EAGAIN`: each returns `timedOut`, `memoryExceeded` (the memory fill on `nitro` and `agentcore`) or a non-zero exit (on `microvm` with `MemoryError` in `stderr`); on `nitro` and `agentcore` the memory fill must return `memoryExceeded` (on `nitro` a tool overrun fails the step, §3.5); on every backend the next call after the fill, on the same sandbox, still reads the `/work/child.pid` that the earlier `setsid` job wrote; one process filled past its own `RLIMIT_AS` returns `memoryExceeded` false and `MemoryError` in `stderr` on every backend; on `nitro` a job that writes 900 MiB of files to `/work` is not killed; on `microvm` a job of four threads that each allocate 32 MiB completes; on `nitro` and `agentcore` a `memfd` fill aimed at 1.5 × L (100 MiB per `memfd`; about 1.2 GiB on `nitro`, 11 GiB on `agentcore`) returns `memoryExceeded` true with the same `bootId`, and the next call works; on `agentcore` a SysV semaphore array a job creates is gone at the next call; after a job that forked N − 1 children was killed, the next job can fork N − 1 children again (no zombies left); the runner is still the one that answers (same `bootId`), nothing of the job survives into A's next call, and A's next call works |
| dead-handle | stop A's sandbox out of band (on `microvm` wait until 4 s past the MicroVM's `terminatedAt`, beyond the 2 s clock margin of ADR-0044); A's next call returns `sandbox` = `started` |
| recycled-address | `nitro`: point A's row at B's live task address (test-only shortcut standing in for an IP that ECS reassigned), then call A: the identity check fails, nothing is sent to B's task, and A gets a fresh task |
| idle | after `sandboxIdle` (2 min) idle the driver invokes the reaper; A's `nitro` task is stopped, and the stop line carries `sandboxSeconds` |
| cold-from-zero | `nitro`: with no instance running, a new tenant `D`'s first call returns `sandbox_starting`; retries reuse the same task until it is `READY`, and no second task starts |
| max-life | `nitro`: the driver invokes the reaper with `maxLifeSeconds` of 60 while A's task runs a long job; the task is stopped and A's next call gets a fresh one. Test-only shortcut: the reaper honours `maxLifeSeconds` only when its environment has `RC_INTEG_OVERRIDES=1`, which the integration stack sets through a CDK escape hatch and no prop exposes |
| failed-start | `nitro` and `microvm`: for tenant `E` the tool passes the runner an exit-at-boot flag (test-only shortcut, honoured only with `RC_INTEG_OVERRIDES=1`); the driver retries `E`'s call until the first `sandbox_failed`, bounded by the backend's start cap; a reaper run then leaves the `FAILED` row alone and writes no stop line; a call before `retryAt` returns `sandbox_failed` and starts nothing (checked with `ListTasks` or `ListMicrovms`); a call after `retryAt` starts again; the tool line carries the reason, and exactly one stop line exists for the failed sandbox |
| microvm-stop | A's MicroVM, idle past `sandboxIdle` (2 min in the integration stack), shows `SUSPENDED`; the driver then ends it with `TerminateMicrovm` out of band and invokes the reaper; a stop line for A's MicroVM carries `sandboxSeconds`, `runningSeconds`, `suspendedSeconds` and `estimated` |
| synth | a unit test synthesises two construct instances in one stack and asserts that every §5.3 name is unique and matches its charset, and that the drain role's policy allows `ecs:DeregisterContainerInstance` on the cluster ARN and the reaper role's does not, and the offboard function runs as the reaper role |
| session-files | `run-code-files`: A's session writes and reads its own `sessions/<sid>/`; a `GetObject` on B's session prefix is denied |
| dns | `run-code` (firewall on): A's script looks up `example.com`, a unique `<token>.example.com`, a 40-character exfil label and a TXT name, then `logs.<region>.amazonaws.com`; the first four return NXDOMAIN and appear in the query log as `BLOCK`, the last resolves to an endpoint address. `run-code-files` (firewall off): `example.com` resolves to a public address. On `nitro` the `BLOCK` line's `srcaddr` is A's task address |
| dns-platform | after the run, every `BLOCK` line in `run-code`'s query log is for a name some test script looked up, or `*.amazon.pool.ntp.org` (left blocked on purpose, §3.9), or a PTR query by a sandbox for the reverse name of its own address (also left blocked, §3.9); any other blocked name, and any other PTR, is a platform name missing from the allow list and fails the step |
| telemetry | Logs Insights finds one tool line per call with the §3.8 fields and the right `tenantId` |
| standalone | the driver invokes `run-code`'s `runCodeFunction` with IAM, as a vendor's own API would, with `tenantId` = `A`: A's script parses its invoice; `input` = `../B/invoice.csv`, `tenantId` = `A/x` and an empty `tenantId` each return `invalid_argument`; a role with no invoke grant is refused (shows IAM applies, not that only granted roles can reach it, T-82). Through the gateway, a `tenantId` argument returns `invalid_argument` |
| standalone-build | before deploy, the driver runs `npm pack` on the sample and installs the tarball into a stub consumer app that has no `agentic-runtime-isolation` anywhere in its tree (a packed install carries no dev dependencies and no symlink back to the sample), with the consumer's default `cdk.json` app command (`ts-node --prefer-ts-exts`): `npm install` succeeds with no peer error, `tsc` compiles, and `cdk synth` of `UntrustedCodeSandboxes` with `standalone: true` succeeds, including the `runCodeFunction` bundle, and no module reached from the package root resolves to the producer |
| forged | a direct invoke of the gateway tool function with a tenant context signed by the wrong key returns `context_invalid`, starts nothing and leaves no registry row (test-only shortcut: only the gateway role may invoke the function in a real deployment) |
| offboard | the driver stops minting tokens for `C`, which stands in for removing its grant, and starts `C`'s sandbox on every backend; `offboardTenant` for `C` stops them and deletes each row, or leaves it `STOPPING` while the sandbox is still listed; a second call returns the same shape with nothing newly stopped |
| teardown | the driver deletes the stack through the CloudFormation API with sandboxes still running for A and B; afterwards no MicroVM, task, instance or log group of the sample is left (the task and usage-log groups, `/aws/lambda-microvms/<imageName>`, the query-log group, and every `/aws/bedrock-agentcore/runtimes/<runtimeName>-*` group), no DNS Firewall resource or construct-owned Logs resource policy of the sample, and the `DescribeResourcePolicies` statements that name the query-log group's ARN match their state before deploy (any difference is reported as the §3.9 known leftover), and the runtime is gone (AgentCore lists no sessions, so "runtime gone" is the `agentcore` check) |

Preconditions, checked by the driver before it deploys: the account's
"maximum allocated ARM_64 MicroVM memory" quota (Service Quotas, looked up
by quota code, not by name) is at least
5 × `microvm.memoryMiB` (tenants A, B, C and E, plus a restart), and the
account has three free CloudWatch Logs resource policy slots (10 per
Region, not adjustable): one for the `dnsFirewall` instance and one for the
usage log of each `agentcore` backend, a number the driver computes from
the app; the driver fails early naming the cause if not. Every behaviour step runs
once per backend unless it names one. `cold-from-zero` records the
`nitro` start time and fails if it comes within half of the start cap. The run
records cold and warm latency per backend and the deploy and destroy time.
