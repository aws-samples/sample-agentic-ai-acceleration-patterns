<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0045: Bound the transaction token at 10,240 bytes

- Status: Accepted
- Date: 2026-11-04
- Amends: ADR-0041 (its 8,192-byte `scope` bound)
- Deciders: Dave Roberts (PSA)

## Context
ADR-0041 raised the `scope` bound from 4,096 to 8,192 bytes on two pieces of evidence. V-16c (spec §7.2) carried an 8,192-byte `scope` through the tools gateway's `CUSTOM_JWT` authoriser and Policy, in an 11,848-byte token. V-13 (spec §7.1) carried an 8 KB custom header through `InvokeAgentRuntime`. Neither proved that the token a full-size `scope` produces, about 11.8 KB, passes the Runtime: V-16c called the tools gateway directly, and V-13 sent a header of 8 KB, not 11.8 KB. Both ingresses forward the token to the Runtime in `X-Amzn-Bedrock-AgentCore-Runtime-Custom-Transaction-Token`, so that hop sees every token.

Spike V-17 (2026-11-04, spec §7.4) measured both hops on `api-gateway`. The REST API REQUEST authoriser `context` carried 8,192 to 24,000 bytes intact to the integration Lambda, cached and uncached; it is not a header, so the 20,480-byte client header quota does not apply. `InvokeAgentRuntime` caps a custom header value at exactly 10,240 bytes: 10,240 passes, 10,241 is `ValidationException: Header '...' exceeds 10KB size limit`, and 16,000 is HTTP 413 from the front door. The header-allowlist page (https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-header-allowlist.html) documents 4 KB per value. So at the 8,192-byte `scope` bound the mint succeeded, cost a KMS `Sign`, and the Runtime refused the token with a 400.

The unit test `test/shared/mint.test.ts` measured the token: it is about 4/3 of (`scope` plus the other claims) plus the header and the signature. With long but valid claims (a 64-character tenant id, a 32-character agent, four 32-character tools gateways, a UUID `sub` and `kid`, a CDK-length role ARN, an execute-api issuer, RS256 with a 2048-bit key) an empty `scope` gives a 1,542-byte token and a 6,144-byte `scope` a 9,734-byte token, 506 bytes under the cap. A 6,656-byte `scope` would leave about 40 bytes.

## Options considered
### Option 1: Keep the 8,192-byte `scope` bound and let the Runtime refuse
Pros: no change. Cons: a grant between about 6.6 KB and 8 KB passes every check of the sample, costs a KMS `Sign` and a cached token, and then fails at the Runtime with an opaque 400 the ingress reports as an upstream error; the tenant user sees a failure no log names as a grant size.

### Option 2: Bound the encoded token at 10,240 bytes and lower the `scope` bound to the measured figure
`MAX_TOKEN_BYTES` 10,240 in `src/shared/mint.ts`: after signing, a longer token is refused with the existing 502 `grant_too_large`, logged with its length, and never cached. `MAX_SCOPE_BYTES` drops to 6,144 in `src/shared/grant.ts`, so the common overflow is still caught before the KMS call, with 400 bytes or more of headroom for the other claims. Pros: the bound is the one the Runtime enforces, measured on the token itself, so a longer `sub`, `iss` or `aud` cannot slip past the `scope` check; the failure is loud and named before any Runtime call. Cons: a smaller `scope`, so a partial-target grant overflows sooner; a token that fails the second check has cost one `Sign`.

### Option 3: Carry the token outside the header
In the request body, or as a reference the agent exchanges for the token. Rejected. The body is the caller's payload, which the sample forwards unchanged and never parses. A reference is a credential store the ingress would have to write, expire and serve, with an exchange endpoint the agent calls on every token life: the store ADR-0031 chose a signed, stateless token to avoid.

### Option 4: Compress `scope` further
A `cut` claim that names what a user lost instead of what the user holds. Rejected for the reason ADR-0041 gives: with one star permit per target there is no Policy forbid for it to act in, so the per-tool wall would have to read two claims for no gain at Policy.

## Decision
Option 2. `MAX_TOKEN_BYTES` = 10,240 bytes, checked on the encoded token after signing; `MAX_SCOPE_BYTES` = 6,144 bytes (the measured ceiling of about 6,600 rounded down to a multiple of 512), checked before signing. Both refusals are 502 `grant_too_large`. Both constants are exported.

## Consequences
Easier: a token that would fail at the Runtime never leaves the ingress; the refusal names the grant size in the log (`encodedBytes`, `limitBytes`, `scopeBytes`); a change in the claims cannot push a token past the Runtime unnoticed. Harder: the `scope` holds about 600 short names (`crm/t0001`, 9 bytes plus a separator) instead of about 800, so a user cut from one tool in two 300-tool targets (about 5.4 KB) still fits, three (about 8.1 KB) overflow, and one 300-tool target with 24-byte names cut by one tool (299 names, about 7.5 KB) overflows alone; the overflow is a loud 502 `grant_too_large` before any Runtime call, as ADR-0041 intended. The sample depends on the Runtime's enforced 10 KB, above the documented 4 KB: if AWS enforces the documented value, a token over 4 KB fails at the Runtime with a 400, which leaves a `scope` of about 2 KB, and `MAX_TOKEN_BYTES` is the one constant to lower (threat model T-101). Follow-up: doc feedback to AgentCore Runtime that the header-allowlist page says 4 KB per value while the service enforces 10,240 bytes. Revisit if the Runtime documents or changes its header cap, or if the Runtime accepts a token in a place other than a custom header.
