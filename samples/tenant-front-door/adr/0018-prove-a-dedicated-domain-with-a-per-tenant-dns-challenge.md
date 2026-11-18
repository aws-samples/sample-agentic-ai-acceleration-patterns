<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0018: Prove a dedicated domain with a per-tenant DNS challenge

- Status: Proposed
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
non-pooled data (ADR-0012), and the sweeper keeps no miss history of its
own: its log is the record. Dedicated domains are an add-on: the pooled
path must not need them, and a deployer who does not use them should not carry the
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
domain cannot point at the front door, so the tenant must run a server
of its own for the check, and that proves control of a web server, not
of the DNS that routing and the certificate depend on. It also needs
plain HTTP on port 80.

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
no cached answer can predate the token. A resolver error is
`unresolved`, never a pass, and a CNAME at the challenge name is
refused, so a CNAME left pointing into a zone someone else can register
never passes. The 7 days cover a tenant's
DNS change process; ACM's own 72-hour validation window starts only
after the challenge passes. The challenge keeps the vendor's decision
with the operator: it is necessary before routing, not a substitute for
the operator's call. The tenant keeps the record for as long as it
holds the domain, and the sweeper re-checks every passed challenge
daily, routed or not, and raises an alarm when the record is missing
on three UTC days in a row for one tenant and domain, and a second
alarm when its lookup only errors on three days in a row; it never
drops a domain itself. The registrar resolves the record once more
before it writes the domain's `host#` key.

## Consequences

- Easier: a dedicated domain is routed only after the tenant has shown
  control of its DNS with a token issued for it, so a former holder's
  validation record, which still validates ACM certificates, no longer
  routes a domain to the wrong tenant (spec §3.4 step 5).
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
  until the operator drops it. The daily re-check covers every passed
  challenge, routed or not, because a pending certificate request rests
  on the same proof; its alarm means the tenant does not show control
  of a domain it claimed. Every sweeper log line has a `type`
  (`run-start`, `entry` or `page-end` for the re-check's record). The
  lister gives each run a run id and a UTC `runDay`, logs both on a
  `run-start` line with the page count (zero included), and passes the
  run id and a page number to every page of 500 entries. Only the
  integration test supplies a `runDay`, never the Scheduler; the lister
  accepts one only within the last 7 days and not after today, and logs
  that it was supplied. Each page looks its records up 10 at a time with
  a 5 s timeout, querying CNAME only when the TXT answer is empty or
  holds the token, and logs one `entry` line per entry with the run id,
  the page, the tenant, the domain and numeric `pass`, `miss` and
  `error` fields, one of them 1, never the token, then a `page-end`
  line, unless the page's own query already showed one. At its start,
  the page runs one Logs Insights query, `limit 10000` set, that
  aggregates with `stats sum(pass), sum(miss), sum(error),
  latest(runDay) by type, runId, page, tenant, domain`, so a retried
  page or an extra run still gives one row for each run and entry, and
  the `run-start` and `page-end` rows stay apart. The page joins entry
  rows to their run's `run-start` row on the run id in memory and walks
  each missed entry's earlier days, one run for each UTC day, the
  newest. Within one run `sum(miss) > 0` makes a miss even when a pass
  was also logged, because a miss only counts toward three; only a
  logged `pass` on a later day breaks the streak. A run holds at most
  500 entries in the page's range, plus any entries in that range whose
  domains have since been dropped, and adds a row for each, its
  `run-start` row and one `page-end` row; with none dropped that is 502
  rows, so 19 runs in the 7 days fit the 10,000-row limit. A page whose
  result reaches the limit fails, and the missing-pages alarm reports
  it. A day with an error or with no line for the entry,
  because its page failed, is unknown and is skipped. Two earlier missed
  days before any pass make a three-miss line with the tenant and
  domain, and one count, as an embedded metric format log line, to the
  metric the alarm watches. Errors keep out of that count, so that an
  outage cannot look like a lost proof, and have a walk of their own:
  an entry whose lines are `error` on three days in a row, with no pass
  or miss between, gets an `unverifiable` line and a count to a second
  metric and alarm, so whoever controls a domain's DNS cannot hold it
  out of detection by breaking only the challenge name. A page takes at
  most 500 s of lookups plus a 60 s poll limit on its one query; a query
  that fails, does not finish, or returns 10,000 rows fails the page
  (the page calls `logs:StopQuery` on a query it gives up on), which
  Lambda retries twice and then keeps in an on-failure queue. The daily
  schedule's retry policy (2 retries, 1 hour maximum event age) and the
  sweeper's asynchronous maximum event age (3 hours), with its
  15-minute function timeout, end every run by 09:30 UTC on the day it
  starts. The next run's lister reads the
  previous run's `run-start` page count and its `page-end` lines and
  emits a missing-pages count. A previous day with no `run-start` line
  counts as one only when the 7-day window holds an earlier Scheduler
  `run-start` line (no supplied `runDay`, and a `runDay` before that
  day); otherwise the lister emits 0, so the first run after the
  sweeper is deployed does not alarm. Four alarms watch the re-check
  besides the three-miss alarm: the queue's depth, the `unverifiable`
  count, and two on the missing-pages count, which say that detection
  was down and judge only finished runs. The missing-pages alarm fires
  on a `Maximum` above zero, one one-day period, 1 of 1, missing data
  not breaching. The no-lister alarm fires on a `SampleCount` below
  one, two one-day periods, 2 of 2, missing data breaching, so it
  alarms only after two days with no lister and stays OK before the
  day's 02:00 UTC run. A custom resource, the starter, deployed with
  the sweeper, starts one Scheduler-shaped lister run (no supplied
  `runDay`) on its Create, when the stack is created with
  `dedicatedDomains` on and on the off-to-on update; no entry holds a
  `d` then, so it is a zero-page run that emits 0 and gives the
  no-lister alarm a datapoint once that run emits, a few minutes after
  deployment; until then the alarm can read ALARM. The starter does not
  wait for it: if that run fails, the no-lister alarm reads ALARM
  until the first daily run, which emits 0 under the first-run rule.
  One query per
  page in flight keeps a run inside the Logs Insights quota of 30
  concurrent queries. The sweeper keeps
  no store of its own: its log is the record. A removed record can still
  pass for as long as the resolver caches it, up to its TTL cap (S-10),
  which delays the alarm by that much. The sweeper does not drop the
  domain: a DNS fault or a tenant's mistake would then take a routed
  domain offline with no person deciding. The re-check does not follow
  ACM renewals, which depend on ACM's own validation record.
- Harder: a CNAME at `_tfd-challenge.<d>` is refused, so a tenant whose
  DNS provider publishes records through a CNAME must publish the TXT
  record itself.
- Harder: `dedicatedDomains` is a deploy-time switch. Off, the
  registrar answers any `customDomain` with 400 and holds no ACM or
  distribution-tenant action, and the sweeper, its role, its
  schedules and the starter are not deployed. The sweeper runs as an execution role of
  its own, with the route table read (`DescribeKeyValueStore`,
  `ListKeys`), the distribution-tenant and certificate deletes and the
  re-check's Logs, SQS and Lambda actions; the registrar's role keeps
  only what a domain call needs and deletes nothing. The teardown custom resource holds both
  roles' CloudFront and ACM actions in both cases, so a front door that once served a dedicated domain
  still tears down. A stack update that turns it off fails, on a custom
  resource, the guard, while any `tenant#` entry holds a `d` or the
  sweeper still has a distribution tenant or certificate to delete, so
  no domain stays routed with no role able to remove it and no
  re-check. The guard exists in both states and takes `dedicatedDomains`
  as a property, so it gets an Update when the switch flips and refuses
  only on-to-off. The registrar function is updated first, so new
  `customDomain` writes get 400; then the guard waits 40 s, the 10 s
  Lambda init limit plus the registrar function's 30 s timeout, so no
  call that started before the update, cold start included, is still
  running, and reads the table, inside its own 2-minute timeout (a call can outlive API Gateway's 504,
  and the operator repeats it, because every operator call is
  repeat-safe); then both roles are narrowed,
  the sweeper's as it goes with the sweeper, and the schedules are
  removed, which depend on the guard; a
  refusal rolls all of it back together. The operator drops every
  dedicated domain first (spec §3.4, the IAM paragraph, and §3.6); spec §10
  step 14 tests the refusal.
- Known limitations: not tested end to end, and covered by unit tests
  with a stubbed resolver or clock instead: challenge expiry and
  reissue, a resolver error (`unresolved`), a CNAME at the challenge
  name, the lookup before the `host#` write, the restart after an ETag
  conflict, a daily-run page that fails, the on-failure queue, the
  missing-pages count, the missing-pages alarm and the no-lister alarm
  (the 0 of a first run and two days with no lister included), the
  starter's deploy-time run, a supplied `runDay` outside its
  range, the guard's 40 s wait, the `unverifiable` line and its alarm for an entry
  that errors three days in a row, and a query that reaches its row
  limit and fails the page (spec §10). The alarms' notifications are not
  checked; the integration test checks the metric the re-check alarm
  watches.
- Not changed: a dedicated domain still never receives an authorization
  code (ADR-0016). The challenge confirms that the tenant controls the
  domain's DNS and can point it at a server of its own, so a code sent
  there could leave the vendor's edge.
- Revisit when S-10 shows a resolver delay operators cannot accept,
  when CloudFront or ACM offer a per-tenant domain proof of their own,
  or when a vendor needs the multi-perspective check.
