<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0003: Give sandboxed code no credentials and no egress

- Status: Proposed
- Date: 2026-11-18
- Deciders: Dave Roberts (Partner Solutions Architect)

## Context

The VM keeps tenant A's code off tenant B's machine on every backend. What
decides the damage is what the code can still reach from inside its own
machine: AWS credentials (an execution role, task metadata, instance
metadata) and the network. By default a Lambda MicroVM can be given
internet egress, an AgentCore session can read its runtime role, and an ECS
task can carry a task role.

## Options considered

### Option 1: No credentials and no egress on every backend
Pros: a hostile script can neither read tenant data nor send the tenant's
own bytes out (C-2, C-3). Cons: no runtime logs from MicroVMs (no execution
role); `nitro` needs isolated subnets and a Logs endpoint; code that needs
a package mirror or an API cannot run.

### Option 2: Tenant-scoped credentials in the sandbox
Pros: code can read the tenant's own data itself. Cons: a one-tenant blast
radius, but the tenant's data can leave with any egress; breaks P-1.

### Option 3: An egress allowlist
Pros: code can reach one package mirror. Cons: one more moving part per
backend (connector, proxy, security group rule); belongs in a later option.

## Decision

Option 1. The sandbox receives bytes (P-1) and returns bytes. `microvm`
runs with no execution role and no egress connector, `nitro` runs with no
task role in subnets with no route out, and `agentcore` runs on a runtime
whose role reaches only its own logs, in VPC mode with no security group
egress. Each claim is measured before acceptance (spikes S-2, S-5, S-6,
S-9, S-10).

## Consequences

The tool logs each run (tenant, backend, exit code, sizes, duration); the
MicroVM itself logs nothing. Egress allowlists are listed in spec §1.2 as
not done yet. If a spike shows a path the backend cannot close, the threat
model records it against that backend and the README says so in the
backend table.
