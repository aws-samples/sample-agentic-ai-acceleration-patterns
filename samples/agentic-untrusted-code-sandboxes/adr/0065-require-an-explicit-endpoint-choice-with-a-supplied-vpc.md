<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0065: Require an explicit endpoint choice with a supplied VPC

- Status: Proposed
- Date: 2026-11-20
- Amends: ADR-0012
- Deciders: Dave Roberts (Partner Solutions Architect)

## Context

The sandbox endpoints for ECR and CloudWatch Logs are interface endpoints with
private DNS. Private DNS applies to the whole VPC, so in a VPC the vendor
supplies, every other workload that resolves `logs.<region>` or the ECR names
reaches endpoints whose security groups and policies admit only this sample.
Those workloads lose CloudWatch Logs and ECR at deploy time. With
`createEndpoints` defaulting to true, a vendor who only passed `vpc` got this
without asking.

## Options considered

### Option 1: Keep the default of true and document it
Pros: the shortest props. Cons: the damage lands in other workloads, and no
smoke deploy notices, because those create their own VPC.

### Option 2: Default to false with a supplied VPC
Pros: nothing changes in the VPC. Cons: a backend that needs the endpoints then
fails at run time, not at deploy time.

### Option 3: Make `createEndpoints` required with a supplied VPC
Pros: the vendor reads the consequence once and chooses; the failure is at
synth. Cons: one more prop for a vendor who supplies a VPC.

## Decision

Option 3. With a supplied `vpc`, synth fails unless `createEndpoints` is set.
`true` adds the endpoints and the VPC-wide effect (threat T-92); `false` needs
a VPC that already has the spec 3.7 endpoints. With the VPC the construct
creates, the default stays true.

## Consequences

A vendor with a VPC of their own makes a choice and sees the effect in the prop
documentation. Existing callers that pass `vpc` alone must add the prop.
