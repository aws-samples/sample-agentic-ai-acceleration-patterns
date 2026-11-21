<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0028: Drive the integration test from a bash driver

- Status: Accepted
- Date: 2026-11-20
- Deciders: Dave Roberts (PSA)

## Context
Spec §10 has 24 steps across two accounts and two Regions. It deploys
the front door, its own control plane, the stand-in agent ingress
(ADR-0024), two cells and the test's roles, and drives the control plane
through about 25 operations. Each operation runs script and hook builds
one at a time, so a run lasts hours. Several steps wait on time rather
than on a resource: route propagation (90 s), a TXT record's TTL, the
sweeper's day boundary and its 15-minute removal run, a WAF rule's
update. Steps 14 and 17 update the stacks under test in the middle of
the run, and step 14 expects one of those updates to fail and roll back.
The teardown of §6.2 is ordered, and three of its parts are API calls
outside CloudFormation.

The control-plane sample's own test uses `@aws-cdk/integ-runner` with
integ-tests-alpha assertions. Its assertion stack for 18 steps in one
account is already close to CloudFormation's limit of 200 outputs and its
1 MB template limit.

The sample standard (§5.2) allows either driver and asks for an ADR when
the test uses the CDK CLI from `scripts/integ.sh`.

## Options considered
### Option 1: integ-runner with integ-tests-alpha
Pros: the standard's default; the runner destroys its stacks in a
`finally` block. Cons: every check is an assertion resource, so 24 steps
would pass CloudFormation's output and template limits, as the control
plane's test nearly does with 18. Waits are polling custom resources with
a 2-minute provider timeout. A stack update that must fail, an update of
a stack under test between steps, and an ordered teardown with API calls
between stack deletes do not fit a deploy-then-destroy runner. Deploy
times per stack are not reported.

### Option 2: a bash driver over CDK apps
`scripts/integ.sh` deploys the stacks of `test/integ.single.ts` or
`test/integ.host.ts` one CDK call per stack, makes the steps' calls with
`curl`, the AWS CLI and the control plane's API, and runs the §6.2
teardown from an `EXIT` trap. Pros: no limit on the number of checks;
waits are plain loops; mid-run stack updates, an expected failed update
and the ordered teardown are ordinary commands; each stack's deploy and
destroy time is recorded; the smoke scripts (`smoke.sh`,
`smoke-domains.sh`) already prove the same helpers live. Cons: the
teardown is the driver's code, so a killed driver leaves stacks, which
`scripts/integ.sh teardown <run id> <mode>` then removes from the run's saved
state; bash is unit tested only through stubs.

## Decision
Option 2. The test's shape, long waits, mid-run updates, one expected
failure and an ordered teardown with API calls, is what a driver script
handles and an assertion stack does not, and Option 1 would not fit
CloudFormation's limits. The CDK apps keep the stacks in code a reader
can copy, and synthesise under cdk-nag in the build.

## Consequences
- `npx projen integ` and `npx projen integ:host` run the driver. The
  driver saves the run's ids (no token, password or key) in `.integ/<run id>/`, so
  `scripts/integ.sh teardown <run id> <mode>` can finish a teardown after
  an interruption.
- Each teardown part is done, skipped or failed. A part is skipped only
  on a not-found answer or when the run's state shows the thing was never
  made; any other error fails it, so a teardown without working
  credentials never reports a clean account. The driver checks its
  credentials before the first part and stops with the resume command
  when they are gone.
- The driver's helpers follow `scripts/CONVENTIONS.md`. Tokens reach
  `curl` on stdin or in 0600 files, and the password and request bodies
  that hold one reach the AWS CLI in 0600 input files.
- Unit tests cover the driver's names, step lists and teardown order, a
  teardown of a run that made nothing, a teardown whose AWS calls fail,
  a teardown and a run whose credentials are gone, a run whose first
  deploy fails, a control plane already in its account, and the demo
  application's scripts and the probe hook against stubs.
  The steps themselves are checked only by a live run.
- Revisit if integ-runner gains ordered multi-stack teardown and checks
  that are not CloudFormation resources.
