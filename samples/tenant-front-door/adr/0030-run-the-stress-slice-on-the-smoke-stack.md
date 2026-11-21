<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0030: Run the stress slice on the smoke stack

- Status: Accepted
- Date: 2026-11-21
- Deciders: Dave Roberts (PSA)

## Context
The front door is one slice of the repository's platform stress test
(`docs/stress-test.spec.md` §3.4). In slice mode the slice runs alone: it
needs a front door to measure, a control plane for the registrar to read,
and a cell for the router to send requests to. The real control plane and
its global hooks belong to the platform run. The smoke test
(`test/smoke/smoke.app.ts`) already deploys a stand-in control plane, the
edge operator and global hook roles, and one demo cell around the front
door. The slice also deploys and destroys stacks on a shared account, so
the names it uses must not collide with a front door that someone else
runs there.

## Options considered
### Option 1: The smoke stack, named by a run prefix
`deploy.sh` deploys the smoke stacks and the front door's three stacks
under `STRESS_PREFIX`. The smoke app takes the stack names and the stand-in
hook role's fleet from two contexts, `smokePrefix` and `smokeFleet`, and
the front door app takes its construct id from `stackNamePrefix`, because
the construct id names CloudFront policies and other account-wide
resources. Pros: no new stack to maintain, the smoke test and the slice
exercise the same stand-ins, and two runs with different prefixes share
neither a stack nor a role. Cons: the registrar reads a stand-in control
plane, so nothing here runs the route hook, the real hooks or the cell
scripts.
### Option 2: A stack of its own in the front door app
Pros: no change to the smoke app. Cons: a second set of stand-ins that
repeats the smoke app's and can drift from it.
### Option 3: Wait for platform mode
Pros: measures the real control plane and hooks. Cons: the route write
rate, the router's compute with large tokens and the refusals that never
reach an origin all concern the front door alone, so the slice can measure
them now.

## Decision
Option 1. A prefix of 1 to 28 letters and digits starting with a letter
names the stacks, the stand-in hook role and the application domain label.
`teardown` destroys every stack of the prefix, so `slice.sh` refuses the
prefixes of the front door's own stacks (`TenantFrontDoor`) and of the
smoke test (`TfdSmoke`), and `deploy.sh` refuses a prefix whose stacks exist
while the host holds no record of a deploy for it in the same account. The
slice declares only Lambda concurrency in its budget, because CloudFront
Functions compute and the API Gateway control plane have no Service Quotas
code. The router's compute utilization goes into the result record under a
key of its own, `quotas.platform.cloudfront-function-compute-utilization-pct`,
which is not a budgeted quota.

## Consequences
- The slice measures the front door against stand-ins. A platform run
  covers the real control plane, hooks and cells in the platform mode of the
  stress test.
- Two front doors in one account need different `stackNamePrefix` values
  and different Regions, because the edge parameter's name is fixed (spec
  §6.4).
- The smoke app gains two optional contexts, and its defaults keep the
  smoke test's names.
- The stand-in control plane's API no longer creates the account's API
  Gateway CloudWatch Logs role, which CDK would retain after the stack is
  deleted. The registrar's stage needs that role for its access logs, so
  the account must hold it before the smoke test or the slice deploys the
  main stack (`aws apigateway update-account`).
- The slice's `collect` writes beyond the contract's late fields: it adds
  the `edge` hop to `latency` and the router's compute reading to
  `quotas.platform` in the records `run` wrote, and writes neither
  `refusals` nor `cost`. That relies on the runner hashing the slice's own
  records after `collect`.
- Revisit when the platform run composes the real control plane, when
  CloudFront Functions compute gets a Service Quotas code, or when the
  contract names the `edge` hop and the compute reading.
