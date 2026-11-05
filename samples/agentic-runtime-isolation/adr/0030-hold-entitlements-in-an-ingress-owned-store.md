<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0030: Hold entitlements in an ingress-owned store, not in identity-provider scopes

- Status: Accepted
- Date: 2026-11-02
- Amends: ADR-0005
- Supersedes: ADR-0025
- Deciders: Dave Roberts (PSA)

## Context
ADR-0025 put each backend's entitlement into tenant-identity's scope catalogue, so the access token carries every scope the user holds. That stops scaling once an agent also names tools. tenant-identity keeps a user's scopes in `custom:scopes`, and a Cognito custom attribute holds at most 2,048 characters ([user pool attributes](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-settings-attributes.html)): about 60 names of `<target>/<tool>` length per user. Every name also rides in the access token, which travels in a header, and API Gateway caps the combined header size of a request ([API Gateway quotas](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-execution-service-limits-table.html)). A new scope means one `PATCH` per tenant before any user can hold it. Cognito has no token-exchange grant, so nothing downstream can trade a fat token for a narrow one (ADR-0007). Internal Amazon guidance moves authorisation from scopes to attributes plus policy, and AWS Prescriptive Guidance's lean-JWT pattern keeps the token small and holds the claims in DynamoDB behind a reference.

## Options considered
### Option 1: Keep scopes in tenant-identity and add bundles
A bundle scope (`billing/*`) stands for a set of tools. Pros: no new store; the token stays the entitlement. Cons: the 2,048-character cap and the header cap still bound the user; a bundle is a second catalogue to keep in step with the tools; a new tool still needs a write per tenant; the identity provider learns every product decision.

### Option 2: A DynamoDB table owned by the ingress
Rows: `TENANT#<id>` (`agents[]`, `tools[]`, `plan?`, `version`, `status`); sparse `TENANT#<id>` / `USER#<sub>` cut rows, absent meaning the full tenant set (ADR-0033); `PLAN#<name>` rows a tenant may reference; `TOOL#<target>/<tool>` catalogue rows with an owner marker (ADR-0035). Agent definitions stay in the SSM registry entry, whose `needs` and `tools` replace `scopes` (ADR-0032). Pros: one `GetItem` for the tenant and one `GetItem` for the user cut, which is usually absent, per token mint; no scan; 100,000s of users cost nothing until a tenant admin cuts one; the identity token stays small. Cons: a new table to run, back up and secure; the ingress becomes the entitlement authority and needs an API to change it.

### Option 3: Amazon Verified Permissions, one policy store per tenant
Pros: a real policy language and an audit trail per decision. Cons: the check is a set intersection, not a policy question; a policy store per tenant is a silo of configuration with its own quotas; a per-request `IsAuthorized` call costs more than two reads and adds a service to the hot path.

## Decision
Option 2, as the `EntitlementStore` construct created by `SharedIngress`. The table answers the one question the ingress asks at mint, which agents and tools this user may use, with two key reads and no scan, and it grows with tenants and cuts rather than with users. Verified Permissions stays a later option if entitlement turns into real policy (conditions, time, attributes). The ingress-wide `requiredScopes` floor on the identity token stays as ADR-0005 defined it; the per-backend scope check of ADR-0025 moves to the store.

## Consequences
Easier: a new tool or agent needs no write to the identity provider; a user's entitlement has no size cap. Harder: tenant-identity no longer holds tool entitlements, so `/platform/scopes` is no longer called and `ScopeRegistration` (C-8) is removed, with its IAM and ownership code; the integration test drops its catalogue cleanup check. The table has point-in-time recovery on. Every write to a `TENANT#` row or a cut row bumps the tenant row's `version`, which feeds the token cache key (ADR-0036). Follow-up: the vendor and tenant-admin APIs on the store (ADR-0033), the transaction token that carries the grant (ADR-0031), and a threat-model entry for the table as an entitlement authority. Revisit if entitlement needs conditions a set intersection cannot express (then option 3), or if a consumer's identity provider can mint narrow tokens itself.
