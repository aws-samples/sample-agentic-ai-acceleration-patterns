<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# Script Conventions

Conventions for the shell scripts in this directory. `demo.sh` walks the
primary flow against a deployed demo stack; `integ.sh` deploys its own
stacks and drives the deployment integration test (spec §10, the steps in
`test/integ.ingestion.ts`). What they print lands in the terminal of the
person running them and, in CI, the job log; both are an audience, not a
scratchpad. A script on this path handles access tokens, temporary
passwords, SigV4 credentials and **presigned URLs**, which carry a signature
that writes or reads a tenant's document until it expires; none of those
ever reaches output.

## Log hygiene

- **Never use `set -x`.** Trace mode prints every expanded command line,
  including bearer tokens, presigned URLs and request bodies. Use
  `set -euo pipefail` only.
- **Never print a token, credential, password, presigned URL or header value.**
  Log the step name, the HTTP status, the tenant id, the delivery id and the
  registry's `status` and `reason` instead:

  ```bash
  echo "step 3 ${TENANT}: HTTP ${status} delivery=${DELIVERY_ID} status=$(jq -r .delivery.status "$BODY")"
  ```

  Bad, the URL can now write to the tenant's drop prefix from anyone's terminal:

  ```bash
  echo "upload to: $(jq -r .uploadUrl "$BODY")"
  ```

- **File names stay out too.** A delivery's file name is tenant data (spec
  §4.2); scripts use synthetic names and print the delivery id instead.
- **AWS CLI output counts as output.** Narrow it with `--query` /
  `--output text` into a variable, or send it to `/dev/null` when only the
  exit status matters. `aws sts assume-role` output is never printed.
- **Synthetic data only.** Invented tenants (`tenant-a`, `tenant-b`), invented
  documents (generated PDFs), `@simulator.amazonses.com` addresses.

## Temp files

- Create temp files with `mktemp`, never a fixed path in `/tmp`. Response
  bodies go to one `mktemp` file each, mode 0600, removed by the `trap`.
- Remove every temp file on exit, including the failure path, from the
  `EXIT` trap.

## Failure behaviour and cleanup

- `set -euo pipefail`, plus a `: "${VAR:?...}"` guard for each required input
  (`AWS_REGION`) and a check for each tool (`aws`, `curl`, `jq`; `npx` in
  `integ.sh` only), so a missing input fails fast with a message that names
  it.
- `integ.sh` runs only in an account that carries the Organizations tag
  `tei:test-account` or the SSM parameter
  `/tenant-encrypted-ingestion/test-account` set to `true`, and refuses any
  other (M-33): the test deploys roles that can use any key the account's
  key policies admit, so it runs only where the vendor marked the account
  for it.
- Register an `EXIT` trap that cleans up whatever the script created.
  `integ.sh` destroys every stack it deployed from the trap, so the destroy
  runs even when the deploy or a step fails, and then lists what was left:
  stacks with the sample's prefix, and the KMS keys tagged with its stacks,
  which can only be pending deletion (spec §6.2, §10 step 12).
- `integ.sh` never replaces or destroys tenant-identity, not even one it
  deployed: it reuses a published one, deploys one only when none is
  published, and leaves it as the account's shared fixture. It destroys
  only its own stacks.
- Exit non-zero on any failure, naming the step, resource or parameter that
  failed (name, not value). Never swallow an error into a success exit.

## Published parameters and who owns them

The scripts read this sample's parameters under
`/application-plane/shared/ingestion/` and tenant-identity's under
`/application-plane/shared/identity/`, and never write either (M-30). The one
parameter they write is the `test-switch` validator's mode (the demo stack's
`TestSwitchParameterName` output), which the stack owns and the integration
test sets back to `accept` when it is done with it.

## Scope

These conventions apply to every script in this directory and any script
added later. They are the local-script counterpart of
`docs/sample-standard.md` §4.4 (no secrets, tokens or caller payloads in logs)
and of M-27 (no URL, signature or file name in any log).
