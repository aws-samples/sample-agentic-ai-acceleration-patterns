<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0006: Forward the user token only on opt-in, in a Runtime custom header

- Status: Accepted
- Date: 2026-10-26
- Deciders: Dave Roberts (PSA)

## Context
Delegation is optional. The Runtime is a trusted boundary (delegation patterns article), so passing the user JWT is allowed, but SigV4 owns `Authorization` on the ingress-to-Runtime hop, and the Gateway forbids allowlisting `X-Amzn-*` headers except `X-Amzn-Bedrock-AgentCore-Runtime-Custom-*`.

## Options considered
### Option 1: Always forward
Cons: every agent holds a bearer token it may not need.
### Option 2: Forward on opt-in in `X-Amzn-Bedrock-AgentCore-Runtime-Custom-User-Token`, allowlisted on the Runtime only when on
Pros: off by default; the header is allowed on both paths. Cons: spike V-6 must confirm it arrives.
### Option 3: Forward inside the payload
Cons: mixes credentials with user input the agent parses.

## Decision
Option 2. When `forwardUserToken` is false the header is not in the Runtime's `requestHeaderAllowlist`, so a client cannot inject one either.

## Consequences
Easier: least privilege by default. Harder: the agent must never log the header; a unit test asserts redaction.
