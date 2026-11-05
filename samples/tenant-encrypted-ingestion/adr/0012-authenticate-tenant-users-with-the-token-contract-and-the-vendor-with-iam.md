<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0012: Authenticate tenant users with the token contract through a Lambda authoriser and the vendor with IAM, and register the scopes at deploy

- Status: Accepted
- Date: 2026-11-05
- Deciders: Dave Roberts (PSA)

## Context
Two caller types reach the API. Tenant users call `/tenant/*` with an access
token whose `tenant_id` is the only trusted tenant source on that path
(§7.3). The vendor, through a control-plane tenant create script, calls
`/platform/*` to create and delete keys. The token must meet the repository
contract (`ARCHITECTURE.md` §2.1): verified issuer, allowed `client_id`,
expiry, `token_use`, and refused while it still carries `tenants`. Deliver and
read need separate scopes. The construct must work with any issuer that meets
the contract, not only `tenant-identity`. Realises P-2 and §3.1 (API, token
authoriser), §3.2, §3.3 (`identity`, `identityApi`), §6.4.

## Options considered
### Option 1: API Gateway Cognito user pool authoriser
Pros: managed, no code, checks scopes per method. Cons: Cognito only, so the
construct could not take a generic OIDC issuer; cannot check a `client_id`
allowlist on access tokens or refuse a token that still carries `tenants`;
cannot pass `tenantId` and `sub` to the integration as named context.
### Option 2: Custom Lambda authoriser verifying the token contract
Pros: verifies every rule of §2.1 against the discovery URL, so any compliant
issuer works; passes `tenantId` and `sub` as authoriser context; result
caching by token keeps cost and latency low. Cons: security-critical code the
sample owns, with unit tests for every refusal; a cold start on the first
request.
### Option 3: API keys
Pros: trivial. Cons: API keys identify a usage plan, not a user or a tenant;
they are not an authentication mechanism and cannot carry a tenant.

## Decision
Option 2 for `/tenant/*` and IAM (SigV4) for `/platform/*`. The authoriser
requires `ingestion/deliver` for `CreateDelivery` and `ingestion/read` for
`GetDelivery` and `ListDeliveries`. IAM on the platform routes keeps vendor
identity separate from tenant identity (`ARCHITECTURE.md` §2.3) and lets the
deployer grant `execute-api:Invoke` to exactly the control-plane role. The
construct takes the issuer as props (`identity.discoveryUrl`,
`allowedClientIds`) and depends on no parameter. Only the demo app and the
integration driver read `tenant-identity`'s published parameters
(`/application-plane/shared/identity/*`); at deploy the demo registers both
scopes in `tenant-identity`'s catalogue through its `PUT /platform/scopes/{scope}`,
the way `agentic-runtime-isolation` registers backend scopes; `identityApi` can
be passed by value or skipped by a deployer with another issuer.

## Consequences
Easier: tenant-identity's tokens work unchanged; a deployer with another
compliant issuer swaps two props. Harder: the authoriser is part of the
tenant boundary and is tested like it; scope registration is a deploy-time
call into another sample, so the demo fails fast when the parameters are
missing. Revisit if API Gateway gains a native authoriser that can enforce
the full token contract.
