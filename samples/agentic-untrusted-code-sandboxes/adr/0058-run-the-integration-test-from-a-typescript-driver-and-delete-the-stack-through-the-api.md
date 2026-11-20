<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0058: Run the integration test from a TypeScript driver and delete the stack through the API

- Status: Proposed
- Date: 2026-11-20
- Amends: ADR-0008 (the driver is TypeScript, and the destroy goes through the API; its other decisions stand)
- Deciders: Dave Roberts (Partner Solutions Architect)

## Context

ADR-0008 chose the CDK CLI over `@aws-cdk/integ-runner`, so a shell script
deploys the integration app, runs the step table and destroys from an exit
trap. The step table is long (spec §8 lists 28 steps, most of them per
backend), most steps run scripts inside sandboxes, wait on clocks, read
registry rows and logs, and need to keep going after a failed check. The
destroy must run when a step crashes and when the run is stopped, and it
must not depend on a CLI that a wrapper script has to find and call: a
teardown written as shell text is one more thing to keep alive after the
shell is gone.

## Options considered

### Option 1: A bash driver, as `agentic-runtime-isolation` does
Pros: one language with the other samples' scripts. Cons: 28 steps, about
60 units, JSON handling of tool answers, Logs Insights polling and
SigV4 are hard to write and impossible to unit-test in bash; the teardown is
shell text.

### Option 2: A TypeScript driver, with a shell wrapper that only calls it
Pros: the pure parts (step order, result recording, the override guard, the
tool answer reader, SigV4) are unit-tested in the build; assertions record and
continue; the stack delete goes through the CloudFormation API (the same
operation the CLI's destroy performs), so the teardown runs from the driver
process itself.
Cons: the driver deploys with the CLI as a child process, so there are two
mechanisms; it needs ts-node at run time.

## Decision

Option 2. `scripts/integ.sh` checks `AWS_REGION` and the tools, then runs
`test/integ/driver.ts run` and, from its exit trap, `driver.ts cleanup`,
which destroys a stack the last run left. The driver deploys with
`cdk deploy --all --concurrency $INTEG_DEPLOY_CONCURRENCY` (default 2, the
API Gateway control-plane throttle in the testing rules), runs the steps, and
destroys in a `finally` and from its SIGINT and SIGTERM handlers. It records
the deploy and destroy time of every phase in the run record. It keeps the
stack's resource ids in a state file outside the repository, so the leftover
check (ADR-0062) looks for exactly what the run owned.

The run needs two test hooks in run-time code that no deployment turns on:
the reaper takes `maxLifeSeconds` from its event, and the tool passes
`failAtBoot` to `SandboxBackend.start` for one tenant (`src/backend.ts`
`StartOptions`; `runner/PROTOCOL.md`, "Test hook: a failed start"). Both
apply only when the function's environment has `RC_INTEG_OVERRIDES=1`, which
the integration app sets (ADR-0059); the names are in `src/env.ts`
(`TEST_HOOKS`). The `integ` projen task runs `scripts/integ.sh`.

## Consequences

`integration-test.md` gives the one line a person runs to destroy a stack by
hand, and what the exit trap does. The `teardown` step still tests the
consumer's path (C-6): a delete of the stack with sandboxes running. A
change of the deploy mechanism (for example the CDK toolkit library) touches
`test/integ/deploy.ts` only. Revisit if the deploy takes the driver past its
own time limits.
