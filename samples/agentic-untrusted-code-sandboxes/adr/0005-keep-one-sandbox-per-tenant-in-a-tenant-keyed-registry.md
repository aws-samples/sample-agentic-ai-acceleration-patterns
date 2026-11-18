<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0005: Keep one sandbox per tenant in a tenant-keyed registry

- Status: Proposed
- Date: 2026-11-18
- Deciders: Dave Roberts (Partner Solutions Architect)

## Context

A sandbox per call is cleanest but slow on `nitro` and wasteful on
`microvm`. A sandbox shared across tenants defeats the VM boundary. The tool
must find a tenant's live sandbox, start one when there is none, and never
start two in a race.

## Options considered

### Option 1: A DynamoDB row per tenant per backend, reached with the tool tenant role
Pros: `dynamodb:LeadingKeys` on `TENANT#${aws:PrincipalTag/TenantId}`
makes a lookup of another tenant's sandbox an IAM refusal (enforced);
a conditional put settles the race. Cons: one more table; a stale row after
a crash needs the expiry and "not found" path (spec §4.1).

### Option 2: Find the sandbox by tag on each call (`ListMicrovms`, `ListTasks`)
Pros: no table. Cons: list calls are filtered, slow and throttled; no
place to settle a race.

### Option 3: A fresh sandbox per call
Pros: no reuse state at all. Cons: every call pays the cold start; files
cannot persist across turns.

## Decision

Option 1. The row holds the handle, address, state and expiry; the reuse
rule is spec §4.1. AgentCore needs no handle beyond the derived session id,
but keeps a row so all three backends share the same rule.

## Consequences

The reaper reads every row with its own role, which reaches no tenant data.
Offboarding a tenant deletes its rows and stops its sandboxes. A row
outliving its sandbox costs one failed call, then a restart.
