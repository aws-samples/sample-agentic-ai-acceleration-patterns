<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0002: Deliver a draft validation kit before a deployable contribution

- Status: Proposed
- Date: 2026-10-21
- Deciders: Pending repository maintainer review

## Context

The requested output is a blog draft and code to validate its isolation design.
The initial iteration preceded selection of a test environment. ADR-0003 adds a
disposable SDK environment and synthetic issuer; `VALIDATION.md` records its
actual cloud results.

## Options considered

### Option 1: Build a full CDK/projen contribution now

Would satisfy repository conventions, but requires a complete identity stack,
deployment lifecycle, scanner review, and cloud validation before claiming
readiness.

### Option 2: Deliver an explicitly labelled local draft kit

Makes policy and serialization tests repeatable and provides cloud probes
against the deployer's test environment. Leaves full contribution gates visible.

## Decision

Deliver option 2 on a feature branch in a fork. This draft diverges from the
repository's required projen/CDK layout and integ-runner lifecycle. The SDK
driver, AWS-icon draw.io export, and root README index support review and live
testing; they do not make the draft merge-ready.

## Consequences

The user can review and test the design immediately. A repository contribution
requires the remaining sample-standard gates, including a passing full cloud
matrix, CDK/integ-runner integration, and required security scans.
