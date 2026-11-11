<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0006: Create the Memory Gateway without an MCP protocol type

- Status: Accepted
- Date: 2026-10-26
- Deciders: Daniel Wirjo (Solutions Architect)

## Context

The native `agentcore-memory` connector is an HTTP target: agents send native
Memory requests to `/{targetName}/memories/...`. `CreateGateway` accepts an
optional `protocolType`. In the live run on 2026-10-26 a Gateway created with
`protocolType: MCP` rejected the Memory HTTP target.

## Options considered

### Option 1: An MCP Gateway with a Memory tool in front

Fits MCP-only agent frameworks, but needs a vendor-built tool that calls
Memory, which replaces the native connector.

### Option 2: A Gateway with no protocol type

Accepts the native HTTP connector; agents call Memory's own API shape through
Gateway.

## Decision

Option 2. The Gateway is created without `protocolType`, and a unit test
fails if the rendered request sets it. The current documentation agrees: the
connector is an `http` target configuration
([setup guide](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/memory-gateway-setup.html)),
and HTTP targets need a Gateway created without `--protocol-type MCP`
([HTTP passthrough targets](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-target-http-passthrough.html)).

## Consequences

This Gateway serves native Memory requests, not MCP tools. A deployment that
also serves MCP tools runs them on a separate MCP Gateway; in particular, the
Memory connector cannot be a target of an existing MCP tools gateway.
