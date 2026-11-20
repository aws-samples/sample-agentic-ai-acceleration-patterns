<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0003: Give sandboxed code no internet and the fewest credentials each backend allows

- Status: Proposed
- Date: 2026-11-18
- Amended by: ADR-0015, ADR-0016
- Deciders: Dave Roberts (Partner Solutions Architect)

## Context

The VM keeps tenant A's code off tenant B's machine on every backend. What
decides the damage is what the code can still reach from inside its own
machine: AWS credentials (an execution role, task metadata, instance
metadata) and the network. The defaults differ:

- A Lambda MicroVM has public internet access unless it is given a VPC
  egress connector (Lambda MicroVMs developer guide, Networking). Without an
  execution role it has no AWS access and no runtime logs.
- An ECS task has no AWS credentials without a task role. In a sandbox mode
  its ENI has no public IP; its route out is whatever its subnet has.
- An AgentCore runtime always has a role, and code in a session can read
  that role's credentials. In VPC mode the runtime needs ECR, an S3 gateway
  endpoint for image layers, and Logs (AgentCore VPC guide), and AgentCore
  refreshes the image from ECR periodically.

## Options considered

### Option 1: No internet on every backend; no credentials where the backend allows, a narrow role where it does not
Pros: a hostile script cannot send the tenant's bytes to the internet on
any backend, and cannot read tenant data on any backend. Cons: MicroVMs
need a VPC connector and subnets; `agentcore` needs endpoints with scoped
policies, because the paths it must keep (ECR, S3 layers, Logs) are also
paths code could misuse; no runtime logs from MicroVMs.

### Option 2: Tenant-scoped credentials in the sandbox
Pros: code can read the tenant's own data itself. Cons: a one-tenant blast
radius, but the tenant's data can leave with any egress; breaks P-1.

### Option 3: An egress allowlist
Pros: code can reach one package mirror. Cons: one more moving part per
backend; belongs in a later option.

## Decision

Option 1. `microvm` runs with no execution role, `logging` disabled, and
only a VPC egress connector into sandbox subnets with no route out.
`nitro` runs with no task role in sandbox subnets with no route out, its
security group open only to the Logs endpoint. `agentcore` runs on a
runtime whose role reaches only ECR pull on the runner repository and Logs
writes on its own log group, in sandbox subnets whose only paths are the
ECR, S3 and Logs endpoints, each with a policy scoped to the sample's
repository, the ECR layer bucket and the sample's log groups (spec §3.7).
Each claim is measured before acceptance (spikes S-2, S-5, S-6, S-9, S-10).

## Consequences

C-2 is stated per backend: `agentcore` code holds the narrow runtime role,
the other two hold nothing. The tool's log line is the record of every run,
because the MicroVM logs nothing. If a spike shows a path a backend cannot
close, the threat model records it against that backend and the README says
so in the backend table.

Note 2026-11-18: amended by ADR-0015. "No internet" holds for connections; DNS lookups resolve public names on every backend and are the stated exception. The `nitro` task group reaches only the Logs endpoint; ECR and S3 endpoints serve `agentcore` only. The MicroVM metadata service answers, without credentials.

Note 2026-11-19: amended by ADR-0016. A `dnsFirewall` option closes the DNS exception: with it on, only AWS names resolve and every other lookup is blocked and logged.
