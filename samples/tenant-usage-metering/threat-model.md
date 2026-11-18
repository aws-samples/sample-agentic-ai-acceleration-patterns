<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# Threat model

Status: written from the specification (`design/tenant-usage-metering.spec.md`)
before any code. Every mitigation points at the ADR or specification section
that defines it; the code locations, tests and integration steps are added
when the sample is built, and the security review below is filled in then.

Assets: the usage records a bill is built from, the tenants' raw usage
events, the registry of which cell may report for which tenant, the meter
and sink configuration, and the sink credentials.

Actors: the vendor (operators, the control plane's global hook, the
metering service), emitters in vendor-owned and tenant-owned cell accounts,
vendor accounts that subscribe to the buses, and any other AWS account.

## Threats and mitigations

| Threat | Mitigation | Implemented by |
| --- | --- | --- |
| T-1: A caller forges its identity: names another emitter, cell, application or account in the event body | M-1: The ingest door is IAM-authorised; the function takes identity only from the verified assumed-role ARN and looks up `EMITTER#<account>#<role>`; body fields naming an emitter, cell, application or account are ignored, and the enriched fields are added by the function | ADR-0001; spec P-2, §3.2, §4.8 |
| T-2: A cell reports usage for a tenant it does not hold, in another cell or before or after it held it | M-2: Each event's `tenantId` must have a binding to the caller's cell whose `activeFrom`..`closedAt` (or one of its `intervals`) covers the event's `time`; otherwise `TENANT_NOT_IN_CELL` or `REGISTRATION_CLOSED` | ADR-0001; spec §4.2, §4.3 |
| T-3: A tenant that controls a tenant-owned cell under-reports, or stops reporting, its own usage | Accepted: the sample proves who sent an event and which tenants it may speak for, not that the quantity is true. Production: bill only from emitters the vendor runs, or reconcile reported usage against cost or infrastructure signals the tenant cannot write | spec §1.2 |
| T-4: Code in a pooled cell reports usage for another tenant of the same cell | Accepted: a cell is vendor code and speaks for every tenant it holds. A role per deployment is a seam | spec §1.2; ADR-0001 Consequences |
| T-5: Any AWS account creates a role matching `<fleet>-ue-*` and floods the ingest door | M-5: The function refuses non-assumed-role and unregistered callers with a 403, stores nothing, and logs at most one line per caller per minute; reserved concurrency keeps the rest of the stack running; an alarm fires on the unregistered-caller metric. Residual: a flood can delay real emitters until the vendor blocks the source | spec §3.2, P-8 |
| T-6: An account that holds cells reads other tenants' raw events or counted records from a bus | M-6: Both buses are shared through AWS RAM only with listed vendor accounts; `PutCellEmitter`, in the `CELL_CREATE` `PRE` hook, refuses a cell in a subscriber account or the metering account, and a deploy that adds an account already holding a cell fails | ADR-0006; spec §3.2, §3.4 |
| T-7: A principal other than the control plane registers an emitter or a binding, so a cell may report for tenants it was never given | M-7: Registration operations admit only `registrarPrincipalArns`, which a cell account neither holds nor trusts (the control plane's `<fleet>-global-hook`, control-plane R-41). Residual: every global hook the vendor registers shares that role and so holds the grant; a role per global hook is a control-plane seam | ADR-0001; spec §3.2, §3.4 |
| T-8: A tenant-shaped value (`PARAM_BILLING_ACCOUNT`) runs as code in the hook, or reaches a billing system unchecked | M-8: The hook builds request bodies with `jq --arg` and never interpolates a value into a command line; `PutTenantBinding` refuses a billing account outside `[A-Za-z0-9._:-]{1,128}` | spec §3.4; control-plane §6.5 |
| T-9: A delete hook the control plane skips after its retries leaves a registration `ACTIVE`, so the cell keeps reporting for a deleted tenant | Accepted residual: `ListTenantBindings` and `ListCellEmitters` let an operator compare with the control plane; automatic reconciliation is a seam | spec §1.1, §3.4 |
| T-10: Retries, redrives, re-admission or recounts count an event twice and inflate a bill | M-10: The recount keeps one event per `(applicationId, tenantId, eventId)` with a deterministic winner; the ingest bus also suppresses repeats within five minutes. Residual: an emitter that resends an event with a new `time` in another hour is counted twice; the emitter contract and snippet resend unchanged bytes | ADR-0003; spec P-5, §4.9, §6.1 |
| T-11: One application's emitter suppresses another application's events by reusing their `eventId`s | M-11: The dedupe key includes the `applicationId` of the verified emitter, so ids only collide within one application | ADR-0003; spec P-5 |
| T-12: An accepted event, or a written usage record, is lost on the way, so a tenant is under-billed with no signal | M-12: The ingest subscriber retries for 24 hours into an SQS dead-letter queue with an alarm and `StartIngestRedrive`; ingest admits an event only while its hour has 49 hours of the recount window left; the object tracker's failures go to a replayed queue; the usage table is an outbox swept by the scheduler; every bus reader built with `UsageSubscriber` has a dead-letter queue | ADR-0002, ADR-0006; spec §3.1, §4.5, §4.7, §6.2 promises 7-8 |
| T-13: A total that a billing system already received changes under it | M-13: Records are append-only by `seq`; a recount writes only the difference as an `ADJUSTMENT`; each record has a stable `recordId` for idempotent delivery | ADR-0003; spec P-7, §4.7 |
| T-14: Two recounts of one hour race and write totals from a stale listing | M-14: A lease on the hour; every record write is a transaction with a `ConditionCheck` on the lease, and the final status write checks the hour's `generation`; the execution timeout is below the lease | spec §4.5 |
| T-15: An operator, by mistake or on purpose, changes a meter rule or a sink mapping and bills wrongly | M-15: Meter and sink operations admit only `operatorPrincipalArns`; every change is logged with the caller; meter versions are kept and apply from a named hour, so a bad change is reverted by another write | ADR-0004; spec §3.2, §4.1 |
| T-16: An operator points a sink at a destination outside the vendor's control and sends usage there | M-16: `S3_EXPORT` writes only under a prefix of the sample's own export bucket. Accepted for `HTTP`: any HTTPS endpoint an operator configures is trusted; production: an allowlist of endpoints set at deploy time | spec §4.4 |
| T-17: A sink credential leaks | M-17: Credentials stay in Secrets Manager under the name the sink record holds; only the dispatcher reads them, inside its handler, and never logs them | spec §4.4 |
| T-18: The wrong tenant account is billed, or a record's billing account changes after it was sent | M-18: `billingAccount` is copied onto each record once, from the tenant's binding for that application, and never changed after; a missing one blocks only the sinks that need it, with an alarm and a release path | spec §4.7 |
| T-19: Usage events carry personal data that should not sit in a billing store | Accepted for the sample: events hold ids, meters, values and up to ten dimensions of synthetic data. Production: keep personal data out of `dimensions` (the emitter contract says so), and set retention to the billing need | spec §4.8, `rawRetentionDays` |
| T-20: Usage data at rest is encrypted under keys the vendor does not control | Accepted for the sample: S3, DynamoDB, SQS and both buses encrypt at rest with AWS-owned or AWS-managed keys; a customer-managed key per store is a production option | production hardening |
| T-21: A late or redriven event lands after its hour closed and is silently uncounted | M-21: Ingest's accept window, a close guard checked at each write of `READMIT`, `RECOUNT` and `INGEST_REDRIVE` (refused items go to `error/` as `TOO_LATE`), a close that checks the hour's `generation`, and an alarm on any object in a `CLOSED` hour | spec §3.3, §4.5, §4.6 |

## Security review

Not yet run: there is no code. When the sample is built, the review runs on
the synthesised tree (`npx projen build` under the deployment profile), with
ProtoShield or ASH, and cdk-nag `AwsSolutionsChecks` in the build. Every
finding is dispositioned in a table here.
