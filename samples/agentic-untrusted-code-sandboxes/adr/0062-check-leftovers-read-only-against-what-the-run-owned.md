<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0062: Check leftovers read-only against what the run owned

- Status: Accepted
- Date: 2026-11-20
- Deciders: Dave Roberts (Partner Solutions Architect)

## Context

The `teardown` step must show that after the stack is deleted no MicroVM, task,
instance, log group, DNS Firewall resource or construct-owned Logs resource
policy of the sample is left. AgentCore and Lambda create log groups after the
deploy, under names the stack does not own. The person running the test also
needs a way to see what an interrupted run left, without a tool that deletes.

## Options considered

### Option 1: List by name prefix only
Pros: needs no state. Cons: the construct's resource names carry a hash of the
construct path, so a prefix finds the stack and little else.

### Option 2: Snapshot the stack's resources at deploy time and look for exactly those
Pros: precise, covers resources by type, and names the service-created log
groups from the runtime and image names. Cons: needs a state file, and a
run with no state can only list stacks.

## Decision

Option 2. After the deploy the driver writes a state file (outside the
repository, mode 0600) with the stack's resource ids, the runtime and image
names, the query-log group ARN, and the account's Logs resource policies from
before the deploy. `test/integ/leftovers.ts` reads the account with
read-only calls only and returns findings; `scripts/leftovers.sh` prints them
and exits 1 when something is left. A statement that names the query-log
group's ARN in a policy that existed before the run is the one known leftover
of C-6 (spec §3.9): it is listed and does not fail the step. A task
definition revision cannot be deleted, so an ACTIVE one is a finding and an
INACTIVE one is not. DNS Firewall resources are read with the AWS CLI, the one
service the declared SDK clients do not cover. Nothing in the check deletes:
what it finds, a person removes with the commands in `integration-test.md`.

## Consequences

The check proves the absence of what the stack owned and of the two log group
families the services add; it does not prove nothing else in the account
changed. Revisit if the construct names its resources so a prefix finds them.

Note 2026-11-23: a check that cannot run (no credentials, an expired or
refused token, access denied, no `aws` binary) is now its own finding,
`check-unavailable`. `scripts/leftovers.sh` lists it as `CHECK NOT RUN`
apart from the leftovers, never prints "nothing left" then, and exits 1.
