<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# Integration test

This file describes the sample's deployment integration test, as the
[sample standard §5.3](../../docs/sample-standard.md#53-integration-test-document-integration-testmd)
lays it out. The [README](./README.md) carries the command and a link here.

## What it is

The test is one app, [`test/integ.sandboxes.ts`](./test/integ.sandboxes.ts),
and one driver, [`test/integ/driver.ts`](./test/integ/driver.ts), that
[`scripts/integ.sh`](./scripts/integ.sh) calls by name (ADR-0008, ADR-0058).
It is the reference implementation of this sample's wiring ([standard
§5.2](../../docs/sample-standard.md#52-integration-test)): it deploys the
construct twice in one stack, once with all three backends and the standalone
entry, once with `agentcore` and session files, puts the first behind
`agentic-runtime-isolation`'s tools gateway with a `RunCodeToolTarget` as a
vendor would, calls it as a tenant would, and deletes the stack with sandboxes
still running. It is the reference for the composition of this sample with the
producer's ingress and with tenant-identity's issuer. The steps are named and
ordered as the [step table](#steps) below, in the order the code runs them.

## How to run it

Use a non-production, CDK-bootstrapped account, in exactly one Region (the
driver fails fast when `AWS_REGION` is unset), with Docker running (the runner
image is built at synth, ADR-0024).

```bash
AWS_PROFILE=<profile> AWS_REGION=eu-central-1 npx projen integ
```

tenant-identity's `shared-pool` is a shared fixture the run reads and never
destroys. If it is missing, the driver stops before the deploy and says so. Deploy it
once, from `samples/tenant-identity`:

```bash
export AWS_PROFILE=<profile> AWS_REGION=eu-central-1
npx cdk deploy TenantIdentity-shared-pool --context topology=shared-pool --require-approval never
```

The `parse` step's consumer path (on `microvm`) creates a throwaway tenant with the scope
`app/use`. A fresh pool has no such scope in its catalogue, so the step
registers it when it is missing and leaves it in place, because the pool
is shared and another sample's run may use the same scope.

Before it deploys, the driver checks, and fails early naming the cause:

- the account's "Max allocated ARM_64 MicroVM memory" quota (Service Quotas
  code `L-CD1C0CC4`, in GB) is at least 5 × `microvm.memoryMiB` (tenants A, B,
  C and E, plus a restart);
- three CloudWatch Logs resource policy slots are free (10 per Region, not
  adjustable): the stack creates one for the `run-code` DNS Firewall query
  log and one for the usage log of each `agentcore` backend (two). The driver
  computes the number from the app, so a deploy never runs out of slots after
  the VPC and the AgentCore runtimes are up;
- tenant-identity's user pool is published, and Docker answers;
- the producer's dependencies and generated Smithy sources exist (the driver
  runs `npm ci` and `smithy build` in `samples/agentic-runtime-isolation`
  once, for the sample agent bundle and the synth; the Smithy CLI must be on
  the path).

| Variable | Default | Effect |
|---|---|---|
| `AWS_REGION` | none, required | the one Region of the run |
| `INTEG_PREFIX` | `UntrustedCodeSandboxesInteg` | stack name; a letter, then letters and digits, 1 to 40 in all |
| `INTEG_DEPLOY_CONCURRENCY` | `2` | `cdk deploy --all --concurrency`; 2 keeps API Gateway's control-plane throttle away |
| `INTEG_STATE_DIR` | `untrusted-code-sandboxes-integ` under the system temp directory | where the driver keeps its state file, logs and run records (outside the repository) |

The driver prints the table of [Steps](#steps) with a result per unit and the
deploy and destroy times, and exits 1 when any step failed. It prints no
token, nonce, credential, code, input or output.

## What it stands up

One stack named `INTEG_PREFIX`, deployed with `cdk deploy`:

| Part | What |
|---|---|
| Ingress | `agentic-runtime-isolation`'s `SharedIngress` (api-gateway, one tools gateway `default`) and one sample agent, so `parse` can make one call as a consumer's agent would. It publishes no parameters and reuses tenant-identity's issuer |
| Test mint | a Lambda function granted `tokenSigner.grantSign` on the ingress key, which signs a token for any tenant id (S-12) |
| `run-code` | `UntrustedCodeSandboxes` with `microvm`, `nitro` and `agentcore`, `sandboxIdle` 2 min, `runTimeout` 20 s, `dnsFirewall` on, `standalone` on, `maxInputBytes` and `maxOutputBytes` at their caps (6 MiB and 4 MiB), behind a `RunCodeToolTarget` named `run-code` |
| `run-code-files` | `UntrustedCodeSandboxes` with `agentcore` only, `sessionFiles` on, `dnsFirewall` off, behind a `RunCodeToolTarget` named `run-code-files` |
| Standalone step | two roles, one granted with `grantInvokeRunCode`, one with no invoke grant |
| No-egress step | a bucket the endpoint policies do not name, for a presigned PUT |

It deletes everything it deployed, through the CloudFormation API, from the
driver's `finally` and signal handlers, and checks what is left (step
`teardown`, ADR-0062). The shared tenant-identity pool stays.

## Steps

Tenants: `A` and `B` own a synthetic invoice each (`inputs/<t>/invoice.csv`);
`C` races and is offboarded; `D` starts `nitro` from zero; `E` fails to start;
`F` presents a forged context. The table is in the order the code runs the
steps. Spec §8 lists the same steps in another order, because several wait
on a 2-minute idle time or on a state another step leaves (ADR-0061); the
unit test `test/integ/driver.test.ts` checks that both lists hold the same
names and that no step runs before one it needs.

"Units" is the step by instance by backend matrix: a per-backend step runs
once on each backend it names, on `run-code` (`rc`), and `dns` and `teardown`
also on `run-code-files` (`rcf`, `agentcore`, firewall off). 28 steps give 59 units.

| Step | Units | What it checks |
|---|---|---|
| standalone-build | 1 | before the deploy: `npm pack` of the sample, installed into a stub consumer with no `agentic-runtime-isolation` anywhere in its tree and the consumer's default `cdk.json` command: `npm install` has no peer error, `tsc` compiles, `cdk synth` with `standalone: true` succeeds, the `runCodeFunction` bundle included, and no module reached from the package root resolves to the producer |
| synth | 1 | before the deploy: the unit test that synthesises two construct instances in one stack: every §5.3 name is unique and matches its charset, the drain role may deregister container instances on the cluster and the reaper role may not, the offboard function runs as the reaper role |
| seed | 1 | the invoices of A and B on both instances, and on `run-code` an input of exactly `maxInputBytes` and one a byte over it; the mint answers a token for A and B |
| parse | rc × 3 | A parses its invoice; the output matches; `sandbox` is `started` (or `sandbox_starting`, then retried); cold latency recorded; on `microvm` once more through the producer's sample agent and a throwaway tenant (the consumer path, ADR-0060) |
| reuse | rc × 3 | A writes `/work/marker`; its next call reads it; `sandbox` is `reused`; warm latency recorded |
| apart | rc × 3 | B on the same backend cannot see A's marker and starts its own sandbox; B writes a marker of its own |
| race | rc × 3 | two concurrent first calls for `C` start one sandbox (one row; one new MicroVM or task) |
| prefix | rc × 3 | `../B/invoice.csv`, `a/../../B/invoice.csv`, `/etc/passwd`, a name with a space and a 257-character name return `invalid_argument`; `B/invoice.csv` and a missing name return `input_not_found` |
| iam-wall | rc | `SimulatePrincipalPolicy` on the tool tenant role with `TenantId` = `A`: allowed on A's input object and row (controls); denied on `inputs/B/*`, the `TENANT#B` row, and `StopTask` on B's task |
| limits | rc × 3 | an input one byte over `maxInputBytes` returns `input_too_large`; an input of exactly `maxInputBytes` (6 MiB) is read back whole (size and SHA-256); a print of `maxOutputBytes` (4 MiB) of `0x01` bytes, six bytes each in JSON, returns `truncated` with a result under 6 MB (the run record shows how much stdout came back, so it shows whether the runner's cap or the tool's 5 MiB JSON bound cut it); `multiprocessing.Lock()` raises `PermissionError` on `microvm` and works on `nitro` and `agentcore`, where a file left in `/dev/shm` is gone at the next call; on `microvm` `memfd_create`, `semget`, `setsockopt(SO_SNDBUF)`, `socket(AF_UNIX)` and `listen(128)` raise `PermissionError`, `socketpair` and `listen(5)` work, and `Seccomp` is 2; on `nitro` `semget` is refused |
| no-credentials | rc × 3 | A's script looks for credentials in the metadata service, the container credential paths, the environment, a credentials file and the SDK, then reads B's invoice and B's row. `microvm` and `nitro`: none found (the MicroVM metadata path answers 404; the ECS path answers 404; IMDS on `nitro` gives no connection within the script's 2 s); `agentcore`: credentials load and every call outside C-2 is denied. B's invoice: on `agentcore`, which reaches S3, `GetObject` is refused with 403; on `microvm` and `nitro` no connection is made. B's row: no connection on every backend |
| no-egress | rc × 3 | a positive control first: the same request code, under the same deadline, gets a status from the sandbox's own allowed address (the metadata service on `microvm` and `agentcore`, the ECS credentials path on `nitro`); it proves the request code and its deadline, not a name lookup or a route. Then HTTPS to a public name, a TCP connect to a public address with no name lookup, TCP to B's sandbox address (`nitro`: its task IP; `microvm`: HTTPS to its endpoint; `agentcore` has no address to aim at, and C-3 there rests on the runtime security group, which the IP-literal connect tests), and a presigned PUT to the outside bucket (signed by a role that may put under `integ/` there and nothing else, and valid from the driver, which proves the URL) all fail before a TCP connection is made, within 14 s (a name that does not exist, or a connect that fails or takes over 2 s on each of up to four addresses of the name, IPv4 first, after a lookup of up to 5 s). The exception is the presigned PUT on `agentcore`, which reaches the S3 gateway endpoint and must be refused with 403. A request whose connect completes counts as open, however slow its answer, and so does a name lookup with no answer in 5 s or a resolver failure, so a slow but open path cannot pass. The hostile "one bad script" job then reads B's invoice and registry row and posts what it has to the internet and to the presigned URL: each is denied by the same rules (403 for S3 on `agentcore`, no connection everywhere else), and the time cap kills the job |
| dns | rc × 3, rcf | `run-code` (firewall on): `example.com`, a unique `<token>.example.com`, a 40-character exfil label and a TXT name return NXDOMAIN and each appear in the query log as `BLOCK` (on `nitro` with A's task address as `srcaddr`); `logs.<region>.amazonaws.com` resolves to an endpoint address. `run-code-files` (firewall off): `example.com` resolves to a public address |
| runaway | rc × 3 | a loop, a `setsid` child, a kill of PID 1 and of the runner, a file past the file-size limit (`EFBIG`) and a disk fill that ends by a full disk or the time cap (the next call removes the files it left), the job plus N − 1 children allocating to their limits (the N-th fork fails with `EAGAIN`), one process past its own limit (`MemoryError`, `memoryExceeded` false); `nitro`: the children's fill returns `memoryExceeded`, or is a tool overrun (exit -9, `timedOut`) after which the next call starts a fresh task with a new `bootId` and the step reads the stopped task's runner lines; `nitro`: 900 MiB of files not killed; `microvm`: four threads of 32 MiB complete; `nitro` and `agentcore`: a `memfd` fill at 1.5 × L returns `memoryExceeded`; `agentcore`: a SysV semaphore array is gone at the next call; no zombies (the count a job can fork is the same after a killed job); the runner is still the one that answers (the row's `bootId` is unchanged, or after an overrun the fresh task's) and A's next call is `reused` |
| session-files | rcf, agentcore | A's session writes and reads `sessions/<sid>/`; a `GetObject` on B's session prefix is denied |
| standalone | rc × 3 | the driver invokes `runCodeFunction` with IAM: A's script parses its invoice on each backend; `../B/invoice.csv`, `A/x` and an empty `tenantId` return `invalid_argument`; through the gateway a `tenantId` argument returns `invalid_argument`; a role with no invoke grant is refused (IAM applies; T-82 says it does not show that only granted roles can reach it); the role granted with `grantInvokeRunCode` is served |
| forged | rc | a direct invoke of the gateway tool function with a context signed by the wrong key returns `context_invalid` and starts nothing |
| dead-handle | rc × 3 | A's sandbox is stopped out of band (on `microvm` the driver waits until 4 s past the MicroVM's `terminatedAt`, beyond the tool's 2 s clock margin, ADR-0044); A's next call is `started` on a new handle with none of the old files |
| recycled-address | rc, nitro | A's row is pointed at B's live task address (test-only): the identity check fails, nothing reaches B's task (its marker is intact and `reused`), and A gets a fresh task |
| microvm-stop | rc, microvm | A's MicroVM, idle past `sandboxIdle`, shows `SUSPENDED`; the driver ends it out of band and runs the reaper; the stop line carries `sandboxSeconds`, `runningSeconds`, `suspendedSeconds` and `estimated`; the row is gone |
| idle | rc, nitro | after `sandboxIdle` the reaper stops A's `nitro` task; exactly one stop line carries `sandboxSeconds` |
| cold-from-zero | rc, nitro | with no instance running (the driver stops the idle tasks and waits for scale-in, up to 15 min), D's first call returns `sandbox_starting`; retries reuse one task and start no second; the start time is recorded and must be within half of the 300 s start cap |
| max-life | rc, nitro | the reaper runs with `maxLifeSeconds` 60 while A's task, older than 60 s, runs a long job; the task is stopped and A's next call gets a fresh one |
| failed-start | rc, nitro, microvm | E's sandbox exits at boot; the driver retries until the first `sandbox_failed`, bounded by the start cap; a reaper run leaves the `FAILED` row alone and writes no stop line; a call before `retryAt` returns `sandbox_failed` and starts nothing; a call after it starts again; the tool line carries the reason; exactly one stop line exists for the failed sandbox |
| offboard | rc | C's sandbox is started again on all three backends (its earlier ones may have idled out); the driver stops minting tokens for C, which stands in for removing its grant; `offboardTenant` stops the three sandboxes and deletes each row, or leaves it `STOPPING` while the sandbox is still alive (`agentcore` always; a `nitro` task for up to 78 s); a second call returns the same shape and stops nothing the first did not |
| telemetry | rc × 3 | Logs Insights finds exactly one tool line for every call of the run on the backend, and the parse call's line has the §3.8 fields and the right `tenantId` and `backend` |
| dns-platform | rc | every `BLOCK` line in `run-code`'s query log is for a name a test script looked up, or `*.amazon.pool.ntp.org`, or a PTR query by a sandbox for the reverse name of its own address; any other blocked name, and any other PTR, is a platform name missing from the allow list |
| teardown | rc × 3, rcf | with sandboxes started for A and B on every backend, the stack is deleted; afterwards no MicroVM, task, container instance, runtime, VPC or endpoint, log group (the task and usage-log groups, `/aws/lambda-microvms/<imageName>`, the query-log group, every `/aws/bedrock-agentcore/runtimes/<runtimeName>-*` group), DNS Firewall resource or construct-owned Logs resource policy of the sample is left; the `DescribeResourcePolicies` statements that name the query-log group match their state before the deploy (a difference is the §3.9 known leftover, reported and not failed); the step also fails when the leftover check could not run (the credentials or the access failed, or the AWS CLI could not be started) |

The run record lists every unit with its result, its seconds and its evidence,
then the deploy and destroy times and the p50 cold and warm latency per
backend. A failed check marks its unit and the run goes on; a unit that throws
is recorded as a failure with the error's class and message.

## Runtime and cost

One run takes about 20 minutes to deploy (1123 to 1328 s), about 35
minutes of steps, and about 40 minutes to delete (2398 s in run 21; a
delete that stops on leftover network interfaces runs to about 3700 s).
The waits in the steps are `sandboxIdle` (2 min, three times, partly
overlapped) and the `nitro` scale-in before `cold-from-zero` (at most 15
minutes, the driver's wait). How much of the delete the release of the
tool subnets' network interfaces takes is not measured. The driver
waits up to 60 minutes for one delete and retries a failed one once. Cost
is dominated by the NAT gateway, the endpoints, `nitro` instance time and
the DNS Firewall queries; the run record carries the timings.

Last run: run 21, 2026-11-23, eu-west-1: 61 of 61 steps passed on all
three backends, the teardown included (deploy 1218 s, destroy 2398 s,
nothing left). See the [`architecture.md` status block](architecture.md)
for the coverage and the runs in the other Regions.

If a stack of an earlier run still exists (an interrupted run), delete it
first (see below) or use a new `INTEG_PREFIX`. A leftover `nitro` task makes
`parse` find the sandbox `reused` instead of `started`, and the step fails.

## After an interruption

The driver deletes the stack from its `finally` and signal handlers, and
`scripts/integ.sh` runs the driver's `cleanup` from its exit trap, which
destroys a stack the last run left and does nothing when the last run
finished its teardown. To destroy a stack by hand, run the driver by name:

```bash
export AWS_PROFILE=<profile> AWS_REGION=eu-central-1
npx ts-node -P test/tsconfig.json --prefer-ts-exts test/integ/driver.ts destroy
```

from `samples/agentic-untrusted-code-sandboxes`. It deletes the stack through the CloudFormation API
and prints what is left. To see what a run left without deleting anything:

```bash
scripts/leftovers.sh
```

It lists stacks with the prefix (including `DELETE_FAILED` ones, which
CloudFormation refuses to update: a rerun beside them needs another
`INTEG_PREFIX`), then, from the state file of the last run, log groups, task
definitions, clusters and container instances, MicroVMs, runtimes, VPCs and
endpoints and DNS Firewall resources.

A line that starts with `LEFT` is something the run left, or a resource the
check could not read because AWS answered with an error (`LEFT check-failed`,
with the AWS error code or a reason). Any `LEFT` line sets the exit status
to 1.

When the credentials fail or the AWS CLI cannot start (no credentials, an
expired or refused token, access denied, no `aws` binary), the check cannot
tell whether everything is gone. It lists `CHECK NOT RUN` with a short reason,
adds a closing line that says the check must be repeated once the credentials
and the AWS CLI work, never prints `nothing left`, and exits 1. Fix them and
run the check again. In the `teardown` step the same case fails the check
`the leftover check could run`.

Remove by hand what the `LEFT` lines list: the construct's own log groups with
`aws logs delete-log-group`, a leftover runtime log group under
`/aws/bedrock-agentcore/runtimes/` the same way, and an ACTIVE task definition
revision with `aws ecs deregister-task-definition` (a revision cannot be
deleted). The tenant-identity `shared-pool` stays.

Known limitation: the lookups of container instances, task definitions and
MicroVMs read any other error (a throttle, a network error) as "nothing
there", so those three can miss a leftover without a line. An AWS error on the
stack list, a service log group listing or the resource policy listing stops
the check with that error and no list; run it again.

## Test-only shortcuts

Each is something a consumer could not or would not do, with what a consumer
does instead:

| Shortcut | What a consumer does instead |
|---|---|
| The test mint signs a token for any tenant id with the ingress's key (S-12, ADR-0060) | gets a token from the ingress by presenting an identity token; `parse` does that once through the sample agent |
| `RC_INTEG_OVERRIDES=1`, set through a raw property override on the `run-code` reaper, gateway tool function and standalone function: the reaper honours `maxLifeSeconds`, the tool starts tenant `E`'s sandbox with an exit-at-boot flag (`RC_INTEG_FAIL_START_TENANT`) (ADR-0059, T-88) | has no such switch; a unit test proves a normal deployment cannot get one |
| The reaper's 5-minute schedule rule (the one schedule rule under each instance) is turned off in the template, so the driver is its only caller | keeps the schedule |
| `recycled-address` writes A's row with another task's address | an address ECS reassigned |
| `forged` invokes the gateway tool function directly with the driver's own credentials | only the gateway role may invoke it |
| The driver reads registry rows, tasks and logs with its own admin credentials, and stops sandboxes out of band | has the tool roles only |
| `runTimeout` is 20 s and `sandboxIdle` 2 min, so the steps that end on a time cap stay short | keeps the defaults or sets values for the workload |
| `ReaperFunction` is found by its construct path in the integration app, and it and `ToolFunction` are published as stack outputs the construct does not publish | reads the published properties and parameters (spec §6.3) |
| C's grant is not removed before `offboard`: the mint has no grant store, so the driver stops minting tokens for C | removes the grant from its entitlement store |
| The mint loads the SDK's KMS client with `require`, because the Lambda runtime provides it and the sample declares no dependency on it | has no mint |
