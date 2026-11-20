<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0050: Scope the tool's AgentCore rights to the runtime and derive the session id in code

- Status: Proposed
- Date: 2026-11-20
- Deciders: Dave Roberts (Partner Solutions Architect)

## Context

The `agentcore` backend serves every tenant from one runtime, one session
per tenant (ADR-0009). The tool calls `InvokeAgentRuntime` and
`StopRuntimeSession`; the reaper, the drain and the offboard function call
`StopRuntimeSession`. On `nitro` the tool tenant role makes the start and
stop enforced, because ECS honours a `TenantId` tag condition. Spike S-8
(spec §7.1) found that both AgentCore actions support only
`aws:ResourceTag`, that a session-id condition never matched, and that no
API lists a runtime's sessions. IAM therefore cannot tie a caller to one
tenant's session on this backend.

## Options considered

### Option 1: Grant the actions on the runtime and derive the session id in code
Pros: matches what IAM can express; the id is a pure function of the tenant
id (ADR-0009), so the run-time class can refuse any handle that names
another session before it sends anything. Cons: the guard is code, not
policy: a caller that holds the tool role and bypasses the backend class can
name any session.

### Option 2: One runtime per tenant, scoped by `aws:ResourceTag`
Pros: enforced by IAM. Cons: a runtime takes about 200 to 550 s to create
(spec §5.3), costs a runtime per tenant, and breaks the single registry row
per tenant on a shared runtime.

### Option 3: A proxy that holds the grant and checks the tenant
Pros: the check sits in one place. Cons: one more component to build, secure
and keep running, for a check the backend class already makes.

## Decision

Option 1. The tool role holds `bedrock-agentcore:InvokeAgentRuntime` and
`StopRuntimeSession` on the runtime ARN and on `<runtime ARN>/runtime-endpoint/*`,
because both actions authorize against the endpoint ARN as well. The reaper
role (which `offboardTenant` runs as) holds `StopRuntimeSession` on the same
two ARNs. The tool tenant role and the drain role hold nothing for this
backend: the tenant role carries the `nitro` start and stop grants only, and
the drain stops the sessions that have a row with the reaper's grant. None of
the grants carries a condition, because no condition key helps.

The run-time class refuses, with an error and before any call, a handle
whose `backend` is not `agentcore` or whose session id is not
`rc-` + SHA-256(tenant id), and a job whose tenant id or nonce differs from
the handle's. The runner adds the second check: it adopts a nonce only when
the session id header equals the id derived from the job's tenant id, and
`jobAuth` covers that tenant id (ADR-0018).

## Consequences

The enforcement is filtered, not enforced, and the spec's per-backend table
says so. The unit tests cover the guard (a handle of another tenant, of
another backend, a job for another tenant, a job signed with another nonce)
and the synth tests assert the grants, their resources and the absence of a
condition. If AgentCore adds a session-id condition key, the tool's invoke
and stop move to the tool tenant role with that condition and this record is
superseded.
