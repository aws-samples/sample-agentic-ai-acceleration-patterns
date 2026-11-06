<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0016: Alarm on PutKeyPolicy through EventBridge, and probe on any 403 or KMS-named error

- Status: Accepted
- Date: 2026-11-06
- Amends: ADR-0002, ADR-0004
- Deciders: Dave Roberts (PSA)

## Context
Two details of the earlier records did not survive contact with the
deployed services.

The `PutKeyPolicy` alarm. ADR-0002 places the residual of the key-policy
binding in `kms:PutKeyPolicy`, which an administrator needs to read a
tenant's documents or add a consumer, and names a CloudTrail metric filter
as the alarm. A metric filter needs a CloudTrail trail that delivers to a
CloudWatch Logs log group the construct would have to know or own; the
construct creates none of its dependencies and an account usually has one
trail, owned elsewhere.

The fail-closed classifier. ADR-0004 runs the through-S3 probe on any 403
or `AccessDenied` at steps 3 to 8. The integration run (§10 steps 8 and
11) showed that S3 surfaces a disabled key as 400
`KMS.DisabledException` and a key pending deletion as 400
`KMS.KMSInvalidStateException`, not 403. A classifier keyed on 403 alone
retries those into the DLQ instead of failing closed, and one keyed on the
KMS code alone would mark a tenant `REVOKED` on a pipeline fault, which
ADR-0004 rules out.

## Options considered
### Option 1 (alarm): CloudTrail to CloudWatch Logs plus a metric filter
Pros: the classic CIS-style alarm. Cons: the construct must be told the
trail's log group, or own a trail; a second trail costs per event.
### Option 2 (alarm): EventBridge rule on the CloudTrail management event, SQS audit queue
Pros: CloudTrail delivers management events to the default bus without a
log group; the rule's `TriggeredRules` metric is the alarm; the queue keeps
each event 14 days for whoever investigates. Cons: needs a trail that
delivers management events to EventBridge, a deployer prerequisite; an
audit queue with no consumer.
### Option 3 (classifier): probe on 403 or a KMS error code, decide by error code
Cons: decides by code, which ADR-0004 rejected.
### Option 4 (classifier): probe on any 403 or any error that names KMS, decide by the probe
Pros: covers the 400 shapes S3 actually returns; a KMS-named error alone
still never marks a tenant `REVOKED`. Cons: a probe on a few more errors.

## Decision
Options 2 and 4. `src/construct/alarms.ts` puts a rule on the default bus
matching `eventSource kms.amazonaws.com`, `eventName PutKeyPolicy`, with an
SSE-SQS audit queue as target and a CloudWatch alarm on the rule's
`TriggeredRules`; the README names the trail as a prerequisite.
`guardS3` (`src/processor/probe.ts`, with `isAccessDenied` and
`isKmsSourced` in `src/shared/errors.ts`) runs the probe on any S3 error
that is a 403, is `AccessDenied`, or whose code or message names KMS
(`kms:` or `KMS.`); only a probe failure sourced in KMS is
`KEY_UNAVAILABLE`, and a probe success or another failure rethrows the
original error.

## Consequences
Easier: the alarm needs no log group and no trail the construct owns; a
disabled or deleted key fails closed within one delivery, as P-5 intends.
Harder: a deployer without a trail delivering management events to
EventBridge gets a silent alarm, which the README and threat model M-25
state; the classifier's trigger depends on S3's error text naming KMS,
which the integration test pins (steps 8, 11). Revisit if S3 returns the
KMS cause as a stable error code, or the account's trail moves to
CloudTrail Lake only.
