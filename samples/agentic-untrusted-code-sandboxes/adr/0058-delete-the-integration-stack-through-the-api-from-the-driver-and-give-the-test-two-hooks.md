<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0058: Delete the integration stack through the API from the driver, and give the test two hooks

- Status: Accepted
- Date: 2026-11-20
- Amends: ADR-0008 (the destroy is the CloudFormation `DeleteStack` call from the driver process, not `cdk destroy` from the script's exit trap; its other decisions stand)
- Deciders: Dave Roberts (Partner Solutions Architect)

## Context

ADR-0008 chose the CDK CLI over `@aws-cdk/integ-runner`: a script deploys the
integration app, a TypeScript driver runs the step table, and the stack is
destroyed from the script's exit trap with `cdk destroy`. The step table has
about 60 checks (28 steps, most of them once per backend), runs scripts
inside sandboxes, waits on clocks, and keeps going after a failed check. The
destroy must run when a step crashes and when the run is stopped. A
`cdk destroy` in an exit trap does not run when the CLI or its wrapper dies
first, and its output is not available to the leftover check that follows.

The run also needs two behaviours no deployment offers: `max-life` shortens
a sandbox's life through the reaper's event, and `failed-start` makes one
tenant's sandbox exit at boot. Threat T-88 names the risk of such switches.

## Options considered

### Option 1: `cdk destroy` from the script's exit trap, as ADR-0008 says
Pros: the same command a consumer runs. Cons: the teardown lives in shell
text, outside the code that records timings and checks leftovers; it is not
run when the wrapper is killed.

### Option 2: `DeleteStack` from the driver's `finally` and signal handlers
Pros: CloudFormation does the same work as the CLI's destroy, so the
`teardown` step still deletes the stack with sandboxes running, which is C-6;
the driver times the delete, reads the failed resources, retries once, and
runs the leftover check in the same process. A short exit trap in the
wrapper (`driver.ts cleanup`) is a second line of defence for a killed
driver. Cons: the deploy and the destroy use two mechanisms (the CLI and the
API).

## Decision

Option 2. `scripts/integ.sh` checks `AWS_REGION` and the tools, runs
`test/integ/driver.ts run`, and from its exit trap `driver.ts cleanup`,
which destroys a stack the last run left. The driver deploys with
`cdk deploy --all --concurrency $INTEG_DEPLOY_CONCURRENCY` (default 2:
parallel stacks that create API Gateway resources hit the account's
control-plane rate limit), runs the steps, and destroys in a `finally` and
from its SIGINT and SIGTERM handlers. It records the deploy and destroy time
of every phase, and keeps the stack's resource ids in a state file outside
the repository so the leftover check looks for exactly what the run owned.
The `integ` projen task runs `scripts/integ.sh`.

The two behaviours are test hooks in run-time code that no construct prop
turns on: the reaper takes `maxLifeSeconds` from its event, and the tool
passes `failAtBoot` to `SandboxBackend.start` for one tenant
(`src/backend.ts` `StartOptions`; `runner/PROTOCOL.md`, "Test hook: a failed
start"). Both apply only when the function's environment has
`RC_INTEG_OVERRIDES` = `1`, which the integration app sets on its own
functions through a raw property override. The names are in `src/env.ts`
(`TEST_HOOK_ENV`, `TEST_HOOK_FIELDS`).

## Consequences

The `integ` task runs `scripts/integ.sh`. The integration test document
gives the one line a person runs to destroy a stack by hand.
A change of the deploy mechanism (for example the CDK toolkit library)
touches `test/integ/deploy.ts` only. The tool and the reaper read the two
hooks and nothing else does. Revisit if the deploy takes the driver past its
own time limits.
