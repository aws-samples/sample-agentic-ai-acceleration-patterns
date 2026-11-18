# ADR-0046: Make the concurrent build limit a prop

- Status: Proposed
- Date: 2026-11-18
- Amends: ADR-0021 (the build caps of M17)
- Deciders: Dave Roberts (SA)

## Context
Every CodeBuild project the control plane runs (the cell and tenant
projects, and the hook projects of ADR-0044) caps concurrent builds at 5, a
constant in `src/tenant/tenant.sfn.ts` (M17, threat T16): a leaked operator token or a
runaway client cannot fan out into unbounded build cost. A tenant build
takes one to two minutes, so at 5 the control plane onboards about three
tenants a minute. The platform stress test onboards 200 tenants per
`medium` run and seeds 4,000 once at `large` (stress ADR-0004): about 20
hours at 5. A vendor with a large onboarding wave meets the same ceiling.
The account's CodeBuild quota for the projects' compute size,
`BUILD_GENERAL1_SMALL`, defaults to 1 concurrent build and is raised per
account.

## Options considered
### Option 1: A construct prop, `concurrentBuildLimit`, default 5
Pros: the cost guard stays on by default; a deployer raises it on purpose,
in code; one value for every project. Cons: a deployer can set it high and
lose the guard.

### Option 2: Separate limits for the cell and the tenant project
Pros: cell builds (minutes, rarer) and tenant builds (frequent) sized
apart. Cons: two values to explain; no caller needs them apart yet.

### Option 3: Keep the constant; the stress test patches it
Pros: no change to the sample. Cons: a test that runs a modified sample
proves nothing about the sample.

## Decision
Option 1. The control-plane construct takes `concurrentBuildLimit?:
number`, an integer from 1 to 100, default 5, applied to every CodeBuild
project it creates. Synth fails on a value outside that range. Above 20 the
synth prints a warning naming T16 and the account's CodeBuild quota for
`BUILD_GENERAL1_SMALL`, which must hold the value times the number of
projects.

## Consequences
Easier: a deployer, the stress test included, sizes onboarding to its need
without editing the sample. Harder: M17's bound is now the deployer's
value; the threat model states it so, and the README names the quota to
raise. The M17 alarm on more than 20 provisioning executions in five
minutes fires during any large onboarding; it has no action, and the
README says so. The API's stage throttle (M11, 20 rps) still bounds the
`CreateDeployment` rate. Revisit if cell and tenant builds need different
limits.
