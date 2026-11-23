<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0041: Refuse a MicroVM start without the sample's connector, in IAM and in code

- Status: Accepted
- Date: 2026-11-20
- Deciders: Dave Roberts (Partner Solutions Architect)

## Context

A MicroVM run with no egress connector gets the Lambda-managed
`INTERNET_EGRESS` and reaches the internet (S-2). With only the VPC
connector into the dead-end subnet, code reached no internet host, no peer
MicroVM and no interface endpoint. The only difference between a start that
is isolated and one that is not is a missing list entry in the call.
`lambda:PassNetworkConnector` is needed for every connector a start
passes, and for `INTERNET_EGRESS` when the egress list is omitted (S-3).

## Options considered

### Option 1: IAM only
Pros: the platform refuses, whatever the code does. Cons: a mistake shows
only as an `AccessDenied` at run time, and the IAM shape that refuses an
omitted connector was seen in one spike.

### Option 2: Code only
Pros: a clear error before any call. Cons: a code defect or another
function holding the grant could still start an open MicroVM.

### Option 3: Both
Pros: two independent layers; either one alone stops the open start.
Cons: two places to keep in step.

## Decision

Option 3.

- IAM: the tool role holds `lambda:PassNetworkConnector` on the platform's
  `HTTP_INGRESS` connector and on the sample's connector, and on nothing
  else. `INTERNET_EGRESS` is not passable, so a start that omits the
  egress list is refused.
- Code: `MicrovmBackend.start` refuses unless `MICROVM_NETWORK_CONNECTOR_ARN`
  is a network connector ARN (versioned or not) in the image's partition,
  account and Region (the managed connectors carry the account `aws` and are
  refused), and it passes exactly that one connector as
  `egressNetworkConnectors`. It makes no `RunMicrovm` call otherwise.
- The connector's security group has no ingress and no egress, and the
  connector sits in the sandbox subnets, which have no default route
  (spec §3.7).

## Consequences

A deploy that loses the connector variable fails every start with a message
naming the variable, not with an open MicroVM. The code layer is covered by
unit tests. The IAM layer rests on one spike observation (S-3: the connector
is needed for a start that omits the egress list) and on the policy text;
whether the platform refuses an omitted connector in this exact policy shape,
and whether it evaluates the connector's unversioned ARN or a versioned one,
is unverified until a role-limited start runs against a deployed stack. The
integration test step `no-egress` checks the code's reach with the
connector in place. The MicroVM image build still uses `INTERNET_EGRESS`
(ADR-0042); that is a build-time, vendor-owned surface.
