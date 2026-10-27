<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0003: Provision a disposable validation issuer

- Status: Accepted
- Date: 2026-10-22
- Deciders: Daniel Wirjo (Solutions Architect)

## Context

The initial draft required an existing issuer and manual provisioning. Live
validation needs independently signed tokens and a dedicated environment without
changing any existing tenant resources. This changes the validation dependency,
while retaining the architecture and explicit draft scope of ADR-0002.

## Options considered

### Option 1: Reuse an existing issuer and Memory resource

This avoids provisioning but couples validation to existing entitlements and
risks writing test data into shared resources.

### Option 2: Create dedicated resources through an SDK driver

This exercises the native service APIs with a disposable issuer and scoped
synthetic identities. It keeps setup failures separate from runtime evidence,
but does not meet the repository's CDK and integ-runner contribution standard.

## Decision

Use a single-Region SDK driver for the live validation requested for the draft.
Cognito's V2 pre-token trigger adds fixed scopes for three administrator-created
test identities. The fixture ignores editable attributes and caller metadata.
Gateway uses JWT authentication and ENFORCE throughout. Persist only resource
identifiers in ignored state; keep passwords and tokens in process memory.
Create the Gateway without an MCP-only protocol setting. During creation, use
account-and-Region-scoped bootstrap permissions for Policy evaluation, then
narrow those permissions and role trust to the returned Gateway and engine
ARNs before adding the Memory target.

## Consequences

The draft can exercise setup, JWT mapping, authorization, extraction, and teardown
without pre-existing dependencies. The driver removes only journalled resources
and supports resumed cleanup after interruption. Production membership logic and
the complete CDK/projen/integ-runner implementation remain separate work.
