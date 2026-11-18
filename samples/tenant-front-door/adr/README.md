<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# Architecture decision records

One file per decision, in the template of
[`docs/sample-standard.md` §2.2](../../../docs/sample-standard.md).
Every record is Accepted except ADR-0017 and ADR-0018, which are
Proposed. ADR-0017 depends on the control plane's global hooks
(control-plane ADR-0044), also Proposed (spec Q-5). ADR-0018 stays
Proposed until spike S-10 passes, and its `Amended by: ADR-0018` notes
on ADR-0002, 0012 and 0016 take effect when it is accepted. ADR-0017 will supersede
ADR-0013 once ADR-0044 is accepted; until then ADR-0013 stays Accepted. Merge order:
the control-plane hooks branch first, then this one. The `Amended by:
ADR-0017` notes on ADR-0002, 0003, 0012, 0014 and 0015 take effect when
ADR-0017 is accepted. One spike is still open
([spec §9](../design/tenant-front-door.spec.md)): S-10 (what the
registrar's Lambda function sees from its default resolver), which if
it fails reopens the resolver choice in ADR-0018. S-5 (`/agents/*`
streaming) passed on 2026-11-18 on a standard distribution, which settles
the `/agents/*` origin request policy in ADR-0011; the integration test
([spec §10](../design/tenant-front-door.spec.md) step 23) verifies
`/agents/*` on the `tenant-only` distribution.

| Number | Title | Status | Date |
|---|---|---|---|
| [0001](./0001-default-to-one-url-with-the-tenant-from-the-token.md) | Default to one URL with the tenant from the token | Accepted | 2026-11-13 |
| [0002](./0002-use-a-cloudfront-multi-tenant-distribution.md) | Use a CloudFront multi-tenant distribution | Accepted | 2026-11-18 |
| [0003](./0003-keep-the-route-table-in-cloudfront-keyvaluestore.md) | Keep the route table in CloudFront KeyValueStore | Accepted | 2026-11-13 |
| [0004](./0004-route-to-cells-with-cloudfront-functions-origin-modification.md) | Route to cells with CloudFront Functions origin modification | Accepted | 2026-11-13 |
| [0005](./0005-route-on-the-unverified-claim-and-verify-at-the-origin.md) | Route on the unverified claim and verify at the origin | Accepted | 2026-11-17 |
| [0006](./0006-generate-config-json-at-the-edge.md) | Generate `/config.json` at the edge | Accepted | 2026-11-13 |
| [0007](./0007-keep-tokens-in-spa-memory.md) | Keep tokens in SPA memory | Accepted | 2026-11-13 |
| [0008](./0008-use-a-hash-based-csp-with-trusted-types.md) | Use a hash-based CSP with Trusted Types | Accepted | 2026-11-13 |
| [0009](./0009-rate-limit-each-tenant-with-waf-on-the-host-or-at-the-origin.md) | Rate limit each tenant with WAF on the host, or at the origin | Accepted | 2026-11-13 |
| [0010](./0010-deploy-the-edge-stack-in-us-east-1.md) | Deploy the edge stack in us-east-1 | Accepted | 2026-11-18 |
| [0011](./0011-protect-cell-origins-with-origin-access-control-across-accounts.md) | Protect cell origins with origin access control across accounts | Accepted | 2026-11-13 |
| [0012](./0012-cap-the-route-table-and-shard-by-distribution.md) | Cap the route table and shard by distribution | Accepted | 2026-11-17 |
| [0013](./0013-register-routes-through-a-registrar-that-checks-the-control-plane.md) | Register routes through a registrar that checks the control plane | Accepted | 2026-11-17 |
| [0014](./0014-run-one-front-door-per-control-plane-application.md) | Run one front door per control-plane application | Accepted | 2026-11-13 |
| [0015](./0015-read-the-control-plane-with-a-reader-token.md) | Read the control plane with a reader token | Accepted | 2026-11-16 |
| [0016](./0016-sign-in-through-one-shared-host-in-host-mode.md) | Sign in through one shared host in host mode | Accepted | 2026-11-17 |
| [0017](./0017-register-routes-from-a-control-plane-global-hook.md) | Register routes from a control-plane global hook | Proposed | 2026-11-18 |
| [0018](./0018-prove-a-dedicated-domain-with-a-per-tenant-dns-challenge.md) | Prove a dedicated domain with a per-tenant DNS challenge | Proposed | 2026-11-18 |
| [0019](./0019-strip-agents-before-the-agent-ingress.md) | Strip `/agents` before the agent ingress | Accepted | 2026-11-18 |
