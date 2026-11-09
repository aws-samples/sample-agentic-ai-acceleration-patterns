<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0015: Copy LogDrain and ScopeRegistration from agentic-runtime-isolation

- Status: Accepted
- Date: 2026-11-06
- Deciders: Dave Roberts (PSA)

## Context
Two needs of this sample are already solved in agentic-runtime-isolation.
First, API Gateway and Lambda deliver logs a few seconds after a request;
if CloudFormation deletes a log group first, the late line recreates it
with no retention and outside any stack, so teardown leaves log groups
behind (that sample's ADR-0019, which took the pattern from
tenant-identity). Second, the routes need the scopes `ingestion/deliver`
and `ingestion/read` in tenant-identity's scope catalogue before a token
can carry them (spec §3.2, §6.4); agentic-runtime-isolation registers its
backends' scopes with a custom resource that calls `PUT` and `DELETE
/platform/scopes/{scope}` with SigV4 under tenant-identity's published
`PlatformInvokePolicy` (its ADR-0025). `docs/sample-standard.md` §1.1 and
§5.2 forbid imports from another sample's `src/`: samples share only
constructs and parameters.

## Options considered
### Option 1: Import the two constructs from `../agentic-runtime-isolation/src`
Pros: one copy. Cons: forbidden by the standard; a reader copying this
sample out would get a broken import; the two samples would have to
release together.
### Option 2: Extract a shared package
Pros: one copy, versioned. Cons: the repository has no shared package and
no publishing path; a package for two small constructs is more machinery
than the duplication it saves.
### Option 3: Copy both, say where they came from
Pros: the sample is self-contained; the pattern is the same in three
samples, so one explanation covers them. Cons: a fix in one copy has to be
carried to the others by hand.
### Option 4: Leave both out
Pros: no extra resources. Cons: `cdk destroy` leaks log groups (fails §9
"teardown leaves nothing"); the scopes would be a manual deploy step.

## Decision
Option 3. `src/shared/log-drain.ts` (`LogDrain`) and
`src/shared/scope-registration.cdk.ts` with
`src/shared/scope-registration.function.ts` (`ScopeRegistration`) are
copies of agentic-runtime-isolation's, each with a header naming its
origin; ADR numbers in their comments are that sample's records. The drain waits 90 s on delete between the writers
(the API stage and the functions) and their log groups, and its function's
role holds no permission. The registration registers `ingestion/deliver`
and `ingestion/read` at deploy and removes them on delete, with the
ownership marker of that sample's ADR-0025. Its role holds tenant-identity's
`PlatformInvokePolicy` minus an inline Deny on `execute-api:Invoke` for
every `/platform/tenants*` route, so it reaches the scope catalogue and
nothing that creates, changes or deletes a tenant. The policy's KMS grant on
tenant-identity's admin-password key (`kms:ViaService = ssm`) is inert
here: the function calls no SSM API.

## Consequences
Easier: teardown leaves no log group (§10 step 12 checks it); the scopes
exist before any route is live, with no manual step; the code reads the
same as in the sibling sample. Harder: three copies of each construct now
exist in the repository; a fix to one must be carried to the others; every
destroy waits about 90 s; the registration depends on tenant-identity's API
being up at deploy. Revisit if the repository gains a shared construct
package, or tenant-identity publishes a policy narrowed to the scope routes.
