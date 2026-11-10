# ADR-0024: Register accounts at run time and claim cell slots atomically

- Status: Accepted
- Date: 2026-11-09
- Amends: ADR-0013, ADR-0014
- Deciders: Dave Roberts (SA)

## Context
Cells so far lived in the control plane's own account, and nothing bounded how many of them placement could create. Two scenarios need more: scaling the fleet to a second account in the same Region, and deploying a tenant into the customer's own account on demand (data and resources stay with the customer; the vendor holds no credentials). Both need an account concept with a per-account cell limit, and the second needs accounts to appear after deployment, not in deployment configuration. Spec P-5/P-6 require any capacity guard to be a conditional write on an authoritative record, and P-10 wants operator-facing capacity decisions explicit.

## Options considered
### Option 1: Accounts as a deployment input (`cellAccounts` context), records upserted on first claim
Pros: no new API; one list in `cdk.json`. Cons: adding a customer's account is a redeploy of the control plane; the build roles' AssumeRole resources are enumerated at synth, so the customer's account must be known before their stack exists; the home account is a special case unless listed.

### Option 2: An account entity registered through the API, with the cell counter on its record
`PutAccount {owner, maxCells, externalId?}` creates the record; the new-cell transaction claims `cellCount += 1 IF cellCount < maxCells`; the cell-delete transaction releases it. `owner = VENDOR` accounts form the fleet; `owner = TENANT` accounts accept only a targeted `CreateTenant {accountId}`. Pros: accounts arrive on demand; the counter follows the proven ADR-013 pattern one level up; explicit registration matches P-10. Cons: four more operations; a third entity on the table.

### Option 3: No account entity; `CreateTenant` names an account and the cell carries it
Pros: smallest change. Cons: no cell limit per account (the stated requirement), no place for the handshake data, no capacity view.

## Decision
Option 2. The account stores something no neighbour does — the authoritative `cellCount` and the trust handshake — so it is an entity by P-1's own test, and its lifecycle is synchronous, so it adds no workflow. Untargeted placement iterates vendor-owned accounts oldest-registered first, mirroring oldest-first cells; a targeted request tries only the named account. When every eligible account refuses the claim, the request fails (ADR-026) rather than widening capacity. `owner` is immutable because flipping it under live cells would change who those cells belong to. `maxCells` is replaceable and may drop below `cellCount`; that only stops new cells. `PutAccount` writes policy fields only and never `cellCount` (field ownership, ADR-011), so a capacity cut and a concurrent claim compose. `DeleteAccount` is a single conditional delete on `cellCount = 0`, the counterpart of the claim, exactly as `DeleteCell` is to the tenant claim (ADR-014).

## Consequences
Over-provisioning races from ADR-013 are now bounded by `maxCells` per account instead of unbounded. The cell record gains an immutable `accountId`; the cell delete terminal write becomes a two-item transaction (cell delete plus account decrement) with the same absence-is-success read as the tenant delete. `CREATE_FAILED` cells hold their account slot until deleted, as `CREATE_FAILED` tenants hold theirs. GSI-2 gains an `ACCOUNT#<id>` partition for `ListCells?accountId=` and the targeted candidate scan. The home account is registered like any other; a deployment that forgets to register one gets a 409 on the first onboard, which the README deploy steps call out. Revisit if accounts need a Region of their own (spec §11) or a placement policy beyond owner and capacity.
