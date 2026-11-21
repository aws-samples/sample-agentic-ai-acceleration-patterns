<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0016: Offer a DNS Firewall as an option

- Status: Proposed
- Date: 2026-11-19
- Amends: ADR-0003
- Amended by: ADR-0019
- Deciders: Dave Roberts (Partner Solutions Architect)

## Context

Every backend blocks connections out of the sandbox, but the resolver
answers public names, so a script can encode a tenant's data in DNS
lookups and receive replies (ADR-0015, C-3). Spike S-13 (spec §7.2) showed
that every backend's lookups reach the VPC resolver, that one Route 53
Resolver DNS Firewall rule group on the VPC blocks them with NXDOMAIN and
logs each one, and that each backend still runs. It also showed costs:
the ECS Managed Instances retry a blocked `*.api.aws` name hundreds of
times a minute until it is allowed, the platforms look up NTP names, the
query log names a tenant only on `nitro`, and an AgentCore runtime took
about 550 s to become ready on the firewall network against about 200 s
before, cause unknown.

## Options considered

### Option 1: Off by default, a `dnsFirewall` prop turns it on
Pros: a reader gets the measured design without a new moving part; a
vendor who must stop DNS exfiltration turns it on and gets the blocked-
lookup log; the integration test proves both settings. Cons: the default
deployment keeps the DNS channel open.

### Option 2: On by default
Pros: the default closes the last path out. Cons: the allow list must
keep up with platform names (a missed one is a silent retry storm, as
`*.api.aws` showed); the AgentCore ready-time question is open; a vendor
who supplies a VPC with its own resolver rules gets a second rule group.

### Option 3: Leave it out
Pros: nothing to maintain. Cons: the sample would describe a gap it can
already close.

## Decision

Option 1 (spec §3.3, §3.9). The rule group allows `amazonaws.com`,
`*.amazonaws.com`, `*.on.aws`, `*.api.aws`, `time.aws.com`
and `*.compute.internal`, plus any `allowDomains`, and blocks the rest
with NXDOMAIN and `FirewallFailOpen` disabled. `*.amazon.pool.ntp.org`
stays blocked: it is a third-party zone, and no spike saw a failure
without it. Synth refuses the option with a supplied `vpc`, because the
association would block names for every other workload in that VPC. The construct owns the rule group, its
VPC association (mutation protection off), the query-log configuration and
its log group, and its own Logs resource policy for that group, which
the query-log configuration depends on so the grant exists before delivery
starts, and `cdk destroy` removes them all. The policy takes one of the
Region's 10 Logs resource policy slots. It never declares the account's shared
delivery policy; a change delivery makes there is a stated leftover.

## Consequences

C-3 reads per setting. The integration test runs `run-code` with the
firewall on and `run-code-files` with it off, checks both outcomes, and
fails if any platform name other than the NTP pool, or a sandbox's PTR for its own address, was blocked. Running
an `agentcore` runtime in each instance also gives the with-and-without
control for the ready-time question. Names under the allowed AWS zones
still resolve; a narrower list of exact names is a later option. The
AgentCore ready time is measured again on the integration run; if the
firewall causes it, the README says so next to the prop. Revisit the
default once the allow list has held through several runs.

Note 2026-11-19: amended by ADR-0019. S-14 measured the same AgentCore ready time (552 s) without the firewall, so the firewall does not cause it and the README needs no note next to the prop; the cause of the difference from S-9 is unknown. The default stays off for the allow-list upkeep.
