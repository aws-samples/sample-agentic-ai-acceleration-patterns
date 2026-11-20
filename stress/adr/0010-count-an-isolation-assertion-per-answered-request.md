<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0010: Count an isolation assertion per answered request, and every refusal under `refusals`

- Status: Accepted
- Date: 2026-11-19
- Deciders: Dave Roberts (PSA)

## Context
Spec P-1 says every request is an isolation assertion: the driver knows the
tenant each request is for, and every response says which tenant served it.
A refused request names no tenant: a 401, 403, 404 or 429 carries no answer to
check, and neither does a tool call that the tool refuses inside an HTTP 200
(the MCP result carries an error, not a payload). The record (spec §4.3) has a
field for each: `isolation` (assertions and mismatches) and `refusals` (P-7).
The k6 library has to decide which field such a request lands in.

## Options considered
### Option 1: An assertion per answered request; every refusal under `refusals`
A request whose answer names a tenant is one assertion, and a mismatch when
the answer names another tenant or cannot be parsed. A refusal, whether its
status shows it or the body does, is counted under `refusals` and makes no
assertion. Pros: every request lands in exactly one of the two fields, so
nothing disappears; a refusal is never counted as a pass of P-1. Cons:
`assertions` is lower than `requests`, so a reader must add `refusals` to
see that every request was accounted for.
### Option 2: Count a refusal as a passed assertion
Pros: `assertions` equals `requests`. Cons: a run whose every request is
refused passes P-1 with no tenant ever checked.
### Option 3: Count a refusal as a mismatch
Pros: fails closed. Cons: a probe that must be refused (another tenant's
token) fails P-1 for the right answer, and every 429 under load fails the run.

## Decision
Option 1. `isolationCheck` (`stress/k6/lib.js`) makes one assertion per
answered request; a 2xx without a parsable answer is a mismatch. `countStatus`
counts a status of 400 or more under `refusals`, and `countRefusal(tenant,
reason)` counts a refusal the status does not show, such as a tool refused
inside a 200. Because every hop logs such a call as a 200, only the driver can
attribute it: `countRefusal` prints one `body_refusal` line with the tenant and
a short reason code, which the slice's `collect` moves into `byTenantReason`
as it does the status refusals it attributes from the hops' logs. A probe
that must be refused is asserted by the slice itself, as a mismatch when it is
served. Each scenario still fails when it made no assertion at all.

## Consequences
Every request is either checked for its tenant or counted as a refusal. A
reader compares `assertions + refusals` with `requests` (the gap is requests
that got neither, such as a network error). Until a slice's `collect` reads the
`body_refusal` lines, its refusals inside a 200 stay unattributed and fail the
record, as any unattributed refusal does: for runtime-isolation, an S4 run that
reaches the gateway's per-tenant limit fails on attribution, not on isolation.
The k6 README states the rule. Revisit if the spec's P-1 wording changes to
count refusals.
