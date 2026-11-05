<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0018: Create keys from a dedicated role and never rebind a tenant

- Status: Accepted
- Date: 2026-11-05
- Deciders: Dave Roberts (PSA)

## Context
The binding of a tenant to its key rests on three things every check trusts
together: the registry row's `keyArn`, the key's `TenantId` tag, and the key's
policy. The presigner signs the registry's `keyArn`; the tenant roles'
identity policies admit any key whose `aws:ResourceTag/TenantId` equals the
session's tenant (ADR-0003); the processor's key check compares `HeadObject`
against the same registry row (ADR-0008). If one principal can change all
three, every check passes on a binding it chose.

The second security review showed that one did (G-1). `platformRole` held
`kms:CreateKey`, whose `Policy` parameter is free-form and cannot be
constrained by IAM; `kms:TagResource` on `*`, which the account principal's
statement lets IAM reach on every tenant key; and table-wide `PutItem` and
`UpdateItem`. Compromised or buggy platform code could create a key whose
policy also lets an outside principal `Decrypt`, tag it `TenantId=A`, rewrite
`TENANT#A/KEY.keyArn`, and every new delivery for A would then be encrypted
under a key readable outside the vendor, with no check failing. The same path
could rebind a `tenant-key` tenant to any ARN and skip `CreateTenantKey`'s
probe. KMS warns that `kms:TagResource` alone can grant use of keys
controlled by tag conditions. And `platformRole` is also the role the hourly
sweep and the stack-delete drain ran under, so the code with the widest
schedule held the widest key power. Realises P-1, P-2, P-8 and §3.1, §4.1,
§5.1 `CreateTenantKey`, §6.2, §7.1, §7.2.

## Options considered
### Option 1: One platform role does everything (status quo)
Pros: fewest roles; `CreateTenantKey`, the other platform operations, the
drain and the sweep share one identity policy. Cons: the rebind path above
stays open; a bug in the sweep, which runs hourly and touches every tenant,
has key creation and retagging in reach; the threat model's claim that a
compromised platform role "cannot read a document" is false for future
documents.
### Option 2: A dedicated `keyFactoryRole`, `keyArn` written once, keys tagged once, and a stream watch
Pros: key creation moves to one role that serves `CreateTenantKey` only, and
`platformRole`, the drain and the sweep can neither create nor tag a key.
`kms:CreateKey` is constrained to `kms:KeySpec = SYMMETRIC_DEFAULT`,
`kms:KeyOrigin = AWS_KMS`, `kms:MultiRegion = false`, the tag keys `TenantId`
and `tei:stack`, and a required `TenantId` request tag. A key is tagged once,
at `CreateKey`: `keyFactoryRole` may `TagResource` only a key with no
`TenantId` yet, every other role is denied tagging, and key policy statement
5 denies `TagResource` and `UntagResource` to everyone (ADR-0002). `keyArn`
is written once, by a `PutItem` with `attribute_not_exists(keyArn)`, and
every role's `UpdateItem` is denied when `dynamodb:Attributes` contains
`keyArn` or `tier` (ADR-0011). A DynamoDB stream feeds a watch Lambda that
alarms on any change to `keyArn` or `tier`. Cons: one more role and policy to
read and test; a stream, a Lambda and an alarm to deploy; the constraint on
`CreateKey` still cannot inspect the policy the role passes, so a residual
remains.
### Option 3: Option 2 plus a human approval step on `CreateTenantKey`
Pros: a person reviews each new key before it is bound, which would also
close the residual of Option 2. Cons: onboarding stops being an API call and
the control plane's tenant create script needs a wait state; a reviewer
cannot practically audit a key policy per tenant at 10,000 tenants (N-3);
the approval step is itself a workflow with its own trust; it belongs to the
deployer's control plane, which the sample does not own (§6.4).

## Decision
Option 2 (spec §7.1, §7.2, §4.1). `keyFactoryRole` is the only principal that
creates keys and the only one that writes `keyArn`; it runs `CreateTenantKey`
and nothing else. It holds the constrained `kms:CreateKey`, `kms:TagResource`
only while `aws:ResourceTag/TenantId` is null, `kms:CreateAlias`,
`kms:EnableKeyRotation`, `kms:DescribeKey`, `kms:ScheduleKeyDeletion` (to
undo a failed create), the registry writes for the `KEY`, `KEYARN#` and
`SYSTEM` items, and `sts:AssumeRole` on `tenantPlatformRole` for the probe;
its identity policy explicitly denies `kms:PutKeyPolicy`, `kms:CreateGrant`,
`kms:UntagResource` and every use action. `platformRole` keeps administration
without creation and denies `kms:CreateKey`, `kms:TagResource` and
`kms:UntagResource`; the sweep runs under its own `sweepRole`, which has no
KMS action (ADR-0003). The key policy denies tagging to everyone (ADR-0002
statement 5). `keyArn` is canonical (ADR-0004), written once and never
updated by any role; the registry watch alarms on any `KEY` item whose
`keyArn` or `tier` differs between its old and new stream image. The human
approval of Option 3 is left to the deployer's control plane, and the README
names where it would sit.

## Consequences
Easier: an existing tenant can never be rebound to another key: the registry
refuses the write, the key refuses a new tag, and the alarm fires if either
somehow happens; the sweep and the drain, the code that runs most often
across all tenants, hold no key creation or tagging at all; a template test
asserts the `CreateKey` conditions, the tag-once condition, the tagging
Denies, the `keyArn`/`tier` Deny on every role, and the stream and alarm.
Harder: one more role to read and test, and `CreateTenantKey` runs in a
function of its own; the watch is detective, so it reports a change after the
fact; a vendor that genuinely needs to move a tenant to a new key offboards
and re-onboards it. **Named residual:** a compromised `keyFactoryRole` can
still create a key with a policy it chooses, including one that lets an
outside principal decrypt, and bind a **new** tenant to it, because
`CreateKey` cannot constrain the policy content and a new tenant has no prior
binding to protect. The threat model lists it next to T-14 and T-36 (T-50),
and the deployer's mitigations are CloudTrail, which records every
`CreateKey` with the policy it passed, so a deployer can alarm on a key whose
policy differs from the builder's output, and, where onboarding volume
allows, the approval step of Option 3. Revisit if KMS adds condition keys on key policy content at
`CreateKey`, or if the control plane gains an approval workflow the sample
can call.
