<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# Architecture decision records

One file per decision, in the template of
[`docs/sample-standard.md` §2.2](../../../docs/sample-standard.md).
A record marked Proposed waits on the spike it names
([spec §9](../design/tenant-front-door.spec.md)).

| Number | Title | Status | Date |
|---|---|---|---|
| [0001](./0001-default-to-one-url-with-the-tenant-from-the-token.md) | Default to one URL with the tenant from the token | Proposed (spike S-7) | 2026-11-13 |
| [0002](./0002-use-a-cloudfront-multi-tenant-distribution.md) | Use a CloudFront multi-tenant distribution | Proposed (spike S-1) | 2026-11-13 |
| [0003](./0003-keep-the-route-table-in-cloudfront-keyvaluestore.md) | Keep the route table in CloudFront KeyValueStore | Proposed (spikes S-1 and S-2) | 2026-11-13 |
| [0004](./0004-route-to-cells-with-cloudfront-functions-origin-modification.md) | Route to cells with CloudFront Functions origin modification | Proposed (spike S-3) | 2026-11-13 |
| [0005](./0005-route-on-the-unverified-claim-and-verify-at-the-origin.md) | Route on the unverified claim and verify at the origin | Proposed (spike S-7) | 2026-11-13 |
| [0006](./0006-generate-config-json-at-the-edge.md) | Generate `/config.json` at the edge | Accepted | 2026-11-13 |
| [0007](./0007-keep-tokens-in-spa-memory.md) | Keep tokens in SPA memory | Accepted | 2026-11-13 |
| [0008](./0008-use-a-hash-based-csp-with-trusted-types.md) | Use a hash-based CSP with Trusted Types | Accepted | 2026-11-13 |
| [0009](./0009-rate-limit-each-tenant-with-waf-on-the-host-or-at-the-origin.md) | Rate limit each tenant with WAF on the host, or at the origin | Proposed (spike S-6) | 2026-11-13 |
| [0010](./0010-deploy-the-edge-stack-in-us-east-1.md) | Deploy the edge stack in us-east-1 | Accepted | 2026-11-13 |
| [0011](./0011-protect-cell-origins-with-origin-access-control-across-accounts.md) | Protect cell origins with origin access control across accounts | Proposed (spike S-3) | 2026-11-13 |
| [0012](./0012-cap-the-route-table-and-shard-by-distribution.md) | Cap the route table and shard by distribution | Accepted | 2026-11-13 |
| [0013](./0013-register-routes-through-a-registrar-that-checks-the-control-plane.md) | Register routes through a registrar that checks the control plane | Proposed (spike S-8) | 2026-11-13 |
| [0014](./0014-run-one-front-door-per-control-plane-application.md) | Run one front door per control-plane application | Accepted | 2026-11-13 |
| [0015](./0015-read-the-control-plane-with-a-reader-token.md) | Read the control plane with a reader token | Proposed (spike S-9) | 2026-11-13 |
