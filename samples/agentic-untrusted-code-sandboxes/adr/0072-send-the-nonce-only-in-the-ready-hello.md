<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0072: Send the nonce only in the `ready` probe's `/hello`

- Status: Accepted
- Date: 2026-11-23
- Amends: ADR-0018, ADR-0047
- Deciders: Dave Roberts (Partner Solutions Architect)

## Context

On `nitro`, `ready` reads the task's address from its own ENI on every
probe (ADR-0047), and `run` dials the address in the registry row. Until
now both posted `/hello` with the raw nonce. A stopped task's private IP
can go to another tenant's task (T-1). The honest runner there refuses
the nonce, because its `nonceHash` differs. But code with root in that VM
(T-46, accepted) does not run the honest runner: it would read the nonce
from the `/hello`, answer the proof on its own certificate, receive the
job (the other tenant's code and input) and forge the result proof.

## Options considered

### Option 1: Send the nonce only in `ready`; `run` sends the challenge alone
Pros: the runner adopts the nonce on the first `/hello`, at an address
read from this task's ENI a moment before. Every later `/hello` makes the
runner prove with the nonce it holds, so a peer at a recycled address
learns nothing and cannot answer. No extra AWS call per job. Cons: a
change to the pinned protocol (ADR-0025).

### Option 2: `DescribeTasks` before every warm call
Pros: no protocol change. Cons: one ECS call per job, which throttles at
scale; the address can still change between the read and the connect.

### Option 3: Compare the `/hello` `bootId` with the row's
Cons: the nonce has already gone out by the time the answer arrives.

### Option 4: Accept the composition of T-1 and T-46
Cons: the threat model's claim that root code sees only its own tenant's
bytes would not hold.

## Decision

Option 1. `/hello` takes `nonce` as an optional field. With it (the
`ready` probe) the runner checks it against `nonceHash` and adopts it, as
before. Without it (the `/hello` before a job) the runner answers with
the nonce it holds, and a runner that holds none answers `wrong_sandbox`.
The proof, the vectors and the version stay as they were: the field is
optional, and a runner of the earlier shape answers a `/hello` with no
nonce `wrong_sandbox`, so the tool takes over with a fresh task. A
version bump would instead make the earlier `microvm` and `agentcore`
runners refuse every job until their sandboxes end.

## Consequences

The nonce leaves the tool only in the `ready` probe and inside jobs sent
after a passed proof. The `ready` probe still dials an address read a
moment before; the window between the read and the connect is the only
one left, and the task is `RUNNING` in it. Unit tests on both sides cover
the warm `/hello` with no nonce, a peer holding another nonce, and a
peer holding none.
