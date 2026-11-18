<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0020: Keep the re-check state in a sweeper-owned DynamoDB table

- Status: Accepted
- Date: 2026-11-18
- Amends: ADR-0018
- Deciders: Dave Roberts (PSA)

## Context

ADR-0018 has the sweeper re-check every passed domain challenge daily
and alarm when one tenant and domain misses on three days in a row, or
only errors on three. A streak needs a memory that lasts across days.
ADR-0018 gave the sweeper none ("its log is the record"), so each page
rebuilt the history from the sweeper's own log with a Logs Insights
query: a run id, a run day, `run-start` and `page-end` lines, a
10,000-row limit with a 19-run proof, a join in memory, a first-run rule
read from log lines, a 60 s wait for the log to index, a starter that
gives the no-lister alarm its first datapoint, and a run day that only
the integration test supplies. The full design review found two defects
in that: the run id is the invocation id, which Lambda keeps across
asynchronous retries, so whether a retry is a new run is undefined; and
the supplied day is a test seam in the shipped function. No record
compared another way to keep the history.

Constraints: the state is small (at most 3,472 dedicated tenants,
spec §4.1, ADR-0012). The route table is registrar-only (P-3). An
outcome must count once for each day however often a page or the lister
runs. The next day must be able to tell that a run did not finish. The
test must reach a third missed day without waiting three days and
without an input in the shipped function. The table exists only with
`dedicatedDomains` (ADR-0018), and every DynamoDB table in this
repository has point-in-time recovery.

## Options considered

### Option 1: The log as the record (ADR-0018 as accepted)

Pros: no new resource and no data access beyond Logs; the log lines
also serve as an audit trail. Cons: every page runs a Logs Insights
query and joins its rows in memory; the 10,000-row limit bounds the
look-back to 19 runs and fails the page when it is reached; the
concurrent-query quota bounds the pages; a run sees the run before it
only after the log has indexed it; run identity depends on the
invocation id; the test needs a supplied day; and a first-run rule has
to be derived from log lines.

### Option 2: A table owned by the sweeper

Pros: the state is the streak itself, one small item for each tenant and
domain; a day's outcome is one conditional write, so repeats are
no-ops; a run is a key (the UTC date), so a retry is the same run by
construction; detecting an unfinished run is a counter on that item;
the test seeds items and needs no input in the function; no look-back
limit and no query quota. Cons: one more resource with its own IAM
(the sweeper's role, and the test role in the test); a lost table
restarts every streak at zero; item cleanup is the lister's job;
about 3,500 writes a day at the ceiling.

### Option 3: Fields in the route table

The sweeper writes the streaks into the domain's `tenant#` entry. Pros:
no new resource. Cons: it makes the sweeper a second writer of the
route table, against P-3; the registrar rewrites those entries on every
hook and would have to carry the fields through every write; each field
takes bytes from the 20 % headroom that dedicated domains already use
(ADR-0012); and every sweeper write competes with the registrar for the
store's ETag and takes 60 s to propagate for nothing the router reads.

## Decision

Option 2. The sweeper owns one DynamoDB table in the main stack, with
on-demand capacity and point-in-time recovery, deployed and removed with
the sweeper. An entry item for each tenant and domain holds the last
UTC day it recorded, that day's outcome, the miss and error streaks
after it, and the same two streaks before it; a run item for each UTC
day holds the number of pages started and the set of page numbers
finished. A day's outcome is written once, with a condition that the
item is new, or older than today, or from today with a weaker outcome
(error, then pass, then miss), which makes a page, a lister or a day's
run safe to repeat and lets a miss replace a pass. A pass resets both streaks, a
miss ends an error streak and adds to the miss streak, and an error adds
to the error streak and leaves the miss streak alone. The alarms fire
when a write leaves a streak at 3 or more. The run is identified by its
UTC date, so a retry of that day's lister, the starter's run and a run
by hand are one run. The next day's lister reads the previous run item
and emits the missing-pages count; a missing run item counts only when
an earlier one exists. The lister deletes the entry items whose tenant
and domain are no longer current, so the registrar needs no access to
the table. The sweeper takes no day from its caller. Option 1 would
keep the sweeper stateless at the price of the machinery above; Option 3
breaks the one-writer rule for the route table. The starter, the
on-failure queue, the no-lister alarm, the in-call lookups, the guard,
the page size and the removal paths of ADR-0018 stay as decided.

## Consequences

- Easier: the re-check is a read, a computation and one conditional
  write for each entry; no query language, no row budget and no index
  delay. A streak has no look-back limit: a failed page delays an alarm
  and never cancels one.
- Easier: the integration test seeds an entry item as it would stand
  after two missed days, runs the real daily run once, and reads the
  result (the domain challenge step of spec §10). The test role holds `dynamodb:GetItem` and
  `PutItem` on this table only, listed among the test-only shortcuts;
  the table holds no token and no key.
- Easier: a page takes at most 500 ÷ 10 × (2 queries × 5.4 s + 2 DynamoDB
  calls × 2 s) = 740 s, plus 2 s to finish, 742 s, inside the 15-minute
  timeout. The sweeper's role holds `dynamodb:GetItem`, `Query`,
  `UpdateItem` and `DeleteItem` on the table in place of the Logs
  Insights actions.
- Size and cost: at the ceiling of 3,472 dedicated tenants, 3,472 entry
  items of under 400 bytes (about 1.4 MB) and about 14 run items, which
  expire after 14 days. A day makes at most 3,472 reads, 3,472 writes
  and one paginated query, about 104,000 reads and 104,000 writes a
  month, on demand.
- Harder: a table to deploy, secure and remove, with its own IAM. When
  `dedicatedDomains` is turned off it goes with the sweeper, and the
  first run after it is turned on again has no history: a domain that
  was already missing needs three more checks, and the missing-pages
  count is 0 until a run item exists.
- Harder: an item's identity is the tenant and the domain. A domain
  dropped and set again between two daily runs keeps its streaks, and a
  miss on its next check can alarm early. Shortcut: accepted for a
  sample; upgrade to an item key that includes a hash of the challenge
  token when that matters.
- Known limitations: not tested end to end, and covered by unit tests
  with a stubbed clock instead: a repeated page or lister on one day
  changing nothing, a miss replacing a pass and a pass replacing an
  error on one day, an error day leaving the miss streak as it was,
  three error days and the `unverifiable` alarm, a day with no check,
  the missing-pages count and the no-lister alarm (a previous day with
  no run item, the 0 of a first run, two days with no lister), and the
  lister's deletion of the items of a dropped domain (spec §10).
- Revisit when the number of dedicated tenants makes the daily writes a
  cost worth batching, when a vendor needs the streaks to survive the
  switch being turned off, or when a dropped and re-set domain must not
  keep its earlier streaks.
