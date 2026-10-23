# ADR-0001: Select the user-pool topology once, at deploy time, by CDK context

- Status: Superseded in part by ADR-0027
- Date: 2026-10-13
- Deciders: Dave Roberts (SA)

## Context
The sample demonstrates three Cognito user-pool topologies behind one
application contract (spec §1, P-1). Something has to decide which topology
a deployment runs. The options differ in who decides, when, and how much
machinery the choice drags into the runtime.

## Options considered
### Option 1: CDK context value `topology`, required, validated at synth
Pros: the decision is explicit in the deploy command and the stack name; synth
fails fast on a typo (P-7); no runtime branching on configuration; the three
stacks can coexist in one account for comparison. Cons: switching topology is a
redeploy, and migrating tenants between topologies is not supported.
### Option 2: Runtime configuration (SSM parameter or environment variable)
Pros: switch without redeploying. Cons: the stack must provision resources for
every topology (a shared pool that `pool-per-tenant` never uses); handlers
read configuration on every cold start; a mis-set parameter silently changes
which strategy provisions tenants and shapes tokens, which is exactly the
failure P-3 guards against.
### Option 3: Three separate samples
Pros: each is smaller. Cons: the point of the sample is the side-by-side
comparison under one contract; three samples would drift and triple the
test surface.

## Decision
Option 1. The topology is a required CDK context value with three accepted
strings; synthesis fails with the accepted values listed if it is missing or
misspelled; the stack name embeds the value (`TenantIdentity-<topology>`).
The decision is immutable for the life of a deployment.

## Consequences
Easier: the integration test deploys all three stacks in parallel and runs the
same scenario against each; a reader sees the topology in the stack name.
Harder: a deployer who picks wrong must delete tenants and redeploy. Revisit
if a real consumer needs mixed topologies in one deployment (some tenants
with their own pool, the rest shared); that would be a fourth topology with
its own provisioner, not a runtime switch.
