<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0005: Keep one sandbox per tenant in a tenant-keyed registry

- Status: Proposed
- Date: 2026-11-18
- Deciders: Dave Roberts (Partner Solutions Architect)

## Context

A sandbox per call is cleanest but slow on `nitro` and wasteful on
`microvm`. A sandbox shared across tenants defeats the VM boundary. The tool
must find a tenant's live sandbox, start one when there is none, replace
one that died, and never start two in a race or strand a tenant behind a
start that crashed.

## Options considered

### Option 1: A DynamoDB row per tenant per backend, optimistic version, start lease, reached with the tool tenant role
Pros: `dynamodb:LeadingKeys` on `TENANT#${aws:PrincipalTag/TenantId}`
makes a lookup of another tenant's sandbox an IAM refusal (enforced). A
`version = :seen` condition lets the caller that saw a dead or expired
handle take it over, and only one caller wins. A lease on `STARTING`, as
long as the backend's start cap (10 minutes on `nitro`, for an instance
launch from zero), lets a later call take over a start whose Lambda died;
on `nitro` a task still `PROVISIONING` or `PENDING` keeps its lease. Cons: one more table, and
an orphan sweep for sandboxes a crashed start left behind.

### Option 2: Find the sandbox by tag on each call (`ListMicrovms`, `ListTasks`)
Pros: no table. Cons: list calls are filtered, slow and throttled; no
place to settle a race.

### Option 3: A fresh sandbox per call
Pros: no reuse state at all. Cons: every call pays the cold start; files
cannot persist across turns.

## Decision

Option 1, with the reuse rule in spec §4.1: read the row with its version;
reuse it when `READY`; probe it when `STARTING` within its lease; otherwise
take it over with `attribute_not_exists(PK) OR version = :seen`, stop the
handle being replaced, and start. A start that ends before it serves, or
does not become ready within its start cap, sets `FAILED` and backs off
30 s before the next takeover, whoever notices it. A failed identity check, "not found" or
a refused connection marks the row dead. A start that is not ready within
`startWait` returns the retryable `sandbox_starting` instead of holding the
Lambda.

## Consequences

The reaper (ADR-0011) stops idle `nitro` tasks and tasks past
`sandboxMaxLife`, records MicroVMs the platform ended, removes expired rows
and stops orphans with no row. A failed start backs off for 30 s before a
retry, and starts pass an idempotency token. Offboarding deletes a tenant's rows after
stopping its sandboxes. A row outliving its sandbox costs one failed call,
then a restart.
