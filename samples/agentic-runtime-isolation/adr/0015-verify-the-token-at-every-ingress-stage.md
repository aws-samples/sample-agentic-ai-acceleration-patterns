<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0015: Verify the token at every ingress stage, not only at the gateway

- Status: Accepted
- Date: 2026-10-26
- Amended by: ADR-0023
- Deciders: Dave Roberts (PSA)

## Context
Both gateways verify a JWT themselves: API Gateway through an authoriser, AgentCore Gateway through its `CUSTOM_JWT` inbound authoriser. The Lambda that builds the unit id and vends credentials runs after that check and needs the same claims. Two code paths (API Gateway and the Gateway interceptor) must produce the same result for the same token (ADR-0003).

## Options considered
### Option 1: Trust the gateway's check; read claims from the gateway context only
Pros: one verification. Cons: on AgentCore Gateway the interceptor receives the raw `Authorization` header, not verified claims, so it must parse the token anyway; on API Gateway the claims come from the authoriser's own code. The two ingresses would verify differently.
### Option 2: One shared verifier (jose, JWKS from `identity.discoveryUrl`) run by the Lambda on both ingresses; API Gateway keeps a REQUEST authoriser in front for access-log attribution and early refusal
Pros: identical checks, tests, and error codes on both ingresses; the access log carries `tenantId` from the authoriser context (P-9); a bad token is refused before the streaming Lambda starts. Cons: the token is verified twice on API Gateway (JWKS cached in the execution environment, so the second check is microseconds).
### Option 3: Verify only in the Lambda; no gateway authoriser
Cons: the API Gateway access log cannot carry the tenant (no authoriser context); every bad token starts a streaming invocation.

## Decision
Option 2. The REQUEST authoriser caches results for 60 seconds keyed on the `Authorization` header: a cached Allow is at most 60 seconds stale and the integration Lambda re-verifies `exp` before any invoke, so the cache saves a JWKS check without extending a token's life. API Gateway also validates the request body against a JSON schema per option set (`prompt`, plus a patterned `conversationId` when session mapping is on), so malformed bodies are refused before the Lambda (AwsSolutions-APIG2).

## Consequences
Easier: one verifier, one test suite, one error table for both ingresses. Harder: a change to the token contract (§6.2) touches the verifier and the authoriser's identity expression together. Revisit if AgentCore Gateway passes verified claims to interceptors.

Amended by ADR-0023 (2026-10-27): the REQUEST authoriser's result cache is 5 minutes, not 60 seconds (ADR-0023 item 6); the integration Lambda still re-verifies the token, including `exp`, before any invoke, so a cached Allow never outlives the Lambda's own check.
