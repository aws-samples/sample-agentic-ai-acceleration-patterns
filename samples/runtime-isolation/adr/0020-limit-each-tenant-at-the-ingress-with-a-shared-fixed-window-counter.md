<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0020: Limit each tenant at the ingress with a shared fixed-window counter

- Status: Accepted
- Date: 2026-10-27
- Deciders: Dave Roberts (PSA)

## Context
A scale review on 2026-10-27 found two gaps. The API Gateway stage throttle was hard-coded at 50 requests per second with a burst of 25, shared by every tenant. Nothing limited one tenant's share of model calls. So one tenant could use up the stage, the AgentCore Runtime quotas and the account's Bedrock quota for everyone. The Runtime quotas are 2,500 active sessions outside us-east-1 and us-west-2 (5,000 in those two Regions) and 1,000 TPS on the data plane ([AgentCore quotas](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/bedrock-agentcore-limits.html)).

The limit must hold across the whole ingress fleet, not per Lambda environment, and it must work on both ingresses.

## Options considered
### Option 1: API Gateway usage plans with one API key per tenant
The authoriser returns the tenant's key as the usage identifier. Pros: managed throttling with no extra table. Cons: every tenant needs a key provisioned at onboarding. It works on the `api-gateway` ingress only, and it has no notion of model tokens.
### Option 2: An in-memory limiter in each Lambda environment
Pros: no extra service. Cons: the limit scales with the number of environments, so it is not a per-tenant limit at all.
### Option 3: A DynamoDB fixed-window counter shared by all ingress instances
Pros: one limit per tenant fleet-wide. It works on both ingresses and can also count tokens. Cons: one extra write per request, and a fixed window allows bursts at its boundary.

## Decision
Option 3. The construct prop is `tenantLimits?: { requestsPerMinute?: number; outputTokensPerMinute?: number } | false`. It is on by default.

| Setting | Default | Notes |
|---|---|---|
| `requestsPerMinute` | 60 | `0` turns the request limit off |
| `outputTokensPerMinute` | unset (off) | `api-gateway` only; any other ingress is a synth error, because the interceptor never sees the response |
| `false` | | no table, no limit |

The construct creates one `TenantLimits` table (TableV2). Its key is `PK = TENANT#<tenantId>#<epochMinute>`, with TTL on `expiresAt` (180 s), PITR on and `DESTROY`.

After the token is verified and the body parsed, and before the TVM and the backend, the ingress makes one conditional `UpdateItem`. It adds 1 to `requests`, with the condition that `requests` is below the limit, and that `outputTokens` is below the token limit when one is set. A `ConditionalCheckFailedException` returns HTTP 429 `too many requests` (reason `tenant_rate_limited`). That request makes no STS call, opens no Runtime session and makes no model call. On `api-gateway`, after the stream ends, the ingress adds the output tokens the agent reported.

Only `tvmCallerRole` has `dynamodb:UpdateItem` on the table, and the key comes from the verified `tenant_id` only.

The limiter fails open. A DynamoDB error that is not a limit hit admits the request and logs an error. The limit protects availability, so turning a DynamoDB fault into a full outage would defeat it.

The stage throttle becomes the prop `stageThrottle?: { rateLimit?: number; burstLimit?: number }` (defaults 50 and 25), on `api-gateway` only. It is still shared by all tenants; the per-tenant limit sits in front of it. The demo exposes `--context requestsPerMinute` and `--context outputTokensPerMinute`.

Code: `src/shared/limits.ts`, `src/shared/request.ts`, `src/runtime-isolation.cdk.ts`.

## Consequences
Easier: one tenant can no longer use the shared stage, Runtime or model quota for every tenant. A limited request costs one DynamoDB write and nothing else. The integration test shows the request limit: tenant A is limited while tenant B is served. The output-token limit was checked by hand on 2026-10-27: at 200 tokens per minute tenant A was refused after 233 tokens and tenant B was served.

Harder:
- Every request costs one on-demand DynamoDB write (check current pricing).
- A fixed window lets a tenant make up to twice the limit across two adjacent minutes.
- A stream that starts under the token limit may finish over it; the limit stops the next request.
- The interceptor path has no token limit.
- While DynamoDB is failing, no tenant is limited.

Revisit if exact rates are needed (a sliding window or token bucket), or if per-tenant limits must differ by tier.
