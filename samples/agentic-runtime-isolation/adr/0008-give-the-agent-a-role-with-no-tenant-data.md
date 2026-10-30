<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0008: Give the agent an execution role with no tenant-scoped permission

- Status: Accepted
- Date: 2026-10-26
- Amended by: ADR-0018, ADR-0026
- Deciders: Dave Roberts (PSA)

## Context
Any code in the microVM can read the execution role credential from MMDS. If that role could read tenant data, session isolation would not be the only boundary that matters.

## Options considered
### Option 1: Grant data access and filter in code
Cons: filtered isolation inside the session.
### Option 2: Model invocation on one named model, logs, and X-Ray only
Pros: nothing tenant-scoped to leak; keeps the sample about the Runtime boundary.

## Decision
Option 2, plus `requireMMDSV2: true`.

## Consequences
Easier: a small threat surface. Harder: a real agent needs data; the optional TVM (ADR-0012) supplies it with credentials vended from the validated token, so this role stays data-free.

Amended by ADR-0018: the execution role also loses model invocation, which moves to the always-on tenant role, so this role grants logs and traces only.

Amended by ADR-0026 (2026-10-30): `requireMMDSV2: true` is deferred, because `AWS::BedrockAgentCore::Runtime` in aws-cdk-lib 2.274.0 has no property for it; the execution role stays logs and traces only, and threat model T-13 carries the residual until the resource type gains it.
