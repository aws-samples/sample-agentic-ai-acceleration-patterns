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

base64url decoders on both sides refuse padding and any character outside
`A-Z a-z 0-9 - _`. A nonce that does not decode to 32 bytes is a refusal
(`wrong_sandbox`).

## Bodies

Every body is a JSON object, UTF-8, `Content-Type: application/json`.
Every body the tool sends and every result or refusal carries `"v": 1`.
Unknown fields are ignored by both sides.

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

1. parses the body; a malformed body is `tool_failed` (HTTP 400);
2. decodes the nonce; on `microvm` and `nitro` it adopts it only when
   `nonceHash` matches, on `agentcore` only when the
   `x-amzn-bedrock-agentcore-runtime-session-id` header equals the session
   id of `tenantId`; a held nonce that differs is `wrong_sandbox`;
3. checks `jobAuth` over the decoded fields; a mismatch is `wrong_sandbox`;
4. refuses with `busy` while another job runs, and with `dirty` once the
   `agentcore` job group did not drain (spec §3.5 step 3).

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

### `/run` lifecycle hook (`microvm`, port 9000)

`RunMicrovm` `runHookPayload` (at most 4096 characters):

```json
{ "nonceHash": "64 lowercase hex", "tenant": "the tenant id" }
```

The runner answers HTTP 200 with `{}`. It accepts the first hook only and
answers every later `/run` hook with HTTP 200 `{}` and changes nothing.
`/suspend` and `/resume` answer HTTP 200 `{}`.

### `nitro` start

`RunTask` container override `environment` `RUNNER_NONCE_HASH` =
`nonceHash` (lowercase hex). The runner removes it from the environment
it hands to code.

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
