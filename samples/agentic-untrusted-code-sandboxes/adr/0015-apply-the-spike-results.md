<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0015: Apply the spike results

- Status: Accepted
- Date: 2026-11-18
- Amends: ADR-0003, ADR-0004, ADR-0005, ADR-0008, ADR-0010, ADR-0011, ADR-0012, ADR-0013
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
Pros: could close the DNS channel. Cons: a Route 53 Resolver DNS Firewall
rule group and association add deploy time and cost, and whether it covers
the MicroVM connector's lookups, the `nitro` tasks' lookups and the
AgentCore runtime's resolver is unverified on all three.

### Option 3: Drop the backends whose results disappointed
Pros: fewer moving parts. Cons: the sample exists to compare all three.

## Decision

Option 1. The changes, by spec section:

- §3.3: `nitro.instanceTypes` defaults to `m7i.xlarge`, the only type run
  end to end; `m7g.large` reports Nitro Enclaves support and is likely
  cheaper, but was not run on ECS. Synth refuses a type missing from a
  static table of supported types. The tool budget cap is 90 s with an
  ingress and 120 s without.
- §3.4: start caps 20 s (`microvm`), 5 min (`nitro`, room for a full
  instance launch, since the two measured cold starts may have used a
  pre-prepared instance), 30 s (`agentcore`). `microvm` start and stop stay
  filtered: only the image is scoped.
- §3.5: the AgentCore backend is a container image: a direct-code runtime
  runs as an unprivileged uid that cannot drop code to a second user,
  needs S3 reads beyond the endpoint policy, and takes about 9 minutes to
  create. On `microvm` and `agentcore` the runner makes its per-sandbox
  values when the sandbox first serves a tenant, because sandboxes start
  from a shared snapshot. The MicroVM image build has internet access.
- §3.6: the tool role passes only `HTTP_INGRESS` and the sample's
  connector, so a start without the connector is refused. The runtime role
  drops `logs:DescribeLogGroups`, which is refused at its scope and not
  needed. The MicroVM build role and connector operator role are listed.
- §3.7: the `nitro` task group reaches only the Logs endpoint; the ECR and
  S3 endpoints serve `agentcore` only.
- §3.8: MicroVM cost comes from the registry, because MicroVMs take no tags.
- §5.3: drain waits for every task `STOPPED` and every MicroVM
  `TERMINATED` before the stack's resources go, and the log cleanup
  resource also deletes the MicroVM image build log group.
- §6.1: the deployer raises the MicroVM memory quota, sized by tenants
  active within `sandboxIdle` + 30 minutes; §8 checks it before deploying.
- C-3 and §1.2: DNS is named as an open channel, with DNS Firewall as the
  next option.
- §8: the integration test owns its ingress and mints test tokens.

## Consequences

ADR-0003's "no internet" claim stands for connections, and DNS is its
stated exception. ADR-0004's `nitro` backend runs on `m7i.xlarge` by default, about
$0.27 per instance-hour while an instance is up; a Graviton type such as
`m7g.large` is the cheaper option to test next. ADR-0011's drain waits
for sandboxes to end before the resources they block. ADR-0008's driver deploys an ingress on every run. ADR-0010's runner
model holds on `microvm`, `nitro` and the AgentCore container backend.
ADR-0012's endpoint set shrinks for `nitro`. ADR-0013 attributes MicroVM
seconds from the registry only. Revisit when AWS adds MicroVM tags, an
AgentCore session condition key, or an ingress timeout prop in the
producer.
