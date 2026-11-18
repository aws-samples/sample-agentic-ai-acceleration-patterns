<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0001: Serve every boundary behind one run_code tool target

- Status: Proposed
- Date: 2026-11-18
- Deciders: Dave Roberts (Partner Solutions Architect)

## Context

The code a sandbox runs comes from an agent or a tenant. Something has to
know the tenant, fetch the input with tenant-scoped credentials, and pick
the tenant's sandbox. If the agent does it, the agent's prompt can be
steered into the wrong tenant's sandbox or prefix. `agentic-runtime-isolation`
already gives a tool a signed tenant context and a tool-side TVM (its
ADR-0034, ADR-0035).

## Options considered

### Option 1: A `ToolTarget` on the existing tools gateway
Pros: the tenant arrives signed; the grant decides who may call it; the
tool TVM gives enforced access to inputs; no new ingress. Cons: the sample
depends on `agentic-runtime-isolation` and its deploy.

### Option 2: Its own API with its own token check
Pros: stands alone. Cons: re-implements token verification and the TVM;
a second place where the tenant is decided.

### Option 3: Let the agent call the sandbox directly
Pros: fewest parts. Cons: the agent picks the tenant (P-2 broken); every
agent needs sandbox permissions.

## Decision

Option 1. The tool is a Lambda `ToolTarget` with its own tenant role, so the
tenant is chosen once from the signed context (P-2) and the input is read
with enforced credentials (P-6). The dependency is the composition the
repository asks for (standard §1.1).

## Consequences

The integration test reuses or deploys an ingress with a tools gateway.
The tool inherits the gateway's limits (tool Lambda timeout, spike S-11).
A vendor without that ingress can still use the backends by calling the
construct's run function from their own tool, which the README shows.
