<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# Architecture decision records

| Number | Title | Status | Amends / Amended by | Date |
|---|---|---|---|---|
| [0001](./0001-enforce-runtime-isolation-at-an-ingress-the-backend-alone-trusts.md) | Enforce runtime isolation at an ingress the backend alone trusts | Accepted | - | 2026-10-26 |
| [0002](./0002-derive-the-session-id-from-validated-claims.md) | Derive the session id from validated tenant and user claims | Accepted | - | 2026-10-26 |
| [0003](./0003-ship-a-construct-with-ingress-as-a-deploy-time-choice.md) | Ship one construct with the ingress as a deploy-time choice | Accepted | Amended by ADR-0024 | 2026-10-26 |
| [0004](./0004-use-tenant-identity-shared-pool-as-the-identity-provider.md) | Use tenant-identity `shared-pool` as the identity provider, read from its parameters | Accepted | - | 2026-10-26 |
| [0005](./0005-make-scope-checks-optional-and-enforce-them-at-ingress.md) | Make scope checks optional and enforce them at ingress | Accepted | Amended by ADR-0025 | 2026-10-26 |
| [0006](./0006-forward-the-user-token-only-on-opt-in-in-a-custom-header.md) | Forward the user token only on opt-in, in a Runtime custom header | Accepted | - | 2026-10-26 |
| [0007](./0007-downscope-by-requiring-a-narrowed-bearer-token.md) | Downscope by requiring a narrowed bearer token, not by exchanging at ingress | Accepted | - | 2026-10-26 |
| [0008](./0008-give-the-agent-a-role-with-no-tenant-data.md) | Give the agent an execution role with no tenant-scoped permission | Accepted | Amended by ADR-0018, ADR-0026 | 2026-10-26 |
| [0009](./0009-choose-the-default-ingress-by-measurement.md) | Choose the recommended ingress by measurement, after security parity | Accepted | Amended by ADR-0029 | 2026-10-26 |
| [0010](./0010-declare-the-runtime-gateway-target-with-a-raw-override.md) | Declare the Gateway's Runtime target with a typed raw override | Accepted | - | 2026-10-26 |
| [0011](./0011-model-the-compute-service-as-a-backend-agentcore-first.md) | Model the compute service as a backend, with AgentCore Runtime first | Accepted | Amended by ADR-0024 | 2026-10-26 |
| [0012](./0012-vend-tenant-scoped-credentials-at-ingress-and-forward-them.md) | Vend tenant-scoped credentials at the ingress and forward them to the backend | Accepted | Amended by ADR-0018 | 2026-10-26 |
| [0013](./0013-make-session-mapping-an-optional-module.md) | Make session mapping an optional module; a fresh unit per request by default | Accepted | Amended by ADR-0024 | 2026-10-26 |
| [0014](./0014-accept-the-production-hardening-cdk-nag-findings.md) | Accept the production-hardening cdk-nag findings in the sample | Accepted | - | 2026-10-26 |
| [0015](./0015-verify-the-token-at-every-ingress-stage.md) | Verify the token at every ingress stage, not only at the gateway | Accepted | Amended by ADR-0023 | 2026-10-26 |
| [0016](./0016-break-the-tenant-role-trust-cycle-with-a-lazy-caller-arn.md) | Break the tenant-role trust cycle in the demo with a lazy caller ARN | Accepted | - | 2026-10-26 |
| [0017](./0017-meter-pooled-cost-per-tenant-at-the-ingress.md) | Meter pooled cost per tenant at the ingress, with the agent reporting usage | Accepted | Amended by ADR-0018, ADR-0021 | 2026-10-26 |
| [0018](./0018-always-vend-tenant-credentials-and-attribute-model-cost-by-iam-principal.md) | Always vend tenant credentials, and attribute model cost by IAM principal | Accepted | Amends ADR-0008, ADR-0012, ADR-0017 | 2026-10-26 |
| [0019](./0019-teardown-leaves-no-log-group.md) | Teardown leaves no log group: own the execution log group and drain late logs | Accepted | - | 2026-10-27 |
| [0020](./0020-limit-each-tenant-at-the-ingress-with-a-shared-fixed-window-counter.md) | Limit each tenant at the ingress with a shared fixed-window counter | Accepted | - | 2026-10-27 |
| [0021](./0021-make-per-tenant-cloudwatch-metrics-opt-in.md) | Make per-tenant CloudWatch metrics opt-in, off by default | Accepted | Amends ADR-0017 | 2026-10-27 |
| [0022](./0022-bound-the-tvm-credential-cache-and-share-one-sts-call-per-tag-set.md) | Bound the TVM credential cache and share one STS call per tag set | Accepted | - | 2026-10-27 |
| [0023](./0023-tune-the-ingress-cold-and-hot-paths-by-measurement.md) | Tune the ingress cold and hot paths by measurement | Accepted | Amends ADR-0015 | 2026-10-27 |
| [0024](./0024-share-one-ingress-across-runtimes-through-a-backend-registry.md) | Share one ingress across several Runtimes through a backend registry | Accepted | Amends ADR-0003, ADR-0011, ADR-0013; Amended by ADR-0025 | 2026-10-28 |
| [0025](./0025-give-each-backend-its-own-scopes-registered-at-deploy.md) | Give each backend its own scopes, registered with the identity provider at deploy | Accepted | Amends ADR-0005, ADR-0024 | 2026-10-29 |
| [0026](./0026-defer-requiremmdsv2-until-cloudformation-exposes-it.md) | Defer `requireMMDSV2` until CloudFormation exposes it | Accepted | Amends ADR-0008 | 2026-10-30 |
| [0027](./0027-lowercase-the-gateway-name-to-match-its-arn.md) | Lowercase the Gateway name to match its ARN | Accepted | - | 2026-10-30 |
| [0028](./0028-run-the-demo-agent-on-nova-lite-through-a-cross-region-inference-profile.md) | Run the demo agent on Nova Lite through a cross-Region inference profile | Accepted | - | 2026-10-30 |
| [0029](./0029-recommend-api-gateway-as-the-default-ingress.md) | Recommend API Gateway as the default ingress | Accepted | Amends ADR-0009 | 2026-10-30 |
