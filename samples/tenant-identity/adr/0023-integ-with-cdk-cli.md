# ADR-0023: Drive the integration test with the CDK CLI, not integ-runner

- Status: Accepted
- Date: 2026-10-22
- Deciders: Dave Roberts (SA)

## Context
The integration test deploys one stack per topology, runs the spec §10
scenario against all three, and destroys them. The green run on 2026-10-22
took 1,214 s: 394 s deploy and 750 s destroy, with the e2e at 43 s. The
three stacks are independent, but integ-runner 2.205.7 deploys and destroys
a test's stacks one at a time. Its `cdkCommandOptions` pass no
`concurrency` to the toolkit, so the setting cannot be changed from the
test. The integ-tests-alpha assertion stack added a fourth deploy and
destroy, and it holds only a placeholder (ADR-0019).

## Options considered
### Option 1: Keep integ-runner, one test file per topology
Pros: stays on the framework `docs/sample-standard.md` §5.2 names.
Cons: the R-6 parameters are published by one stack only (ADR-0017), and
the scenario runs one jest worker per topology against all three at once,
so three separate tests would each need the others' stacks. integ-runner
runs separate test files in parallel only across Regions or profiles.
### Option 2: The CDK CLI in a script
`cdk deploy --all --concurrency 3`, then the e2e jest suite, then
`cdk destroy --all --concurrency 3 --force` in an exit trap. Pros: the
three stacks deploy and destroy at the same time; no assertion stack; the
destroy runs even when the deploy or the scenario fails. Cons: leaves the
integ-runner workflow (no snapshot, no `--update-on-failed`); the
sample's own script owns the clean-up guarantee.
### Option 3: Keep integ-runner and accept the time
Pros: no change. Cons: every run waits about 15 minutes on stacks that do
not depend on each other.

## Decision
Option 2. `scripts/integ.sh` (the `integ` projen task) synthesises
`test/integ.identity.ts` into its own cloud assembly, deploys, runs the
e2e, and destroys from that same assembly. It still runs in exactly one
Region and fails fast when `AWS_REGION` is unset. The integ-runner and
integ-tests-alpha dependencies are removed.

## Consequences
Easier: deploy and destroy time drop to the slowest stack instead of the
sum of all three, about 20 minutes to under 10 for one run (expected; the
first run under this decision confirms it). No assertion stack, so no
placeholder resource. Harder: the sample leaves integ-runner, the default
driver in `docs/sample-standard.md` §5.2; the standard now allows this CDK
CLI driver for multi-stack tests, with this ADR as its example. A failed destroy leaves stacks that the script names
and tells the operator to destroy again. Revisit if integ-runner gains a
deploy concurrency option.
