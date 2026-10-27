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
  are not credentials (`tenant_id`, `scope`, `token_use`) instead. Good, the
  status and non-secret claims only:

  ```bash
  echo "ExchangeToken -> HTTP ${status}"
  claims "$NARROWED" | jq -c '{tenant_id, scope, token_use}'
  ```

  Bad, the token is now in the terminal and any CI log:

  ```bash
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
- **Report an AWS CLI failure by error class, not by its text.** Capture
  stderr to a file, extract the class in `An error occurred (Class) when
  calling ...` and print that beside the resource name
  (`get-parameter /application-plane/shared/identity/apiUrl failed
  (AccessDeniedException)`). Only `ParameterNotFound` means "missing": any
  other class is a different problem and must not be reported as one. The
  full CLI text can carry request details, so it stays in the file.

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
  checks that nothing was left behind. `integ.sh` and `integ-control-plane.sh`
  share those leftover checks through `integ-lib.sh`.
- **Guard every command inside an `EXIT` trap.** The trap runs under
  `set -e`; one throttled `describe-*` call would otherwise abort it halfway
  and skip the remaining cleanup. Append `|| true` to reads, and record
  `status=1` (then carry on) for a delete that fails, so the trap always
  reaches its final report and exit.
- Exit non-zero on any failure, and name the resource, operation, or
  parameter that failed (name, not value) so the log is diagnosable without a
  re-run. Never swallow an error into a success exit.

## Scripts that run in CodeBuild (`control-plane/`)

`control-plane/{tenant,cell}/*.sh` and `control-plane/lib.sh` are the mount
the `control-plane` sample runs in its tenant and cell CodeBuild projects
(ADR-0028, [control-plane mounting spec](../design/control-plane-mounting.spec.md)
§7). They follow everything above plus the control-plane sample's own
`scripts/CONVENTIONS.md`, because their output lands in a CloudWatch log group
readable by anyone with log-group access:

- **Inputs are environment variables, guarded.** `TENANT_ID`, `TENANT_NAME`,
  `CELL_ID`, `OPERATION`, `ADMIN_EMAIL` (create only), `OPERATOR_ID` and
  `AWS_REGION` (spec §6.1), each behind a `: "${VAR:?...}"` guard, before
  `lib.sh` is sourced.
- **Log the operator beside the tenant id** (`OPERATOR_ID`, spec §3.3), so a
  platform-API access-log line, which shows only the build role, can be joined
  to the operator through the build log.
- **One door to the platform API.** Every call goes through
  `platform_call METHOD TEMPLATE [BODY]`, which prints exactly
  `"<METHOD> <path-template> -> HTTP <code>"` (the template, with
  `{tenantId}` unexpanded) and returns the status and body in
  `PLATFORM_STATUS` / `PLATFORM_BODY`. Nothing else prints a URL or a body.
- **Secrets never touch a command line.** Other local users can read
  `/proc/<pid>/cmdline` while a command runs, so nothing secret goes on argv,
  the parked password included. SigV4 credentials go to `curl` through
  `--config -` on stdin; request bodies and the password go through
  `lib.sh`'s mode-0600 scratch file: `--data-binary @file` for `curl`, and
  `--value "file://$PLATFORM_REQUEST_FILE"` for `aws ssm put-parameter ...
  > /dev/null` (the CLI reads the string from the file). Truncate the file
  after each use, `unset` the variable that held the value, and `unset
  PLATFORM_BODY` once the password has been taken out of a response.
- **A failed park is retried.** The temporary password exists nowhere but in
  the build's memory until `put-parameter` succeeds, so a transient SSM or
  KMS error gets three attempts with a short backoff before the build fails
  naming the parameter.
- **A 409 is verified before it becomes success.** tenant-identity answers
  409 both for "the first-admin slot is held" and, in a shared pool, for "the
  e-mail is already taken" (after releasing the slot). After the slot's 409,
  `create.sh` reads the user list and requires an admin; after
  `CreateTenant`'s 409 it re-reads the tenant and fails naming the e-mail as
  the probable cause when the tenant is still absent. A read AFTER the
  conditional write does not contradict ADR-0032.
- **Replay is the recovery path** (spec M-P-3). Read state first, write only
  what is missing, treat "already there" and "already gone" as success, and
  exit non-zero for anything else, naming the operation and HTTP status.
- **Unit-tested with stubs.** `test/scripts/` runs every script with `aws` and
  `curl` replaced on `PATH`, covering each branch of spec §7 and asserting
  that no stub ever sees a password, e-mail or credential in its argv (the
  password is read back from the `file://` the park names), and that no
  scratch file survives the process.

## Scope

These conventions apply to every script in this directory (`demo.sh`,
`integ.sh`, `integ-control-plane.sh`, `integ-lib.sh`, `control-plane/`) and
any script added later. They are the
local-script counterpart of `docs/sample-standard.md` §4.4 (no secrets,
tokens, or caller payloads in logs).
