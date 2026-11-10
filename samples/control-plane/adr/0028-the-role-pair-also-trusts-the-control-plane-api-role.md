# ADR-0028: The account role pair also trusts the control plane API role

- Status: Accepted
- Date: 2026-11-09
- Amends: ADR-0025, ADR-0027
- Deciders: Dave Roberts (SA)

## Context
ADR-027 has `PutAccount` verify an account's handshake by assuming both roles of the pair from the API function. ADR-025 had each half of the pair trust exactly one principal: the matching control-plane build role. The first integration run showed the gap: the probe runs under the API function's role, which the trust policy does not name, so every registration was refused as "not ready" — including the control plane's own account.

## Options considered
### Option 1: Each half of the pair also trusts the control plane API role
The API function gets a physical role name, `<fleet>-api`, and the pair's `aws:PrincipalArn` condition lists it beside the build role. Pros: one AssumeRole, same external id, the owner's trust policy names everything the control plane does in their account. Cons: a third fixed role name in the contract.

### Option 2: The API function assumes the build role, then the provisioning role
Pros: the pair's trust stays at one principal per half. Cons: the build roles would also have to trust the API role (today only CodeBuild), the probe becomes a two-hop chain, and a refusal no longer says which hop failed.

### Option 3: Drop the probe (ADR-027 Option 2)
Cons: the reason ADR-027 exists.

## Decision
Option 1. The probe is the control plane assuming the pair, so the owner trusting the role that performs it is the honest statement of the contract: the pair trusts the control plane's build roles (the scripts) and its API role (the registration check), nothing else. The API role's own AssumeRole grant stays bounded to the two provisioning role names in any account (ADR-027), and the external id applies to the probe exactly as to the builds.

## Consequences
Five physical role names derive from `fleetName`: `<fleet>-api`, `<fleet>-cell-build`, `<fleet>-tenant-build`, `<fleet>-cell-provisioning`, `<fleet>-tenant-provisioning`. The `CellAccountStack` and the home pair list two principals per half. The spec's §6.4 trust column names both. A customer reading their trust policy sees the registration probe as a distinct, named principal, which is the transparency the external id design wants. Revisit if the API function is ever split, in which case the probe moves with its role name.
