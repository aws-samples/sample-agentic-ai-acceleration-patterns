<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0045: Accept nitro instance types from a static table of Nitro Enclaves families

- Status: Proposed
- Date: 2026-11-20
- Deciders: Dave Roberts (Partner Solutions Architect)

## Context

Nitro Sandboxes on ECS Managed Instances need an instance type with Nitro
Enclaves support (spec §3.3, ADR-0015). Spike S-7 found that `m7i.large`
is refused by the platform at run time, after the stack is up. The
capacity provider would take any type name, and the runner image has one
architecture (spec §3.5), so a list that mixes Intel and Graviton types
cannot work.

## Options considered

### Option 1: A static table in the construct, copied from the Nitro Enclaves requirements page
Pros: synth refuses a bad type at once, offline, with a message that names
the type; the architecture comes from the table, not from a guess at the
type name. Cons: the table ages; a new family is refused until it is added.

### Option 2: Ask EC2 at synth (`DescribeInstanceTypes`)
Pros: always current. Cons: synth needs credentials and a Region, which a
unit test and a consumer's CI may not have.

### Option 3: Let the capacity provider refuse it at deploy
Pros: no code. Cons: a failed deploy of up to 20 minutes for a typo.

## Decision

Option 1. `src/backends/nitro-instance-types.ts` lists each family with
its architecture and the sizes the page excludes ("all instance types
except"). The page excludes the 2 vCPU Intel and AMD sizes and the 1 vCPU
Graviton sizes, so `m7i.large` is refused and `m7g.large` is accepted.
Accelerated computing families are left out: the sample needs none. Synth
refuses an unknown family or size, a type of an architecture for which the
runner has no job filter table (spec §3.5), and a list that mixes
architectures. A test compares the table with a dated copy of the page in
`test/fixtures/nitro-enclaves-instance-types.json`: same families, same
excluded sizes, and every family of the page that is missing from the
table is an accelerated one.

## Consequences

Updating the table is a two-step change: read the page, update the
fixture, then the table, until the test passes. The default stays
`m7i.xlarge`, the one type run end to end; `m7g.large` is accepted and has
not run on ECS. Only the x86_64 job filter table has run on a sandbox
(S-18, S-19), which the README names for Graviton users. Revisit if the
page moves or ECS adds a way to ask which types it accepts.
