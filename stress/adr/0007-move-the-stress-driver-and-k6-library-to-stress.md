<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0007: Move the stress driver and the k6 library to `stress/`

- Status: Accepted
- Date: 2026-11-18
- Amended by: ADR-0008, ADR-0009
- Deciders: Dave Roberts (PSA)

## Context
`agentic-runtime-isolation` has the only stress harness: the
`StressDriver` CDK stack (one EC2 host, no inbound rule, SSM Session
Manager), the k6 library (token pool and refresh, SSE parsing, isolation
counters) and the seed, collect, cost and teardown scripts. Its findings
F-7 (first-boot install race) and F-14 (k6 memory at 1,600 VUs) are fixed
in that driver. The platform run needs the same driver for every slice.

## Options considered
### Option 1: Move the driver and the k6 library to `stress/`; the slice keeps its scenarios
Pros: one driver with its fixes for every slice; runtime-isolation's slice
shrinks to its own scenarios S1 to S7. Cons: a move with history; the
runtime-isolation stress plan and scripts README change paths.

### Option 2: Copy them into `stress/` and leave the originals
Pros: no change to runtime-isolation. Cons: two drivers drift; a fix lands
in one.

### Option 3: Each slice brings its own driver
Pros: slices stay independent. Cons: the platform run needs one host that
holds every tenant's tokens; several drivers cannot share a refresh budget
against tenant-identity's `/oauth2/token` throttle.

## Decision
Option 1. `stress/driver/` takes the `StressDriver` stack and its user data;
`stress/k6/` takes `lib.js`. The runtime-isolation slice keeps `seed`,
`collect`, `cost` and the S1 to S7 scenario files as its slice verbs, on top
of the shared library. The move is one commit with `git mv`, so history
follows.

## Consequences
Easier: one driver, one token pool for the platform run, fixes in one
place. Harder: runtime-isolation's stress test depends on `stress/`, which
ADR-0001 allows for test assets only; its stress plan and README are
updated in the same change. Revisit if a slice needs a load shape k6 cannot
produce.

Note 2026-11-19: ADR-0008 splits `lib.js` into a shared core and the sample's
own `probe.js`, so the file's history does not follow a `git mv`. ADR-0009
makes the driver its own CDK app in `stress/driver/`, with a host role that
holds no AWS managed policy.
