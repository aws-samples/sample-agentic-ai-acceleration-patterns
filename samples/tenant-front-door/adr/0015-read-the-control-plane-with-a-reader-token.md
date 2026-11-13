<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0015: Read the control plane with a reader token

- Status: Proposed (control-plane `client_id` input)
- Date: 2026-11-13
- Deciders: Dave Roberts (PSA)

## Context

The route registrar reads placement on every write: `GetCell` for a cell
route, `GetDeployment` for a tenant route (§3.4, ADR-0013). It faces every
cell account, tenant-owned accounts included, so it is the most exposed
caller of the control plane. The control plane admits callers with a
vendor IdP token whose `role` claim maps to a grant. An operator grant
holds every operation. Control-plane R-36 and control-plane ADR-0042 add a
reader grant: the ten `GET` operations, enforced in the authorizer policy
and again in the service, off until the deployer lists a role value in
`readerRoles`. Control-plane R-37 keeps every `GET` free of writes and
secrets.

## Options considered

### Option 1: A reader role (control-plane ADR-0042)

The registrar has its own app client on the vendor IdP, whose tokens carry
a namespaced role value such as `control-plane:reader`, listed in the
control plane's `readerRoles`. Pros: the registrar can read placement and
change nothing; a leak discloses reads, not control; its calls are told
apart from an operator's in the control plane's access log. Cons: a client
secret to store and rotate; the reader can read all ten `GET` operations,
not only the two it uses.

### Option 2: An operator app client

Pros: no control-plane change. Cons: a bug or a leak in the registrar could
delete tenants, cells and accounts, or register an application whose code
runs in every admitting account.

### Option 3: An IAM-authorised read stage

Pros: no token or client secret. Cons: a second identity model on the
control plane, a second stage to throttle and log; control-plane ADR-0042
declined it.

## Decision

Option 1. The registrar gets a reader token with the client credentials
flow from its own vendor IdP app client, whose role value is a namespaced
entry in the control plane's `readerRoles`, such as
`control-plane:reader`. The client secret lives in Secrets Manager in the
edge account (`controlPlane` input, §3.6). The registrar caches the token
until it expires and refuses a write with 503 when it cannot read the
control plane, never writing unchecked.

## Consequences

- The deployer adds the role value to `readerRoles` and creates the app
  client; the control plane admits no reader until then (§6.1).
- A namespaced value keeps a broader issuer's `reader` or `viewer` from
  mapping to the grant (control-plane R-36).
- A stolen reader token discloses fleet topology, non-secret parameter
  values and application source locations (control-plane T36). It cannot
  change the fleet.
- Spike S-9 (2026-11-13) failed as specified and proved the fallback. A
  Cognito client-credentials token carries `client_id`, `scope`, `sub`
  (equal to `client_id`) and no `aud`, so the control plane authorizer's
  audience check denies it. A pre-token-generation trigger (V3 event, on
  the Essentials plan) added `role: control-plane:reader`, but Cognito
  ignored its `aud` override. With a check that accepts a listed
  `client_id` when `aud` is absent, the same token was allowed with the
  reader grant. Deploy 36 s per phase, destroy 61 s.
- So the vendor IdP needs the V3 trigger for `role`, and the control plane
  needs a new input: a list of client ids accepted in place of `aud` when
  a token has none. That is a control-plane change with its own
  control-plane ADR; this sample does not work around it. This record is
  accepted once that ADR is.
- Follow-up: rotate the client secret, and log token fetch failures apart
  from placement refusals.
- Revisit when the control plane offers a grant narrower than all reads
  (the registrar uses two of ten), or reads scoped to one application.
