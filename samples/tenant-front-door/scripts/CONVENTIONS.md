<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# Script Conventions

Conventions for the shell scripts in this directory and for the route
hook in `../hooks/`. `smoke.sh` and `smoke-domains.sh` deploy the front
door with one demo cell and a stand-in control plane in a test account,
and check the edge, the cell and the registrar live without the control
plane's hooks (design/spikes.md, Smoke run). `register-hooks.sh` puts or
deletes the front door's two global hooks on the control plane (spec
§5.2). What a script prints lands in the operator's terminal and, in CI,
the job log; what the route hook prints lands in the control plane's
hook build log. The scripts handle access tokens, temporary passwords and
SigV4 credentials, so none of those ever reach output.

## Log hygiene

- **Never use `set -x`.** Trace mode prints every expanded command line,
  bearer tokens and SigV4 keys included. Use `set -euo pipefail` only.
- **Never print a token, credential, password or header value.** Print the
  check name, the HTTP status, a tenant id, and at most the first bytes of
  a response body on a failed check. A response body here never holds a
  token: the edge, the cell and the registrar answer with status and
  identifiers only.
- **Credentials and tokens never go on a command line.** They reach `curl`
  through a config on stdin (`--config -`), and request bodies through a
  mode-0600 file, because other local users can read
  `/proc/<pid>/cmdline`.
- **AWS CLI output counts as output.** `aws sts assume-role` and
  `aws configure export-credentials` go straight into a variable.
- **Keep PII out.** Use `@simulator.amazonses.com` addresses and invented
  tenant names (`tfd-smoke-a-<pid>`).

## Temp files

- One `mktemp -d` directory, files mode 0600, removed from the `EXIT` trap
  on every exit.

## Failure behaviour and cleanup

- `set -euo pipefail`, plus a `: "${VAR:?...}"` guard for each required
  input, so a missing input fails fast and names it.
- The `EXIT` trap is armed before the first thing the run creates and
  removes all of it: the tenant-identity tenants (`DeleteTenant`), the
  tenant namespace parameters the demo cell's hosts check reads, and the
  routes it seeded. The route table it writes is the one named by this
  deployment's registrar function (`ROUTE_TABLE_ARN`), never one found by
  name.
- Checks do not exit: each prints PASS or FAIL, the run goes on, and the
  exit status is non-zero when any check failed.
- The stacks stay up after `check`. The operator removes them with
  `cdk destroy` in the order dns, cell, front door, control plane, support.

## Shared fixtures

The smoke uses the `tenant-identity` shared-pool deployment through its
published parameters (`/application-plane/shared/identity/*`) and its
platform API with SigV4: `CreateTenant`, `IssueToken`, `DeleteTenant`. It
never changes or removes the pool itself.

## The route hook

`hooks/route-hook.sh` is a control-plane hook script, so it also follows
the hook section of the control plane's
[`scripts/CONVENTIONS.md`](../../control-plane/scripts/CONVENTIONS.md):
it checks `EVENT`, `PHASE` and `HOOK_SCOPE` first, takes ids only from
the hook environment, treats `SCRIPT_OUTPUTS` as untrusted, logs ids and
statuses and never an output value, and exits non-zero on any failure.
Its credentials reach `curl` through a mode-0600 `-K` file in its own
`mktemp -d` directory, which the `EXIT` trap removes.

## Tests

`test/hooks/` runs `hooks/route-hook.sh` and `register-hooks.sh` with
bash against stub `curl`, `aws` and `sleep` commands placed first on
`PATH`. A change to either script keeps those tests passing. The smoke
scripts are checked by running them live.

## The stress slice

`stress/` follows the log hygiene and temp file rules above, and differs
in two places. The runner calls its verbs one at a time, so the stacks it
deploys stay up for the `teardown` verb, not for an `EXIT` trap, and
`teardown` removes the run's tenants, routes, parameters and stacks and
lists what it leaves. `seed` registers the vendor scope `app/use` on the
shared pool when the catalogue lacks it and leaves it there, because a
later run reuses it; it changes nothing else in the pool. See
[`stress/README.md`](./stress/README.md).

## Scope

These conventions apply to every script in this directory, the route
hook, and any script added later. They are the local-script counterpart
of `docs/sample-standard.md` §4.4.
