# ADR-0029: Require an external id for tenant-owned accounts

- Status: Accepted
- Date: 2026-11-09
- Amends: ADR-0025
- Deciders: Dave Roberts (SA)

## Context
ADR-025 made the external id on the account role pair optional and "recommended for tenant-owned accounts". A tenant-owned account is a third party handing the control plane a role, which is the case AWS's own guidance reserves the external id for. The blind review found two consequences of leaving it optional: a customer can install the pair without one and the control plane accepts the registration without comment, and a provisioning script that reached the build role's credentials (T29) could assume the pair in every tenant-owned account that had skipped it. The `aws:PrincipalArn` pin in the trust policy keeps every other AWS account out; the external id is the only check that ties a registration to the account owner's consent.

## Options considered
### Option 1: `PutAccount` requires `externalId` when `owner` is `TENANT`
Pros: the sample shows the pattern AWS recommends for third-party roles; a missing id is a 400 at registration, when the operator can act on it; one `if` in the service and the Smithy input stays optional for vendor accounts. Cons: one more value the customer must generate and hand over out of band.

### Option 2: Keep it recommended, record the reasoning in the threat model
Pros: no change. Cons: the sample's default for the sovereignty case is weaker than the AWS guidance it cites; a reader copying the README's `PutAccount` call without the id gets no signal.

### Option 3: Require it for every account
Cons: a vendor-owned account sits inside the vendor's own trust and the `aws:PrincipalArn` pin already names the only callers; the id would guard against nothing and add a step to the home-account registration.

## Decision
Option 1. `PutAccount` refuses `owner: TENANT` without `externalId` before the handshake probe runs, so a pair installed without one is caught at registration rather than passing the probe silently. `owner: VENDOR` may omit it. The `CellAccountStack` validates a supplied id against STS's pattern at synth. The limits stay written down in the threat model: the id gates registration only (any operator uses the stored value afterwards), it rides the build's plaintext environment override (T28), and the main wall against cross-account reach is the `aws:PrincipalArn` pin plus the credential scoping of M24.

## Consequences
Spec §6.4 and §3.3 read MUST for tenant-owned accounts; the README's customer-account walkthrough always sets one. A customer who installed the pair without an id redeploys it with one before registering. The integration test already registers account B with an external id, so no run changes. Revisit if registration ever becomes self-service (spec §11): the external id would then be the check that stops one customer registering another's account, and the stored value would need per-operator scoping.

---

**Amended by ADR-0030 (2026-11-10):** the 400 before the probe catches a *missing* value only. Whether the pair *requires* the id is proven by the probe's negative call (assume without the id, expect a refusal); the sentence "a pair installed without one is caught at registration rather than passing the probe silently" holds through that call, not through this check.
