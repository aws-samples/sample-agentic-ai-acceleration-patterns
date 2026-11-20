<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# Runner wire protocol

The contract between the tool (TypeScript, [`src/protocol.ts`](../src/protocol.ts))
and the runner (Python, this directory). It pins every encoding the spec
(§3.4, §3.5) leaves open; [ADR-0025](../adr/0025-pin-the-runner-wire-protocol-and-the-backend-interface.md)
records the choices. Both sides test against
[`protocol/vectors.json`](protocol/vectors.json), which
[`protocol/make_vectors.py`](protocol/make_vectors.py) generates with the
Python standard library only. A change here is a change to both sides and
to the vectors in one pull request.

## Encodings

| Value | Raw form | On the wire |
|---|---|---|
| `nonce` | 32 bytes from the CSPRNG, made by the tool at start | base64url, no padding (43 characters); the registry row stores the same text |
| `nonceHash` | SHA-256(`"nonce"` ‖ raw nonce), the 5 ASCII bytes then the 32 nonce bytes | lowercase hex (64 characters) |
| start idempotency token | SHA-256(`"start"` ‖ raw nonce) | first 32 lowercase hex characters |
| AgentCore session id | `"rc-"` ‖ hex SHA-256(UTF-8 tenant id) | 67 characters |
| `jobAuth` | HMAC-SHA-256, key = raw nonce, message below | base64url, no padding (43 characters) |
| result `proof` | HMAC-SHA-256(raw nonce, UTF-8 `runId`) | base64url, no padding |
| `/hello` `challenge` | 32 bytes from the CSPRNG, made by the tool per connection | base64url, no padding |
| `certFingerprint` | SHA-256 of the runner certificate's DER bytes | lowercase hex (64 characters) |
| `/hello` `proof` | HMAC-SHA-256(raw nonce, raw challenge (32 bytes) ‖ raw fingerprint (32 bytes)) | base64url, no padding |
| `bootId` | 16 bytes from `os.urandom` | lowercase hex (32 characters) |
| `input` | the input object's raw bytes | standard base64 with padding; the field is absent when the call names no input |
| `code` | UTF-8 text | a JSON string |
| `runId` | UTF-8 text made by the tool, a UUID in practice | a JSON string |

`jobAuth` message, each `len` a 4-byte big-endian count of the bytes that
follow:

```
len(runId) ‖ runId ‖ len(tenantId) ‖ tenantId ‖ SHA-256(len(code) ‖ code ‖ len(input) ‖ input)
```

An absent input and an empty input are both zero bytes, so they sign the
same. The runner decodes `input` from base64 before it hashes it. Every
proof the receiver checks is compared in constant time.

base64url decoders on both sides refuse padding, any character outside
`A-Z a-z 0-9 - _`, and text that does not re-encode to itself (non-zero
spare bits in the last character). A nonce or a challenge that does not
decode to 32 bytes is a refusal (`wrong_sandbox`).

## Bodies

Every body is a JSON object, UTF-8, `Content-Type: application/json`.
Every job, `/hello` request and response, result and refusal carries
`"v": 1`; the `/run` hook payload and `/ping` do not. Unknown fields are
ignored by both sides.

### `RunJob`: `POST /run` (`microvm`, `nitro`) and `POST /invocations` (`agentcore`)

```json
{
  "v": 1,
  "runId": "string, 1 to 128 bytes",
  "tenantId": "[A-Za-z0-9][A-Za-z0-9_-]{0,63}",
  "nonce": "base64url, 43 characters",
  "code": "string, at most 65536 bytes as UTF-8",
  "input": "standard base64, optional",
  "timeoutMs": 30000,
  "maxOutputBytes": 262144,
  "jobAuth": "base64url, 43 characters"
}
```

`timeoutMs` and `maxOutputBytes` are the construct's `runTimeout` and
`maxOutputBytes`; the runner clamps `timeoutMs` to 1000 to 60000 and sets
`RLIMIT_CPU` from it. They are not covered by `jobAuth`: they bound the
job and carry no tenant data.

The runner, in this order, before it writes the input or starts code:

1. parses the body; a malformed body is `tool_failed` (HTTP 400,
   `MALFORMED_JOB_STATUS`); a fault inside the runner is `tool_failed`
   (HTTP 500);
2. decodes the nonce and checks that it may adopt it: on `microvm` and
   `nitro` its `nonceHash` must match, on `agentcore` the
   `x-amzn-bedrock-agentcore-runtime-session-id` header must equal the
   session id of `tenantId`; a held nonce that differs, or one it may not
   adopt, is `wrong_sandbox`;
3. checks `jobAuth` under that candidate nonce; a mismatch is
   `wrong_sandbox`, and the runner keeps nothing;
4. adopts the nonce only now (idempotent when it already holds it), so a
   job with a valid session header but a forged `jobAuth` cannot pin a
   nonce on `agentcore`;
5. refuses with `busy` while another job runs, and with `dirty` once the
   `agentcore` job group did not drain (spec §3.5 step 3).

The tool waits at most `timeoutMs` + 5 s for an answer (spec §4.1 step
5); a backend reports a longer wait as `no_answer`, and the tool stops the
sandbox and returns `timedOut`.

### `RunResult`: HTTP 200

```json
{
  "v": 1,
  "runId": "the job's runId",
  "exitCode": 0,
  "stdout": "string",
  "stderr": "string",
  "truncated": false,
  "durationMs": 412,
  "timedOut": false,
  "memoryExceeded": false,
  "bootId": "32 lowercase hex",
  "proof": "base64url HMAC(nonce, runId)"
}
```

`exitCode` is the process exit status 0 to 255, or `-N` when signal `N`
ended it. stdout and stderr together are at most `maxOutputBytes` bytes,
stdout cut first, counted on the raw bytes; each is then decoded as UTF-8
with invalid sequences replaced by U+FFFD. `truncated` is true when
anything was cut.

### Refusal

```json
{ "v": 1, "error": "wrong_sandbox | busy | dirty | tool_failed", "bootId": "optional" }
```

| `error` | HTTP status on `/run`, `/hello` | Tool action (spec §4.1, §5.1) |
|---|---|---|
| `wrong_sandbox` | 403 | dead handle: take over |
| `busy` | 409 | `sandbox_busy` to the caller |
| `dirty` | 410 | dead handle: take over |
| `tool_failed` | 400 (malformed job) or 500 | `tool_failed` to the caller |

On `/invocations` every refusal is HTTP 200 with the same body, so that
AgentCore returns it to the tool as the payload. The tool decides on the
`error` field on every backend, never on the status alone.

### `GET /ping`

```json
{ "status": "Healthy", "bootId": "32 lowercase hex" }
```

On `microvm` `bootId` is absent until the `/run` hook delivered
`nonceHash`, and the tool treats such a `/ping` as not ready. On
`agentcore` `/ping` carries no session header and `bootId` is absent until
the session's first job.

### `POST /hello` (`nitro`, TLS on 8443)

Request:

```json
{ "v": 1, "nonce": "base64url", "challenge": "base64url, 32 bytes" }
```

Response, HTTP 200:

```json
{ "v": 1, "bootId": "32 lowercase hex", "certFingerprint": "64 lowercase hex", "proof": "base64url" }
```

The tool computes the fingerprint of the certificate the TLS connection
presented, checks that it equals `certFingerprint` and that `proof`
matches, and then sends the job on the same connection (HTTP/1.1
keep-alive). A runner whose `nonceHash` does not match answers with the
`wrong_sandbox` refusal (HTTP 403).

### Lifecycle hooks (`microvm`, port 9000)

The platform calls `POST /aws/lambda-microvms/runtime/v1/<name>` on the
hook port; the runner serves the same names at `/<name>` too. `ready`
runs at image build and answers HTTP 200 `{}` once the runner serves and
can take a job (HTTP 503 after a forced failed start). `run` delivers the
start call's payload; `suspend`, `resume` and `terminate` answer HTTP 200
`{}` and change nothing. A hook request may carry no body and no
`Content-Length` (the platform sends `suspend` that way); its body is then
empty, as RFC 9112 section 6.3 says. A `Transfer-Encoding` other than `chunked` is HTTP 400 and
closes the connection. The first `run` hook with an empty body is HTTP 400;
a later `run` hook answers HTTP 200 whatever its body. Any other path is HTTP 404.

The platform wraps the `RunMicrovm` `runHookPayload` (at most 4096
characters) as a JSON string, `{"microvmId": "…", "runHookPayload":
"<payload>"}`; a body without `runHookPayload` is read as the payload
itself. The payload:

```json
{ "nonceHash": "64 lowercase hex", "tenant": "the tenant id" }
```

The runner answers HTTP 200 with `{}`. It accepts the first hook only and
answers every later `run` hook with HTTP 200 `{}` and changes nothing; a
first hook whose payload breaks the shape above answers HTTP 400 and is
not taken.

### `nitro` start

`RunTask` container override `environment` `RUNNER_NONCE_HASH` =
`nonceHash` (lowercase hex). The runner removes it from the environment
it hands to code.

### Test hook: a failed start

The integration test makes one sandbox fail to start (spec §8
`failed-start`; ADR-0037 is the runner's side of the hook).

- `nitro`: the `RunTask` container override `environment` also holds
  `RUNNER_FAIL_AT_BOOT` = `1` (that exact value). The runner logs
  `fail_at_boot` and exits 1 before it opens a port. The runner reads the
  variable on `agentcore` too, but the `agentcore` backend ignores the
  option the tool passes, because its start makes no AWS call.
- `microvm`: the `run` hook payload also holds `"failAtBoot": true` (only
  the JSON value `true` counts). The runner reads it inside the
  `runHookPayload` wrapper and before it checks the payload shape, so the
  hook answers HTTP 200 `{}` with or without `nonceHash` and `tenant`; a
  body that is not JSON still answers HTTP 400. The runner claims nothing:
  `ready` answers HTTP 503, a well-formed job is refused with
  `wrong_sandbox` (HTTP 403), a later `run` hook (a second `failAtBoot`
  included) answers HTTP 200 `{}` and changes nothing, and the process
  exits 1 about half a second after the hook.

The tool passes the hook only when its own environment has
`RC_INTEG_OVERRIDES` = `1` and the tenant is the one named in
`RC_INTEG_FAIL_START_TENANT`; nothing else sets it (ADR-0058, threat T-88).

## Vectors

[`protocol/vectors.json`](protocol/vectors.json) holds, per case, the
nonce (hex and base64url), `runId`, `tenantId`, `code`, the input (hex, or
`null` for no input) and the expected `nonceHash`, start token, session
id, `jobAuth`, result proof and the whole `RunJob` body; plus one `/hello`
case and three negative `jobAuth` values that must differ from the first
case. Cases:

| Case | Covers |
|---|---|
| `basic` | ASCII code, a small text input |
| `absent-input` | no `input` field |
| `empty-input` | an empty input: same `jobAuth` as `absent-input` |
| `non-ascii-code` | code with 2-, 3- and 4-byte UTF-8 characters: lengths count bytes |
| `binary-input` | input bytes that are not UTF-8, with NUL |
| `tenant-at-limit` | a 64-character tenant id full of hyphens, empty code |
| `one-char-tenant` | a 1-character tenant id, an input longer than 255 bytes |

Regenerate with `python3 -m runner.protocol.make_vectors` from the sample
root; `npx projen test` fails when the file and the generator disagree
(`runner/tests/test_vectors.py`) or when the TypeScript side disagrees
with the file (`test/protocol.test.ts`).
