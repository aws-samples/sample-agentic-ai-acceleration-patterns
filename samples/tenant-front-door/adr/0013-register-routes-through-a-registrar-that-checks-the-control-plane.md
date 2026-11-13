<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0013: Register routes through a registrar that checks the control plane

- Status: Accepted
- Date: 2026-11-13
- Deciders: Dave Roberts (PSA)

## Context

Cell and tenant scripts run in the cell's own account, vendor-owned or
tenant-owned, and must write the cell's API domain and the tenant's route
into the route table in the edge account (P-9). The route table is vendor
data (P-3): whoever writes a `tenant#` entry decides which cell serves that
tenant. A tenant-owned account controls its own credentials, so anything
it can write, it can write for any tenant. An account must route traffic
only to itself (P-5), and the control plane is the one source of truth for
where each cell and deployment lives (P-6).

## Options considered

### Option 1: A registrar with a placement check

An `AWS_IAM` API in the edge account (§3.4, §5.1). It takes the caller's
account and role from the signed request, reads the cell or deployment
from the control plane (ADR-0015), and writes only when the record's
`accountId` is the caller's. Pros: the account comes from the signature,
never the body; placement is read back on every write, with no copy kept
(P-6); scripts sign with the provisioning role credentials they already
hold. Cons: an API and a function to run; writes fail with 503 when the
control plane cannot be read.

### Option 2: A cross-account role that writes the store directly

Pros: no service to run. Cons: the role can write any key, so a
tenant-owned account could point another tenant's traffic at its own cell
(P-5 broken); key-level conditions cannot express "a cell the control
plane places in this account".

### Option 3: The control plane writes routes

Pros: placement and route written together. Cons: the control plane does
not know a cell's API domain until the cell script has run; it would need
write access to the edge account and knowledge of this sample, which other
applications on the same control plane do not use.

## Decision

Option 1; spike S-8 passed on 2026-11-13. The registrar is the only
writer of the route table. Its resource policy admits
`<fleet>-cell-provisioning` and `<fleet>-tenant-provisioning` roles in any
account, plus the edge operator role, and denies every other principal
with an explicit `Deny` and `ArnNotLike` on `aws:PrincipalArn`. Admission
grants no route. Every write checks the caller's
account against `GetCell` or `GetDeployment`, and a tenant route also needs
its cell's route written by the same account. Deletes check the account
recorded on the route, so cleanup works after the control plane has
removed the record.

## Consequences

- A tenant-owned account cannot register, change or delete another
  account's route (integration steps 11 and 12).
- The registrar is on the onboarding path: a control plane outage blocks
  route writes, never routing, which reads only the store.
- The `ac` field in each value records the verified account for deletes;
  the router never reads it.
- Spike S-8 (2026-11-13): a provisioning role in a second account got 200,
  with `identity.accountId` and `userArn` in the request context; a role of
  another name in that account got 403. The edge account's own admin also
  got 200 although the policy names only the provisioning roles: for a
  same-account caller, an identity policy that allows `execute-api:Invoke`
  is enough. The explicit `Deny` closes that gap. Deploy 75 s, destroy
  33 s.
- The integration test checks the `Deny`: an edge-account principal that
  is not the operator role gets 403.
- Revisit when the control plane offers a route hook of its own, or a
  cell origin type needs more than a domain.
