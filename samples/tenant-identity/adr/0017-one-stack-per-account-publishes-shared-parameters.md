# ADR-0017: Let only one stack per account and Region publish the shared identity parameters

- Status: Accepted
- Date: 2026-10-21
- Deciders: Dave Roberts (SA)

## Context
R-6 publishes four parameters at fixed names under
`/application-plane/shared/identity/`, so the sample mounts into the
`control-plane` sample's shared namespace. §3.3 and §10 also need all three
topology stacks in one account and Region at once. Two stacks cannot own the
same parameter name: the second stack's create fails.

## Options considered
### Option 1: Put the stack name in the parameter path
Pros: every stack publishes. Cons: breaks the shared namespace R-6 exists
for; a consumer would have to know the topology to find the parameters.
### Option 2: A stack prop that turns publishing off
`publishSharedParameters`, default true. Pros: a normal deployment behaves
as R-6 says; the integration test deploys three stacks with one publisher.
Cons: two of the three test stacks do not exercise publishing.

## Decision
Option 2. A real deployment runs one topology, so the fixed names stay
right for it. The integration test publishes from the
`shared-pool-multi-tenant` stack and asserts the four parameters in its
assertion stack; unit tests cover publishing for every topology and the off
switch. It is a stack prop, not CDK context, so a deployer cannot turn it
off by accident.

## Consequences
Easier: three topologies coexist in one account. Harder: only the unit
tests prove the pool-per-tenant and shared-pool stacks' parameters.
Revisit if two topologies must run side by side outside the test.
