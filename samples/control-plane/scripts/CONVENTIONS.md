# Provisioning and Hook Script Conventions

Conventions for authoring cell and tenant provisioning scripts and hook
scripts run by AWS CodeBuild. Everything a script prints lands in the
build's CloudWatch log group, readable by anyone with log-group access.
Treat build logs as an audience, not a scratchpad — a script that echoes
fetched values turns the log group into an unintended secrets store.

## Log hygiene

- **Never use `set -x`.** Trace mode prints every expanded command line,
  including fetched parameter values, credentials in CLI arguments, and
  request payloads. Use `set -euo pipefail` only.
- **Never echo parameter or secret values.** Log the parameter NAME or path
  and a success/failure status instead:

  ```bash
  # Good — name and status only
  echo "Wrote /application-plane/cells/${CELL_ID}/shared-endpoint"

  # Bad — the value is now permanently in CloudWatch Logs
  echo "Endpoint is ${CELL_SHARED_ENDPOINT}"
  ```

- **The same applies to derived values** (URLs assembled from fetched parts,
  connection strings, tokens) and PII (email addresses, names). If the value
  wasn't safe to publish, neither is anything computed from it.
- **AWS CLI output counts as log output.** Suppress or narrow it: use
  `--query`/`--output text` into a variable, or redirect to `/dev/null` when
  you only need the exit status. Never let `get-parameter` print its full
  JSON response (it contains the value).

## Secret delivery

- Deliver secrets to builds via SSM SecureString or Secrets Manager
  references in the CodeBuild environment (`parameter-store:` /
  `secrets-manager:` env types). CodeBuild masks these values in the build
  log automatically — plaintext env vars and inline `get-parameter` values
  are not masked.
- Never pass secrets as plaintext environment variables or command-line
  arguments defined in an application's definition.

## Untrusted inputs

- **`TENANT_NAME` and `ADMIN_EMAIL` are operator-supplied free text.** The
  control plane passes them through unchanged (ADR-004, ADR-023); the name
  has only a length limit and may contain quotes, `$(`, backticks or
  newlines. Always expand them quoted (`"${TENANT_NAME}"`), never `eval`
  them or interpolate them into a command line, a URL, a file path or a
  resource name, and sanitise (or reject) them before using either as an
  identifier. The control plane delivers them as structured CodeBuild
  environment variables, so the first script that expands one unquoted is
  the first place an injection becomes possible.
- **`PARAM_<NAME>` values are operator-supplied free text too** (ADR-039,
  ADR-040): the control plane checks a value against its declaration (at
  most 1,024 bytes, no control characters) but never interprets it. Treat
  them like `TENANT_NAME`: quote them, never `eval` them, and log the
  variable name, never its value. A declared parameter with neither a
  value nor a default is unset, not empty, so test with `${PARAM_X+set}`
  when "not set" and "set to empty" differ. Values are plain text: a
  secret comes as the *name* of a Secrets Manager secret or SSM
  `SecureString` the script reads under its own role (spec N-11).
- A delete script finds what its create made through its namespace, never
  by recomputing names or sizes from `PARAM_` values: defaults are resolved
  per build, so a delete can see a different default from its create
  (spec R-35).
- `TENANT_ID` and `CELL_ID` are control-plane-generated ULIDs,
  `APPLICATION_ID` is operator-chosen but constrained to `[a-z0-9-]{1,32}`
  by the API, and `OPERATION` is a fixed verb, so the samples use them in
  parameter names and paths as-is. `OPERATOR_ID` is the verified `sub`
  claim of the operator's vendor-IdP token (ADR-019): fine to log or tag
  with, but quote it and treat it like free text anywhere else.

## Failure behaviour

- Exit non-zero on any failure — `set -euo pipefail` plus
  `: "${VAR:?VAR env var is required}"` guards for required inputs. The
  workflow maps a non-zero exit to `CREATE_FAILED`/`UPDATE_FAILED`/
  `DELETE_FAILED`; a script that swallows errors leaves the control plane
  believing provisioning succeeded.
- On failure, name the resource or parameter that failed (name, not value)
  so the build log is diagnosable without re-running.

## Scope

These conventions apply to every script referenced by an application's
definition (`cellScripts` and `tenantScripts`) and to every hook script
(ADR-044, ADR-045). The samples in `sample-cell/`, `sample-tenant/`,
`sample-noop/` and `sample-hook/` follow them and are the reference
implementations.

## Hook scripts

- A hook runs in the control plane account under its scope's hook role,
  never in a cell account. It has no role to assume and never sees the
  external id. It can call only what you attach to that role.
- **`SCRIPT_OUTPUTS` is untrusted.** It comes from the cell's account,
  which a tenant may own. Parse it with `jq`, check each value you use,
  and take the record you act on from `APPLICATION_ID`, `CELL_ID`,
  `CELL_ACCOUNT_ID`, `TENANT_ID` or `ACCOUNT_ID`, never from an output.
- **Make it idempotent.** A delete hook is retried, and a build can repeat.
  Key any write on `EXECUTION_ID`, `EVENT`, `PHASE` and `HOOK_ID`, which
  together name one hook run (spec R-42), so a second try changes nothing.
  `EXECUTION_ID` alone is not enough: one `CreateDeployment` that makes a
  new cell runs both `CELL_CREATE` and `DEPLOYMENT_CREATE`.
- **A non-zero exit refuses or fails the operation.** A failing `PRE` hook
  on a create or update stops it, and a failing `POST` hook marks it
  failed. On delete a failure is retried and then skipped, so a delete hook
  cannot block a delete.
- Check `EVENT` and `PHASE` first and exit non-zero on one the hook does
  not expect, so a wrong registration fails loudly (`name-gate.sh`).
- The same log rules apply: log ids, never `TENANT_NAME`, `PARAM_` values
  or output values (`audit.sh` logs output names only).
