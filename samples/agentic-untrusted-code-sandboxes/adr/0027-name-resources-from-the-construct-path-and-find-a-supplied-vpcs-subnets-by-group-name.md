<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0027: Name resources from the construct path, and find a supplied VPC's subnets by group name

- Status: Accepted
- Date: 2026-11-20
- Deciders: Dave Roberts (Partner Solutions Architect)

## Context

Spec §5.3 gives every explicitly named resource a name from the construct
path, through one sanitiser per service, with 8 hex characters of a hash,
so two instances in one account and Region never collide. Spec §3.7 and
§6.1 ask a supplied VPC for subnets "tagged `run-code:tier` = `tool` or
`sandbox`". CDK reads subnet tags only for subnets it created in the same
app; for a VPC passed in (`Vpc.fromLookup`, `fromVpcAttributes`) the tags
are not known at synth, so a construct cannot select subnets by tag.

## Options considered

### Option 1: One `nameFor(path, service, suffix)` in `src/names.ts`, and subnet groups named `Tool` and `Sandbox`
Pros: the sanitiser is a pure function with a table of charsets and
lengths, tested for every service; a supplied VPC selects subnets with
`subnetGroupName`, which works for a `Vpc` and for `fromVpcAttributes`
(`privateSubnetNames`, `isolatedSubnetNames`). The construct still puts the
`run-code:tier` tag on the subnets it creates, so the tag is there for
people and for the integration test. Cons: a supplied VPC must name its
subnet groups.

### Option 2: Each backend and each resource builds its own name
Pros: no shared helper. Cons: one charset rule per file, no single test, and
two instances collide in the first backend that forgets the hash.

### Option 3: Select a supplied VPC's subnets by tag with a lookup custom resource
Pros: follows the spec text. Cons: a Lambda and a role to read tags at
deploy time, and the subnet ids it returns cannot be used for the VPC
connector and endpoint subnet properties CDK validates at synth.

## Decision

Option 1. `nameFor` keeps each service's charset, truncates so the whole
name fits the service's length, joins 8 hex characters of SHA-256 over the
path, the service and the suffix, and applies the service's own rules (a
runtime name starts with a letter and holds no `-`; a capacity provider name
never starts with `aws`, `ecs` or `fargate`; an ECR repository name is
lower case). A supplied VPC must have subnet groups named `Tool` and
`Sandbox`; synth fails with a message that says so when either is missing.

## Consequences

The sample never writes a name by hand. The tag in spec §6.1 is a
convention for the integration test, not an input the construct reads. A
vendor with their own VPC renames their subnet groups, or builds a
`fromVpcAttributes` VPC with those names. Revisit if CDK learns to select
by tag.
