<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0011: Protect cell origins with origin access control across accounts

- Status: Proposed (spike S-3)
- Date: 2026-11-13
- Deciders: Dave Roberts (PSA)

## Context

Every cell's API is an origin of one distribution in the edge account, and
the cell lives in whichever account the control plane placed it in:
vendor-owned or tenant-owned. The edge refuses requests with no tenant, an
unknown tenant or a suspended tenant before any origin is reached (P-7), and
sets the web baseline on every response (P-8). A cell origin that answers
callers who bypass the distribution skips both. The demo cell API is a
Lambda function URL (§6.1). The tenant router picks the origin per request
with origin modification (ADR-0004), so the protection must work on an
origin chosen at run time, in another account, with no secret in the
function (§3.3).

## Options considered

### Option 1: Origin access control with a cross-account Lambda permission

The function URL uses `AWS_IAM` auth. The router sets the cell's domain
with origin access control, so CloudFront signs the origin request. The
`CellRouteAccess` construct, deployed in the cell's account, grants the
edge distribution `lambda:InvokeFunctionUrl` on the cell's function URL,
conditioned on the distribution ARN. The cell stack reads that ARN from
`/application-plane/applications/<applicationId>/shared/front-door`
(§6.4).

Pros: no shared secret; the grant names one distribution, so no other
distribution and no direct caller reaches the URL; the grant lives in the
cell's account, owned by the cell stack. Cons: depends on origin
modification setting origin access control for an origin in another
account, which no document states; with origin access control, `PUT` and
`POST` callers must send the body's SHA-256 in `x-amz-content-sha256`, so
the SPA computes it.

### Option 2: Secret header

The distribution adds a header the cell checks. Pros: works with any
origin type. Cons: the router holds no secrets (§3.3), so the header comes
from the origin configuration, one value for every cell; a tenant-owned
account sees the value in its own cell and can then call any other cell
directly. Rotation touches every cell account.

### Option 3: IP allowlist

The cell admits only CloudFront's origin-facing address ranges. Pros: no
signing. Cons: those ranges serve every distribution in every AWS account,
so any distribution passes; a function URL takes no security group.

## Decision

Option 1, if spike S-3 passes. Origin access control on the Lambda function
URL, with `CellRouteAccess` granting the edge distribution
`lambda:InvokeFunctionUrl` conditioned on the distribution ARN in the
cell's account, is the only option that binds the origin to this one
distribution without a secret a tenant-owned account could read.

## Consequences

- A direct call to a cell's function URL is 403 (integration step 10). The
  edge checks and the header baseline cannot be skipped.
- A cell stack needs the distribution ARN at deploy time, so the shared
  stack in each cell account copies it from the edge (§6.4).
- The SPA sends `x-amz-content-sha256` on every `PUT` and `POST` to
  `/api/*`. The demo SPA does it; a vendor SPA must too.
- Origins are Lambda function URLs and S3 only (§1.2). Another origin type
  needs its own record.
- Spike S-3 must show a signed request reaching a function URL with
  `AWS_IAM` auth in the second account, an unsigned one refused with 403,
  and a `POST` with a body served. It also confirms the exact permission
  set the function URL needs.
- If S-3 fails, this record and ADR-0004 are reopened together: a declared
  origin per cell with origin access control (a distribution update per
  cell) and the secret header are the options left.
- Revisit when CloudFront offers origin access control for another origin
  type a cell uses, or a cell moves off function URLs.
