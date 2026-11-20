<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0036: Test the registry against an in-memory engine with real conditions

- Status: Proposed
- Date: 2026-11-20
- Deciders: Dave Roberts (Partner Solutions Architect)

## Context

The tool, the reaper, the drain and the offboard function rest on
conditional writes (`attribute_not_exists`, `version = :v`, `lastUsedAt <
:end`). A mock that returns canned answers would pass a race test without
evaluating one condition. The unit tests must run in the build, with no AWS
call and no container.

## Options considered

### Option 1: canned `aws-sdk-client-mock` answers
Pros: trivial. Cons: tests the call order, not the conditions.

### Option 2: DynamoDB Local in a container
Pros: the real engine. Cons: the build needs a container runtime and a
pulled image, which a consumer's CI may not have.

### Option 3: a small in-memory engine behind `aws-sdk-client-mock`
Pros: no container; evaluates `ConditionExpression` (`attribute_exists`,
`attribute_not_exists`, comparisons, `AND`, `OR`, `NOT`, parentheses),
`UpdateExpression` `SET` with `+` and `if_not_exists`, name and value
placeholders, `ReturnValues`, and paged scans; it also refuses a reserved word
written bare and a placeholder no expression uses, as DynamoDB's validation does
(the reserved list is a subset); an expression it does not understand throws, so a test cannot pass on a condition nobody ran. Cons: a
second implementation of a subset of DynamoDB, which can differ from the real
engine.

## Decision

Option 3 (`test/dynamo-double.ts`, with its own tests). A hook runs before
each operation so a test makes a rival caller win between a read and a write,
and `Promise.all` of two calls interleaves them at every `await`. The fake
backend (`test/fake-backend.ts`) signs results with the real protocol
functions. A fake clock sleeps by advancing itself.

What the unit tests do not prove, and the integration test must:

- how DynamoDB itself orders concurrent writes, and that the tool tenant role's
  `dynamodb:LeadingKeys` condition admits every call the tool makes;
- that S3 answers 403 for a missing key to a caller without `ListBucket`, as
  `input_not_found` assumes;
- every platform behaviour behind `ready`, `run`, `stop`, `list`, `isAlive`
  and `cleanup`: what "gone" looks like, how long a stop takes, whether a
  listing lags a start;
- the drain's ten-minute bound against a real instance drain.

## Consequences

A change to a condition expression in `src/tool/registry.ts` is a change the
double must understand, or its test fails. The integration test is the check
on the double's idea of DynamoDB.
