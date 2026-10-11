# ADR-0016: Pagination tokens stay unsigned — partition-pinned queries make forged tokens harmless

**Status:** Accepted (2026-09-07)

**Context:** The pagination token is base64url-encoded JSON of DynamoDB's
`LastEvaluatedKey` — readable and forgeable by any caller. The backlog
carried "sign the token" (HMAC or KMS) as a hardening candidate, on the
theory that a forged token becomes a scope bypass if listing is ever
tenant-scoped.

**Decision:** Do not sign. The authenticity concern is structurally moot
because every list path is a **Query pinned to a server-side partition**:
`ListCells` and `ListTenants` query GSI partitions whose key values (`CELL`,
`TENANT`, `CELL#<cellId>`) are set by the service, never by the caller. Per
the DynamoDB Query contract, a query "returns all items with that partition
key value" from the `KeyConditionExpression`; `ExclusiveStartKey` only
positions WITHIN that result set (verified against the API reference,
2026-09-07). A forged token can reposition the caller inside data they may
already page through, or produce a `ValidationException` — which the
repository maps to the modelled 400 — but it can never widen the result set
beyond the queried partition. This argument holds even for a future
tenant-scoped listing, provided the partition value derives from the
caller's verified context (JWT), which is exactly how a tenant-scoped
partition would be built. The one API that took a caller-positioned key
without a partition pin — the Scan-based `Repository.list()`, dead code
since the cell redesign moved all listing to the GSIs — is deleted, so the
property is enforced by construction rather than by convention.

**Consequences:** No signing key to provision, cache, or rotate — material
simplification for a sample. The invariant to preserve is stated where it
matters (repository doc comment): pagination must go through
partition-pinned `Query`; reintroducing an unpinned `Scan` (or deriving the
partition value from caller input rather than verified context) reopens the
question and would justify signed tokens. Tokens remain readable — they leak
key attribute names and one item's key values to the caller who just read
that item, which is not sensitive here.
