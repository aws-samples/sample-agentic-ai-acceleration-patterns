<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# Agentic runtime isolation: deployment integration test

This file describes the sample's deployment integration test, as the
[sample standard §5.3](../../docs/sample-standard.md#53-integration-test-document-integration-testmd)
lays it out. The [README](./README.md) carries the command and a link here.

## What it is

The deployment integration test ([`test/integ.runtime.ts`](./test/integ.runtime.ts),
driven by [`scripts/integ.sh`](./scripts/integ.sh)) is the reference
implementation of this sample's wiring ([sample standard
§5.2](../../docs/sample-standard.md#52-integration-test)): it deploys or
reuses tenant-identity through its own deploy path, registers the vendor
scopes, wires the stacks through the published document where a consumer
would, writes subscriptions, a plan and a cut through the Entitlements API,
drives every step through the public routes, and tears everything down. It
is the reference for the composition of this sample with tenant-identity.
Its steps are named and ordered as the [step table](#steps).

## How to run it

Use a non-production, CDK-bootstrapped account, in exactly one Region: the
script fails fast when `AWS_REGION` is unset.

```bash
AWS_PROFILE=<profile> AWS_REGION=eu-central-1 npx projen integ
```

Optional knobs:

| Variable | Default | Effect |
|---|---|---|
| `INTEG_PREFIX` | `RuntimeIsolationInteg` | stack prefix |
| `INTEG_PUBLISHER` | `api-gateway` | the stack that writes the published document, or `none` |
| `INTEG_MODEL_ID` | the Region's `defaultModelId` ([`test/integ.runtime.ts`](./test/integ.runtime.ts)) | the model id the stacks are deployed with |
| `INTEG_REPLACE_STALE_IDENTITY=1` | unset | replaces a tenant-identity without the scope catalogue, and so deletes every other consumer's tenants and users |

## What it stands up

It reuses tenant-identity `shared-pool` (and `shared-pool-multi-tenant`), or
deploys them through their own deploy path, and registers the vendor scopes
`app/use` and `entitlements/admin` (step 1). It then deploys six stacks at
once (`--concurrency 6`; `INTEG_DEPLOY_CONCURRENCY=2` when the Region's API
Gateway control-plane quota is at its default, where six REST APIs at once
have thrown a `CreateModel` 429 in us-east-1 and eu-central-1):

| Stack suffix | Ingress | Modules |
|---|---|---|
| `api-gateway` | `api-gateway` | everything on, both agents, both tools gateways, demo tenant data, per-tenant metrics; publishes the document |
| `agentcore-gateway` | `agentcore-gateway` | the same, not publishing, per-tenant metrics off |
| `session-off` | `api-gateway` | session off, the default `TenantModelRole` |
| `session-user` | `api-gateway` | `session: { scope: 'user' }` |
| `limits` | `api-gateway` | tenant limit 5 per minute, the scope floor `app/use` |
| `multi-tenant` | `api-gateway` | `identity.multiTenant` on a second tenant-identity, `shared-pool-multi-tenant` |

On the stacks it creates tenants A (users A1, A2, admin AA) and B (B1), plan
`standard` and the subscriptions, and AA cuts A2 from `crm/update_case`
(step 2). It destroys everything from the exit trap, also on failure, and
verifies nothing is left (step 10).

## Steps

Steps 3 to 24 run on both all-on stacks except 9-drain and 12-late, which
run on `api-gateway` only: the `agentcore-gateway` ingress needs a Gateway
target per agent, which the agent added after the deploy does not get.

| Step | What it checks |
|---|---|
| 1 | tenant-identity `shared-pool` reused or deployed (and `shared-pool-multi-tenant`); vendor scopes `app/use`, `entitlements/admin` registered |
| 2 | synth and deploy the six stacks; tenants A (users A1, A2, admin AA) and B (B1); plan `standard`; subscriptions; AA cuts A2 from `crm/update_case` |
| 3 | direct `InvokeAgentRuntime` with the runner's own credentials is denied (P-1) |
| 4b | session `tenant` scope: B1 with A1's conversation lands in B's unit; A2 sharing it shares A1's |
| 5 | A1 resumes its conversation on the same microVM |
| 6 | no token, tampered token, ID token, malformed `conversationId`: refused |
| 7 | grants: `scope`, `tenant_id`, `agent`, `aud` and `act.sub` per caller |
| 8a | TVM: own tenant item read, other tenant's denied in IAM; the runner cannot assume the tenant role |
| 8b | a model prompt ends with `event: usage` |
| 9 | latency: 20 `report` calls with a cold mint cache, 20 warm; TTFB and total p50/p95 |
| 9-registry | registry entries carry `needs`, `tools` and `version`; unknown agent refused; on `api-gateway` an agent added after the deploy is served within 90 s |
| 12-late | an agent with `needs` only is served; its token names no tools gateway |
| 9-drain | the late agent, once `draining`, is refused within 90 s |
| 11 | the identity token stays at the ingress: header names, `typ: txn+jwt`, `iss` the ingress; the tool's context holds no token |
| 12 | agent subscription: B1 on `billing` 403; AA cuts A1 from `billing` (next request 403), deletes the cut (200); on `api-gateway` the tenant-admin routes refuse a token without the admin scope (403 `admin_scope_missing`), an `X-Tenant-Id` naming a foreign tenant (403) and an unsigned vendor call (403) |
| 13 | tenant tool subscription: B1 lists the `crm` tools on `default` and nothing of `finance`; B1's `crm/update_case` refused by the interceptor |
| 14 | agent product bound: `default`'s token cannot reach `finance`; with `finance` in `aud` the interceptor refuses; A1 on `billing` is served |
| 15 | cross-tenant: an altered `tenant_id` is 403 at the Gateway; a client `_ri_ctx` for B is overwritten; B1 gets B's data |
| 16 | a cut lands at once for new mints, and at `exp` for a token in flight |
| 17 | interceptor and Gateway checks on minted tokens: no `act`, wrong `aud`, a foreign gateway, an identity token |
| 18 | the ingress refuses its own transaction token as an identity token |
| 19-tenant_id | A1 (a `tenant_id` token) with `X-Tenant-Id` B: 403 `tenant_not_allowed` |
| 20 | tool data isolation: the `crm` Lambda without a context assumes no role; the tool's credentials cannot read tenant B |
| 22 | partial-target grant: A2 served `crm/get_account`, refused `crm/update_case` by the interceptor; the Lambda is not invoked |
| 23 | one star permit per target (`crm` on `default`, `invoices` on `finance`); time to ACTIVE recorded |
| 24 | list filter on `finance`: a cut `list_invoices` disappears from A1's list and comes back; a failing filter lists nothing, the call is still served |
| 25 | delegation (ADR-0048, `api-gateway` only): `default` hands A1's transaction to `billing`; the relayed report is `billing`'s with chain `[default]`, the same `scope` as A1's direct call and the caller's `txn`; `billing` to `default` and `default` to itself are `delegation_not_declared`, B1 `agent_not_subscribed`, a chain that comes back to `billing` `delegation_loop`, a chain at `maxDepth` `delegation_depth`; an identity token on `/delegations` and a transaction token on `/invocations` are refused |
| 4a | `session-off`: `conversationId` is 400; two requests land in two units |
| 4b-user | `session-user`: A2 sending A1's conversation lands in its own unit |
| limits | `limits`: tenant A limited at 5 a minute, B served; the scope floor `app/use` admits both |
| 19 | `multi-tenant`: user MU in tenants A' and M: no header refused, B' not allowed, M and A' each their own grant and data |
| 21 | key rotation on `api-gateway` (redeploy with `keyGeneration` 2): the JWKS lists both `kid`s; the old token is accepted until `exp`; new tokens carry the new `kid` |
| 20-cloudtrail | no `AssumeRole` on the `crm` tool tenant role for the direct invoke (with a positive control) |
| sweep | no token, signature segment or `_ri_ctx` value in any log group on the path; the Runtime groups are read with `--unmask` (their policy would otherwise hide a leak), and `LogEventsWithFindings` over them is 0 |
| mask | probe lines in one Runtime group (a fake JWT, credential header and decoded credential object in three spellings) read back masked, a plain line unchanged, `--unmask` returns the originals (ADR-0047) |
| 8b-metrics | per-tenant `ModelOutputTokens` for tenant A on `api-gateway`; none on `agentcore-gateway` |
| 10 | destroy from the exit trap (also on failure) and verify nothing is left |

That is 36 rows; the 22 per-ingress rows run on both all-on stacks, so the
table the script prints holds 58 steps.

## Runtime and cost

A run takes **about 45 minutes** and costs **about $3 per run** at on-demand
rates, mostly AgentCore Runtime session time and the Gateways across six
stacks. Last green integration run: run 18, 2026-11-09, us-east-1, 58/58
steps (step 25 SKIP on `agentcore-gateway` by design); timings and coverage
are in the
[`architecture.md` status block](./architecture.md).

## After an interruption

The destroy runs from the script's exit trap, also when the deploy or a
step fails, and the run fails if anything the stacks owned is left. When
the script itself is stopped before the trap runs, look for and remove by
hand, in the Region of the run:

- CloudFormation stacks named `<INTEG_PREFIX>-*` (default
  `RuntimeIsolationInteg-*`), including any in `DELETE_FAILED`.
  CloudFormation refuses updates to those, so a rerun beside them needs
  another `INTEG_PREFIX`; the leftover check is scoped to that prefix.
- The fixed-name SSM parameters the publishing stack wrote, the log groups
  the stacks owned, the AgentCore Runtime log groups of the deployed
  agents, the DynamoDB tables, the Gateways and the Policy engines of the
  run. The script records each of these at deploy time and checks them
  after the destroy ([`scripts/integ.sh`](./scripts/integ.sh)).

The tenant-identity `shared-pool` stacks are a shared fixture of the
account and stay; the run never destroys them unless it deployed them
itself.

## Test-only shortcuts

- The test reads stack outputs for the values a step needs, because the
  non-publishing stacks write no parameters
  ([ADR-0044](./adr/0044-publish-from-the-construct-and-drive-the-integration-test-with-the-cdk-cli.md)).
  A consumer wires through the published document instead, as the test does
  wherever a consumer would.
