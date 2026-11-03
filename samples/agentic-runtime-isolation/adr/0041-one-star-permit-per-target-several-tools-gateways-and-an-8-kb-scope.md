<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0041: One star permit per target, several tools gateways, and an 8 KB `scope`

- Status: Accepted
- Date: 2026-11-03
- Amends: ADR-0034, ADR-0040
- Deciders: Dave Roberts (PSA)

## Context
The spec raised its scale target to 100s of agents and 1,000s of tools (§1, 2026-11-03). Spike V-16 (§7.2) then measured AgentCore Policy at that scale. A Policy engine's combined Cedar schema is capped at 400 KB, a quota that is not adjustable, and every tool of the Gateways the engine controls counts against it, about 1.2 KB each: one Gateway with one engine holds about 330 tools. A policy statement is capped at 10,000 characters after the Gateway qualifies each action, so a per-tool permit in the V-9 shape holds at most 28 tools; a 300-tool target needs a `<target>/*` permit plus 11 group permits, and each policy takes 2 to 3 minutes to become ACTIVE once the engine holds 15 or more. A `ToolTarget` deploy of 30 to 60 minutes, sequential, is not acceptable. The transaction token's `scope` passed the Gateway authoriser and Policy at 8,192 bytes (V-16c), and the Runtime carried 8 KB (V-13), so the design's 4,096-byte bound is tighter than the platform's. A `cut` claim with forbids worked (V-16b) but needs one forbid per cut tool, 28 per policy, which doubles the policy count and the deploy time. The REQUEST interceptor already runs before Policy and already refuses a tool the token does not grant (V-11, ADR-0040).

## Options considered
### Option 1: Per-tool policies, as ADR-0034 implied
One star permit plus per-tool permits in groups of 28, optionally forbids on a `cut` claim. Pros: Policy enforces and filters `tools/list` at tool grain; a denial names its policy. Cons: 12 to 23 policies per 300-tool target and a 30 to 60 minute deploy; about 40 big targets reach the 1,000-policies-per-engine quota; a tool moved between groups rewrites two policies inside the orphan-policy ordering of ADR-0040.

### Option 2: One star permit per target; the interceptor decides per tool; an optional RESPONSE interceptor filters the list per tool
Policy holds one permit per target: any action in the target when `scope` names `<target>/*` or any `<target>/<tool>`. The REQUEST interceptor keeps the exact per-tool check it already performs. `tools/list` is filtered natively at target grain; a RESPONSE interceptor, off by default, trims each page to the exact tools when a Gateway serves products with partial-target grants. Pros: one policy per target, a deploy of one to three minutes, the native wall and its decision logs kept at target grain, no new claim. Cons: inside a target the user already holds, the per-tool decision at call time is vendor code alone, so an interceptor bug is a per-tool leak within that target; the RESPONSE interceptor is one per Gateway, so it is on or off for every caller of that Gateway, and it costs one Lambda invocation per list page where it is on.

### Option 3: No Policy; REQUEST and RESPONSE interceptors only
Pros: deploys in seconds, no policy lifecycle. Cons: the wall is vendor code alone, which `ARCHITECTURE.md` §3.2 calls filtered isolation; no platform decision logs; every list page is a Lambda invocation; the sample loses the deterministic-authorisation story the AgentCore guidance rests on.

## Decision
Option 2, with two companions. (1) Tools are spread over several tools gateways, one Policy engine each, each under the schema bound: `SharedIngress.toolsGateways` is a list, each entry a named Gateway with its own rate limits and RESPONSE filter switch; a `ToolTarget` names its gateway; an `AgentBackend`'s `tools` resolve to the gateways their targets live on, and the transaction token's `aud` lists `tools-gateway:<name>` for each. The default is one gateway named `default`, so a small deployment reads as before. `ToolTarget` fails synth when its gateway's catalogued tools would exceed a configurable `maxToolsPerGateway`, default 300. (2) The `scope` bound rises from 4,096 to 8,192 bytes; `grant_too_large` stays as the loud failure above it, and the README names the case that reaches it (a user cut from one tool in several large targets). The `cut` claim is not adopted: with per-tool policies gone it buys nothing in Policy.

## Consequences
Easier: a `ToolTarget` deploy is one policy and minutes; the Cedar generator is one template; the policy count is the target count. Harder: the per-tool call decision inside a granted target rests on the REQUEST interceptor, so its unit tests and the integration steps must prove a partial-target grant (a user with `crm/get_account` calling `crm/update_case` is refused) and the threat model records the interceptor as the per-tool wall; the agent holds one MCP client per gateway in `aud`; a tenant's rate-limit budget is per gateway, not shared. Follow-up: spec §3.3 (`toolsGateways`, `maxToolsPerGateway`, `responseFilter`), §3.6 (star permit, 8 KB), §6.2.2 (`aud` list), §6.4 (parameters per gateway), threat model, scaffold. Revisit if the schema quota becomes adjustable, if Policy gains a target-scoped action group that needs no per-tool naming, or if partial-target grants turn out to be common (then the RESPONSE filter becomes the default).
