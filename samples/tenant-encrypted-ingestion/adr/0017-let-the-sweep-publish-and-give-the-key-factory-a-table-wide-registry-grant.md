<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0017: Let the sweep publish, and give the key factory a table-wide registry grant

- Status: Accepted
- Date: 2026-11-06
- Amends: ADR-0003, ADR-0009
- Deciders: Dave Roberts (PSA)

## Context
Two role grants of the earlier records were narrower than the code they
govern.

The bus. ADR-0009 lets only `processorRole` put events on the delivery
bus. The sweep (spec §8) terminates deliveries too: it rejects abandoned
leases with `DeliveryRejected` and republishes events still owed by rows
marked `statusBucket = OWED` (a terminal row whose event the processor
could not publish). Without a publish path those events are lost, and
consumers never learn that a delivery ended.

The key factory. ADR-0003 limits `keyFactoryRole` to `PutItem` of `KEY`,
`KEYARN#` and `SYSTEM` items. `CreateTenantKey` writes the key row
`CREATING`, then in one transaction the `KEYARN#<keyArn>` item and the
`UpdateItem` to `ACTIVE`, and on a retry reads the `CREATING` row back to
resume. The key row and the `KEYARN#` item sit in different partitions,
and IAM has no sort-key condition key, so a grant limited by item type
cannot be written; the factory also needs `UpdateItem`, `GetItem` and
`ConditionCheckItem`.

## Options considered
### Option 1: Keep the bus processor-only; the sweep invokes the processor to publish
Pros: one publisher. Cons: a second invoke path into the processor for
work that is a single `PutEvents`; the sweep would need
`lambda:InvokeFunction` instead, no narrower.
### Option 2: Exempt `sweepRole` from the bus Deny beside `processorRole`
Pros: the same Deny, one more ARN; what the sweep publishes is the same
allowlisted detail (`src/shared/events.ts`). Cons: one more role can forge
an outcome.
### Option 3: Key factory grant by leading key per item type
Cons: cannot be written: the `KEYARN#` partition key is the key ARN, not
the tenant, and IAM conditions cannot tell the sort keys apart.
### Option 4: Key factory table-wide `PutItem`, `UpdateItem`, `ConditionCheckItem`, `GetItem`, with no attribute Deny
Pros: matches what the code does. Cons: the factory can write any item in
the table, delivery rows included.
### Option 5: Option 4 plus the `keyArn`/`tier` Deny of `platformRole`
Cons: breaks the factory's own flow: its `UpdateItem` to `ACTIVE` names
`keyArn` in its condition, so the Deny would refuse every onboarding.

## Decision
Options 2 and 4. The bus policy (`src/construct/events.ts`) denies
`events:PutEvents` unless `aws:PrincipalArn` is `processorRole` or
`sweepRole`, and `sweepRole` holds `events:PutEvents` on the bus.
`keyFactoryRole` holds `dynamodb:PutItem`, `UpdateItem`,
`ConditionCheckItem` and `GetItem` on the table (`src/construct/roles.ts`,
statement `WriteBindings`), with no `keyArn`/`tier` Deny, because it is
the one writer of the binding: code guards the write with
`attribute_not_exists(keyArn)` and the registry watch (ADR-0010) alarms on
a `MODIFY` that changes `keyArn` or `tier` and on a re-onboarding within 7
days.

## Consequences
Easier: every delivery the sweep terminates and every owed event reaches
consumers; onboarding resumes after a crash. Harder: two roles can publish
an outcome, both of them pipeline roles; compromised key-factory code can
also overwrite delivery rows (status, landed key, counters), which the
stream watch does not see because its filter passes only `SK = KEY` items
(threat model, accepted risk 3). The claim stays as ADR-0003 states it:
tenant-role code cannot touch a binding (enforced), key-factory code can
(detected). Revisit if DynamoDB gains a sort-key condition key, or the
binding moves to its own table.
