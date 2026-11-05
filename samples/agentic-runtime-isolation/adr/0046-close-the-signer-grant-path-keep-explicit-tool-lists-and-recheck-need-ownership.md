<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0046: Close the signer grant path, keep explicit tool lists explicit, and re-check need ownership at the ingress

- Status: Accepted
- Date: 2026-11-04
- Amends: ADR-0032, ADR-0037
- Deciders: Dave Roberts (PSA)

## Context
The 2026-11-04 review of the implemented sample (design review and security review) found three places where the decisions in ADR-0032 and ADR-0037 left a path open that the sample's guarantees depend on being closed. The fixes were first written as in-place notes on those records; `docs/sample-standard.md` §2.2 keeps an accepted record's text immutable and has `Amended by` name a record, so the three changes are recorded here.

1. Key policy (ADR-0037). ADR-0037 grants `kms:Sign` to the mint role only and `kms:GetPublicKey` to "the JWKS Lambda only". A key policy that lets the account delegate through IAM, or that allows `kms:CreateGrant`, would let an IAM policy or a KMS grant add a signer the key policy never names. The implemented JWKS is not served by a Lambda at request time: it is rendered at deploy from `GetPublicKey` into a mock integration.
2. Grant compression (ADR-0032). The grant `needs ∪ (tools ∩ tenant.tools ∩ user.tools)` is written into `scope`, compressed to `<target>/*` where a whole target is held to stay under the size bound (ADR-0041, ADR-0045). `<target>/*` in `scope` admits every tool of the target at the interceptor and in Policy, so compressing an explicit list that happens to cover today's catalogue would grant a tool added to the catalogue later to an agent, tenant or plan that never named it (threat model T-99).
3. Need ownership (ADR-0032). Synth checks that an agent's `needs` are `<backend>/<action>`. A need rides in `scope` verbatim, so a hand-written registry entry with a need owned by another name (`crm/getaccount`) would read as a tool grant at the tools gateway.

## Options considered
### Option 1: Leave the decisions as written and rely on synth and review
Pros: no change. Cons: each of the three gaps widens a grant or adds a signer without any code of the sample doing it on purpose; a hand-edited registry entry or a later catalogue change is enough.

### Option 2: Close each path where the token or the key is made
Write the key policy in full and deny grants; compress only from wildcards each contributing set held; re-check need ownership when the ingress reads a registry entry. Pros: each check sits on the one path that produces the value it guards, so no consumer has to repeat it. Cons: a few more lines in `signingKey`, `compressTools` and `parseRegistryEntry`; an explicit list of a whole target costs more `scope` bytes than `<target>/*`.

## Decision
Option 2, with three changes. (a) The key policy of every `TokenSigner` key and of `ToolContextKey` gives the account root `kms:PutKeyPolicy` and the other administrative actions but no `kms:Create*`, and denies `kms:CreateGrant` to every principal; `kms:Sign` is granted only in the key policy, to the minting role (the interceptor role for `ToolContextKey`), and `kms:GetPublicKey` to the JWKS renderer and the verifiers. (b) The granted set is compressed to `<target>/*` only for a target that every contributing set held as `<target>/*` itself: `A.tools`, `T.tools` (the tenant row or its plan) and `U.tools` (no cut names a tool of the target); an explicit list stays explicit even when it covers the whole catalogue today. (c) The ingress re-checks need ownership when it reads a registry entry (`parseRegistryEntry` with the backend name), not only at synth; an entry with a need owned by another name is `registry_entry_invalid` (502).

## Consequences
Easier: no IAM policy and no grant can add a signer, so the signers are read from the key policy alone; a tool added to a target reaches only the agents, tenants and plans that hold the target as `<target>/*`; a hand-written registry entry cannot smuggle a tool grant in as a need. Harder: the residual signer path is `kms:PutKeyPolicy`, held by the account's key administrators (the deployer's own privilege, which CloudFormation needs to update the key) and visible in CloudTrail (threat model T-97, M-78); a grant that names every tool of a target one by one uses more of the 6,144-byte `scope` than `<target>/*` (threat model T-99, M-80); a registry entry written by hand must use the backend's own need names. Code: `signingKey` in `src/shared/token-signer.cdk.ts`, `compressTools` in `src/shared/grant.ts`, `parseRegistryEntry` in `src/shared/registry.ts`. Revisit if KMS offers a key policy that removes `PutKeyPolicy` from the account without breaking CloudFormation updates, or if Policy and the interceptor gain a way to bind a wildcard to the catalogue at grant time.
