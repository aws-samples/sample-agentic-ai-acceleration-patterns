<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0017: Split the core from the gateway entry

- Status: Proposed
- Date: 2026-11-19
- Amends: ADR-0001
- Deciders: Dave Roberts (Partner Solutions Architect)

## Context

ADR-0001 made the ingress optional, but one construct still imported
`ToolTarget` and `toolHandler` from `agentic-runtime-isolation`. A vendor
with their own identity provider and API would then install, build and
trust a sample they never deploy. Standard §1.1 asks that a consumer's
construct stay producer-agnostic.

## Options considered

### Option 1: A core construct at the package root and a gateway construct under a subpath
Pros: the core has no producer import; the producer becomes a dev and
optional peer dependency; the gateway path is still one construct away.
Cons: two constructs and two functions to document and test.

### Option 2: One construct, a dynamic `require` of the producer when `ingress` is set
Pros: one construct. Cons: the import is hidden from the type system and
from bundlers; a missing package fails at synth, not at install.

### Option 3: Keep the static dependency
Pros: nothing to change. Cons: the standalone case carries the producer.

## Decision

Option 1. `UntrustedCodeSandboxes` (package root) holds the pattern and
deploys `runCodeFunction`, which a vendor's own API invokes with IAM,
passing a tenant id it verified; the function vends the tool tenant role
itself. `RunCodeToolTarget` (`gateway` subpath) takes the core construct
and an ingress, deploys a gateway function that wraps the same run logic
in `toolHandler`, and gets its grants from `sandboxes.grantRunCode`.
Invoke on `runCodeFunction` is granted only through `grantInvokeRunCode`.
A lint rule and a unit test keep the producer import inside
`src/gateway/`.

## Consequences

The integration test drives both entries: the behaviour steps through
the gateway, and a `standalone` step through `runCodeFunction` with IAM.
On the standalone path the vendor decides the tenant (threat T-61, T-82).
The core function's budget may reach 120 s; the gateway entry refuses a
budget above 90 s.
