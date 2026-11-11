<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0010: Drive the integration test with the CDK CLI

- Status: Accepted
- Date: 2026-11-10
- Deciders: Daniel Wirjo (Solutions Architect)

## Context

The integration test must sign in synthetic users, call the Gateway with
their access tokens, wait for asynchronous extraction, and change the
deployed fence and Policy engine briefly for the re-tests. integ-runner runs
assertions as CloudFormation custom resources, whose inputs and outputs are
stored in the stack: passwords and bearer tokens would pass through
CloudFormation, and a 15-minute extraction wait does not fit an assertion
provider well.

## Options considered

### Option 1: integ-runner with `httpApiCall` and `awsApiCall` assertions

Pros: the standard's default driver. Cons: credentials in CloudFormation
data; polling extraction through `waitForAssertions`; re-tests that edit the
deployed stack out of band are awkward to express and to undo.

### Option 2: The CDK CLI in `scripts/integ.sh`

The script deploys the demo stack, runs `test/integ.memory-isolation.ts` with
the AWS SDK and `fetch`, and destroys from an exit trap. Pros: secrets stay
in process memory; ordinary code for waits, re-tests, and their cleanup;
teardown proven resource by resource. Cons: not the default driver.

## Decision

Option 2, the standard's second driver (§5.2). The script refuses to run
without `AWS_REGION`, without an operator-confirmed account
(`TMI_INTEG_ACCOUNT`), or when the demo stack is already deployed, and it
tears down only what it deployed.

## Consequences

The step program is the reference wiring a consumer copies: published
parameter, issuer sign-in, Gateway calls. It leaves no snapshot. A failed
destroy is retried once; anything left is printed and fails the run.
