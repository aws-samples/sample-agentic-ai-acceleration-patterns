<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0040: Apply the spike findings to the tools gateway and the transaction token

- Status: Accepted
- Date: 2026-11-02
- Amends: ADR-0031, ADR-0034, ADR-0038
- Amended by: ADR-0041
- Deciders: Dave Roberts (PSA)

## Context
Spikes V-8 to V-15 (spec §7.1, 2026-11-02, eu-central-1) proved the v2 shape and found seven things the design had assumed differently. The REQUEST interceptor runs before AgentCore Policy, not after. A policy left behind when its target is deleted stops `tools/list` filtering for every caller within about 60 s, while `tools/call` stays denied. The default quota is 100 targets per Gateway; a policy takes 54 to 90 s to become active once the engine holds 50 or more, and 53 of 98 policies created in parallel failed. The Gateway's vended application log records the request body after the interceptor (so the signed `_ri_ctx`) and every tool result. The Gateway refuses a bad signature, `aud`, `iss` or `exp` with 403 `insufficient_scope`, not 401, and does not check `typ`. The AgentCore Identity token vault keys a 3LO grant on (`iss`, `sub`) alone, so with ADR-0038 one user's grant would be shared across their tenants. An OBO authorisation server receives the transaction token as `subject_token`, and that token is still a valid tools-gateway bearer for the rest of its life.

## Options considered
### Option 1: Keep the design as specified and document the gaps
Pros: no change to the accepted records. Cons: the orphaned-policy window is a real cross-tenant `tools/list` leak; the shared 3LO grant crosses the tenant boundary; both break P-13 and P-15.

### Option 2: Amend the three records with the operational rules the spike dictates
Interceptor first, Policy second; policy deleted before its target; sequential policy writes with retry; a 100-target cap; application logs off; 403 as the expected refusal; a tenant-qualified `sub` in the transaction token; OBO limited to trusted authorisation servers. Pros: every finding has one owner in code. Cons: `sub` changes shape for the agent and the tools.

### Option 3: Drop AgentCore Policy and enforce at the interceptor only
Pros: no policy lifecycle, no orphan window, no 100-second writes. Cons: the wall becomes vendor code alone (review §4 rejected this); `tools/list` filtering would need a RESPONSE interceptor and a second Lambda per list.

## Decision
Option 2. (1) The interceptor is the first wall: it verifies the token, `typ`, `iss`, `aud`, `act.sub` and the tool against `scope`, refuses with the tenant in its log line, and signs `_ri_ctx` only for an admitted call; Policy is the second wall and the native `tools/list` filter. (2) `ToolTarget` deletes its policy and waits for it to be gone before it deletes the target; it creates policies one at a time with retry, and `SharedIngress` caps a tools gateway at 100 targets. (3) Gateway application-log delivery is off by default; a deployer who turns it on is told it holds tool arguments, signed contexts and tool results. (4) The spec's §5.4 and the tests expect 403 for a refused token at the Gateway. (5) The transaction token's `sub` is `<tenant_id>#<sub>`; a `user` claim carries the identity provider's `sub` for logs and the session prefix, and the agent and tools read the user from `user`, never by splitting `sub`. (6) OBO credential providers are configured only for authorisation servers the vendor trusts, and the README says why. (7) A tools gateway with a 3LO target lists MCP `2025-11-25` in `supportedVersions`.

## Consequences
Easier: no orphan window, no cross-tenant 3LO grant, one refusal path per layer. Harder: `sub` is no longer the identity provider's value, so a consumer that joins logs on `sub` must use `user`; the `ToolTarget` custom resource is slower on delete (it waits for the policy) and on create (sequential). Follow-up: threat-model rows for the orphaned policy and the vault key shape; integration steps for policy-before-target delete and for `sub` qualification; the README's quotas table. Revisit if Policy gains a target-scoped lifecycle, if the vault keys on more than (`iss`, `sub`), or if the Gateway's authoriser starts checking `typ`.

**2026-11-03.** Amended by ADR-0041: the `scope` bound rises to 8,192 bytes; the policy-lifecycle rules now apply to one policy per target.
