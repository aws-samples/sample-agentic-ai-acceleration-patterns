# Script Conventions

Conventions for the shell scripts in this directory. They run locally against
a deployed `RuntimeIsolation-<ingress>` stack (`demo.sh` walks the primary
flow; `integ.sh` drives the deployment integration test, spec §8). What they
print lands in the operator's terminal and, in CI, the job log; both are an
audience, not a scratchpad. A script on this path handles access tokens,
refresh tokens, temporary passwords, SigV4 credentials and, with the TVM on,
the base64 credential header the agent reports on, so the overriding rule is
that none of those ever reach output.

## Log hygiene

- **Never use `set -x`.** Trace mode prints every expanded command line,
  including bearer tokens, SigV4 keys and request bodies. Use
  `set -euo pipefail` only.
- **Never print a token, credential, password, session id or header value.**
  Log the HTTP status, the tenant id, the step name, and the agent's
  non-secret report fields (`sessionPrefix`, `nonce`, `forwardedScope`,
  `read.result`) instead:

  ```bash
  # Good — status, tenant and the prefix the agent derived
  echo "step 5 ${TENANT}: HTTP ${status} prefix=$(jq -r .sessionPrefix "$BODY")"

  # Bad — the token is now in the terminal and any CI log
  echo "token: ${ACCESS_TOKEN}"
  ```

- **The full unit id stays out of logs too.** The agent reports `unitId`; the
  scripts compare it in variables and print only `sessionPrefix` (spec P-9:
  the prefix, never the token, and the conversation part is the client's).
- **AWS CLI output counts as output.** Narrow it with `--query` /
  `--output text` into a variable, or send it to `/dev/null` when only the
  exit status matters. `aws sts assume-role` output in particular is never
  printed: the step 8a negative check reads only the exit status.
- **Keep PII out.** Use `@simulator.amazonses.com` addresses and invented
  tenant names (`tenant-a`, `tenant-b`); never a real e-mail.

## Temp files

- Create temp files with `mktemp`, never a fixed path in `/tmp`. Response
  bodies go to one `mktemp` file each and are removed by the `trap`.
- Remove every temp file on exit, including the failure path, from the
  `EXIT` trap, not only at the end of the happy path.

## Failure behaviour and cleanup

- `set -euo pipefail`, plus a `: "${VAR:?...}"` guard for each required input
  (`AWS_REGION`, and the tools the script needs: `aws`, `curl`, `jq`,
  `npx`), so a missing input fails fast with a message that names it.
- Register an `EXIT` trap that cleans up whatever the script created.
  `demo.sh` deletes the demo table items and users it wrote and removes its
  temp files on every exit; `integ.sh` destroys every stack it deployed from
  the trap, so the destroy runs even when the deploy or a step fails, and
  then checks that nothing with the sample's prefix was left behind
  (stacks, log groups, `/application-plane/shared/agent-runtime/*`).
- Exit non-zero on any failure, naming the step, resource or parameter that
  failed (name, not value). Never swallow an error into a success exit.

## Scope

These conventions apply to every script in this directory (`demo.sh`,
`integ.sh`) and any script added later. They are the local-script counterpart
of `docs/sample-standard.md` §4.4 (no secrets, tokens or caller payloads in
logs) and of spike V-7 (no header value on any log on the path).
