<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0019: Teardown leaves no log group: own the execution log group and drain late logs

- Status: Proposed
- Date: 2026-10-27
- Deciders: Dave Roberts (PSA)

## Context
The first integration run (2026-10-27, sandbox account, eu-central-1) destroyed cleanly in CloudFormation but left four log groups behind, three with no retention:

- `API-Gateway-Execution-Logs_<apiId>/prod`, one per `api-gateway` stack. With `loggingLevel: INFO`, API Gateway creates this group itself, outside the stack.
- The access log group of one stack. CloudFormation deleted it, then API Gateway delivered a few seconds of buffered logs and recreated it.

tenant-identity met the same two problems and solved them with an owned execution log group and a `LogDrain` custom resource (its ADR-0019, ADR-0024). The Lambda log groups on this path have the same exposure: their callers (the API stage, the Gateway) can invoke them until they are deleted, and Lambda delivers logs late too.

## Options considered
### Option 1: Delete leftovers in the integration script
Pros: no construct change. Cons: a deployer running `cdk destroy` still leaks groups with no retention; the script hides a construct defect.
### Option 2: Turn execution logging off
Pros: no execution group. Cons: loses the stage's error detail; the access-log recreation remains.
### Option 3: Own the execution group and add one drain per ingress (tenant-identity's pattern)
Pros: `cdk destroy` leaves nothing; the same pattern as tenant-identity, so one explanation covers both samples. Cons: every destroy waits about 90 seconds; one extra function per stack, which has no permissions and writes no logs.

## Decision
Option 3. The construct owns `API-Gateway-Execution-Logs_<apiId>/prod`. One `LogDrain` per ingress waits 90 seconds on delete between the writer and the log groups it writes to:

| Ingress | Writer | Protected log groups |
|---|---|---|
| `api-gateway` | the API stage | access, execution, authoriser function, ingress function |
| `agentcore-gateway` | the Gateway | interceptor function |

`LogDrain` is copied from tenant-identity (`src/shared/log-drain.ts`), not imported: samples share only constructs and parameters (Sample Standard §1.1). The Runtime's own log groups under `/aws/bedrock-agentcore/runtimes/<runtimeId>-*` are created by the service and named after a runtime id known only after deploy; the integration test deletes them after destroy, and the README tells a deployer to do the same.

## Consequences
Easier: a destroy leaves no orphaned log group from the ingress path; the integration test's leftover check passes without special cases. Harder: about 90 seconds more per destroy; a new caller of an ingress function must be added as a drain writer. Revisit if the Runtime gains a log-group setting or the drain's wait proves too short.
