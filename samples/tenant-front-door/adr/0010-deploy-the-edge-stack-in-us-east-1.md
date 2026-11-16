<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0010: Deploy the edge stack in us-east-1

- Status: Accepted
- Date: 2026-11-13
- Deciders: Dave Roberts (PSA)

## Context

Four parts of the front door have a fixed Region. An ACM certificate that
CloudFront uses, for `<appDomain>` and in `host` mode `*.<appDomain>`, must
be issued in `us-east-1`. A web ACL with CloudFront scope must also be
created in `us-east-1`. That web ACL carries the per-tenant rate rule in
`host` mode (ADR-0009). CloudFront standard logging v2 is configured through
the CloudWatch Logs API in `us-east-1`: the delivery source (the
distribution), the delivery destination and the delivery that links them
are created there. A CloudWatch Logs delivery cannot cross Regions (spike
S-1). With the destination in `us-east-1` and the log group in another
Region, CloudWatch Logs refused it ("Region from identity does not match
the Destination Resource ARN"). With the destination in the log group's
Region, it refused the delivery ("Cross-region Delivery Destination is not
supported"). So the log group the logs land in is the fourth part: it must
be in `us-east-1` too.

The rest of the sample has no such constraint. The route registrar, the SPA
bucket and the published parameter
`/application-plane/shared/front-door/edge` (spec §6.4) live in the
deployment Region, `eu-central-1` for the sample and its integration test
(spec §10). The samples it consumes, `tenant-identity` and
`control-plane`, publish their parameters there too (spec §6.3).

## Options considered

### Option 1: Edge stacks in us-east-1, main stack in the deployment Region

A small edge stack in `us-east-1` holds the certificate and the web ACL.
The main stack, in `eu-central-1`, holds the distribution, the router, the
route table, the registrar and the SPA bucket, and reads the certificate
and web ACL ARNs through CDK cross-Region references. The logging
delivery source names the distribution, so the delivery source, the
delivery destination, the delivery and the log group all go in an edge
logging stack in `us-east-1` that deploys after the main stack.

Pros: only the Region-bound resources leave the deployment Region. The
registrar, its logs and the published parameter stay next to the control
plane and the cells. CloudFront logs arrive in 33 s and are queried with
CloudWatch Logs Insights. Cons: three stacks with a fixed deploy order.
Cross-Region references add a helper custom resource and parameters in each
Region. Per-tenant log queries run in `us-east-1`, not in the Region a cell
script and an operator already use.

### Option 2: Edge stacks in us-east-1, logs to S3 in the deployment Region

As Option 1, but the delivery destination is an S3 bucket in `eu-central-1`
(destination and delivery stay in `us-east-1`, with a bucket policy for
`delivery.logs.amazonaws.com`). Pros: the logs sit in the deployment
Region. Cons: spike S-1 measured 312 s from request to the object, against
33 s for CloudWatch Logs, and the logs are queried with Athena, which needs
a table, a workgroup and a results bucket.

### Option 3: Everything in us-east-1

One stack in `us-east-1`.

Pros: one stack, no cross-Region references. Cons: the registrar, the SPA
bucket and the published parameter move away from the control plane and the
cells. Readers in `eu-central-1` would have to look in another Region for
`/application-plane/shared/front-door/edge`.

## Decision

Option 1. The edge stack in `us-east-1` holds the ACM certificate and the
CloudFront-scope web ACL (spec §3.1). The edge logging stack in `us-east-1`
holds the standard logging delivery source, delivery destination, delivery
and the log group. Everything else runs in `eu-central-1` and takes the
ARNs it needs through cross-Region references. The Region constraint is
CloudFront's and CloudWatch Logs', so the split keeps it to the resources it
applies to, and every other part of the front door sits in the same Region
as the control plane and the cells it serves. Logs go to CloudWatch Logs
because it is nine times faster to the first record than S3 and needs no
query setup.

## Consequences

- Easier: the registrar, its logs and the published parameter are in the
  Region a cell script and an operator already use.
- Easier: the edge stacks change rarely, so most updates touch the main
  stack only.
- Harder: per-tenant log queries (integration step 14) run in `us-east-1`.
  An operator looks for the CloudFront log group there.
- Harder: deploy runs the edge stack, then the main stack, then the edge
  logging stack; destroy runs them in reverse. The certificate cannot be
  removed while the distribution still uses it.
- Harder: `cdk destroy` must remove all three stacks and the cross-Region
  reference helpers, so nothing is left behind (spec §6.2).
- Spike S-1 (2026-11-16): the three-stack deploy took 481 s and the destroy
  312 s. Logs reached the log group in 33 s.
- Follow-up: the integration test deploys and destroys every stack and
  reports deploy and destroy time for each.
- Revisit when CloudFront accepts certificates, web ACLs or log
  configuration from other Regions, or CloudWatch Logs deliveries cross
  Regions. A deployer whose Region is `us-east-1` gets every stack in one
  Region with no change to this design.
