<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0010: Declare the Gateway's Runtime target with a typed raw override

- Status: Proposed
- Date: 2026-10-26
- Deciders: Dave Roberts (PSA)

## Context
The CDK L1 `CfnGatewayTarget` lacks `TargetConfiguration.Http` (aws-cdk#37999); CloudFormation supports it.

## Options considered
### Option 1: Custom resource calling `CreateGatewayTarget`
Cons: a Lambda with control-plane rights; drift outside CloudFormation.
### Option 2: `addPropertyOverride('TargetConfiguration', {Http: {AgentcoreRuntime: {...}}})` behind a typed helper with a synth-time assertion on the emitted keys
Pros: plain CloudFormation; a casing error fails the unit test, not the deploy.

## Decision
Option 2, pending spike V-2.

## Consequences
Remove the override when the L1 type lands; the helper's assertion test then fails and points here.
