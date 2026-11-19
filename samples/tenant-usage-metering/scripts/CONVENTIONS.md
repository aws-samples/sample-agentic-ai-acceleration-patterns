<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# Script conventions

Conventions for the scripts in this directory: `integ.sh` deploys the demo
stack and drives the deployment integration test
([`../integration-test.md`](../integration-test.md)); `demo.sh` walks the
primary flow against a deployed stack; `control-plane/metering-hook.sh` is
the control plane's global hook; `emit-usage.ts` is the emitter snippet a
cell's workload runs. What they print lands in a terminal, a CI job log or
the control plane's hook log; all three are an audience.

## Log hygiene

- **Never use `set -x`.** Trace mode prints every expanded command line,
  SigV4 keys and session tokens included. `demo.sh` and the hook use
  `set -euo pipefail`; `integ.sh` uses `set -uo pipefail` so a failed test
  step still reaches the exit-trap destroy and its exit status is kept.
- **Print step names, HTTP statuses, ids and the API's `reason`, never
  values that grant access.** No access key, secret key, session token,
  sink secret or signed header reaches output. Usage event bodies are not
  printed either; print the per-event `result` and `reason`.
- **AWS CLI output counts as output.** Narrow it with `--query` and
  `--output text` into a variable. `aws sts assume-role` output is read
  into shell variables and never printed.
- **Synthetic data only.** Invented tenants (`tenant-a`, `tenant-b`,
  `demo-tenant`), meters and billing accounts (`acct-a`, `acct-b`).

## Credentials

- Credentials live in shell variables or process memory only. The hook
  hands the signing key and session token to `curl` in a mode-600 config
  file, never on a command line, and removes the file from its exit trap.
- `emit-usage.ts` signs with the credential provider chain of the cell's
  emitter role; it never reads or logs a key itself.
- Every value from the hook environment is checked against its charset
  first and reaches a request body only through `jq --arg`, never inside a
  string the shell evaluates (M-8). The hook reads the metering API URL
  from `metering-hook.env` beside it, never from a `PARAM_` value (M-25).

## Temp files and cleanup

- Response bodies go to one `mktemp` file per call, removed when the call
  returns.
- Every script that creates something removes it from an exit trap, also
  on failure: `demo.sh` deletes its binding, emitter and meter; `integ.sh`
  destroys the stack unless `INTEG_KEEP_STACK=1`.
- Each script runs in exactly one Region, `AWS_REGION`, and fails fast
  when it is unset.

## Checks

- A check passes only on the status and `reason` it names: a refusal check
  expects its exact 4xx (for example 409 `PLACEMENT_MISMATCH`, 403 for an
  unsigned call to the test receiver), and any other status fails it.
- Retried calls (the hook's `PUT`s and `DELETE`s, the snippet's sends)
  are idempotent, so a re-run is safe.
