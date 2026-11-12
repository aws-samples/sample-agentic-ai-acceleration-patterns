# ADR-0041: Run the build tasks in JSONata

- Status: Accepted
- Date: 2026-11-12
- Deciders: Dave Roberts (SA)

## Context
ADR-0039 and ADR-0040 pass each build its resolved parameter set as one `PARAM_<NAME>` CodeBuild environment variable per entry. The names are known only at accept time, so the build task must append a variable list built from a map in the execution input to its fixed variables. Spec §8.1 also caps every state's payload at 256 KiB: a build task keeps only the build ARN and status in state, on success and, because `ResultSelector` does not reach it, on the failure path, where the `.sync` task's error `Cause` is the whole `Build` JSON with every environment value in it. The state machine is written in JSONPath. JSONPath has no intrinsic that concatenates two arrays, and a JSONPath `Catch` can only place the whole error object at a `ResultPath`; it cannot drop the `Cause`.

## Options considered
### Option 1: The build tasks in JSONata, the rest of the machine in JSONPath
Each `startBuild.sync` task sets `QueryLanguage: JSONata`. `EnvironmentVariablesOverride` is `$append` of the fixed variables and `$each` over the phase's parameter map; the task `Output` merges the input with `{Build: {Arn, BuildStatus}}`; the Catch `Output` keeps `error.Error` and, when the Cause parses as a Build, `failure.{buildArn, buildStatus}`. Pros: one state per build, as today; the terminal writes keep their paths (`$.tenantBuildResult.Build.Arn`); the raw Cause never enters state. Cons: two query languages in one machine; the task's `Output` does the job the spec calls a `ResultSelector`; CDK's `CustomState` takes no `queryLanguage`, so a small subclass sets it.

### Option 2: The service sends the whole `EnvironmentVariablesOverride` list
The service resolves the full list, fixed variables included, into the execution input. Pros: the tasks stay JSONPath. Cons: the variable contract moves from the workflow into the service; the input grows by the fixed variables' JSON; the failure path still cannot drop the Cause, so the payload budget is not met.

### Option 3: The whole machine in JSONata
Pros: one language. Cons: rewrites every state, the terminal-write transactions included, for a change that only needs the build tasks.

## Decision
Option 1. It is the only option that meets both the environment contract (§6.1) and the failure-path payload rule (§8.1) without moving the variable contract into the service, and it confines the change to the four build task states. The task `Output` is the `ResultSelector` §8.1 asks for: it keeps exactly the build ARN and status.

## Consequences
The four `RunTenantBuild*` / `RunCellBuild*` states are JSONata; every other state stays JSONPath and reads the same fields as before. The JSONPath evidence chain that parsed `$.error.Cause` in state is replaced by a single Choice on `$.failure.buildArn`. The unit tests evaluate the synthesized expressions with the `jsonata` package (a dev dependency), registering `$parse`, which Step Functions adds to JSONata. Revisit if CDK's `CustomState` gains a `queryLanguage` prop (drop the subclass) or if the machine moves to JSONata as a whole.
