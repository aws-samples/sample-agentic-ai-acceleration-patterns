<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0007: Offer SigV4 with the dispatcher's role as an HTTP sink auth mode

- Status: Accepted
- Date: 2026-11-19
- Deciders: Dave Roberts (SA)

## Context
An `HTTP` sink authenticated only with a credential the operator stores in
Secrets Manager and the dispatcher sends as a header (spec §4.4). A billing
API that runs on AWS, behind a Lambda function URL or API Gateway, could
only take such a sink by being open to the internet and checking that
secret in its own code. The sample's own test receiver did exactly that:
its function URL had `AuthType NONE` and a resource policy open to any
principal, which security scanning flagged. A shared secret checked in
application code is also an authentication scheme the endpoint owner has to
build and maintain.

## Options considered
### Option 1: Shared secret only
Pros: one path, works for any HTTPS endpoint. Cons: every AWS-hosted billing
API must be internet-open with its own secret check; secrets to rotate.

### Option 2: SigV4 for any host, with the service and Region set on the sink
Pros: covers custom domains and private APIs. Cons: the dispatcher would
sign for hosts that do not verify SigV4, so the request (access key id,
session token, signed body) reaches whoever runs the host; easy to
misconfigure.

### Option 3: SigV4 only for function URL and execute-api hosts (`auth: AWS_IAM`)
The dispatcher signs as its own role; the service and Region come from the
host, which must be `*.lambda-url.<region>.on.aws` or
`*.execute-api.<region>.amazonaws.com` on `https:` with no port. The check
runs at create, on update and before each send. Pros: no secret; the
endpoint is gated by IAM before its code runs; the grant on the dispatcher
role is the allowlist. Cons: custom domains and private API hosts are not
covered; the deployer must grant the dispatcher role invoke, and across
accounts the target also needs a resource policy naming that role.

## Decision
Option 3, beside the existing secret mode, which stays the default.
It removes the need for an internet-open AWS endpoint for the common case
of a billing API on AWS, and keeps the signing scope on endpoints that
verify SigV4. The host check is not an ownership check: what the
dispatcher can invoke is bounded by the IAM grants on its role, so the
deployer grants it only on the billing endpoints.

## Consequences
- `auth` is set at `CreateSink` only; an `AWS_IAM` sink takes no
  `secretName`. A stored sink that fails the check (a direct table write)
  is `FAILED` with `AUTH_TARGET_INVALID` at once.
- The demo receiver is an `AWS_IAM` function URL that only the dispatcher
  role may invoke, with no Lambda resource policy; a CDK unit test pins it.
- A grant on `*` would let any operator POST mapped bodies to every
  endpoint the grant covers (threat model M-17).
- Revisit to add custom domains or private APIs with an explicit service
  and Region, if consumers need them.
