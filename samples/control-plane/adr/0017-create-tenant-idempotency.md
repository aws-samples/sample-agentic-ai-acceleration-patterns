# ADR-0017: CreateTenant idempotency via an optional clientToken and a transactional idempotency record

**Status:** Accepted (2026-09-07)

**Context:** `CreateTenant` is asynchronous but its placement is a
synchronous write: an API Gateway timeout (or network failure) after the
placement transaction commits leaves the client unsure whether the tenant
was onboarded. The natural client reaction — retry — onboards a second
tenant, and possibly a second cell. Stage throttling bounds the blast
radius but not the duplication. Alternatives considered: (a) dedupe on
Step Functions execution name — wrong layer, the duplication happens at the
placement transaction, before `StartExecution`; (b) dedupe on tenant `name`
— names are not unique by design; (c) DynamoDB's transaction
`ClientRequestToken` — a 10-minute idempotency window scoped to identical
request payloads, useful for automatic SDK retries but not for a client
retry that re-runs placement (the retry may pick a different candidate
cell, changing the transaction payload).

**Decision:** An optional `clientToken` on `CreateTenant` (`@idempotencyToken`,
1–64 chars). When present, the service writes an **idempotency record**
(`PK=IDEMPOTENCY#<token>`, `SK=META`, carrying the new `tenantId` and a
SHA-256 hash of the request parameters) as a third item in the SAME
placement `TransactWriteItems` — both the claim-slot and new-cell shapes —
conditional on `attribute_not_exists(PK)`. Detection and the original write
are one atomic transaction; there is no check-then-act window. A cancelled
idempotency condition classifies as a replay (it takes precedence over the
lost-race classification): the service reads the record and returns the
original tenant when the request hash matches — whatever its current
lifecycle status — or the modelled 409 when the hash differs (token reuse
with different parameters), when the tenant was since deleted, or in the
TTL-race corner where the record vanished between transaction and read.
Records carry a 24-hour `expiresAt` for DynamoDB TTL garbage collection;
because TTL deletion is lazy, replay handling ignores `expiresAt` — a
surviving record is authoritative, making the honoured window "at least
24 hours" rather than a hard cutoff. Without a token, behaviour is
unchanged.

**Consequences:** A client retry after a timeout is now safe — same token,
same outcome, no duplicate tenant or cell. The cancellation-reason
classification in the placement transactions gains a third position; the
idempotency item is always appended LAST so its code has a fixed index.
The cost is one extra item per tokenised onboard (self-garbage-collecting
via TTL) and the table's TTL attribute. The idempotency record is
control-plane-owned bookkeeping — it is never listed, never returned, and
carries no GSI keys. `DeleteTenant` deliberately does not clean up the
record: a replayed create after a delete is a 409 pointing at the deleted
tenant, not a silent re-onboard — the safer semantics for an operator API.
