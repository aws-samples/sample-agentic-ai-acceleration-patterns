<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0018: Always vend tenant credentials, and attribute model cost by IAM principal

- Status: Accepted
- Date: 2026-10-26
- Deciders: Dave Roberts (PSA)

## Context
The backend is always shared (pool), so no resource tag splits its bill by tenant. ADR-0017 meters cost at the ingress, and model tokens reach the ingress only through the agent's `usage` event: a figure the agent reports, which a consumer's own agent may omit. Amazon Bedrock now allocates inference cost to the calling IAM principal in CUR 2.0 and Cost Explorer, including session tags passed on `sts:AssumeRole`, which appear as `iamPrincipal/<key>` ([Bedrock user guide](https://docs.aws.amazon.com/bedrock/latest/userguide/cost-mgmt-iam-principal-tracking.html)). A model call made with credentials tagged `TenantId` is therefore billed per tenant by AWS itself. Under ADR-0008 and ADR-0012 the agent calls the model with the shared execution role, and the TVM is optional, so that attribution is lost.

## Options considered
### Option 1: Keep the TVM optional; the deployer's tenant role may also allow the model
Pros: no change for deployers who do not need tenant data. Cons: model cost is attributed by IAM only when the TVM is on; otherwise it falls back to the reported `usage` event.
### Option 2: An always-on model role beside an optional TVM
Cons: two vending paths, two roles and two credential headers for the same claims; more to audit for no gain over Option 3.
### Option 3: Make the TVM required, with a default tenant role that may invoke only the one model
Pros: every model call is signed by a principal carrying the verified `TenantId`, on every deployment; one vending path; the deployer who needs data access passes their own role and the construct adds the model grant. Cons: one `AssumeRole` per tenant per credential lifetime always (cached per ADR-0012, about 0.1 s warm, 1.5 to 3.7 s cold, spike V-7); vended credentials always transit the backend's transport, so the V-7 logging rules always apply.

## Decision
Option 3.
- `tvm` stays an optional prop, but the TVM is always on. `tvm.role` is optional: unset, the construct creates `TenantModelRole`, trusted by `tvmCallerRole` only, requiring a non-empty `TenantId` request tag, `aws:TagKeys` pinned to the configured tag set, with `sts:TagSession`, and allowed only `bedrock:InvokeModel` and `bedrock:InvokeModelWithResponseStream` on the one model (same ARNs as the `OneModel` statement). Set, the construct adds the same model statement to the deployer's role (`addToPrincipalPolicy`; an imported role must already carry it, README).
- The execution role loses model access (amends ADR-0008): it keeps code, logs, traces and metrics only. The agent builds its Bedrock client from the vended credentials per request; without them a model prompt is an `event: error` `NoCredentials`, never a fallback to the execution role.
- The credentials header is always on the Runtime allowlist (ADR-0012 transport unchanged).
- Model cost per tenant is read from CUR 2.0 (`line_item_iam_principal`, `iamPrincipal/TenantId`). The deployer activates the `iamPrincipal/TenantId` cost allocation tag and the CUR 2.0 "Include caller identity (IAM principal) allocation data" option; both are account-level, so the README lists them and the construct does not set them. The `usage` event and the token metrics stay as a near-real-time cross-check; the bill is the source of truth for tokens.

Runtime, Gateway and Lambda cost is billed to the shared ingress and construct roles, so IAM principal attribution does not split it; ADR-0017's ingress metering still applies there.

## Consequences
Easier: model cost per tenant comes from the bill, independent of the agent's honesty; the agent holds no shared model permission at all, so a compromised agent cannot call the model outside a tenant's credentials. Harder: every deployment vends credentials, so STS quota (600 rps per account per Region, shared) and the header-logging checks are always in scope; a CUR line item expands to one row per principal and tag set, which raises CUR storage. Revisit when AgentCore Runtime session usage logs (per-session CPU and memory) can be joined to the session id, which would replace `BackendInvokeSeconds` as the Runtime share key.
