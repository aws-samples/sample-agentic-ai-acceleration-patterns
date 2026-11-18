<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0015: Apply the spike results

- Status: Proposed
- Date: 2026-11-18
- Amends: ADR-0003, ADR-0004, ADR-0008, ADR-0010, ADR-0012, ADR-0013
- Deciders: Dave Roberts (Partner Solutions Architect)

## Context

Spikes S-1 to S-12 (spec §7.1) measured what the design had assumed. Most
claims held. Six did not, or held only in part: MicroVMs cannot be tagged
or scoped per MicroVM; DNS resolves public names from every sandbox;
`m7i.large` cannot run Nitro Sandboxes; the `nitro` task does not pull its
own image; AgentCore direct code deployment cannot drop code to a second
user and fails under the S3 endpoint policy; and the producer's ingress
cuts every agent turn at 120 s and lets no consumer mint a token.

## Options considered

### Option 1: Keep the design and adjust settings, roles and the drive path
Pros: the trust model is unchanged; every change is a default, a policy
line, a packaging choice or a test step. Cons: DNS stays an open channel
on every backend until a later option closes it.

### Option 2: Add DNS filtering now
Pros: closes the DNS channel on `nitro` and `microvm`. Cons: a Route 53
Resolver DNS Firewall rule group and association add deploy time and cost,
and whether it covers the AgentCore runtime's resolver is unverified.

### Option 3: Drop the backends whose results disappointed
Pros: fewer moving parts. Cons: the sample exists to compare all three.

## Decision

Option 1. The changes, by spec section:

- §3.3: `nitro.instanceTypes` defaults to `m7i.xlarge`, and synth refuses a
  type without Nitro Enclaves support. The tool budget cap is 90 s with an
  ingress and 120 s without.
- §3.4: start caps 20 s (`microvm`), 2 min (`nitro`), 30 s (`agentcore`).
  `microvm` start and stop stay filtered: only the image is scoped. The
  AgentCore runner makes its `bootId` at a session's first job.
- §3.5: the AgentCore backend is a container image, not direct code.
- §3.6: the tool role passes only `HTTP_INGRESS` and the sample's
  connector, so a start without the connector is refused. The runtime role
  drops `logs:DescribeLogGroups`.
- §3.7: the `nitro` task group reaches only the Logs endpoint; the ECR and
  S3 endpoints serve `agentcore` only.
- §3.8: MicroVM cost comes from the registry, because MicroVMs take no tags.
- §5.3: drain waits for every task `STOPPED` and every MicroVM
  `TERMINATED` before the stack's resources go.
- §6.1: the deployer raises the MicroVM memory quota.
- C-3 and §1.2: DNS is named as an open channel, with DNS Firewall as the
  next option.
- §8: the integration test owns its ingress and mints test tokens.

## Consequences

ADR-0003's "no internet" claim stands for connections, and DNS is its
stated exception. ADR-0004's `nitro` backend runs on 4-vCPU Intel or
Graviton types, which raises the idle cost per instance to about $0.27 per
hour. ADR-0008's driver deploys an ingress on every run. ADR-0010's runner
model holds on `microvm`, `nitro` and the AgentCore container backend.
ADR-0012's endpoint set shrinks for `nitro`. ADR-0013 attributes MicroVM
seconds from the registry only. Revisit when AWS adds MicroVM tags, an
AgentCore session condition key, or an ingress timeout prop in the
producer.
