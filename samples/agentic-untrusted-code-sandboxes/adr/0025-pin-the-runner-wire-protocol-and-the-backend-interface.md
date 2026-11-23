<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0025: Pin the runner wire protocol and the backend interface

- Status: Accepted
- Date: 2026-11-20
- Deciders: Dave Roberts (Partner Solutions Architect)

## Context

The tool (TypeScript) and the runner (Python) sign and parse the same
bytes. Spec §3.5 fixes `jobAuth` but not the job and result bodies, the
`/hello` bodies, the nonce and hash encodings, the result proof's encoding,
how a refusal travels, or how `input` travels. Spec §3.4's
`SandboxBackend` has `start`, `ready`, `run` and `stop`, but the reaper,
the drain and the offboard function also need to list sandboxes, check a
`READY` one is alive, read stop facts and deregister `nitro` instances,
and `ready` must report what it learnt (`address`, `bootId`) for the row.
The CDK side of each backend (resources, statements, endpoints,
environment, drain order) has no seam either.

## Options considered

### Option 1: One protocol document with generated vectors, and an extended interface the backends implement
Pros: both sides test the same bytes before anything is deployed; the
reaper, drain and offboard function can be built against a fake backend.
Cons: a document and a file both sides must keep in step.

### Option 2: Let each side read the spec
Pros: nothing to write. Cons: a hex-versus-base64url slip shows only when a
real job runs, at the end of the build.

## Decision

Option 1.

Protocol (`runner/PROTOCOL.md`, `src/protocol.ts`):

- The nonce is 32 raw bytes; it travels and is stored as base64url
  without padding. `nonceHash` and the start token hash the raw bytes and
  are lowercase hex. Every HMAC output (`jobAuth`, result `proof`,
  `/hello` `proof`) is base64url without padding. `bootId` is 16 bytes,
  lowercase hex. `certFingerprint` is the lowercase hex SHA-256 of the
  certificate's DER bytes; the `/hello` HMAC message is the raw challenge
  (32 bytes) then the raw fingerprint (32 bytes), so no separator is needed.
- Every transport is JSON, so `input` always travels as standard base64,
  and the field is absent when the call names no input.
- `RunJob` also carries `timeoutMs` and `maxOutputBytes`, so the runner
  needs no per-backend environment for them; they are outside `jobAuth`
  because they bound the job and carry no tenant data.
- A refusal is a JSON body with `error`; on `/run` and `/hello` it also has
  an HTTP status (403, 409, 410, 400 or 500), and on `/invocations` it is
  HTTP 200, so AgentCore returns it as the payload. The tool decides on
  `error`.
- `runner/protocol/make_vectors.py` (standard library only) generates
  `runner/protocol/vectors.json`; the TypeScript unit test, the Python
  unit test and the runner's own tests read it. A change to the protocol
  changes the document, both sides and the vectors in one pull request,
  by a maintainer decision.

Backend interface (`src/backend.ts`):

- `ready(handle, row)` returns `ready` with a `patch` (`address`,
  `bootId`), `starting` with an optional `address`, or `ended` with the
  reason (a failed start, spec §4.1). It does one probe; the caller owns
  the `startWait` loop.
- A backend never reads or writes the registry. The caller writes the
  patch with its own version condition and keeps the returned version
  (spec §4.1 "every conditional write after the first uses the version
  returned by that call's own last successful write"). This keeps
  DynamoDB access with the tool tenant role and the reaper role.
- `run` returns a result (proof checked), a refusal, `no_answer` when the
  runner did not answer by the job's `timeoutMs` plus 5 s (spec §4.1 step
  5; the backend enforces that deadline), or a dead handle.
- Added: `startCapMs`, `list()` (with `tenantId` where the platform tags
  it and `startedAt`), `isAlive(handle)`, `stopReason(handle)` and an
  optional `cleanup(deadline)` for the drain. `SandboxHandle`,
  `TenantCredentials` and `RegistryRow` are defined there.
- IAM statements live on the CDK side, `BackendConstruct` in
  `src/backend-construct.ts` (tool, tool tenant, reaper and drain
  statements, sandbox endpoints and their client groups, function
  environment, drain order, log cleanup, and the per-backend ARNs the core
  exposes), with one
  `src/backends/<name>.cdk.ts` per backend. The run-time class reads the
  environment its `BackendConstruct` sets.
- `test/fake-backend.ts` implements the interface in memory and signs
  results with the real protocol functions.

## Consequences

The runner and each backend can be built in parallel against fixed
bytes and types. A backend that needs a field the interface lacks asks for
an interface change rather than reaching into the registry. The spec's
interface block in §3.4 is the four-method core of this one.
