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
keys, and the number of `ListKeys` calls of 50 keys, depends on the
entry sizes. No spike measured `ListKeys` latency from the deployment
Region to the store's global endpoint.

## Options considered

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

## Decision

Option 3. The lister passes its UTC date to each page, a page whose
date is not the current UTC date when it starts exits as a no-op with a
stale-page line, and otherwise the passed date is today for every read
and write of the page. A lost redriven page is already reported by the
missing-pages alarm, which is better than outcomes filed under a day
nobody started (Option 1) or a day anyone can name (Option 2). With it:
the three-miss count is emitted only when this write's outcome is a
miss and leaves `missStreak` at 3 or more, so an error day or a pass
emits none; each page re-reads the route table with one `ListKeys`
scan, which the role already holds, keeps the `tenant#` entries in its
range and skips one whose domain is gone or whose challenge is open;
each `ListKeys` call has a 2 s limit with the SDK's standard retries,
and the page fails once the scan has run for 120 s, a deadline rather
than a per-call product, because the store is capped by bytes and not
keys; and the sweeper's role holds `dynamodb:BatchWriteItem` on the
table. The rest of ADR-0020 stands.

## Consequences

- Easier: a page's writes all land on one day, and a redrive or a late
  hand run never files under a day its lister did not start. The
  Scheduler's input names no date, and the test still reaches other
  days by editing items (spec §10 step 14).
- Easier: a page takes at most 120 s for the scan, plus 500 ÷ 10 ×
  (2 queries × 5.4 s + 2 DynamoDB calls × 2 s) = 740 s, plus 2 s to
  finish, 862 s, inside the 900 s timeout. Every term is a hard limit.
- Harder: the 2 s call limit and the 120 s deadline are chosen, not
  measured. The page logs the scan's duration and the integration run
  records it (spec §10 step 14). A store too large to scan in 120 s
  fails every page, which the missing-pages alarm reports.
- Harder: a page redriven on a later day, and the pages of a hand run
  that start after midnight, are lost and show as missing pages for
  their own day.
- Known limitations: not tested end to end, and covered by unit tests
  with a stubbed clock instead: a page whose date is not today exiting
  with its stale-page line, and an error day emitting no three-miss
  count (spec §10).
- Revisit when a measured `ListKeys` scan time from the deployment
  Region comes close to 120 s, or when a vendor needs a redriven page's
  work kept rather than reported.
