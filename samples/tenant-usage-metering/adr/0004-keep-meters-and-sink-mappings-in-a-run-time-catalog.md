<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0004: Keep meters and sink mappings in a run-time catalog

- Status: Proposed
- Date: 2026-11-18
- Deciders: Dave Roberts (SA)

## Context
Vendors add meters as they add features, and billing systems change the
fields they want on a usage record. If either is code, each change is a
deploy of the metering service, and of every emitter that lists meters.

## Options considered
### Option 1: Meters and mappings in CDK props
Pros: reviewed with the code. Cons: every change is a deploy.

### Option 2: A catalog behind the admin API, versioned by hour
Meters and sinks are records. A meter change writes a new version that
counts from a named whole hour: the next one for a change, up to the
recount window back for a new meter. A sink mapping is read at dispatch.
Pros: no deploy; an hour is always counted under one rule; history is
kept. Cons: a bad change takes effect without review; the admin API is a
sensitive surface.

## Decision
Option 2 (P-6). The admin API is open only to `operatorPrincipalArns`,
every change is logged with the caller, and versions are never deleted,
so a bad change is reverted with another write. Sum rules (`COUNT`,
`SUM`, `MAX`, `UNIQUE_COUNT`) stay code: a new rule changes how totals
are computed and must be tested.

## Consequences
- Emitters send any meter id; an unknown one goes to the error store
  (P-8). `CreateMeter` may set `effectiveFrom` back to a whole hour
  inside the recount window, so those events can be re-admitted and
  counted; changes to an existing meter still start at the next hour.
- Ingest and the recount check an event against the meter version in
  effect at its hour, so a meter retired later still counts its earlier
  hours.
- Infrastructure-as-code users can still seed meters from a script that
  calls the admin API.
