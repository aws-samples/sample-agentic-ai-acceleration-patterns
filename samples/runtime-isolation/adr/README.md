<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# Architecture decision records

| Number | Title | Status | Date |
|---|---|---|---|
| [0001](./0001-enforce-runtime-isolation-at-an-ingress-the-backend-alone-trusts.md) | Enforce runtime isolation at an ingress the backend alone trusts | Proposed | 2026-10-26 |
| [0002](./0002-derive-the-session-id-from-validated-claims.md) | Derive the session id from validated tenant and user claims | Proposed | 2026-10-26 |
| [0003](./0003-ship-a-construct-with-ingress-as-a-deploy-time-choice.md) | Ship one construct with the ingress as a deploy-time choice | Proposed | 2026-10-26 |
| [0004](./0004-use-tenant-identity-shared-pool-as-the-identity-provider.md) | Use tenant-identity `shared-pool` as the identity provider, read from its parameters | Proposed | 2026-10-26 |
| [0005](./0005-make-scope-checks-optional-and-enforce-them-at-ingress.md) | Make scope checks optional and enforce them at ingress | Proposed | 2026-10-26 |
| [0006](./0006-forward-the-user-token-only-on-opt-in-in-a-custom-header.md) | Forward the user token only on opt-in, in a Runtime custom header | Proposed | 2026-10-26 |
| [0007](./0007-downscope-by-requiring-a-narrowed-bearer-token.md) | Downscope by requiring a narrowed bearer token, not by exchanging at ingress | Proposed | 2026-10-26 |
| [0008](./0008-give-the-agent-a-role-with-no-tenant-data.md) | Give the agent an execution role with no tenant-scoped permission | Proposed | 2026-10-26 |
| [0009](./0009-choose-the-default-ingress-by-measurement.md) | Choose the recommended ingress by measurement, after security parity | Proposed | 2026-10-26 |
| [0010](./0010-declare-the-runtime-gateway-target-with-a-raw-override.md) | Declare the Gateway's Runtime target with a typed raw override | Proposed | 2026-10-26 |
| [0011](./0011-model-the-compute-service-as-a-backend-agentcore-first.md) | Model the compute service as a backend, with AgentCore Runtime first | Proposed | 2026-10-26 |
| [0012](./0012-vend-tenant-scoped-credentials-at-ingress-and-forward-them.md) | Vend tenant-scoped credentials at the ingress and forward them to the backend | Proposed | 2026-10-26 |
| [0013](./0013-make-session-mapping-an-optional-module.md) | Make session mapping an optional module; a fresh unit per request by default | Proposed | 2026-10-26 |