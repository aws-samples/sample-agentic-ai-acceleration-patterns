<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0035: Register tools and agents at deploy with an owner marker, in the store and the registry

- Status: Accepted
- Date: 2026-11-02
- Amends: ADR-0024
- Deciders: Dave Roberts (PSA)

## Context
A tenant may only subscribe to a tool that exists, and a tool added after the ingress deploy must announce itself, as a backend already does through its registry entry (ADR-0024). ADR-0025 solved the same problem for scopes in tenant-identity's catalogue with an ownership marker: claim a name, never overwrite another owner's, and let stacks that share a marker co-own names. ADR-0030 removes that catalogue, but the problem and the mechanism remain, now for `TOOL#<target>/<tool>` rows in the entitlement store and for agents in the registry.

## Options considered
### Option 1: Tool names declared only in the Gateway target
The Gateway is the catalogue; the store holds whatever names a vendor writes. Pros: no extra rows. Cons: the vendor API cannot refuse a typo or a tool that does not exist; the ingress would need Gateway read access at run time to check.

### Option 2: Catalogue rows with an owner marker, written by `ToolTarget`'s custom resource
On create, the custom resource writes one `TOOL#` row per tool with `owner = <StackId>#<LogicalResourceId>` (or a shared owner prop), using a condition that fails when another owner holds the name; on delete it removes only rows it owns. The `AgentBackend` registry entry carries the same marker. Pros: the claim rule of ADR-0025, unchanged in meaning; a conditional write replaces the GET-then-PUT race; the vendor API checks against it. Cons: one more custom resource per tool target; co-owners must still be destroyed together.

### Option 3: Register tools with tenant-identity
Pros: reuses ADR-0025's code. Cons: puts tool entitlement back in the identity provider, which ADR-0030 removed.

## Decision
Option 2. `ToolTarget` registers its tools in the store and `AgentBackend` writes its registry entry, both with the owner marker, both claiming and never overwriting.

## Consequences
Easier: a tenant subscription naming an uncatalogued tool is a 400; a reader sees which stack owns each tool. Harder: deleting a target removes its `TOOL#` rows but leaves tenant rows naming it alone; the grant intersection (ADR-0032) drops the missing tool, and the vendor API reports such names as stale. Draining follows ADR-0024: the registry entry goes to `draining` before removal; the Gateway target is removed after its tools leave the catalogue. Follow-up: a sweep in the vendor API that lists stale tool names per tenant; an integration test that a second stack cannot claim a tool another stack owns. Revisit if the Gateway exposes a cheap catalogue read the vendor API could use instead.
