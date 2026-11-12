# ADR-0038: The mount follows the control plane's deployment model

- Status: Accepted
- Date: 2026-11-11
- Amends: ADR-0028, ADR-0031, ADR-0033
- Deciders: Dave Roberts (SA)

## Context
The control plane serves several applications from one deployment. An application (source, cell scripts, tenant scripts, `maxTenants`) is registered at run time with `PutApplication` and stamped onto each of its cells; the control plane stack carries no provisioning source (control-plane ADR-032). A tenant is a customer record that runs no build, and what is provisioned for it is a deployment, one per application, created with `CreateDeployment` and carrying `adminEmail` (control-plane ADR-037). Scripts receive `APPLICATION_ID`, and a tenant script owns `/application-plane/tenants/<tenantId>/<applicationId>/*`. Shared infrastructure has an account-wide namespace, `/application-plane/shared/*`, beside the per-application one, and both halves of the role pair read both (control-plane ADR-034, ADR-038). The mount has to say what it is in that model, where its parked password lives, and where it reads the identity parameters from.

## Options considered
### Option 1: One application, account-wide identity parameters, per-deployment parked password
The mount is the application `identity-mount`; a tenant's identity is its deployment of it. The identity stack keeps publishing at `/application-plane/shared/identity/*`, and the mount reads it there. The parked password moves to `/application-plane/tenants/<T>/<A>/admin-temporary-password`. Pros: the identity stack is unchanged and publishes once per account, before any application exists, which is what ADR-0017 and control-plane ADR-038 describe; the password sits in the namespace the deployment owns, so a second application of the same tenant never shares its path; the tenant id stays one id across every application (M-P-1). Cons: the password's path carries an application id the vendor must know to collect it; `APPLICATION_ID` is spliced into a parameter name and needs a charset check.

### Option 2: One application, identity parameters under the application's shared namespace
Publish `/application-plane/applications/identity-mount/shared/identity/*`. Pros: the mount's inputs sit behind its own application path. Cons: the identity stack would have to know the application id at deploy time and republish for every other application that wants identity, which is the coupling control-plane ADR-038 exists to avoid; every other reader of the parameters would move with it.

### Option 3: Identity as part of every application's tenant scripts
Each application that needs identity calls the platform API from its own tenant scripts. Pros: no separate deployment per tenant. Cons: the onboarding logic, the first-admin replay and the parked password are copied into every application; two applications of one tenant would race to create the same identity, and offboarding one would offboard it for all.

## Decision
Option 1. The mount registers one application, `identity-mount`, with the six scripts of `scripts/control-plane/` and the source that holds them; the vendor onboards with `CreateTenant` then `CreateDeployment`, re-applies with `UpdateDeployment` and offboards with `DeleteDeployment` then `DeleteTenant`. The tenant scripts require `APPLICATION_ID`, and `lib.sh` refuses one outside `[a-z0-9-]{1,32}` before any call (mounting spec M-R-12). The parked password lives at `/application-plane/tenants/<T>/<A>/admin-temporary-password`, amending the path of ADR-0031 and ADR-0033; the key, the encryption and the delete-on-offboard are unchanged. The identity parameters stay in the account-wide shared namespace, read through `read_identity_param` as before. ADR-0028's script set is unchanged in shape and is registered as the application's definition rather than passed as a control-plane stack input.

## Consequences
The integration test registers the application and the account, drives the tenant and its deployment through the control-plane API, and removes tenant, cell, account and application before teardown (mounting spec §10 steps 0 to 11b). Every tenant script of every application in the account runs as the same tenant provisioning role, which holds `PlatformInvokePolicy` and write/delete on `/application-plane/tenants/*`: another application's script can call the platform API and can overwrite or delete a parked password it cannot decrypt (threat-model T-34). A tenant's other applications reach its identity under the same tenant id but do not create it; an application that needs identity before its own deployment builds depends on the `identity-mount` deployment being `ACTIVE`, which the control plane does not order. Revisit if the control plane gains per-application role pairs, which would let the mount hold `PlatformInvokePolicy` alone, or deployment dependencies, which would let other applications wait for identity.
