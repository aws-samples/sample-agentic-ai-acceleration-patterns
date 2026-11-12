# ADR-0038: An account-wide shared namespace beside the per-application one

- Status: Accepted
- Date: 2026-11-11
- Amends: ADR-0034, ADR-0010
- Deciders: Dave Roberts (SA)

## Context
ADR-034 keyed the shared parameter namespace by application, so two applications in one account keep their shared infrastructure apart. Some shared infrastructure is not an application's: an identity platform mounted under the control plane serves every application a tenant uses and publishes its identifiers once per account, before any application is registered. Under ADR-034 alone that platform would have to know every application id at deploy time and publish its parameters once per id, and the role pair would refuse a read of anything outside `/application-plane/applications/*`.

## Options considered
### Option 1: Two shared namespaces
`/application-plane/shared/*` for infrastructure every application in the account may use (an identity platform, a shared network), `/application-plane/applications/<applicationId>/shared/*` for one application's. Both halves of the role pair read both. Pros: a cross-application platform publishes once and needs no application list; an application's own infrastructure stays behind its path; the choice of namespace states what the infrastructure is for. Cons: two places to look; a script that reads the account-wide namespace by mistake succeeds, so the per-application isolation is by path only where the publisher chose the per-application path.

### Option 2: Per-application only
Cross-application platforms publish under every application id they serve, from a list given at deploy time, and republish when an application is added. Cons: couples the platform's deployment to the control plane's application registry; a new application needs a platform redeploy before its first cell can build.

### Option 3: Account-wide only (ADR-010 as it was)
Cons: two applications in one account cannot keep their shared infrastructure apart, which is what ADR-034 set out to fix.

## Decision
Option 1. The parameter namespace contract has four namespaces: the account-wide shared one, the per-application shared one, the cell one and the tenant one. The role pair's `ReadSharedResources` statement covers `/application-plane/shared/*` and `/application-plane/applications/*`. Publishers choose: infrastructure that every application may use goes under `shared`, infrastructure of one application under `applications/<id>/shared`. The sample scripts read their application's namespace; the tenant-identity mount reads the account-wide one.

## Consequences
Spec §6.2 lists four namespaces; `ssm-namespaces.ts` grants both read paths; the CDK test checks both. A script's `APPLICATION_ID` still selects its own namespace, and nothing writes to either shared namespace under the control plane's credentials. Revisit if an account-wide publisher needs to hide a value from some applications; that is the per-application namespace, which exists.
