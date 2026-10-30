<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0013: Make session mapping an optional module; a fresh unit per request by default

- Status: Accepted
- Date: 2026-10-26
- Amended by: ADR-0024
- Deciders: Dave Roberts (PSA)

## Context
The sample set out as "runtime isolation with session mapping". The core of the pattern, a backend that trusts one ingress which chooses the isolation unit from validated claims (ADR-0001), does not need sessions at all. Session mapping adds conversation state that survives across requests, and with it the need to prove a user can resume only their own session (ADR-0002). A later backend such as Lambda may have no session concept. Scope checks, delegation and the TVM are already optional modules (P-4); session mapping was the one behaviour baked in.

## Options considered
### Option 1: Session mapping always on
Pros: one code path; matches the builder.aws.com Figure 3 pattern exactly. Cons: ties the pattern to backends with sessions; the construct cannot express the strictest setting, nothing shared between requests; stateless agents pay for a session concept they do not use.
### Option 2: Session mapping as an optional `session` module, off by default
Pros: the core stays backend-neutral; off means a random unit id per request and no state between requests, which is the strictest setting and so the right default under P-4; on gives ADR-0002 unchanged. Cons: two unit-id code paths in the shared unit module; the request body differs (`conversationId` only with `session`).
### Option 3: Session mapping as a separate sample
Cons: a second sample for one prop's worth of behaviour; the ingress, resource policy and tests would be duplicated.

## Decision
Option 2. `IsolatedRuntime` takes an optional `session: { scope?: 'user' | 'tenant' }`. Without it the ingress generates `s-` plus base32 of 32 random bytes per request and rejects a `conversationId` in the body (400). With it ADR-0002 applies. In both modes the ingress overwrites any unit id the client sent (spike V-3). The sample's title is "Runtime Isolation"; session mapping is one of its modules.

## Consequences
Easier: the pattern reads as what it is, enforced mapping of a caller to an isolated unit, and a backend without sessions can be added without changing the core. The default deployment is stateless and the simplest to reason about. Harder: the integration suite runs step 4 in both modes (4a without `session`, 4b and 5 with it), and the README must say plainly that conversation memory needs `session`.

Amended by ADR-0024 (2026-10-28): `IsolatedRuntime` is replaced by `SharedIngress` (the ingress alone) plus one `AgentBackend` per Runtime; the optional `session` module is a `SharedIngress` option and applies to every backend behind that ingress.
