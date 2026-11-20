<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0023: Ship a compiled package with a handler tree on the pinned CDK and SDK

- Status: Proposed
- Date: 2026-11-20
- Deciders: Dave Roberts (Partner Solutions Architect)

## Context

ADR-0017 fixes the package shape (compiled `lib/`, two entries, the
producer as an optional peer, a post-compile copy of the handler sources,
`handlerEntry`). It leaves four build choices open: which modules the copy
takes, where the runner lands, which libraries carry the services the
spec names, and whether esbuild is a build or a run-time dependency.

The sibling samples pin `aws-cdk-lib` 2.274.0 and the SDK for JavaScript v3
at 3.1154.0. Checked at those pins:

| Spec piece | `aws-cdk-lib` 2.274.0 | SDK v3 3.1154.0 |
|---|---|---|
| `AWS::Lambda::MicrovmImage`, `AWS::Lambda::NetworkConnector` | L1 `CfnMicrovmImage`, `CfnNetworkConnector`; no L2 | not needed at run time |
| `RunMicrovm`, `GetMicrovm`, `ListMicrovms`, `TerminateMicrovm`, `CreateMicrovmAuthToken` | - | `@aws-sdk/client-lambda-microvms`; `@aws-sdk/client-lambda` has none of them |
| Network connector API | - | `@aws-sdk/client-lambda-core` |
| AgentCore Runtime V2 | L2 `Runtime` in `aws-bedrockagentcore` with `PlatformVersion.V2`, `lifecycleConfiguration` | `@aws-sdk/client-bedrock-agentcore` (`InvokeAgentRuntime`, `StopRuntimeSession`) |
| ECS Managed Instances capacity provider | L2 `ManagedInstancesCapacityProvider` | `@aws-sdk/client-ecs` |
| Task definition `TrustedExecutionConfiguration.IsolationMode` = `ISOLATED_SANDBOX` | not in the L1 or L2 types | - |

## Options considered

### Option 1: Stay on the sibling pins, use L1 classes and one property override
Pros: one CDK version across the repository; every piece exists, typed
except the isolation mode. Cons: one `addPropertyOverride` on the task
definition, which no type checks.

### Option 2: Move to a newer `aws-cdk-lib`
Pros: may type the isolation mode. Cons: diverges from the siblings that
the gateway entry builds against; not verified to help.

## Decision

Option 1.

- The MicroVM image and connector use the typed L1 classes
  `lambda.CfnMicrovmImage` and `lambda.CfnNetworkConnector`. The `nitro`
  task definition sets `TrustedExecutionConfiguration.IsolationMode` with
  `addPropertyOverride`, and a synth test asserts the property.
- Run-time MicroVM calls use `@aws-sdk/client-lambda-microvms`. Nothing at
  run time manages connectors, so `@aws-sdk/client-lambda-core` is not a
  dependency.
- `esbuild` is a run-time dependency of the package: the constructs bundle
  their handlers at the consumer's synth (ADR-0017), and without esbuild
  `NodejsFunction` falls back to Docker.
- The post-compile task `projenrc/copy-handlers.ts` copies every
  `src/**/*.function.ts` and every module it reaches through a relative
  import into `lib/handlers/` at the same path under `src/`, and copies
  `runner/` to `lib/handlers/runner/`. A handler that imports a module
  outside `src/` fails the build. `handlerEntry(path)` resolves a path
  under `src/`; `runnerPath(path)` resolves a path under `runner/`; both
  pick `src/` or `runner/` in the repository and `lib/handlers/` from the
  package, and throw when the target is missing. The entries the
  constructs name are listed once, in `HANDLERS`.
- `aws-cdk-lib` and `constructs` stay plain dependencies, as projen's
  CDK app project writes them, pinned like the siblings'. npm shares one
  copy when the consumer's version satisfies the pin; a consumer on another
  CDK version gets a second copy and construct type mismatches, so the
  README names the pinned version. `cdk-nag` is a dev dependency: only the
  demo app applies it, and the package's `files` leaves the demo app out.
- An app project may not declare peer dependencies through projen, and
  projen rewrites the dependency fields after rendering, so `.projenrc.ts`
  writes `peerDependencies` in a post-synthesis step.

## Consequences

Every backend and the core can use typed L1 or L2 constructs except one
property. If a later `aws-cdk-lib` types the isolation mode, the override
goes and the test stays. The handler tree grows with each new
`*.function.ts` without a change to the copy step. Unit tests check that
every `HANDLERS` entry exists under `lib/handlers/`, that every relative
import there resolves, and that no `.ts` other than a `.d.ts` sits outside
`lib/handlers/`.
