<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0050: Run the agent on Runtime platform version V2, set explicitly, with the nonce drawn on the first request

- Status: Proposed
- Date: 2026-11-13
- Amends: ADR-0011 (the `agentcore-runtime` backend)
- Deciders: Dave Roberts (PSA)

## Context
AgentCore Runtime has two platform versions. New runtimes default to V2 when `PlatformVersion` is omitted. `AgentCoreRuntimeBackend` (`src/backend/agentcore-runtime.cdk.ts`) sets no `PlatformVersion`, so the platform a deployment gets depends on the day it was created.

V2 keeps the guarantee this sample rests on: each session runs in its own Firecracker microVM (P-2, T-24). The resource policy (ADR-0001), the header allowlist (ADR-0012, ADR-0031), the execution role (ADR-0008, ADR-0018) and the log group policy (ADR-0047) do not depend on the platform version. Three things do change.

1. **Start-up state.** V2 builds one snapshot per Runtime version and restores every session's microVM from it. Anything the agent computes at import or in a warmup hook is the same in every microVM. Every instance reports hostname `localhost` and PID 1. Node `crypto` (`randomUUID`, `randomBytes`, `getRandomValues`) can return the same values in two restored microVMs, even when called inside a request handler. `src/agent/app.ts` sets `NONCE = randomUUID()` at module scope. The nonce is the probe that proves which microVM answered: integration steps `session` and `tenant` (`scripts/integ.sh`) and demo steps 3 and 4 (`scripts/demo.sh`) compare it across users and tenants. On V2 every microVM reports the same nonce, so "B1 reached A1's microVM" fails when isolation holds, and "A1 resumed c1 on the same microVM" passes when it does not. The probe stops measuring anything.
2. **Deploy time.** A V2 create or update builds the snapshot, which takes minutes instead of seconds. The container must report healthy within 120 s. Old snapshots stay for up to 8 hours after an update or delete.
3. **Limits and pricing.** A V2 session starts in under 2 s whatever the image size. It holds up to 250 concurrent connections (V1: 8 per vCPU), and an idle session scales its memory down. An optional resource configuration sets a committed baseline from 0.25 vCPU and 1 GB to 2 vCPU and 8 GB, with bursts up to 4x. V2 also adds session context keys, which scope an execution role's access to one session or one Runtime, and an `OverheadLatency` metric.

The ingress code that draws random values (`src/shared/mint.ts` for `jti` and `txn`, `src/shared/session.ts` for unit ids) runs in Lambda, not in the Runtime, so the snapshot does not touch it.

## Options considered
### Option 1: Pin `PlatformVersion: V1`
Pros: no code change; deploys stay fast; the nonce probe keeps working. Cons: the sample teaches a platform version that new runtimes no longer get by default; it misses the faster starts, the connection limit and the scale-to-zero billing that the scaling guidance relies on; V1 is likely to be retired.

### Option 2: Leave `PlatformVersion` unset and fix the nonce
Pros: one code change; the sample follows the service default. Cons: the platform a deployment runs on still depends on its creation date, so two runs of the same commit can measure different platforms; a deployer cannot choose V1 without editing the construct.

### Option 3: Set `PlatformVersion` explicitly through a backend prop, default `V2`, and draw the nonce on the first request
Pros: the version is in the template, so a run is reproducible; a deployer can choose `V1` (for example in a Region without V2); the nonce probe measures the microVM again. Cons: one more prop; the integration test's deploy and update take minutes longer; a deployer on V1 does not get V2's limits.

### Option 4: Option 3 plus session context keys on the execution role
Pros: a second, service-side wall that scopes the execution role to its own session. Cons: the execution role holds logs and traces only (ADR-0018), so there is no tenant data for the keys to fence; tenant data is reached with the vended credentials, which the keys do not cover. It adds policy with nothing to protect today.

## Decision
Option 3. `AgentCoreRuntimeBackendProps` gains `platformVersion?: 'V1' | 'V2'`, default `'V2'`, written to `CfnRuntime` as `platformVersion` (or as a `PlatformVersion` property override if the pinned `aws-cdk-lib` does not type it yet). The agent draws its nonce on the first request it serves, not at import: 16 bytes read from `/dev/urandom`, hex-encoded and kept for the life of the process. It does not use `node:crypto`, because a restored snapshot can repeat its values. Every other module-scope value in `src/agent/app.ts` is a constant, an SDK client or an empty cache (the MCP session store, the keep-alive agent). Those may be shared by the snapshot because no request runs before it is taken. A unit test checks that importing the module reads no random bytes. The agent configures no warmup hook, so nothing request-specific can enter the snapshot.

## Consequences
Easier: the nonce again tells two microVMs apart on V2, so the session and tenant checks prove isolation; a run's platform version is in its template; sessions start in under 2 s, and the 250-connection limit leaves room for one MCP client per tools gateway and a streaming response. Harder: the integration test's deploy and Runtime updates take minutes longer (measure them on the first V2 run and record them in `integration-test.md`); a teardown leaves snapshots behind for up to 8 hours, which are not billed as sessions but stay visible. Follow-up: rerun the integration test and the demo on V2; refresh the Runtime rows of the scaling guidance (start rate, connections, memory reclaim, baseline pricing) and the README cost table from measurement; record a deployer note that any agent code computing a secret, a nonce or an id at import shares it across every session's microVM on V2. Revisit if the agent's execution role gains access to tenant data (then Option 4 applies), when the service publishes V1 retirement, or when session-labelled storage credentials ship and overlap the vended tenant credentials (ADR-0012).
