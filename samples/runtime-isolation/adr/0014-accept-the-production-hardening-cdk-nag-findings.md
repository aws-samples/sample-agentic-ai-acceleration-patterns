<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0014: Accept the production-hardening cdk-nag findings in the sample

- Status: Accepted
- Date: 2026-10-26
- Deciders: Dave Roberts (PSA)

## Context
cdk-nag `AwsSolutionsChecks` raises three findings the sample cannot answer by configuration: IAM4 for `AWSLambdaBasicExecutionRole` on every function role, IAM5 for the X-Ray `PutTraceSegments`/`PutTelemetryRecords` wildcard that active tracing needs, and APIG3 for a REST stage without a WAF web ACL. Each is a production-hardening item, not a sample defect, and the standard (§4.3) requires every suppression to cite a record.

## Options considered
### Option 1: Satisfy the rules in the construct
Cons: a bespoke logs policy duplicates the managed one; X-Ray accepts no resource ARN; a WAF web ACL adds cost and a deployer-specific rule set the sample cannot choose.
### Option 2: Drop active tracing and ship a WAF with default rules
Cons: loses per-request traces the README comparison (ADR-0009) relies on; a default WAF is a false sense of coverage.
### Option 3: Acknowledge the three with a reason that cites this record and the README hardening checklist
Pros: honest, consistent with tenant-identity; consumers who apply cdk-nag see the same result.

## Decision
Option 3. The construct's `NagSuppressions` for IAM4, IAM5 (X-Ray only) and APIG3 cite ADR-0014 and threat-model M-19/M-21; the README production hardening checklist lists WAF association as a deployer step.

## Consequences
Easier: the build is nag-clean with the module set fully on. Harder: a deployer who wants WAF adds it outside the construct. Revisit if cdk-nag gains a path to accept the managed logs policy, or if a WAF prop is added to the construct.
