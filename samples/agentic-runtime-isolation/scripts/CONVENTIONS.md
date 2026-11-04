<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# Script Conventions

Conventions for the shell scripts in this directory. They run locally against
a deployed `RuntimeIsolation-<ingress>` stack (`demo.sh` walks the primary
flow; `integ.sh` drives the deployment integration test, spec §8; `perf.sh`
measures client-seen latency, ADR-0009 and ADR-0023). What they
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
  `read.result`) instead. Good, the status, the tenant and the prefix the
  agent derived:

  ```bash
  echo "step 5 ${TENANT}: HTTP ${status} prefix=$(jq -r .sessionPrefix "$BODY")"
  ```

  Bad, the token is now in the terminal and in any CI log:

  ```bash
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
  temp files on every exit; `perf.sh` deletes its tenant and, unless
  `PERF_OUT` asked to keep the raw samples, its output directory; `integ.sh` destroys every stack it deployed from
  the trap, so the destroy runs even when the deploy or a step fails, and
  then checks that nothing it created was left behind: stacks with the
  sample's prefix, plus the log groups and SSM parameters its own stacks
  owned. It ignores parameters under `/application-plane/shared/agent-runtime/*`
  that another deployment wrote.
- `integ.sh` deploys the stacks of `test/integ.runtime.ts` at once and
  destroys them together from the trap. Each stack has its own entitlement
  store, so their name reservations never collide; they all pass
  `owner: 'RuntimeIsolationInteg'` (ADR-0035). After the destroy the trap
  checks: no stack with the sample's prefix, none of the stacks' parameters,
  log groups (the Runtimes' own included), tables, Gateways or Policy
  engines left, every KMS key pending deletion, and each tool target's
  policy deleted before its target (ADR-0040, from the deleted stacks'
  events).
- `integ.sh` never replaces a published tenant-identity on its own. v2
  needs a `shared-pool` deployment with the scope catalogue (it registers
  the vendor scopes `app/use` and `entitlements/admin` there, spec §6.4);
  one without `/platform/scopes` is stale, and the script fails and names
  the fix unless `INTEG_REPLACE_STALE_IDENTITY=1` is set, because the
  replacement deletes the shared user pool and every other consumer's
  tenants and tokens with it. The vendor scopes are removed at the end only
  when this run added them, and the trap checks they are gone.
- The user in several tenants (step 19) signs in at a second tenant-identity
  deployment, `TenantIdentity-shared-pool-multi-tenant`, deployed beside the
  first with `publishSharedParameters=false` when it is not there and
  destroyed at the end only then. `INTEG_SKIP_MULTI_TENANT=1` skips it.
- Assertions in `integ.sh` do not exit: each records a failure for its step,
  the run goes on, and the step table (step | PASS/FAIL/SKIP | evidence) is
  printed at the end, also after a failure. Only set-up that later steps
  cannot do without calls `fail`. The exit status is non-zero when any step
  failed. Evidence names statuses, counts, tenant ids and claim names or
  values that are not credentials; never a token.
- The test-only mint (`test/integ/mint.function.ts`) exists on the
  integration stacks only. The script invokes it with its own credentials;
  the token comes back in a mode-0600 file and goes straight into a shell
  variable. The signature segment of every token and context the run
  handles is kept (mode 0600) for the log sweep, which pulls every log
  group on the path and fails on any `eyJ`, signature segment or `_ri_ctx`
  value (spec §8, v1 V-7).
- Exit non-zero on any failure, naming the step, resource or parameter that
  failed (name, not value). Never swallow an error into a success exit.

## Published parameters and who owns them

The scripts read this sample's published parameters under the ingress's
`registryPrefix` (default `/application-plane/shared/agent-runtime/`,
`PARAM_PREFIX` in `lib.sh`) and never write the ones a stack owns
(ADR-0024):

| Parameter | Owner | Scripts |
|---|---|---|
| `ingress`: one JSON document (`version: 2`, `ingress`, `endpointUrl`, `baseUrl`, `ingressRoleArn`, `ingressId`, `tenantRoleArn`, `gatewayIdentifier` on `agentcore-gateway`, `issuer`, `jwksUrl`, `entitlementsTableName`, `entitlementsApiUrl`, `toolContextKeyId`, `toolsGateways`; ADR-0042) | the ingress stack (`SharedIngress`) | read only, with `jq` (`demo.sh`, `perf.sh`); `integ.sh` reads stack outputs |
| `backends/<name>` | the stack that deployed that `AgentBackend`; its custom resource writes `active`, `draining`, then removes the entry | read only, except `backends/late` |
| `backends/late` | `integ.sh` step 9-registry, written with `aws ssm put-parameter` to show a backend added after the ingress deploy; it names billing's Runtime, `needs: ["late/run"]` and `tools: []` (the v2 shape, spec §4.3). Its `NAME#late` reservation row, which a vendor subscription needs (spec §5.3), is written into the entitlement store the same way | the script deletes both at the end of the step and again from the `EXIT` trap, so a failed run leaves no route or row behind |

The scripts also call tenant-identity's platform API with SigV4 (`platform`
in `lib.sh`): `CreateTenant` with the tenant's `scopes`, `IssueToken`,
`DeleteTenant`, and `GET /platform/scopes` to tell a stale deployment from
one with the scope catalogue (ADR-0025); (v2) `integ.sh` also puts and
deletes the vendor scopes and calls `CreateMembership`, and calls this
sample's entitlement API: the vendor operations with SigV4 (`vendor`) and
the tenant-admin operations with the tenant admin's identity token
(`admin_api`). The tenant admin's cut of a user's
scopes goes through the tenant API with a bearer token narrowed to
`tenant-admin/users` (`set_user_scopes`). The scopes the scripts create
tenants with (`DEFAULT_SCOPE`, `BILLING_READ_SCOPE`, `BILLING_INVOKE_SCOPE`
in `lib.sh`) must match `DEFAULT_SCOPES` and `BILLING_SCOPES` in
`src/demo.cdk.ts`: a tenant created without them holds no scope and every
token is refused at the ingress.

A script that writes a registry entry owns its deletion. Never overwrite a
`backends/<name>` entry a stack wrote: CloudFormation does not see the
change, and the stack's delete would race the drain.

## Scope

These conventions apply to every script in this directory (`demo.sh`,
`integ.sh`, `perf.sh`) and any script added later. They are the local-script counterpart
of `docs/sample-standard.md` §4.4 (no secrets, tokens or caller payloads in
logs) and of spike V-7 (no header value on any log on the path).
