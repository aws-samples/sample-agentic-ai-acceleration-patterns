<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0006: Pass input bytes in, and never let the sandbox fetch

- Status: Accepted
- Date: 2026-11-18
- Deciders: Dave Roberts (Partner Solutions Architect)

## Context

The code needs the tenant's file. It can get it by fetching (a role, a
presigned URL, a mounted bucket) or by being handed the bytes.

## Options considered

### Option 1: The tool fetches with tenant credentials and passes the bytes
Pros: the sandbox needs no credentials and no egress (ADR-0003); the
tenant prefix is enforced by the tool tenant role. Cons: inputs are capped
by the request size (`maxInputBytes`, 5 MiB by default).

### Option 2: A presigned URL for the one object
Pros: large files. Cons: needs egress to S3; the URL is a bearer credential
the code can send anywhere it can reach.

### Option 3: Mount the tenant prefix (S3 Files, Mountpoint)
Pros: natural file access. Cons: sandbox modes rule out S3 Files volumes on
ECS; credentials sit next to the code.

## Decision

Option 1 (P-1). The size cap is checked with a `HeadObject` before any
sandbox starts.

## Consequences

Large inputs are out of scope; the README points to chunking or to a
later egress option. Outputs return the same way, capped by
`maxOutputBytes`, and the tool writes them to `outputs/<tenant>/` when asked.
