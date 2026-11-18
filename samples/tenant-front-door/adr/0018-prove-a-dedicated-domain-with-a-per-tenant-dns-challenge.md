<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0018: Prove a dedicated domain with a per-tenant DNS challenge

- Status: Accepted
- Date: 2026-11-18
- Amends: ADR-0002, ADR-0012, ADR-0016
- Deciders: Dave Roberts (PSA)

## Context

A tenant with its own domain gets a dedicated distribution tenant on the
front door's distribution (ADR-0002). Only the vendor's edge operator
role sets a tenant's `customDomain` (spec §3.4 step 3), and the
registrar then requests an ACM certificate in `us-east-1`, creates the
distribution tenant once the certificate has validated, and writes the
domain's `host#` key (spec §3.4 step 5). Spec Q-3 asked two things:
does this path belong in the sample, and how does the vendor confirm
that the tenant controls the domain before it is routed?

The validated certificate does not answer the second. ACM keeps one
validation record per domain name per account and reuses it for every
later certificate for that name. A validated certificate proves that
the edge account's validation record is in the domain's DNS, not which
tenant published it. A former holder's record keeps validating after
the domain has moved to someone else, and a certificate requested for a
second tenant validates from the first tenant's record. The registrar
already refuses a domain for which it holds another tenant's
certificate (spec §3.4 step 4), but that only orders claims inside the
registrar; it proves nothing about DNS control.

Constraints: the proof must name the tenant and the domain, so neither
another tenant's proof nor a stale one passes. It must work before the
domain points at the front door, because CloudFront serves a domain only
once its distribution tenant and certificate exist. The route table is a
KeyValueStore with a 5 MB ceiling, of which 20 % is headroom for
non-pooled data (ADR-0012), and the registrar keeps no store of its own
(spec P-6). Dedicated domains are an add-on: the pooled path must not
need them, and a deployer who does not use them should not carry the
CloudFront and ACM permissions they need (spec §3.4).

## Options considered

### Option 1: A validated ACM certificate only

The registrar treats a certificate that reaches `ISSUED` as proof. Pros:
no new state, no new record for the tenant to publish; already on the
path. Cons: it proves the edge account's record, not the tenant
(Context). A former holder's validation record, or a second tenant's
request for a domain the first validated, passes. The registrar cannot
tell the tenant that controls the domain from one that merely asked.

### Option 2: A TXT record carrying a token the registrar issued for the tenant and domain

On the operator's first call for a domain, the registrar issues a
random token, stores it in the tenant's `tenant#` entry next to `d`
with an expiry, and answers 202 with the record to publish,
`_tfd-challenge.<domain>` TXT `tfd-verify=<token>`. A repeat resolves the
record, and only when it holds this token does the registrar request the
certificate. Pros: the proof names one tenant and one domain; a token
exists only from its issue, so no leftover record can hold it; works
before the domain points anywhere; no new store, a few bytes per
dedicated tenant; the same lookup re-checks a routed domain later.
Cons: one more round for the tenant (publish a TXT record, then ACM's
record); depends on what the registrar's resolver sees, including its
cache; trusts DNS from one vantage point.

### Option 3: An HTTP file challenge on the domain

The tenant serves the token at
`http://<domain>/.well-known/tfd-challenge/<token>`. Pros: familiar from
ACME `http-01`; no DNS change for a tenant that already runs a web
server on the domain. Cons: before the distribution tenant exists the
domain cannot point at the front door, so the tenant has to run a
server of its own for the check, and a domain that already points at
the front door, for example a former holder's leftover CNAME, would be
answered by the vendor's own edge, which makes the check circular. It
needs plain HTTP on port 80, and it proves control of a web server, not
of the DNS that routing and the certificate depend on.

### Option 4: The operator attests by hand

The operator confirms control out of band (a ticket, a call) and then
sets `customDomain`. Pros: no code. Cons: nothing binds the attestation
to the tenant or the domain, nothing is recorded that the registrar can
check, and it fails silently the way Option 1 does. It does not scale
with the number of dedicated tenants.

## Decision

Option 2, with the path kept in this sample and off unless the
deployer turns on `dedicatedDomains` (spec §3.6). The spec, the
removal logic and ADR-0002 already design the path, and moving it to a
follow-up would leave `customDomain`, `d` and the sweeper as dead
design; making it optional keeps the pooled path, the registrar role's
permissions and the sweeper free of it for a deployer who does not need
it. The token is 32 bytes from a cryptographic random source, base64url
without padding (43 characters), stored as `dk` with its expiry `dx`, 7
days out, in the tenant's `tenant#` entry (spec §4.1). It is stored as
it is, not hashed: the tenant publishes it in public DNS, knowing it
lets no one pass without control of the domain's DNS, and keeping it
lets a repeat answer 202 with the same record. It lives next to `d`, is
compared only for that `d`, and is removed with it, so another tenant's
token, a token for another domain and a former holder's token never
pass. An expired open challenge gets a new token on the next call. The
registrar resolves the record with the default resolver of a Lambda
function outside a VPC: AWS's recursive resolver, with no third party,
no egress rule and no resolver code. A DNS-over-HTTPS resolver would
send every tenant domain to a third party and caches the same way;
querying the authoritative servers directly would skip the cache but
needs an iterative resolver in the function and UDP from Lambda, which
nothing has proven. Caching can delay a pass, never cause one, because
no cached answer can predate the token. The 7 days cover a tenant's
DNS change process; ACM's own 72-hour validation window starts only
after the challenge passes. The challenge keeps the vendor's decision
with the operator: it is necessary before routing, not a substitute for
the operator's call. The tenant keeps the record while the domain is
routed, and the sweeper re-checks it daily and raises an alarm after
three days of misses; it never drops a domain itself.

## Consequences

- Easier: a dedicated domain is routed only after the tenant has shown
  control of its DNS with a token issued for it, so a former holder's
  validation record, which still validates ACM certificates, no longer
  routes a domain to the wrong tenant (spec §10 step 14).
- Easier: no new store. A dedicated tenant carries `dk` (51 bytes) and,
  while its challenge is open, `dx` (16 bytes) on its `tenant#` entry,
  beside `d` (71) and its `host#<d>` entry (166). At worst 288 bytes per
  dedicated tenant once routed, so the 20 % headroom holds 3,472 of them,
  less what `app` and `signin` take (spec §4.1, ADR-0012).
- Easier: an open challenge holds no claim and requests no certificate,
  so a tenant that never publishes its token blocks no one. Two tenants
  can hold open challenges for one domain; the first to pass gets the
  certificate, and the other's next call gets 409 from the existing
  pending-claim check (spec §3.4 step 4).
- Easier: removal is unchanged. `dk` and `dx` go in the same write as
  `d`, before the two-phase removal of the distribution tenant and the
  certificate, and the sweeper has nothing extra to clean up. The TXT
  record in the tenant's DNS is the tenant's to remove; once its `d` is
  gone it names a dead token.
- Harder: onboarding a dedicated domain takes two DNS rounds, the
  challenge record and then ACM's validation record, and two kinds of
  202 (`stage` `domain-challenge` and `certificate`).
- Harder: a repeat call made before the tenant published the record can
  make the resolver cache a negative answer for the zone's
  negative-caching TTL, which delays the pass by that much. Spike S-10
  measures what the function sees; if the delay is more than an
  operator can live with, the resolver choice is reopened.
- Harder: the check trusts one DNS answer from one Region without
  DNSSEC, as ACM's own DNS validation does. Shortcut: one vantage point;
  upgrade to a second Region's answer, or DNSSEC validation, when a
  vendor needs the multi-perspective check public certificate
  authorities make.
- Harder: a domain that changes owner stays routed to the old tenant
  until the operator drops it. The daily re-check logs each miss with
  the tenant and domain, never the token, and an alarm fires after
  three daily runs in a row with a miss. The sweeper does not drop the
  domain: a DNS fault or a tenant's mistake would then take a routed
  domain offline with no person deciding. The re-check does not follow
  ACM renewals, which depend on ACM's own validation record.
- Harder: `dedicatedDomains` is a deploy-time switch. Off, the
  registrar answers any `customDomain` with 400 and holds no ACM or
  distribution-tenant action. The teardown custom resource holds them
  in both cases, so a front door that once served a dedicated domain
  still tears down.
- Not changed: a dedicated domain still never receives an authorization
  code (ADR-0016). Proving that the tenant controls the domain's DNS is
  the reason: a code sent there reaches a server the tenant runs.
- Revisit when S-10 shows a resolver delay operators cannot accept,
  when CloudFront or ACM offer a per-tenant domain proof of their own,
  or when a vendor needs the multi-perspective check.
