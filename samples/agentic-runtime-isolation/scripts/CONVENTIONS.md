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
- Exit non-zero on any failure, naming the step, resource or parameter that
  failed (name, not value). Never swallow an error into a success exit.

## Published parameters and who owns them

The scripts read this sample's published parameters under the ingress's
`registryPrefix` (default `/application-plane/shared/agent-runtime/`,
`PARAM_PREFIX` in `lib.sh`) and never write the ones a stack owns
(ADR-0024):

| Parameter | Owner | Scripts |
|---|---|---|
| `endpointUrl`, `ingress`, `ingressRoleArn`, `ingressId`, `tenantRoleArn`, `gatewayIdentifier` (`agentcore-gateway` only) | the ingress stack (`SharedIngress`) | read only (`demo.sh`, `integ.sh`, `perf.sh`) |
| `runtimeArn` | the one-backend demo stack | read only |
| `backends/<name>` | the stack that deployed that `AgentBackend`; its custom resource writes `active`, `draining`, then removes the entry | read only, except `backends/late` |
| `backends/late` | `integ.sh` step 9-registry, written with `aws ssm put-parameter` to show a backend added after the ingress deploy; it names billing's Runtime and `billing/invoke` (an entry must carry `scopes`, ADR-0025) | the script deletes it at the end of the step and again from the `EXIT` trap, so a failed run leaves no route behind |

The scripts also call tenant-identity's platform API with SigV4 (`platform`
in `lib.sh`): `CreateTenant` with the tenant's `scopes`, `IssueToken`,
`DeleteTenant`, and `GET /platform/scopes` to tell a stale deployment from
one with the scope catalogue (ADR-0025). The tenant admin's cut of a user's
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
