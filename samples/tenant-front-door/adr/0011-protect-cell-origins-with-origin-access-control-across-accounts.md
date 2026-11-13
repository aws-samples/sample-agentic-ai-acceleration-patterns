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

The cell also needs the viewer's bearer token, because it is the authoriser
(ADR-0005). Origin access control on a function URL signs with
`signingBehavior: always`, which overwrites the viewer `Authorization`
header with CloudFront's SigV4 signature. `no-override` keeps the viewer
header but does not sign, so an `AWS_IAM` function URL refuses the request.

## Options considered

### Option 1: Origin access control with a cross-account Lambda permission

The function URL uses `AWS_IAM` auth. The router sets the cell's domain
with origin access control (`signingBehavior: always`), so CloudFront signs
the origin request. The router copies the bearer token into
`x-tenant-token` for `/api/*`, after it strips every client `x-tenant-*`
header (§3.3 steps 1 and 7), so a client cannot set it. The origin request
policy forwards `x-tenant-token` and `x-tenant-route`, and the cell
verifies the token it reads from `x-tenant-token`. The `CellRouteAccess`
construct, deployed in the cell's account, grants `cloudfront.amazonaws.com`
both `lambda:InvokeFunctionUrl` and `lambda:InvokeFunction` on the cell's
function, conditioned on the edge distribution's ARN (`SourceArn`). The cell
stack reads that ARN from
`/application-plane/applications/<applicationId>/shared/front-door`
(§6.4).

Pros: no shared secret; the grant names one distribution, so no other
distribution and no direct caller reaches the URL; the grant lives in the
cell's account, owned by the cell stack. Cons: depends on origin
modification setting origin access control for an origin in another
account, which no document states; the token travels in a header the
sample defines, so every cell API reads `x-tenant-token`, not
`Authorization`; `PUT` and `POST` callers must send the body's SHA-256 in
`x-amz-content-sha256`, so the SPA computes it.

### Option 2: Secret header

The distribution adds a header the cell checks. Pros: works with any
origin type. Cons: the router holds no secrets (§3.3), so the header comes
from the origin configuration, one value for every cell; a tenant-owned
account sees the value in its own cell and can then call any other cell
directly. Rotation touches every cell account. A value per cell avoids the
shared secret, at the cost of secrets in the route table; it is the
fallback below.

### Option 3: IP allowlist

The cell admits only CloudFront's origin-facing address ranges. Pros: no
signing. Cons: those ranges serve every distribution in every AWS account,
so any distribution passes; a function URL takes no security group.

## Decision

Option 1, if spike S-3 passes. Origin access control on the Lambda function
URL, with `CellRouteAccess` granting the edge distribution
`lambda:InvokeFunctionUrl` and `lambda:InvokeFunction` conditioned on the
distribution ARN in the cell's account, is the only option that binds the
origin to this one distribution without a secret a tenant-owned account
could read. The bearer token reaches the cell in `x-tenant-token`, a
router-owned header no client can set. `/agents/*` goes to the single
`agentIngress` input, an origin without origin access control (the API
Gateway or AgentCore Gateway ingress of `agentic-runtime-isolation`). Its
origin request policy, `Managed-AllViewerExceptHostHeader`, forwards
`Authorization` on `GET` and `POST` and does not forward `Host`.

## Consequences

- A direct call to a cell's function URL is 403 (integration step 10). The
  edge checks and the header baseline cannot be skipped.
- A cell API verifies the token from `x-tenant-token` (§6.1). The demo cell
  API is the reference.
- A cell stack needs the distribution ARN at deploy time, so the shared
  stack in each cell account copies it from the edge (§6.4).
- The SPA sends `x-amz-content-sha256` on every `PUT` and `POST` to
  `/api/*`. The demo SPA does it; a vendor SPA must too.
- Origins are Lambda function URLs and S3 only (§1.2). Another origin type
  needs its own record.
- Spike S-3 must show, through the multi-tenant distribution with its ARN
  as the permission's `SourceArn`: a signed request reaching a function URL
  with `AWS_IAM` auth in a second account; an unsigned one refused with
  403; a `POST` with a body and `x-amz-content-sha256` served; the cell
  receiving the viewer's token in `x-tenant-token`. It confirms the
  permission set and reports deploy and destroy time.
- If S-3 fails, the fallback is a per-cell secret header, and ADR-0004
  keeps origin modification. The cell create script generates the secret
  in the cell's account. The registrar stores it in that cell's `cell#`
  value. The router adds it on requests to that cell, and the cell refuses
  requests without it. A tenant-owned account learns only its own cell's
  secret, so it can reach only its own cell. The cost: the route table holds
  secrets. Any principal in the edge account with KeyValueStore read
  (`cloudfront-keyvaluestore:GetKey`, `ListKeys`), or with
  `cloudfront:UpdateFunction` and `TestFunction` on a function associated
  with the store, reads every cell's secret, so that read permission becomes part of the
  boundary. The secret travels in the `PutCellRoute` body, so the §5.1
  schema gains a `secret` field and "never log the body" (§3.4 step 6)
  becomes a security control. Rotation goes through `PutCellRoute`. A new
  record supersedes this one. It also changes the "no secrets" statements in
  §3.3, ADR-0003 and ADR-0005 Option 1. The IP allowlist
  (Option 3) is no fallback, and neither is a declared origin per cell,
  which needs a distribution update per cell and breaks P-9.
- Revisit when CloudFront offers origin access control for another origin
  type a cell uses, or a cell moves off function URLs.
