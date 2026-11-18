<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0022: Pin each sweeper page to the lister's date and re-read the route table

- Status: Accepted
- Date: 2026-11-18
- Amends: ADR-0020
- Deciders: Dave Roberts (PSA)

## Context

ADR-0020 keeps the daily re-check state in a sweeper-owned DynamoDB
table. A run is one UTC day, and "the sweeper takes no day from its
caller": each page reads the clock. Two full design reviews found four
gaps in that.

- A page that the on-failure queue redrives on a later day, or a page
  of a run started by hand late in the day, reads a later date from
  the clock. It files its outcomes and its page number under a day its
  lister did not start, so the later day's run item shows a page it
  never planned and the earlier day shows the page as finished nowhere.
- A page that starts before midnight and writes after it would split
  its writes across two days.
- ADR-0020 has the alarms fire when a write leaves a streak at 3 or
  more. An error day leaves `missStreak` as it was, so a domain at
  three misses would count again on every error day, which is not a
  new miss.
- The lister lists the entries once, and a page starts up to 3 hours
  later (the on-failure retries). A page that trusts the lister's list
  can check a domain that was dropped or reopened in between. The
  sweeper's role also needs `dynamodb:BatchWriteItem` for the lister's
  batch delete, an IAM action separate from `DeleteItem`.

Constraints: the integration test must not reach another day through
an input of the shipped function (ADR-0020). A page must stay inside
the sweeper function's 900 s timeout with every term of its bound a
hard limit. The route table is capped by bytes (5 MB, spec §4.1), not
by keys: the registrar refuses a write only past 5 MB, so the number of
keys, and the number of `ListKeys` calls of 50 keys a full scan needs,
depends on the entry sizes. No spike measured `ListKeys` or `GetKey`
latency from the deployment Region to the store's global endpoint. An
asynchronous Lambda invocation carries at most 256 KB of payload.

## Options considered

Two choices: which day a page files under (Options 1 to 3), and how a
page re-reads the route table before it checks an entry (Options 4
and 5).

### Option 1: No date passed (ADR-0020 as accepted)

Each page reads the clock. Pros: no input at all, so nothing for a
caller to choose. Cons: a redriven or late page files under the wrong
day, and a page that crosses midnight splits its writes.

### Option 2: A date the page trusts

The lister passes its UTC date and the page uses it whatever the clock
says. Pros: a redriven page files under its own day, so its work is not
lost. Cons: the date becomes a caller-chosen input of the shipped
function. Anyone who can invoke the sweeper can file outcomes under any
day, and the test seam ADR-0020 removed comes back.

### Option 3: A date the page must match to today

The lister passes its UTC date. A page compares it with the current UTC
date when it starts; when they differ it logs a stale-page line and
exits as a no-op. Otherwise it uses the passed date as today for every
read and write: the `lastCheckedDay` it compares and writes, the day
rule's condition and the run item whose `pagesFinished` it adds to.
Pros: no caller can choose a day other than today; a page that crosses
midnight files all of its writes under its own day; a redriven page on a
later day writes nothing. Cons: that redriven page's work is lost, and
it shows as a missing page for its own day; a run by hand late in the
day loses the pages that start after midnight.

### Option 4: A `ListKeys` scan with a deadline

The lister passes each page a range of tenant ids. The page scans the
whole store with `ListKeys`, keeps the `tenant#` entries in its range,
and fails once the scan has run for a fixed deadline. Pros: one read
pattern, and the role already holds `ListKeys`. Cons: the scan's cost
is the store's shape, not the page's. A full store of small entries
needs hundreds of calls, so a large store can miss the deadline on
every page of every day, and the re-check stays down until the code
changes, with only the missing-pages alarm to show it. The range can
also grow between the lister and a retry, so a page can hold more than
500 entries and overrun its bound.

### Option 5: A `GetKey` per passed tenant id

The lister passes each page its list of tenant ids (at most 500 ids of
at most 63 characters, about 33 KB, inside the 256 KB async limit). The
page reads each `tenant#<id>` entry with `GetKey`, 10 at a time, and
checks only those ids. Pros: the read cost is tied to the page size,
not the store, so a large store changes nothing; the page never checks
an entry the lister did not pass. Cons: one more IAM action on the
sweeper's role, and up to 500 reads a page instead of one scan of a
small store.

## Decision

Option 3 for the date and Option 5 for the re-read. The lister passes
its UTC date to each page, a page whose date is not the current UTC
date when it starts exits as a no-op with a stale-page line, and
otherwise the passed date is today for every read and write of the
page. A lost redriven page is already reported by the missing-pages
alarm, which is better than outcomes filed under a day nobody started
(Option 1) or a day anyone can name (Option 2). The lister also passes
each page its list of tenant ids, and the page reads each one's
`tenant#<id>` entry with `GetKey`, 10 at a time, each read made once
with a 2 s limit, and skips one whose domain is gone or whose challenge
is open; it does no `ListKeys` scan (the lister still lists). This
bounds the page by its own size, where a scan (Option 4) is bounded by
the store's. With it: the three-miss count is emitted only when this
write's outcome is a miss and leaves `missStreak` at 3 or more, so an
error day or a pass emits none; the sweeper's role holds
`cloudfront-keyvaluestore:GetKey` on the store; and it holds
`dynamodb:BatchWriteItem` on the table. The rest of ADR-0020 stands.

## Consequences

- Easier: a page's writes all land on one day, and a redrive or a late
  hand run never files under a day its lister did not start. The
  Scheduler's input names no date, and the test still reaches other
  days by editing items (spec §10 step 14).
- Easier: a page takes at most 500 ÷ 10 × 2 s = 100 s for its reads,
  plus 500 ÷ 10 × (2 queries × 5.4 s + 2 DynamoDB calls × 2 s) = 740 s,
  plus 2 s to finish, 842 s, inside the 900 s timeout. Every term is a
  hard limit, and none depends on the size of the store.
- Harder: the 2 s `GetKey` limit is chosen, not measured. The page logs
  the time its reads took and the integration run records it (spec §10
  step 14).
- Harder: a page redriven on a later day, and the pages of a hand run
  that start after midnight, are lost and show as missing pages for
  their own day.
- Known limitations: not tested end to end, and covered by unit tests
  with a stubbed clock instead: a page whose date is not today exiting
  with its stale-page line, and an error day emitting no three-miss
  count (spec §10).
- Revisit when a measured `GetKey` time from the deployment Region
  comes close to 2 s, or when a vendor needs a redriven page's work kept
  rather than reported.
