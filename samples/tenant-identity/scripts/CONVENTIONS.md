# Script Conventions

Conventions for the shell scripts in this directory. They run locally against
a deployed `TenantIdentity-<topology>` stack — `demo.sh` walks the primary flow
and `integ.sh` drives the deployment integration test — rather than inside AWS
CodeBuild. What they print lands in the operator's terminal and, when run in
CI, the job log; both are an audience, not a scratchpad. A script on the token
path handles refresh tokens, access tokens, temporary passwords and SigV4
credentials, so the overriding rule is that none of those ever reach output.

## Log hygiene

- **Never use `set -x`.** Trace mode prints every expanded command line,
  including refresh tokens, SigV4 keys, temporary passwords, and request
  bodies. Use `set -euo pipefail` only.
- **Never print a token, refresh token, password, or credential.** Log the
  HTTP status code, the tenant id, the operation name, and claim fields that
  are not credentials (`tenant_id`, `scope`, `token_use`) instead:

  ```bash
  # Good — status and non-secret claims only
  echo "ExchangeToken -> HTTP ${status}"
  claims "$NARROWED" | jq -c '{tenant_id, scope, token_use}'

  # Bad — the token is now in the terminal and any CI log
  echo "Narrowed token: ${NARROWED}"
  ```

- **The same applies to derived values.** A JWT payload decoded for display is
  shown field by field through `jq`, never as the raw token; SigV4 credentials
  live in shell variables (`aws configure export-credentials`) and are passed
  to `curl` by reference, never echoed.
- **AWS CLI output counts as output.** Narrow it with `--query` / `--output
  text` into a variable, or send it to `/dev/null` when only the exit status
  matters. Never let a describe or get call print a full JSON response that may
  carry an identifier or value you did not mean to publish.
- **Keep PII out.** The scripts use `@simulator.amazonses.com` addresses and
  invented tenant names; do not log a real admin e-mail.

## Temp files

- Create temp files with `mktemp`, never a fixed path in `/tmp` that another
  process could read or pre-empt. `demo.sh` holds the HTTP response body in a
  single `mktemp` file and nothing secret is written to disk beyond the
  in-flight request or response.
- Remove every temp file on exit, including the failure path — do it from the
  `trap` handler (below), not only at the end of the happy path.

## Failure behaviour and cleanup

- `set -euo pipefail`, plus a `: "${VAR:?...}"` guard for each required input
  (`AWS_REGION`, and the tools the script needs), so a missing input fails
  fast with a message that names it.
- Register an `EXIT` trap that cleans up whatever the script created. `demo.sh`
  deletes the tenant it onboarded and removes its temp file on every exit,
  success or failure; `integ.sh` destroys every stack it deployed from a `trap`
  so the destroy runs even when the deploy or the scenario fails, and then
  checks that nothing was left behind.
- Exit non-zero on any failure, and name the resource, operation, or
  parameter that failed (name, not value) so the log is diagnosable without a
  re-run. Never swallow an error into a success exit.

## Scope

These conventions apply to every script in this directory (`demo.sh`,
`integ.sh`) and any script added later. They are the local-script counterpart
of `docs/sample-standard.md` §4.4 (no secrets, tokens, or caller payloads in
logs).
