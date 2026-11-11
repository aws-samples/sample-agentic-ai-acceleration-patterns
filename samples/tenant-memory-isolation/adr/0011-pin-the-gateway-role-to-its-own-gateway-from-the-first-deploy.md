<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0011: Pin the Gateway role to its own Gateway from the first deploy

- Status: Accepted
- Date: 2026-11-10
- Deciders: Daniel Wirjo (Solutions Architect)

## Context

The Gateway needs its execution role, with Policy permissions, before it
exists: `CreateGateway` checks them. The SDK driver this sample started from
(ADR-0003) trusted `bedrock-agentcore:<account>:*` and granted
`AuthorizeAction` on `gateway/*` until the Gateway returned its ARN, then
narrowed both. During that window any Gateway in the account could assume
the role, which is the one principal the Memory fence admits (ADR-0004).

## Options considered

### Option 1: Bootstrap wide, then narrow

Pros: exact ARNs in the end state. Cons: a window, and a second update that
CloudFormation would have to sequence with a custom resource.

### Option 2: Name the Gateway, and pin to its name

The construct chooses the Gateway's name; the service appends a 10-character
suffix to form its id. The role trusts the AgentCore service only with
`aws:SourceAccount` and `aws:SourceArn` matching
`gateway/<name>-??????????` or the Policy engine's ARN, and its Policy grants
name the same pattern. Pros: no window; one deploy. Cons: the pattern, not
the exact ARN; it matches only a Gateway with this exact name, and names are
unique in the account and Region.

## Decision

Option 2. `?` matches exactly one character, so the pattern cannot match a
longer Gateway name; agentic-runtime-isolation's tools gateway uses the same
name-pattern technique.

## Consequences

The role is pinned from its first deploy. The live preflight compares the
deployed Gateway's ARN with the pattern. A Gateway renamed by a future
change of the construct's path gets a new role with it.
