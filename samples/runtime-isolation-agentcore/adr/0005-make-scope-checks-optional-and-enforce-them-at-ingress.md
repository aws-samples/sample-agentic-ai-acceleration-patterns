<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0005: Make scope checks optional and enforce them at ingress

- Status: Proposed
- Date: 2026-10-26
- Deciders: Dave Roberts (PSA)

## Context
The user asked for JWT scopes as optional access control. Scope checks belong where the token is verified, before a session is touched.

## Options considered
### Option 1: Always require a scope
Cons: forces a scope design on every consumer.
### Option 2: `requiredScopes?: string[]`, checked by the ingress (Lambda authoriser, or interceptor); on `agentcore-gateway` also set as the Gateway authoriser's `allowedScopes`
Pros: off by default (P-4); on Gateway the service checks it before the interceptor runs. Cons: two places express it on the Gateway path; tests cover both.

## Decision
Option 2. All listed scopes must be present (AND).

## Consequences
Easier: consumers opt in. Harder: tenant-identity's scopes are a fixed set (its P-7); the demo uses `tenant-api/read`.
