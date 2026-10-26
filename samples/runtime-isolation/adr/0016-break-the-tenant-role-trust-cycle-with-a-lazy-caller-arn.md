<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0016: Break the tenant-role trust cycle in the demo with a lazy caller ARN

- Status: Proposed
- Date: 2026-10-26
- Deciders: Dave Roberts (PSA)

## Context
The construct takes `tvm.role` as a prop (ADR-0012) and exposes `tvmCallerRole`, the Lambda role that assumes it. The tenant role's trust policy must name that caller, and the caller is created by the construct that receives the tenant role: a construction-order cycle in the demo stack.

## Options considered
### Option 1: Two stacks (tenant role first, then the construct), passing the role ARN by import
Cons: the tenant role must trust a caller that does not exist yet, so its trust policy would be widened to the account or patched later.
### Option 2: Let the construct create the tenant role
Cons: the construct would own the ABAC policy for data it does not know (§4.5: the construct creates none of its dependencies).
### Option 3: Create the tenant role in the demo stack with a `Lazy.string` trust principal resolved from `tvmCallerRole.roleArn` at synth
Pros: one stack, trust stays exactly one principal, no import, no widening. Cons: a lazy token in a trust policy is an unusual pattern that needs a comment and a template test.

## Decision
Option 3. The demo stack creates the tenant role and resolves its trust principal lazily; `test/demo.cdk.test.ts` asserts the trust policy names only the construct's caller role, requires `aws:RequestTag/TenantId`, and pins `aws:TagKeys`.

## Consequences
Easier: the demo shows the full contract a deployer must meet (threat-model M-10). Harder: a consumer building the tenant role in a separate stack must follow the same trust rules by hand; the README snippet shows the policy. Revisit if CDK adds a first-class way to reference a role before construction.
