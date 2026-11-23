<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0040: Filter MicroVM calls by code and scope IAM to the image

- Status: Accepted
- Date: 2026-11-20
- Deciders: Dave Roberts (Partner Solutions Architect)

## Context

Every `microvm` action authorizes against the image ARN. There is no
MicroVM ARN, `RunMicrovm` and `CreateMicrovmAuthToken` take no tags or
request-tag condition, and the only condition key is the image's
`aws:ResourceTag` (S-3). The tool tenant role cannot be limited to one
tenant's MicroVM the way `nitro` tasks are (ADR-0014). The tool role runs,
calls and ends any MicroVM of the image, so a tool defect that names the
wrong MicroVM id could end or call another tenant's sandbox.

## Options considered

### Option 1: One grant on the image, and a tenant filter in code
Pros: one image, one build, no per-tenant resource. Cons: IAM does not
refuse a tool that names the wrong MicroVM; the code and the runner do.

### Option 2: One image per tenant, with the grant on that image
Pros: IAM enforces the tenant. Cons: a build of about 120 s per tenant,
an image per tenant to keep and delete, and a drain that must find them.

### Option 3: A role per tenant that holds the MicroVM actions
Pros: enforcement by role. Cons: a role cannot be narrower than the image
ARN, so it adds assume-role calls and no isolation.

## Decision

Option 1. The grants are on the image ARN and nothing wider (`*` only for
`lambda:ListMicrovms`, which takes no resource). The tenant filter is
code in `MicrovmBackend`:

- `start` takes the tenant only from its call, refuses credentials of
  another tenant, and sends the tenant to the runner with the nonce hash.
- `run` refuses a job whose nonce or tenant is not the handle's own, before
  any token or request is made.
- Every job carries `jobAuth` over the run id, the tenant and the code and
  input (ADR-0018). A MicroVM of another tenant refuses it with
  `wrong_sandbox` before it writes the input or runs the code.
- The result carries `HMAC(nonce, runId)`; a result without it is a dead
  handle (ADR-0044).
- Auth tokens are made per call, allow port 8080 only and last five
  minutes, so a token never reaches the hook port.

## Consequences

A defect in the tool's choice of MicroVM id can still end another tenant's
sandbox (a denial of service for that tenant) because IAM cannot refuse it.
It cannot run code in, or read results from, another tenant's MicroVM: the
runner refuses the job. The integration test steps `apart` and
`dead-handle` run per backend; a deliberate wrong-handle call is a unit
test of this backend (`run` refuses it before any request) and of the
runner. Revisit when MicroVM actions accept a tag condition or a MicroVM
ARN.
