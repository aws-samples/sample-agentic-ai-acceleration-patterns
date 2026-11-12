# ADR-0034: The shared parameter namespace is per application

- Status: Accepted
- Date: 2026-11-10
- Amends: ADR-0010
- Deciders: Dave Roberts (SA)

## Context
Shared resource identifiers reach the application plane through three SSM namespaces in the cell's account (ADR-010): `/application-plane/shared/*` for infrastructure provisioned out of band, `/application-plane/cells/<cellId>/*` written by the cell scripts, `/application-plane/tenants/<tenantId>/*` written by the tenant scripts. Cell and tenant ids are ULIDs, so their namespaces never collide across applications. The shared namespace is one per account, and with ADR-032 two applications can host cells in the same account while needing different shared infrastructure (a different base domain, a different cluster).

## Options considered
### Option 1: Key the shared namespace by application
`/application-plane/applications/<applicationId>/shared/*`. Both provisioning roles read `/application-plane/applications/*`. Pros: two applications in one account cannot read each other's shared identifiers by accident, and a wrong `APPLICATION_ID` fails fast on a missing parameter; the id is operator-chosen and path-safe by construction (ADR-032). Cons: one more segment in every path; the demo parameter the home account publishes moves under an application.

### Option 2: Leave the namespace as it is
Scripts separate applications by convention, using `APPLICATION_ID` in their own parameter names. Cons: separation by convention, enforced by nothing; a script that forgets the convention reads another application's values and succeeds.

### Option 3: Key every namespace by application
Also `/application-plane/applications/<id>/cells/<cellId>/*` and `.../tenants/<tenantId>/*`. Cons: the ids are already unique; the extra segment buys nothing and the role grants stay as wide as today (`cells/*`, `tenants/*`).

## Decision
Option 1. Only the shared namespace changes. The cell and tenant namespaces keep their paths and their asymmetric grants (P-12). Both halves of the role pair read `/application-plane/applications/*`; nothing writes there under the control plane's credentials, as before.

## Consequences
Spec §6.2 and the `ssm-namespaces` grants change; the home account's demo parameter becomes `/application-plane/applications/<applicationId>/shared/base-domain`, published for the application the integration test registers. A tenant-owned account that hosts two applications publishes shared infrastructure twice, once per application, which is the intended reading of "shared".

---

2026-11-11: Amended by ADR-0038. The account-wide `/application-plane/shared/*` namespace stays beside the per-application one for infrastructure every application in an account may use; the role pair reads both.
