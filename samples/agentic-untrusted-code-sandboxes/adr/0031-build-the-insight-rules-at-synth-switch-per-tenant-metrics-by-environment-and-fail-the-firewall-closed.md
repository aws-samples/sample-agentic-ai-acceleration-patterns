<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0031: Build the insight rules at synth, switch per-tenant metrics by environment, and fail the firewall closed

- Status: Proposed
- Date: 2026-11-20
- Deciders: Dave Roberts (Partner Solutions Architect)

## Context

Spec §3.8 and ADR-0013 want Contributor Insights rules over the tool's
structured lines and an opt-in switch for per-tenant EMF metrics. Spec §3.9
and ADR-0016 want an optional DNS Firewall that blocks everything but the
AWS names. A function bound with `bindRunCode` brings its own log group
after the core is built, so a rule cannot list its groups at construction.

## Options considered

### Option 1: Rule bodies built lazily at synth; the metrics switch is an environment variable; the firewall uses the service default for fail-open
Pros: a late-bound function is in the rules; no code path differs between
metrics on and off except the handler's one `if`; the default fail mode is
closed. Cons: the rule body holds log group names as tokens.

### Option 2: One rule per function log group
Pros: no lazy body. Cons: Contributor Insights ranks within one rule, so a
tenant that uses two functions would appear twice.

## Decision

Option 1.

- Runs by tenant counts lines with `runId` over the tool functions' log
  groups, keyed on `tenantId`. Sandbox seconds by tenant sums
  `sandboxSeconds` over every function that writes a stop line (tool,
  reaper, drain, offboard).
- With `dnsFirewall` a third rule counts the query log's blocked lookups by
  `srcaddr`.
- `perTenantMetrics` sets `PER_TENANT_METRICS` on every function; the
  handler writes EMF lines only when it is `true`. The construct adds no
  `cloudwatch:` permission: EMF needs only the log write.
- The firewall association has `MutationProtection` `DISABLED`.
  CloudFormation has no property for `FirewallFailOpen`, whose service
  default is `DISABLED` (fail closed), so the integration run reads it back
  with `GetFirewallConfig` and fails if it is `ENABLED`. The Logs resource policy is the construct's own and names
  the one query log group's ARN, and the query log config and its
  association depend on it (spec §3.9).
- `createEndpoints: false` is refused for a VPC the construct creates,
  because a `nitro` or `agentcore` sandbox with no endpoints cannot pull
  its image or log; it is for a supplied VPC that has them. The core then
  adds no security group rule for those endpoints, so the app opens 443 from
  each backend's client group to them (ADR-0028).
- The log group of the Logs resource policy statement is the group's own ARN
  (already ending in `:*`), the form the integration driver compares.

## Consequences

The three rule names, the policy name and the Resolver names come from
`nameFor` (ADR-0027), so two instances share a Region. Per-tenant
metrics stay off until the vendor accepts their cost (ADR-0013).
