<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0012: Vend tenant-scoped credentials at the ingress and forward them to the backend

- Status: Accepted. Amended by ADR-0018.
- Date: 2026-10-26
- Deciders: Dave Roberts (PSA)

## Context
P-6 keeps the execution role free of tenant data, so a real agent has no way to reach tenant data at all. The usual answer is a token vending machine (TVM): assume a tenant role with a `TenantId` session tag, so IAM, not agent code, is the data wall (ABAC on `${aws:PrincipalTag/TenantId}`). The TVM is optional (P-4). Where it runs and how its credentials reach the agent decide its blast radius.

## Options considered
### Option 1: The agent calls a TVM itself, with the forwarded user token
Pros: credentials never transit the ingress. Cons: the agent must hold `sts:AssumeRole`, so a prompt-injected agent can call the TVM with any tenant it can name unless the TVM re-validates the token; a second JWT verifier inside the microVM; the TVM is a new endpoint to run.
### Option 2: The ingress assumes the tenant role after validating the token and forwards the credentials to the backend
Pros: the tag values come from the same validated claims that build the session id, in the same code path (P-3); the agent holds no `sts:AssumeRole`; no new endpoint. Cons: credentials transit the ingress and the Gateway; a logged header would leak them; a credential lifetime is at least 15 minutes.
### Option 3: The ingress writes the credentials to a store the session reads
Cons: a store keyed by session id becomes the mapping and the boundary; more moving parts than Option 2 with no gain.

## Decision
Option 2. When `tvm` is set, the token-validating ingress Lambda (the API Gateway integration or the Gateway REQUEST interceptor) calls `sts:AssumeRole` on `tvm.role` with `sts:TagSession`, tags `TenantId = tenant_id` always and, when enabled, `UserId = sub` and allowlisted claims (`tvm.claimTags`), `DurationSeconds` 900 to 3600 (role chaining caps at one hour), session name `tenant-<tenant_id>`. How the credentials reach the backend is the backend's concern (ADR-0011): each backend defines one transport, documented in §3. For `agentcore-runtime` it is base64-JSON in `X-Amzn-Bedrock-AgentCore-Runtime-Custom-Tenant-Credentials`, allowlisted on the Runtime like the user token (spike V-6), never in the body. A later backend (a Lambda microVM, for example) would carry them in its own invoke payload or context, with its own logging check (V-7 repeated for that backend). The construct grants the ingress role `sts:AssumeRole` and `sts:TagSession` on `tvm.role`; the deployer owns the role, its trust policy (trust `tvmCallerRole` only, require the `TenantId` request tag, pin `aws:TagKeys` to the expected set) and its ABAC policy. The ingress caches credentials per tag set until two minutes before expiry, with jitter, so STS sees roughly one call per tenant (or per user) per lifetime.

## Consequences
Easier: enforced data isolation with the same claims that isolate the session; one place to audit. Harder: every hop on the backend's transport must not log the credential (for `agentcore-runtime`: API Gateway access logs, the Gateway, the interceptor; threat model); the agent must build its clients from the header per request and never log it; a `tvm.role` whose trust policy allows another caller silently widens the boundary, so the integration test asserts the role refuses the runner's own credentials. Revisit if the Runtime gains a way to receive per-invocation credentials natively.

Amended by ADR-0018: the TVM is no longer optional (always on), `tvm.role` is optional (the construct creates a default model-only role), and the vended credentials also sign the model call, so the credential transport is always present.
