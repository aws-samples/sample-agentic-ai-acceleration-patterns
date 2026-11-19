<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# Platform stress test: architecture decision records

Decisions for the shared stress contract in `stress/` (see
[`docs/stress-test.spec.md`](../../docs/stress-test.spec.md) §8). Decisions
that change a sample are recorded in that sample's `adr/`.

| Number | Title | Status | Date |
|---|---|---|---|
| [0001](./0001-keep-the-shared-stress-contract-in-a-root-stress-folder.md) | Keep the shared stress contract in a root `stress/` folder | Accepted | 2026-11-18 |
| [0002](./0002-give-the-stress-test-its-own-tenant-identity-deployment.md) | Give the stress test its own tenant-identity deployment | Accepted | 2026-11-18 |
| [0003](./0003-split-the-agents-across-cells.md) | Split the agents across cells | Accepted | 2026-11-18 |
| [0004](./0004-seed-the-large-fleet-once-and-keep-it.md) | Seed the `large` fleet once and keep it | Accepted | 2026-11-18 |
| [0005](./0005-log-one-correlation-header-at-every-hop.md) | Log one correlation header at every hop | Accepted | 2026-11-18 |
| [0006](./0006-deploy-cells-through-a-scoped-cell-bootstrap.md) | Deploy cells in standalone accounts through a scoped cell bootstrap | Proposed | 2026-11-18 |
| [0007](./0007-move-the-stress-driver-and-k6-library-to-stress.md) | Move the stress driver and the k6 library to `stress/` | Accepted | 2026-11-18 |
| [0008](./0008-split-the-k6-library-and-write-the-record-from-handlesummary.md) | Split the k6 library, mirror the repository on the host, and write the record from handleSummary | Accepted | 2026-11-19 |
| [0009](./0009-deploy-the-driver-as-its-own-cdk-app-in-stress.md) | Deploy the driver as its own CDK app in `stress/` | Accepted | 2026-11-19 |

In `samples/control-plane/adr/`:

| Number | Title | Status | Date |
|---|---|---|---|
| [0046](../../samples/control-plane/adr/0046-make-the-concurrent-build-limit-a-prop.md) | Make the concurrent build limit a prop | Proposed | 2026-11-18 |
| [0047](../../samples/control-plane/adr/0047-let-the-cell-account-owner-attach-policies-to-the-cell-role.md) | Let the cell account owner attach policies to the cell role | Proposed | 2026-11-18 |
