<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0012: Cap the route table and shard by distribution

- Status: Accepted
- Date: 2026-11-17
- Amended by: ADR-0017, ADR-0018
- Deciders: Dave Roberts (PSA)

## Context

The route table is a CloudFront KeyValueStore (ADR-0003). A store holds at
most 5 MB of keys and values, a key is at most 512 bytes, a value at most
1 KB, and a function has one store. The tenant router is one function on
the distribution, so one front door has one store.

A pooled tenant takes one `tenant#` entry, plus one `host#` entry in `host`
mode (§4.1). `cell#` entries and the one `app` entry are few and small.
Values carry a version field (`"v":1`), so their shape can change without a
key change. Display name `n` is the only free-text field. The registrar
stores it for display only, truncated to at most 64 UTF-8 bytes with no
character that needs JSON escaping (§4.1), so it never refuses a long name.

Worst-case sizes, from the §4.1 shapes with a 63-character tenant id, a
26-character ULID cell id, a 12-digit account, status `suspended`, a
64-byte `n`, and a host of a 63-character label, a dot and an `appDomain`
of up to 64 characters (§3.6). A control-plane tenant id is 26 characters;
63, the most a DNS label holds, is a safe upper bound:

| Entry | Key | Value | Total |
|---|---|---|---|
| `tenant#` | `tenant#` + 63 = 70 B | `{"v":1,"c":"…26…","ac":"…12…","s":"suspended","n":"…64…"}` = 147 B | 217 B |
| `host#` | `host#` + 63 + `.` + 64 = 133 B | `{"v":1,"t":"…63…","ac":"…12…"}` = 97 B | 230 B |

So a tenant needs at most 217 bytes in `single` mode and 447 bytes in `host`
mode, 217 + 230. The `host#` value names its tenant (`t`), which the
registrar checks before another tenant's write, and records the
account (`ac`), which deletes check. A pooled tenant's `tenant#` value
has no `d`: only a tenant with a dedicated domain carries it (§4.1).
The vendor needs to know where the limit sits and what happens past it,
before a tenant create script hits a full store.

## Options considered

### Option 1: One store with a stated ceiling

Pros: one function, one store, at most three reads per request (§3.3); one
writer (the registrar); nothing to choose per tenant. Cons: a hard ceiling
per front door.

### Option 2: Shard by distribution

Several distributions, each with its own router and store, and the
registrar choosing a shard per tenant. Pros: no ceiling. Cons: each shard
needs its own pooled distribution tenant and, in `single` mode, its own
domain, because one domain reaches one distribution; the SPA and the
issuer must learn which domain a tenant uses; a second assignment record
outside the control plane (P-6).

## Decision

Option 1, with Option 2 as the plan past the ceiling. One front door uses
one store. The stated ceiling is 80 % of the store divided by the
worst-case bytes per tenant, which leaves 20 % for `cell#` entries, the
`app` entry, the `signin` entry in `host` mode and dedicated domains,
and matches the alarm:

- `single` mode: floor(5,000,000 × 0.8 / 217) = 18,433 tenants;
- `host` mode: floor(5,000,000 × 0.8 / 447) = 8,948 tenants.

The registrar enforces the store size in bytes: it refuses with 507 a write
that would take the store past 5 MB. Past the ceiling the plan is another
distribution and another store; the sample does not build it, because the
shard assignment and the domain per shard are application choices that
need their own record.

## Consequences

- Routing stays one function and one store, so the request path has no
  shard lookup.
- The ceiling is a real number because `n` has a byte limit; typical
  tenants are smaller, so a store usually holds more.
- A dedicated tenant's own domain adds one more `host#` entry and a `d`
  field on its `tenant#` entry, both counted against the 20 % headroom
  and covered by the 507.
- The registrar returns a clear error when the store is full, and the
  README states the ceiling per mode.
- One front door per application (ADR-0014) means the ceiling is per
  application, not per vendor.
- Follow-up: a store-size metric and an alarm at 80 % of 5 MB, so the
  vendor plans a shard before a create fails.
- Follow-up: the registrar writes the store through the KeyValueStore data
  plane API, which signs with SigV4A.
- Revisit when an application expects more than about 18,000 tenants in
  `single` mode or 8,900 in `host` mode, or when CloudFront raises the
  store size or allows more than one store per function.

Amended 2026-11-17 by ADR-0017: each `tenant#` value also carries
`dt`, the deployment's `createdAt` as Unix milliseconds
(`"dt":<13 digits>,`, 19 bytes), so a hook can tell a new deployment
from a leftover entry. The worst-case `tenant#` value is 166 bytes and
the entry 236, so a tenant needs at most 236 bytes in `single` mode and
466 in `host` mode. The ceilings become floor(5,000,000 × 0.8 / 236) =
16,949 tenants in `single` mode and floor(5,000,000 × 0.8 / 466) = 8,583
in `host` mode, and the revisit points about 16,900 and 8,500.

Amended 2026-11-18 by ADR-0018: a dedicated tenant's `tenant#` value
also carries its domain challenge, `dk` (51 bytes) and, while the
challenge is open, `dx` (16 bytes). With a 64-character domain a routed
dedicated tenant adds at most 288 bytes to the 20 % headroom (`d` 71,
`dk` 51, its `host#<d>` entry 166), so the headroom holds
floor(1,000,000 / 288) = 3,472 dedicated tenants, less what `app` and
`signin` take. The pooled ceilings do not change.
