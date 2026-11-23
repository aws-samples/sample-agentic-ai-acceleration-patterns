<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0026: Copy the distribution ARN to cell accounts as a plain string

- Status: Accepted
- Date: 2026-11-19
- Deciders: Dave Roberts (PSA)

## Context

A cell's API lets only the edge distribution invoke it, through two
Lambda permissions conditioned on the distribution's ARN (`CellRouteAccess`,
spec §5.2, ADR-0011). A cell stack runs in the cell's account, which
cannot read the edge account's published parameter, so the application's
shared stack copies the ARN to
`/application-plane/applications/<applicationId>/shared/front-door` in
each cell account (§6.4). A cell stack reads that copy at deploy time with
a CloudFormation SSM parameter, which returns the value as a string and
cannot parse JSON.

## Options considered

### Option 1: A JSON document, `{"distributionArn": "..."}`

Pros: room for more fields later. Cons: CloudFormation can only take the
ARN out with `Fn::Split` on `"` and a fixed index, which breaks silently
if a key is added in front of it or the writer orders keys differently.

### Option 2: The ARN as a plain string

Pros: the parameter's value is the `SourceArn` as it is; nothing to
parse. Cons: a second value needs a second parameter.

## Decision

Option 2. The copy exists for one value, and a plain string is the only
form a CloudFormation SSM parameter hands over without parsing. A wrong
value still fails closed: the permissions name an ARN no distribution
has, and the edge gets 403.

## Consequences

- `CellCopyParameter` in `src/shared/contracts.ts` is a string, and
  `CellRouteAccess` uses the parameter value as the `SourceArn`.
- Spec §6.4 states the copy's form.
- A future value a cell needs from the edge gets its own parameter beside
  this one.

Note 2026-11-23: the proof of this record is the `CellRouteAccess` test
that reads the copy as a plain string and uses it as it is
(`test/demo-cell/demo-cell-api.cdk.test.ts`).
