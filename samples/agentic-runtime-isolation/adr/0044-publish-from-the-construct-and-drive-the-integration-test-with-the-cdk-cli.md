<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0044: Publish from the construct, and drive the integration test with the CDK CLI over stack outputs

- Status: Accepted
- Date: 2026-11-04
- Deciders: Dave Roberts (PSA)

## Context
The 2026-11-04 review of the implemented sample compared it with `docs/sample-standard.md` and found three places where the sample does something the standard says otherwise, none of them recorded as a decision.

1. Standard §1.1 and §4.5 say the demo stack, never the construct, writes the published parameters; the construct exposes read-only properties and the demo stack publishes them. `SharedIngress` writes `<registryPrefix>ingress` itself (`publish`, default `true`, ADR-0042).
2. Standard §5.2 names `@aws-cdk/integ-runner` as the default driver and allows the CDK CLI in `scripts/integ.sh` for a test of several independent stacks, recorded in an ADR (tenant-identity ADR-0023 is the worked example). This sample's driver is `scripts/integ.sh` over the CDK CLI: six stacks of one app (`test/integ.runtime.ts`) deployed with `cdk deploy --all --concurrency 6` and destroyed with `--force` from an exit trap, and no ADR said so.
3. Standard §5.2 says the integration test, as the reference implementation, uses no stack outputs. The driver reads them with `--outputs-file`: `EntitlementsTableName`, `EntitlementsApiUrl`, `BillingRuntimeArn`, `MintFunctionName`, `CrmFunctionName`, `ResponseFilterFunctionName`, `PolicyEngineIdDefault` and others. Since ADR-0042 only the `INTEG_PUBLISHER` stack (`api-gateway` by default) writes the published document, so the other five stacks have no parameter to read; and some values exist only for the test (the test mint function, the forced-error hook of the list filter) and must never be published.

## Options considered
### Deviation 1: who writes the published parameter
#### Option 1a: The demo stack publishes, as the standard says
Pros: the construct writes nothing outside its own resources; matches every other sample. Cons: the document is built from the construct's own members (the ingress role, the issuer, the JWKS URL, the entitlement API, the tools gateways with their roles and Policy engines, the context key id) and its version; a consumer who builds its own ingress from `SharedIngress` would have to rebuild the same document and keep it in step with `fromParameters`, or `AgentBackend` and `ToolTarget` in other stacks could not find the ingress.
#### Option 1b: The construct publishes, behind a `publish` prop
`SharedIngress` writes the one `PublishedIngress` document itself, `publish` default `true`, `false` for a stack that must not hold the fixed-name parameter. Pros: the writer and the reader (`SharedIngress.fromParameters`) live in one construct, so the shape cannot drift; a consumer's own ingress publishes without extra code. Cons: a construct with a fixed-name SSM side effect; two instances in one account and prefix collide at deploy unless one sets `publish: false`.

### Deviation 2: the integration driver
#### Option 2a: integ-runner, one test per stack
Pros: the standard's default. Cons: integ-runner deploys and destroys a test's stacks one at a time, and the six stacks are independent: about 45 minutes become several hours. The steps run across stacks (the `api-gateway` stack publishes, step 19 needs the `multi-tenant` stack beside it, the log sweep reads every stack's log groups), and the teardown is verified by the driver (no stack, parameter, log group, table, Gateway or Policy engine left, a retry at concurrency 2), which integ-runner's destroy does not do. The policy ordering check (each policy deleted before its target, ADR-0040) reads the deleted stacks' events after the destroy, and step 20-cloudtrail reads CloudTrail.
#### Option 2b: The CDK CLI in `scripts/integ.sh`
`cdk deploy --all --concurrency 6 --outputs-file`, the steps, then `cdk destroy --all --force` from an exit trap with one retry at concurrency 2, then the leftover checks; the log sweep runs before the destroy. Pros: the stacks deploy and destroy together; the driver owns the clean-up check the sample promises (ADR-0019); the standard allows it with an ADR. Cons: no snapshot and no `--update-on-failed`; the script is the sample's own code to keep correct.

### Deviation 3: how the driver finds what it tests
#### Option 3a: Every stack publishes, the driver reads the parameters
Pros: the test reads only the published interface. Cons: six stacks writing the same fixed name collide (ADR-0042 option 4 exists for this), and the test-only hooks would have to be published to be found, teaching a consumer to read them.
#### Option 3b: The driver reads stack outputs; one stack publishes
The `INTEG_PUBLISHER` stack writes the document, as a consumer's ingress would, and `fromParameters` is exercised from the demo and the unit tests; every other value the steps need is a stack output of the integration app, never of the demo stack. Pros: no fixed-name collisions; test-only hooks stay out of the published interface. Cons: the integration test is not a pure reference for wiring through parameters, so the README says which values come from outputs and why.

## Decision
1b, 2b and 3b. `SharedIngress` publishes the `PublishedIngress` document itself (`publish`, default `true`); `test/integ.runtime.ts` publishes from the `INTEG_PUBLISHER` stack only (ADR-0042). `scripts/integ.sh` drives the six stacks with the CDK CLI (`--concurrency 6`, `--force`, a destroy from the exit trap retried once at concurrency 2) and reads stack outputs for the values a step needs; those outputs are defined in the integration app only, and the demo stack's own outputs are documented in the README.

## Consequences
Easier: a consumer's own ingress publishes without code of its own; the integration run takes about 45 minutes instead of hours and fails on any leftover resource; test-only hooks never appear in the published interface. Harder: the sample departs from the standard in three named places, so the README, `architecture.md` and spec §8 point here; the construct's fixed-name parameter means a second `SharedIngress` in the same account and prefix sets `publish: false`. Revisit if the standard adopts construct-side publishing, if integ-runner gains a deploy concurrency option and a teardown hook, or if the driver can run its steps from the published document of each stack without colliding names.
