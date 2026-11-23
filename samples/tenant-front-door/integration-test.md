<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# Tenant front door: integration test

This file describes the sample's integration test, as the
[sample standard §5.3](../../docs/sample-standard.md#53-integration-test-document-integration-testmd)
lays it out. The steps are those of [spec §10](./design/tenant-front-door.spec.md#10-integration-test-outline).

## What it is

[`scripts/integ.sh`](./scripts/integ.sh) drives two CDK apps,
[`test/integ.single.ts`](./test/integ.single.ts) and
[`test/integ.host.ts`](./test/integ.host.ts), whose stacks are built in
[`test/integ/stacks.ts`](./test/integ/stacks.ts)
([ADR-0028](./adr/0028-drive-the-integration-test-from-a-bash-driver.md)).
It deploys the front door with its own control plane in two accounts,
runs the steps below and tears everything down in the order of spec
§6.2.

The test is the reference implementation of the front door's wiring:
how the `TenantFrontDoor` construct, the control-plane sample (deployed
through its own app), its global hooks and `RouteHookAccess`, the demo
cell API and the `tenant-identity` shared pool fit together is read from
that code, not from prose.

## How to run it

Two non-production accounts:

- The **edge account**, the one your credentials point at. It holds the
  public hosted zone for the test domain and is CDK-bootstrapped in your
  Region and in `us-east-1`. It also holds the `tenant-identity`
  `shared-pool` deployment (and `shared-pool-multi-tenant` for a `single`
  run), whose published parameters the test reads and which it never
  changes or removes. Deploy `shared-pool-multi-tenant` beside the other
  with this command, run in `samples/tenant-identity`, because one stack
  owns the fixed-name parameters:

  ```bash
  npx cdk deploy TenantIdentity-shared-pool-multi-tenant --context topology=shared-pool-multi-tenant --context publishSharedParameters=false
  ```

  The account must hold no other front door in your Region (the edge
  parameter's name is fixed, spec §6.4), and API Gateway must have its
  CloudWatch Logs role set there, naming a role that exists. For an
  account without one, `test/integ/api-gateway-account.app.ts` sets it
  (deploy command in its header); it keeps the role when its stack is
  removed, because other API Gateway stages in the Region log through it.
  The driver checks the hosted zone, that no other front door is there,
  the `tenant-identity` deployments and the logs role before it creates
  anything; a missing CDK bootstrap fails the first deploy.
- The **control plane's account**, CDK-bootstrapped in your Region to
  trust the edge account, so the driver deploys into it with the edge
  account's credentials. It must hold no other control plane in that
  Region. Before it deploys, the driver reads this account, read only,
  through its CDK bootstrap lookup role, and refuses to start when a
  control plane (`/control-plane/tenant-api-url`) or a stack of the run's
  id is there.

Once, with credentials for the control plane's account:

```bash
npx cdk bootstrap aws://<CONTROL_PLANE_ACCOUNT_ID>/<REGION> --trust <EDGE_ACCOUNT_ID> --cloudformation-execution-policies arn:aws:iam::aws:policy/AdministratorAccess
```

In `samples/control-plane`, run `npm ci` once. Then, from this sample,
with credentials for the edge account that last at least five hours:

```bash
export AWS_REGION=eu-central-1
export TFD_INTEG_ACCOUNT_B=<CONTROL_PLANE_ACCOUNT_ID>
export TFD_APP_DOMAIN=<a name below the zone's apex>
export TFD_HOSTED_ZONE_ID=<the zone's id>
export TFD_DEDICATED_DOMAIN=<a second name in the zone, outside TFD_APP_DOMAIN>
npx projen integ
```

`npx projen integ:host` runs the `host` mode steps. A run takes hours;
start it from a shell that outlives it (`nohup`, `tmux`). The driver
needs bash 4.4 or later, GNU coreutils (`date +%s%3N` for millisecond
log windows), curl 7.75 or later (`--aws-sigv4`), jq 1.6 or later, the
Smithy CLI (the preflight builds the control plane's model) and AWS CLI v2.9
or later (`aws configure export-credentials`); on macOS, install them and put
them first on `PATH`.

| Knob | Default | Effect |
|---|---|---|
| `AWS_REGION` | none (required) | The control plane's Region; the edge stacks go to `us-east-1` |
| `TFD_INTEG_ACCOUNT_B` | none (required) | The control plane's account |
| `TFD_APP_DOMAIN`, `TFD_HOSTED_ZONE_ID`, `TFD_DEDICATED_DOMAIN` | none (required) | The test domain, its zone in the edge account, and step 14's domain |
| `TFD_INTEG_RUN_ID` | new per run | `[a-z0-9]{1,10}`, and not containing `aws`, `amazon` or `cognito`; names every stack, role, policy and application of the run |
| `TFD_IDENTITY_REGION` | `AWS_REGION` | The Region of the `tenant-identity` deployments |
| `TFD_ISSUER_DOMAIN` | reserved example endpoints | The `https://` origin of a Cognito domain (for example `https://<prefix>.auth.<region>.amazoncognito.com`) for the front door's `issuer` input |
| `TFD_INTEG_KEEP` | unset | `1` skips the teardown; run `scripts/integ.sh teardown <run id> <mode>` after. `scripts/demo.sh <run id>` walks the tenants of a kept `host` run: the run ends with tenant `b` suspended (step 18), and the demo sets it active first |

Both accounts use CDK's default bootstrap qualifier (`hnb659fds`): the test
apps use the default synthesizer, and the preflight reads the control
plane's account through its default lookup role.

`scripts/integ.sh plan [single|host]` prints the run's names, its deploy
order, its steps and its teardown order without an AWS call.

## What it stands up

`<p>` is `TfdInteg-<run id>`; the control plane's fleet is `tfdi-<run id>`.

| Stack | Account | Contents |
|---|---|---|
| `<p>-support` | edge | The vendor IdP (a Cognito pool whose trigger adds `role`), its operator and registrar reader clients and the reader secret; the edge operator role; a stranger role for step 12; the edge pair's probe policy |
| `<p>-cp-setup` | control plane | The source zip of the route hook, the `tfd-probe` hook and the demo application's scripts, in a versioned bucket; the home pair's probe policy; the driver's access role |
| `<p>-agent-ingress` | edge | The stand-in agent ingress ([ADR-0024](./adr/0024-test-the-agent-route-against-a-stand-in-ingress.md)) |
| `<p>-control-plane` | control plane | The control plane, through the control-plane sample's app, with the vendor IdP, a reader role, the registrar's client id and, after step 1, the `RouteHookAccess` policy |
| `tfdi-<run id>-cell-account` | edge | The account role pair with the run's external id, through the control-plane sample's app |
| `<p>-edge`, `<p>-main`, `<p>-edge-logging` | edge | The front door under test |
| `<p>-route-hook-access` | control plane | `RouteHookAccess` ([ADR-0027](./adr/0027-write-the-hook-parameter-from-the-registrar-url-input.md)) |
| `<p>-cell-a`, `<p>-cell-b` | control plane, edge | One demo cell API each |
| `<p>-test-role` | edge | The test role (spec §6.1) |

The run reuses the `tenant-identity` pools and tears down everything
else, in the §6.2 order, from an `EXIT` trap.

## Steps

| # | Step | What it checks |
|---|---|---|
| 1 | Setup | Both accounts `ACTIVE` through `PutAccount` (the edge account tenant-owned with an external id), the front door, `RouteHookAccess` on the control plane, `ListHooks` names both front door hooks, the demo application `ACTIVE` |
| 2 | Tenants and fixture | `a` in cell A (control plane's account), `b` in cell B (edge account), each cell and deployment ran `front-door-post`, the route entries, the `host#` fixture |
| 3 | Headers | §7.1 headers on the SPA and the router's answers, `/logout` and `/signin-state` in `single` mode, a dedicated domain's `signInHost` |
| 4 | Cells | `/api/whoami` reaches each tenant's cell |
| 5 | 401 | No token, a `tenants` token, an oversized `Authorization`; no origin log line; an 8,192-byte header in `TestFunction` |
| 6 to 10 | Refusals | Unregistered tenant 403, forged payload refused by cell B, client route headers ignored, `Sec-Fetch-Site` 403, direct function URL 403 |
| 11 to 13 | Who may write | The pair roles' 403s (from the demo application's scripts), the operator's 400 and 409, a stranger's 403, a suspension a tenant cannot lift |
| 14 | Domain challenge | Tokens, mismatch, certificate, 409, the daily re-check (pass, third miss, metric), ACM's repeat request, the switch-off guard, the sweeper's delete |
| 15 | Telemetry | Per-tenant counts in the edge log, the registrar's access log and log |
| 16 | Delete hook | `b`'s route removed before its delete script |
| 17, 18 | `host` mode | Tenant hosts, the rate rules, the sign-in host |
| 19 to 21 | Hooks | An application without a front door, `tfd-probe` outside its operation, a cell event without `frontDoorApiDomain` |
| 22 | Skipped delete hook | A suspension across a re-created deployment |
| 23 | `/agents/*` | The rewrite, the 404s, the refusals, a suspension, one streamed call to the stand-in |
| 24 | Teardown | The fixture, then §6.2 in order, then the leftover check |

The `single` run runs steps 1 to 16 and 19 to 24; the `host` run steps
1 to 4, 11, 15, 17, 18, 23 and 24. Spec §10 lists what the steps leave to
unit tests.

## Runtime and cost

About four and a half hours for a `single` run (an estimate, not run) and
one hour for a `host` run (measured: 64 minutes). The stack deploy times
add up to about 21 minutes and the stack destroys to about 11 minutes
(stacks of one phase overlap, so less on the clock); the rest is step time,
including the control plane's script and hook builds, which run one at a time.
The driver prints each stack's deploy and destroy time at the end
(`.integ/<run id>/times.tsv`). The cost is a few dollars: CloudFront, a
few dozen short CodeBuild builds, one ACM certificate for `<dd>` and one or
two probe certificates for `probe.<dd>`, Lambda, DynamoDB and API Gateway
requests, all removed at the end.

Last green run: 2026-11-21, `host` mode, control plane in `eu-west-1`
(steps 1, 2, 3, 4, 11, 15, 17, 18, 23 and 24; the status block of
[`architecture.md`](./architecture.md) holds the coverage and what the run
did not exercise). 103 checks passed, 0 failed, 3 skipped.
Stack deploys took 1,289 s in all (the front door's main stack 375 s, the
control plane 116 s; stacks of one phase overlap), the teardown 633 s of
stack destroys, and the whole run 64 minutes including the leftover
check, which found 0. The cost was not measured; the estimate above
stands. `single` mode has not run.

## After an interruption

The driver saves the run's ids, and which deploy phase it reached, in
`.integ/<run id>/state.env`. Run `scripts/integ.sh teardown <run id>
<mode>` with the same environment: it runs every teardown part and ends
with the leftover check. Each part reports `done`, `skipped` or
`FAILED`. A part is skipped only when its resource is absent
(CloudFormation's "does not exist", or the service's own not-found
error) or the state shows it was never made; any other error, such as
expired credentials or access denied, fails it, and a rerun tries it
again. Before the first part the driver checks its credentials; when
they are gone it stops at once and prints the teardown command to run
once they are refreshed. While any part in or for the control plane's
account has failed, the driver keeps `<p>-cp-setup` and `<p>-support`,
because they hold its access role and the vendor IdP a rerun needs.
`scripts/integ.sh leftovers <run id> <mode>` runs the leftover check
alone: it exits 1 when something is left and 2 when a read failed, since
then it cannot say the accounts are clean. It also reads the run's
tenants in both `tenant-identity` deployments with `GetTenant`; a tenant
still there (for example in `DELETING`) is reported, and a teardown
rerun sends `DeleteTenant` again. By hand, look for stacks named
`TfdInteg-<run id>-*` and `tfdi-<run id>-*` in both accounts (and in
`us-east-1` of the edge account), the parameter
`/application-plane/applications/tfd-<run id>/shared/front-door-hook` in
the control plane's account, TXT records at `_tfd-challenge.<dd>`, and
certificates for `<dd>` and `probe.<dd>` in the edge account's
`us-east-1`. Default Lambda log groups under `/aws/lambda/TfdInteg-<run
id>` are expected leftovers of the CDK custom resources.

## Test-only shortcuts

| In the test | What a deployer does instead |
|---|---|
| The edge account is registered tenant-owned and hosts a tenant-owned cell (spec §6.1) | Keeps the edge account the vendor's alone |
| The step 2 fixture and step 14's sweeper items are written straight to the route table and the sweeper's table by the test role | Nothing: only the registrar and the sweeper write them |
| A throwaway vendor IdP whose trigger picks `role` from the user name | Configures its own vendor IdP (spec §6.1) |
| Hooks and scripts from an S3 zip, read through a bucket policy | Registers the hooks from the repository at a commit (spec §5.2) |
| The cells' origins are deployed ahead of the cells | Lets each cell script deploy its cell's origin |
| The pair roles hold a probe policy, and the demo application's scripts call the registrar on a test parameter | Nothing: a pair role never calls the registrar |
| A driver access role in the control plane's account writes the hook parameter, and reads the run's stacks, tenant namespaces and cell probe parameters | Nothing: only `RouteHookAccess` writes it |
| The driver reads stack outputs the sample does not publish: the main stack's `Integ*` outputs, which the test app adds from the construct's properties and its construct tree (route table, routing endpoint, router function, registrar and sweeper log groups, sweeper function and table), the edge logging stack's `IntegEdgeLog*`, `RouteHookAccess`'s `IntegHookPolicyArn` and `IntegHookParameterName`, and `TenantIdentity-shared-pool-multi-tenant`'s `ApiUrl` | Reads the edge parameter `/application-plane/shared/front-door/edge` for the registrar URL and the distribution, takes `routeTableArn`, `routingEndpoint` and `distributionId` from the `TenantFrontDoor` construct in its own CDK app, adds the `RouteHookAccess` policy through its own control-plane deploy, and reads `tenant-identity`'s published parameters (`/application-plane/shared/identity/*`), which only the `shared-pool` deployment publishes |
| The preflight reads the control plane's account through its CDK bootstrap lookup role | Nothing: a deployer knows what its own accounts hold |
| The driver retries an operator call to the registrar that answers 503 "control plane cannot be read", up to three times 5 s apart, notes each retry and counts them in the run summary | Retries the call by hand; the registrar already retries each control-plane read once (spec §3.4 step 2), so a 503 that reaches the driver is a read that failed twice, or failed in a way the registrar does not retry |
| Browser and issuer sign-in checks of steps 3 and 18 are run by hand | Runs them as part of its release checks |
