<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0014: Drive the integration test with the CDK CLI and read test wiring from stack outputs

- Status: Accepted
- Date: 2026-11-06
- Deciders: Dave Roberts (PSA)

## Context
The integration test (spec §10) needs three independent deployments: the
tenant-identity shared pool, the test-aid stack
(`TenantEncryptedIngestionTestAid`) and the demo stack with the test
profile (`TenantEncryptedIngestionInteg`). The pool is a long-lived fixture
of the test account: the test detects a published deployment and reuses
it, deploys it through tenant-identity's own path only when it is absent,
and never destroys it. integ-runner deploys and destroys a test's stacks one
at a time and has no notion of a stack it must reuse but not own.

The steps are driven by `test/integ.ingestion.ts`, a separate process that
runs after the deploy. Besides the published parameters and the public API,
it needs handles on the test's own stacks that a consumer embedding the
construct would read as construct properties in its own CDK code: the
processor and sweep function names, the queue and DLQ URLs and ARNs, the
registry table name, the event bus name, the log group names, the
Contributor Insights rule names, the binding alarm name, the pipeline
timing, the tenant role ARNs and the test-switch parameter name from the
demo stack (`src/demo.cdk.ts:256-277`), and the probe, consumer, scratch
writer, redrive and access-log reader role ARNs, the scratch bucket and key
and the event capture queue from the test-aid stack
(`test/integ/test-aid-stack.ts:191-198`): 25 outputs in all. A separate
process cannot read construct properties. `docs/sample-standard.md` §5.2
says the test uses no stack outputs.

## Options considered
### Option 1: integ-runner with integ-tests-alpha assertions
Pros: the default driver of §5.2; assertions can read construct properties
inside the app. Cons: the steps need two accounts, wait on KMS
propagation, re-issue tokens and run about 73 minutes of stateful
sequence, which `awsApiCall` chains express badly; stacks deploy one at a
time; the reused pool fits no integ-runner concept.
### Option 2: The CDK CLI in `scripts/integ.sh`, driver reads published parameters only
Pros: no outputs. Cons: the construct publishes nothing about its
internals, so the demo stack would have to publish SSM parameters that only
the test reads, which is a stack output by another name and outlives the
test's purpose in every demo deployment.
### Option 3: The CDK CLI in `scripts/integ.sh`, driver reads `--outputs-file`
`cdk deploy --all --concurrency 2 --outputs-file cdk.integ.out/outputs.json`,
then the driver, then `cdk destroy --all --force --concurrency 2` from the
EXIT trap. Pros: the two sample stacks deploy at once; the pool is reused
by a plain lookup; the driver reads the outputs file once
(`test/integ.ingestion.ts:72`, `:1380`). Cons: a deviation from §5.2's
"no stack outputs".

## Decision
Option 3, after tenant-identity ADR-0023, the worked example of the CDK
CLI driver. `scripts/integ.sh` synthesises `test/integ/app.ts` into
`cdk.integ.out/`, deploys with `--outputs-file`, runs the driver with
`INTEG_OUTPUTS` pointing at that file, and destroys from the EXIT trap,
listing what is left. The outputs are test-only wiring of the test's own
stacks: they stand for construct properties (spec §3.4) that a consumer
reads in its own CDK code, and nothing a consumer of a deployed sample
would use is offered only as an output. Everything the composition itself
needs (API URL, bucket, tenant roles, consumer roles, event bus,
access-log bucket) goes through the published parameters under
`/application-plane/shared/ingestion/`, and the driver reads it there.

## Consequences
Easier: one script owns deploy, steps and teardown, and the teardown runs
on failure too; the stateful steps read as plain code in spec §10's order.
Harder: the test deviates from §5.2 "no stack outputs"; the README's
integration-test section names which outputs are test wiring so a reader
does not copy them as the composition contract. The demo stack class
carries the outputs in every deployment, not only the test's; they reveal
resource names, no secrets. Revisit if the driver moves into the CDK app
(assertions reading properties directly) or if integ-runner gains reuse of
a fixture stack and deploy concurrency.
