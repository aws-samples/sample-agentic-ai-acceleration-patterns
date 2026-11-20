<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0063: Bound the answer by its JSON size and the input by the runner's limit

- Status: Proposed
- Date: 2026-11-20
- Amends: ADR-0032
- Deciders: Dave Roberts (Partner Solutions Architect)

## Context

`maxOutputBytes` counts raw bytes, up to 4 MiB. The answer leaves the tool as
JSON, where one control byte takes six bytes, so a script that prints control
bytes can make an answer of up to 24 MiB. A synchronous Lambda response holds
6 MB, so the standalone entry fails and the gateway target returns
`tool_failed`, and tenant code causes it. The tool also cut the runner's
decoded text a second time, and a replacement character counted as three
bytes, so the tool could set `truncated` on output the runner reported whole.

`maxInputBytes` allowed 50 MiB, but the input travels in one job body that the
runner refuses above 6 MiB of input (ADR-0039), so an input between 6 and 50
MiB started a sandbox and then failed.

## Options considered

### Option 1: Keep the raw cut and lower the cap to about 960 KiB
Pros: one rule. Cons: it cuts honest output to cover the worst case, and keeps
the second cut and the false `truncated`.

### Option 2: Trust the runner's cut and bound the JSON-encoded size at 5 MiB
Pros: the default and any ordinary output are untouched; control-byte output
is cut, stdout first, and marked `truncated`. Cons: the tool no longer checks
`maxOutputBytes` itself.

### Option 3: Bound the JSON size and also cut raw bytes again
Pros: a defence if the runner miscounts. Cons: it brings back the false
`truncated`.

## Decision

Option 2. After the nonce proof the runner is trusted, and its cut is covered
by its own tests. The tool counts the bytes of stdout and stderr as JSON
writes them in UTF-8, keeps at most 5 MiB together, cuts stdout first on a
character boundary and sets `truncated`. 5 MiB leaves room under the 6 MB
limit for the other fields. `maxInputBytes` is at most 6 MiB, the runner's own
limit. A `bootId` is 32 lowercase hex characters, as the protocol says, and the
tool shares that pattern with the backends.

## Consequences

An output of control bytes is cut earlier than `maxOutputBytes` says, with
`truncated` set. Raising the 5 MiB budget needs a response path other than a
synchronous Lambda answer. The cap of 6 MiB for inputs follows the runner:
raising one means raising the other.
