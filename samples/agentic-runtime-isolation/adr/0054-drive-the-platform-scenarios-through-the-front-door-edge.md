<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0054: Drive the platform scenarios through the front door's edge

- Status: Accepted
- Date: 2026-11-21
- Amends: ADR-0052
- Deciders: Dave Roberts (PSA)

## Context
ADR-0052 made the sample's stress test a slice of the platform stress contract and left the platform mode for later: in a platform run the control plane deploys the cells, so this slice has nothing of its own to deploy. A platform run needs this slice to do something, because it owns five of the platform scenarios (`docs/stress-test.spec.md` §5.1: PS-2, PS-3, PS-4, PS-6 and PS-8), and the platform has an edge in front of the cells (the front door), the stress identity (`tenant-identity`) and the tenants the control plane onboards. Four choices were not obvious.

1. **What to drive.** The slice's own ingress is not in a platform run. Requests go to the front door's edge, which routes them to the cells' ingress.
2. **Which load shapes.** The platform scenarios have no k6 scripts of their own.
3. **Where the inputs come from.** The edge, the identity and the tenants belong to other slices.
4. **Who attributes a refusal.** The slice's `collect` joins the ingress and authoriser logs to the driver's counts (ADR-0052). In a platform run the edge's and the cells' logs are in other accounts and are not joined.

## Options considered
### Option 1: Reuse the slice's S1, S2, S3, S5 and S6 shapes against the edge, read the other slices' manifests, attribute refusals from the driver's own lines
Pros: one set of load shapes, tested in slice mode; no new k6 script; the slice needs no write access to the cells' accounts; the manifest contract is the only coupling to the other slices. Cons: the records hold the client's latency hops only, with no quota peaks or cost, and PS-3 cannot retire the cells' Lambda instances.

### Option 2: Write new k6 scripts for the platform scenarios
Pros: each script fits the platform's shape. Cons: a second copy of every load shape that goes stale; no comparison with the slice-mode records.

### Option 3: Deploy a cell of this sample's own inside the platform run
Pros: the slice can retire instances and read its own logs. Cons: the platform run measures a cell of this slice's own instead of the cells the control plane built, which is what a platform run is for.

## Decision
Option 1. It keeps one set of load shapes, comparable with slice mode, and needs no access to the cells' accounts; Option 3 would not measure the cells the control plane built, and Option 2 would keep a second copy of every shape.

- **Mapping.** PS-2 sends the S1 shape, PS-3 the S2 shape, PS-4 the S3 shape, PS-6 the S5 shape and PS-8 the S6 shape, to `<edgeUrl>/agents/<agent>/invocations`. The record carries the `PS-<n>` id (`RECORD_SCENARIO`). `S1` to `S7` are refused in platform mode and the `PS-<n>` scenarios in slice mode, so a run cannot mix the two.
- **Inputs.** The slice reads `tenant-front-door.json`, `identity.json`, `tenant-identity.json` and `control-plane.json` from `$STRESS_HOME/$STRESS_PREFIX/` (`stress/README.md`, "Platform mode: manifests") and stops with a message that names the file and the slice that writes it. It drives the control plane's seeded tenants that the identity manifest lists with an admin user, and refuses each other tenant with a reason.
- **The k6 host.** `deploy` deploys `<prefix>-driver` only when none exists and records that it made it; `teardown` removes the host only then. A host that was there is left to its owner.
- **Refusals.** `collect` takes each refusal's tenant and reason from the `edge_refusal` lines the driver prints (`k6/edge-refusals.js`) and leaves the rest `unattributed`, which fails the run (P-7). It does not join the edge's or the cells' logs.

## Consequences
Easier: a platform run exercises the same load shapes as slice mode through the real edge, and this slice needs nothing from the cells' accounts beyond what the front door routes to.

Harder: a platform record has the client's latency hops only, with no ingress latency, quota peaks or cost. PS-3 starts its herd after 60 s idle, so its cold-start share is whatever the instances' age allows. Until something creates the identity tenant and users for the tenants the control plane onboards (spec §3.3, steps 3 and 4), the slice refuses every control-plane tenant and the run fails with the list.

Revisit when: the edge's and the cells' logs can be joined to the driver's counts without write access to the cell accounts, or the platform run creates the identity tenant and users, or a platform run shows the shapes diverging from slice mode.
