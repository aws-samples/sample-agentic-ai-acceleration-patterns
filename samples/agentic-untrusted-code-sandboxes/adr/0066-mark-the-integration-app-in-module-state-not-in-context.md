<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0066: Mark the integration app in module state, not in context

- Status: Proposed
- Date: 2026-11-20
- Amends: ADR-0059
- Deciders: Dave Roberts (Partner Solutions Architect)

## Context

`enableIntegOverrides` refused to run unless the app carried the context key
`rcIntegTest`. Any app can carry a context key: `cdk deploy -c rcIntegTest=true`
sets it. The comment on the guard said no other app could pass it, and that was
not true.

## Options considered

### Option 1: Keep the context key and say so
Pros: no change. Cons: the guard is documentation, as ADR-0059 itself calls it.

### Option 2: Register the app in a module-private set that only `createIntegApp` writes
Pros: no context value or flag can set it; the check is one line.
Cons: the integration module must create the app, which it already does.

## Decision

Option 2. `createIntegApp` calls `markIntegApp(app)`, and `enableIntegOverrides`
throws unless the function's root app is in that set. A test passes
`rcIntegTest=true` as context and expects the refusal.

## Consequences

Copying the `enableIntegOverrides` call into a deployment, with or without the
context key, fails at synth. The hook code in the tool, reaper and runner still
ships in every bundle and reads two variables that only tests set; the effect of
setting them by other means is a shorter sandbox life or one tenant's failed
start, and no data leaves (threat T-88).
