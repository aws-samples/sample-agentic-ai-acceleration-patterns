<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0068: Trust the connector operator role without a source account condition

- Status: Accepted
- Date: 2026-11-20
- Amends: ADR-0042
- Deciders: Dave Roberts (Partner Solutions Architect)

## Context

ADR-0042 has the `microvm` backend's two service roles trust
`lambda.amazonaws.com` only for calls from this account (`aws:SourceAccount`).
A smoke run deployed the connector with that condition. Four later
deployments in one non-production account and Region, of the integration
stack and of a `microvm`-only stack, all failed at `AWS::Lambda::NetworkConnector`
with "The service is unable to assume the provided NetworkConnectorOperatorRole.
Please verify the trust policy on the role." The failure comes about one second
after the connector starts, and the role and its policy were already complete.
CloudTrail shows no `AssumeRole` call for the operator role at that time.

A controlled test deployed one connector per trust policy, in the default VPC,
with the same service principal and action:

| Trust | Policy | Result |
|---|---|---|
| `lambda.amazonaws.com`, no condition | AWS managed `AWSLambdaNetworkConnectorOperatorPolicy` | created (253 s) |
| `lambda.amazonaws.com`, `aws:SourceAccount` | the same managed policy | refused, as above |
| `lambda.amazonaws.com`, `aws:SourceAccount` | the sample's inline policy | refused, as above |

The trust condition is the only difference between the refused and the created
connector. The service no longer accepts it on this role.

## Options considered

### Option 1: Drop the condition on the connector operator role
Pros: the connector deploys; the trust matches the role AWS SAM generates for a
network connector, which trusts the `lambda.amazonaws.com` service principal and
nothing else ([SAM generated resources](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/sam-specification-generated-resources-networkconnector.html)). The
role can still only create network interfaces in the sandbox subnets with the
connector security group, and tag interfaces the connector service manages.
Cons: the trust no longer limits the caller to this account. The service
assumes the role only when a principal passes it, and passing a role needs
`iam:PassRole` in this account, so another account cannot cause the assumption.

### Option 2: Keep the condition and wait for the service to accept it
Pros: the trust stays as ADR-0042 wrote it. Cons: the `microvm` backend cannot
be deployed until then, and nothing says it will change.

### Option 3: Replace it with `aws:SourceArn`
Pros: a narrower trust if it worked. Cons: the service's source ARN is not
documented (ADR-0042), and it is untested, so a guess could fail the same way.

## Decision

The decision is Option 1, for the connector operator role only. The image build role keeps the
condition of ADR-0042: a `microvm`-only deployment with this change built the image with it
in about 2 minutes. A unit test pins the trust of the operator role to the
service principal and `sts:AssumeRole`.

## Consequences

The connector operator role is trusted by the Lambda service for any caller
that can pass it; the permission policy (ENI creation in the named subnets and
security group, tagging of managed interfaces) and the `iam:PassRole` boundary
are the controls. A principal in this account with broad `iam:PassRole` could
attach the role to another connector; its rights stay limited to network
interfaces. Revisit when the service documents a source ARN or accepts
`aws:SourceAccount` again.
