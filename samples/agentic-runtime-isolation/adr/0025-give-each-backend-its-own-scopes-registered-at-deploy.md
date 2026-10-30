<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0025: Give each backend its own scopes, registered with the identity provider at deploy

- Status: Accepted
- Date: 2026-10-29
- Amends: ADR-0005, ADR-0024
- Deciders: Dave Roberts (PSA)

## Context
ADR-0024 gave each backend a `requiredScopes` list in its registry entry, checked AND on top of the ingress-wide floor (ADR-0005). The names come from tenant-identity's fixed set, so the demo's `billing` backend requires `tenant-api/write`, a scope every tenant user holds. The check proves the token was narrowed (ADR-0007), not that the tenant or user is entitled to billing.

tenant-identity now offers a scope catalogue that a backend fills through `PUT /platform/scopes/{scope}` (its ADR-0034), entitlement per tenant (tenant-identity ADR-0035) and per user (tenant-identity ADR-0036). A backend must own one or more scopes of its own, unique to it, and a backend added after the ingress deploy must bring its scopes with it, as it already brings its registry entry.

## Options considered
### Option 1: Keep `requiredScopes` as free names and document the convention
Pros: no code change. Cons: nothing stops two backends sharing a scope, and the identity side never learns a new scope without a redeploy.

### Option 2: `scopes: string[]` on `AgentBackend`, named `<backend>/<action>`, registered by a custom resource
At synth the construct refuses an empty list, a duplicate, and a name whose prefix is not the backend's own name, so uniqueness follows from the unique backend name (`Overwrite: false`, ADR-0024). A `ScopeRegistration` custom resource calls tenant-identity's `PUT /platform/scopes/{scope}` with SigV4 for each scope on create, `DELETE` on delete, using the published `PlatformInvokePolicy` and API URL parameters (tenant-identity ADR-0030, tenant-identity ADR-0017). The registry entry is written after the scopes exist, so a token can never be checked against a scope the issuer does not know. The ingress lets a token through when it carries **any one** of the backend's scopes (OR); the ingress-wide floor stays AND and optional. The agent receives the token's scopes as today (ADR-0007) and separates read from write itself. Pros: a backend is one construct with its route, Runtime, registry entry, Gateway target and scopes; a new backend needs no identity redeploy. Cons: one more custom resource and a deploy-order dependency on the identity API being up.

### Option 3: Register scopes from the shared ingress, listing its backends
Cons: the ingress would need to know every backend at deploy, which ADR-0024 removed.

## Decision
Option 2. The registry entry field is renamed `scopes`; the demo's backends own `default/chat` and `billing/read`, `billing/invoke`. The demo entitles tenant A to all three and tenant B to `default/chat`, and its integration test checks: tenant B narrowed to `billing/*` is refused at the exchange; a user of A cut to `billing/read` by the tenant admin reaches billing; `/nosuch/invocations` and the drain path behave as before.

## Consequences
Easier: scopes are entitlement, not a narrowing proof; a consumer sees in one construct what a backend claims. Harder: the ingress-wide `requiredScopes` floor is mostly redundant and the README says when to still use it (a scope every backend shares, e.g. `platform/active`); a `cdk destroy` of a backend removes its scopes from the catalogue while tenants still name them, which tenant-identity tolerates by intersection; `scripts/integ.sh` deploys tenant-identity with the scope routes granted in `PlatformInvokePolicy`. The authoriser cache key stays header plus path, so OR changes no cache behaviour.

Implementation-time consequences (2026-10-29): the registration claims a scope rather than overwriting it. Every `PUT` writes the description `<StackId>#<LogicalResourceId>` as an ownership marker; Create `GET`s each scope first and fails the deploy with `scope <name> already registered by another stack` when the marker names another owner, taking the physical id `scope-registration:<backend>:unclaimed` so the rollback's Delete is a no-op; Delete skips a scope another owner holds. The marker is the optional `AgentBackend.scopeOwner` (non-empty, at most 200 characters, no `#`; passed to the custom resource as `Owner`), default `<StackId>#<LogicalResourceId>`. Stacks that pass the same `scopeOwner` co-own the names: several stacks can then register the same backend names at once (the integration test's four stacks pass `RuntimeIsolationInteg`), at the cost that the first co-owner destroyed removes the scopes from the catalogue, so co-owners must be destroyed together; the message `is another backend named <Backend> deployed?` is the Create failure a stack without a shared owner gets instead. Renaming a backend is a replacement: the new name's scopes are claimed first, then the old name's are deleted. Each platform call has a 10 s abort timeout and one retry on 429, 5xx or a transport error, and the handler answers CloudFormation before its Lambda timeout, so a slow or unreachable identity API fails the stack rather than hanging it. `ApiUrl` must be an `https` URL whose hostname ends `.execute-api.<region>.amazonaws.com`. The function's role carries the published `PlatformInvokePolicy` less an inline Deny on every `/platform/tenants*` route; the policy's `kms:Encrypt` and `kms:GenerateDataKey` on tenant-identity's admin-password key (`kms:ViaService = ssm`) are inert for it (threat model T-41, M-31).

Residuals: the handler re-validates the event's shape and the owner rule, but a principal allowed to invoke the function directly can pass any `Backend`, so the control there is IAM on `lambda:InvokeFunction` and on the role; and a principal with `ssm:PutParameter` on `/application-plane/shared/identity/*` can repoint `apiUrl` or `platformInvokePolicyArn` for the next deploy (threat model T-29, T-30). `scripts/integ.sh` replaces a stale published tenant-identity only with `INTEG_REPLACE_STALE_IDENTITY=1`, because the replacement deletes the shared pool other consumers may depend on, and its cleanup checks the demo scopes are gone from a reused catalogue. Revisit if tenant-identity mints a per-owner platform policy.
