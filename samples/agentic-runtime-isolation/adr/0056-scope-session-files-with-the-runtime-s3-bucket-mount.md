<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0056: Scope session files with the Runtime S3 bucket mount, and keep tenant data on vended credentials

- Status: Proposed
- Date: 2026-11-24
- Deciders: Dave Roberts (PSA)

## Context
AgentCore Runtime can mount an Amazon S3 bucket prefix into the microVM through `filesystemConfigurations` and `s3BucketMount` ([documentation](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-filesystem-configurations.html#configure-s3-bucket-mount)). The facts below come from that page and from the [session context keys](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-sessions.html#runtime-session-isolation) section of the sessions page.

- The mount needs platform version V2 (ADR-0050) and is not supported on a runtime that uses a capacity provider (Instances).
- The mount is part of the Runtime's configuration, set on `create-agent-runtime` or `update-agent-runtime`. A mount that fails to come up fails the invocation with HTTP 424. Each mount has a 30-second timeout.
- AgentCore mounts the prefix with Mountpoint for Amazon S3, using the execution role's credentials. The role needs `s3:ListBucket` on the bucket with an `s3:prefix` condition, and `s3:GetObject`, `s3:PutObject`, `s3:AbortMultipartUpload` and `s3:DeleteObject` on the objects under the prefix.
- The prefix can hold the `{runtimeSessionId}` placeholder, which AgentCore replaces with the session id. The page documents no other placeholder, so there is none for a tenant id. The session id must then be 33 to 256 characters, start with a letter or digit, and hold only letters, digits, underscores and hyphens, or the request fails with a `ValidationException`.
- A fixed prefix, or no prefix, gives every session of the Runtime the same files. Mountpoint does not coordinate writes between sessions.
- For a bucket in another account, `s3BucketOwner` is set to the owner's account id, and the bucket policy grants the execution role access.
- On V2, AgentCore adds `aws:AgentCoreRuntimeSourceSid` (the session id) and `aws:AgentCoreRuntimeSourceArn` (the Runtime ARN) to the credentials of each session. A bucket policy can deny the execution role any object outside `sessions/${aws:AgentCoreRuntimeSourceSid}/*`. The deny applies even when the role policy allows the whole bucket. The keys are in the session's credentials, so the condition applies to any S3 call made with them, not only the mount's. The page says the keys show where credentials came from, not that a call ran inside the microVM.
- A client built at import or module scope loads its credentials before the snapshot is taken and so carries no session key. A client for S3 has to be built inside the request handler.

Three parts of this sample meet that feature.

- The Runtime is pooled, and one session is the compute unit (P-2, ADR-0001). The ingress alone chooses the session id (ADR-0002). With `session` off, the id is `s-` plus 52 random base32 characters per request. With it on, the id is `s-<26 base32 characters of sha256(tenant_id|sub)>-<conversationId>`, and `scope: 'tenant'` hashes `tenant_id` only (ADR-0039). Both shapes meet the id rules above (`src/shared/session.ts`: `conversationId` is 16 to 64 of `[A-Za-z0-9]`).
- The execution role holds logs and traces only. Tenant data is reached with credentials the ingress vends for a tenant role, tagged `TenantId` (ADR-0008, ADR-0012, ADR-0018, P-6). ADR-0050 looked at session context keys on the execution role and set them aside because there was no tenant data for them to fence.
- The agent keeps no files between requests today. A deployer who wants session working files, generated reports or a read-only reference set has to bring their own storage path.

The decision is whether the sample offers the mount, and how, as a per-session isolation layer for files. The enforced scope of the mount is the session, not the tenant. Whether a session maps to one tenant depends on the ingress, which is the only party that sets the session id.

## Options considered
### Option 1: No mount (status quo)
Tenant files go through the S3 SDK with the vended tenant credentials, under the tenant role's `${aws:PrincipalTag/TenantId}` condition.
Pros: nothing new; the wall is the tenant, which is the scope the sample promises; the execution role stays free of tenant data. Cons: no file system for tools that expect paths; every deployer builds the prefix layout and the cleanup; nothing separates two conversations of one tenant, because the tenant role covers the whole tenant prefix.

### Option 2: Session-prefix mount with a `SourceSid` bucket policy, tenant bound to the session upstream
Mount `sessions/{runtimeSessionId}/` at a path such as `/mnt/data`. Deny the execution role every object outside `sessions/${aws:AgentCoreRuntimeSourceSid}/*`, in the bucket policy, with the same condition on `s3:ListBucket`. The ingress mints the session id from validated claims (ADR-0002), so the id carries the tenant.
Pros: the file system is a plain path for the agent and its tools; the fence is IAM on the session credentials, so it holds when agent code calls S3 directly and when the agent is prompt-injected; it separates two conversations of one tenant as well as two tenants; no new endpoint, and one Runtime still serves every tenant. Cons: the execution role gains S3 access, a change to ADR-0008 that the policy and a test have to make safe; the scope is the session, so tenant isolation rests on the ingress binding the session to the tenant (here, ADR-0002 with `session` on); with `session` off the prefix is new per request and holds nothing a later request can read; the V2 mount adds a start-up step that can fail with 424; objects stay in the bucket after the session ends, so the deployer owns a lifecycle rule and the teardown has to empty the bucket; Mountpoint does not support in-place edits, appends or renames on a general purpose bucket; S3 cost is not split by tenant principal.

### Option 3: One Runtime per tenant (silo) with a tenant prefix
Create a Runtime per tenant with `prefix: "tenants/<tenant>/"` and a role per Runtime.
Pros: a Runtime boundary and a role per tenant, so the S3 wall needs no session mapping. Cons: it gives up the pooled Runtime the sample demonstrates (one Runtime per agent, `architecture.md`); a V2 create or update builds a snapshot and takes minutes (ADR-0050), so onboarding a tenant is slow; Runtime and role counts grow with tenants; it answers a different question (a tenant that must have its own compute).

### Option 4: Shared fixed-prefix mount for read-only common data
Mount `shared/` for every session with only `s3:GetObject` and `s3:ListBucket` granted.
Pros: simple; fits a reference set that is the same for every tenant; no session or tenant logic. Cons: every session of the Runtime sees every file, so it must never hold tenant data; the sample has to keep write permission off, because Mountpoint does not coordinate writes between sessions.

## Decision
Option 2, as an opt-in module that is off by default, in the way ADR-0013 made session mapping optional. Option 1 stays the path for tenant data, and Option 4 is allowed beside Option 2 for read-only data that is the same for every tenant. The mount becomes a prop on the `agentcore-runtime` backend with the prefix fixed to `sessions/{runtimeSessionId}/`. The construct writes the bucket policy with the `SourceSid` deny on objects and on `s3:ListBucket`, gives the execution role the S3 actions on the session prefix only, and refuses to synthesise when the mount is on and the platform version is not V2 or the backend uses a capacity provider. The agent builds its S3 client inside the request handler, never at module scope. The README and the threat model state that the enforced scope is the session: tenant isolation of mounted files holds only while the ingress derives the session id from validated claims (ADR-0002) and the client cannot set it. With `session.scope: 'tenant'` the prefix is per tenant and conversation, and listing `sessions/s-<26 characters>-` finds a tenant's objects for offboarding; with `'user'` it is per user; with `session` off it holds scratch for one request. Tenant data does not move to the mount: a tool that needs it still reads it with the vended tenant credentials. The ADR stays Proposed until an integration test proves cross-session denial (Consequences), and moves to Accepted when that test passes.

## Consequences
Easier: a deployer gets per-session working files with a path and an IAM fence that holds against agent code, without a store of its own; two conversations of one tenant cannot read each other's files; the offboarding of a tenant is a prefix listing when `scope` is `tenant`. Harder: the execution role is no longer free of S3 permission, so ADR-0008 and P-6 need an amendment that says the role holds access to the session's own files (which, with `scope: 'tenant'`, are that tenant's files) and still reaches no other tenant's data and no tenant data store; the bucket needs a lifecycle rule and an empty-on-destroy step, and teardown time grows by that step; each cold start gains a mount that can fail the call with 424; S3 cost for mounted files is split by session prefix, not by tenant principal (ADR-0018 attributes model cost by principal, and the mount uses the execution role).

Follow-up work:
1. Add an integration step that writes a file in session A, then proves session B cannot list, read, write or delete it, through the mount and through a direct S3 call with the agent's own credentials. It also proves that a client built at module scope is denied.
2. Run the step on V2 and record deploy and destroy time next to the result in `integration-test.md`. Include the bucket's empty-on-destroy time.
3. Add threat-model rows for a session id the ingress does not own (T-11 fail-open case), for a bucket policy missing the deny, and for tenant data written to a shared prefix.
4. Check the pinned `aws-cdk-lib` types `filesystemConfigurations` on `CfnRuntime`, and use a property override if they do not.

Revisit if the service adds a tenant placeholder to the prefix, or exposes tenant tags as session tags that an S3 condition can read (ABAC on the tenant, as with `${aws:PrincipalTag/TenantId}` today). Either would let the tenant, not the session, be the enforced scope and would let Option 2 absorb Option 1 for files. Also revisit if Mountpoint limits (no in-place edit, no append) block the tools that the sample's agents run.
