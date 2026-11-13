<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0010: Deploy the edge stack in us-east-1

- Status: Accepted
- Date: 2026-11-13
- Deciders: Dave Roberts (PSA)

## Context

Three parts of the front door have a fixed Region. An ACM certificate that
CloudFront uses, for `<appDomain>` and in `host` mode `*.<appDomain>`, must
be issued in `us-east-1`. A web ACL with CloudFront scope must also be
created in `us-east-1`. That web ACL carries the per-tenant rate rule in
`host` mode (ADR-0009). CloudFront standard logging v2 is configured through
the CloudWatch Logs API in `us-east-1`, even for cross-Region delivery: the
delivery source (the distribution) and the delivery that links it to a
destination are created there.

The rest of the sample has no such constraint. The route registrar, the SPA
bucket, the CloudWatch Logs group the standard logs land in, and the
published parameter `/application-plane/shared/front-door/edge` (spec §6.4)
live in the deployment Region, `eu-central-1` for the sample and its
integration test (spec §10). The samples it consumes, `tenant-identity` and
`control-plane`, publish their parameters there too (spec §6.3).

## Options considered

### Option 1: Edge stacks in us-east-1, main stack in the deployment Region

A small edge stack in `us-east-1` holds the certificate and the web ACL.
The main stack, in `eu-central-1`, holds the distribution, the router, the
route table, the registrar, the SPA bucket and the log group, and reads the
certificate and web ACL ARNs through CDK cross-Region references. The
logging delivery source and delivery also sit in `us-east-1`. The delivery
source names the distribution, so they go in an edge logging stack that
deploys after the main stack and delivers across Regions to the log group
in `eu-central-1`.

Pros: only the Region-bound resources leave the deployment Region. The
registrar, its logs, the CloudFront logs and the published parameter stay
next to the control plane and the cells. Cons: three stacks with a fixed
deploy order. Cross-Region references add a helper custom resource and
parameters in each Region.

### Option 2: Everything in us-east-1

One stack in `us-east-1`.

Pros: one stack, no cross-Region references. Cons: the registrar, the SPA
bucket, the logs and the published parameter move away from the control
plane and the cells. Readers in `eu-central-1` would have to look in another
Region for `/application-plane/shared/front-door/edge`.

## Decision

Option 1. The edge stack in `us-east-1` holds the ACM certificate and the
CloudFront-scope web ACL (spec §3.1). The edge logging stack in `us-east-1`
holds the standard logging delivery source and delivery. Everything else,
the destination log group included, runs in `eu-central-1` and takes the
ARNs it needs through cross-Region references. The Region constraint is
CloudFront's, so the split keeps it to the resources it applies to, and
every other part of the front door sits in the same Region as the control
plane and the cells it serves.

## Consequences

- Easier: the registrar, its logs, the CloudFront logs and the published
  parameter are in the Region a cell script and an operator already use.
- Easier: the edge stacks change rarely, so most updates touch the main
  stack only.
- Harder: deploy runs the edge stack, then the main stack, then the edge
  logging stack; destroy runs them in reverse. The certificate cannot be
  removed while the distribution still uses it.
- Harder: `cdk destroy` must remove all three stacks and the cross-Region
  reference helpers, so nothing is left behind (spec §6.2).
- Spike: S-1 confirms that the `us-east-1` delivery writes to the log group
  in `eu-central-1`. If it does not, the log group moves into the edge
  logging stack and per-tenant log queries run in `us-east-1`.
- Follow-up: the integration test deploys and destroys every stack and
  reports deploy and destroy time for each.
- Revisit when CloudFront accepts certificates, web ACLs or log
  configuration from other Regions. A deployer whose Region is `us-east-1`
  gets every stack in one Region with no change to this design.
