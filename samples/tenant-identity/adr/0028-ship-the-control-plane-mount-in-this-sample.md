# ADR-0028: Ship the control-plane mount as `scripts/control-plane/` in this sample

- Status: Proposed
- Date: 2026-10-26
- Deciders: Dave Roberts (SA)

## Context
The control-plane sample runs vendor-supplied tenant and cell scripts and owns no identity (control-plane ADR-004). Something must call this sample's `CreateTenant` and `DeleteTenant` from those scripts. §11 names the seam ("Control-plane mounting"); the [control-plane mounting spec](../design/control-plane-mounting.spec.md) specifies it.

## Options considered
### Option 1: Scripts in this sample, `scripts/control-plane/`
The sample that knows the platform API ships the calls to it; control-plane stays identity-free (its P-3). The scripts change in the same PR as the API. Con: this sample now documents a CodeBuild runtime as well as a local one.

### Option 2: Scripts in control-plane, beside `sample-tenant/`
One place for every script. Con: control-plane would hold identity-shaped code and change whenever this API does.

### Option 3: A third "composition" sample
Clean ownership of the join. Con: a sample with no pattern of its own, and three samples to keep in step.

## Decision
Option 1. The producer of a capability ships its own mount (spec M-P-2), which also gives later samples a template: each one adds a `scripts/control-plane/` set.

## Consequences
Scripts follow both `scripts/CONVENTIONS.md` files; the conventions here gain a CodeBuild section. The integration test deploys control-plane through its own deploy path (spec §10). Revisit if control-plane grows an exported construct that takes a typed adapter.
