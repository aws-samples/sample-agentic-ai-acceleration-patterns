<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# Tenant Front Door for Agentic Applications

A multi-tenant agentic application serves one web client to every tenant,
and each tenant request must reach the cell that hosts the tenant. The
control plane places those cells across many AWS accounts: vendor-owned
accounts that fill and overflow, and tenant-owned accounts. This sample puts
one Amazon CloudFront multi-tenant distribution, in one edge account, in
front of a shared single-page application (SPA) and every cell's API. A
CloudFront Function, the tenant router, finds the request's tenant, looks it
up in a CloudFront KeyValueStore (the route table) and sends the request to
that tenant's cell. The control plane's own operations write the routes: a
vendor route hook, which the control plane runs on cell and deployment
events, calls a route registrar in the edge account. No role a cell account
holds can write a route.

The router finds the tenant in one of two ways, chosen at deploy time:

| Mode (`addressing`) | Tenants reach the app at | The router reads the tenant from |
|---|---|---|
| `single` (default) | one URL, `https://<appDomain>` | the `tenant_id` claim of the bearer token |
| `host` | one host each, `https://<tenant>.<appDomain>` | the host name |

A tenant can also bring its own domain (`dedicatedDomains`), after it proves
control of the domain with a DNS challenge. The edge refuses unknown and
suspended tenants before any origin, sets one web security header baseline
for every tenant, rate limits each tenant, and writes the tenant it routed on
into the access log.

**What this is NOT.** It is not an identity provider: the SPA signs in
against an issuer that meets the token contract
([`ARCHITECTURE.md`](../../ARCHITECTURE.md) §2.1). It is not the authoriser:
the router reads the tenant claim without checking its signature, and the
cell verifies the token. It is not the application: the demo cell API and the
demo SPA exist only to prove the routing and the browser baseline. It is not
tenant onboarding or placement: the control plane creates tenants and places
them in cells, and this sample registers each route and reads the placement
back to check it. It serves one Region per front door, with no failover
between cells.

- Design: [`architecture.md`](./architecture.md)
- Decisions and their reasoning: [`adr/`](./adr/) (indexed in [`adr/README.md`](./adr/README.md))
- Threats and mitigations: [`threat-model.md`](./threat-model.md)
- Working specification the sample was built from: [`design/tenant-front-door.spec.md`](./design/tenant-front-door.spec.md)
- Integration test: [`integration-test.md`](./integration-test.md)

## Architecture

![Components: a tenant user's request reaches a distribution tenant and the multi-tenant distribution, whose tenant router looks the tenant up in the route table and sends the request to the cell's API (or the SPA bucket for static files); the route hook, run by the control plane, calls the route registrar, which reads the cell or deployment from the control plane and is the only writer of routes; the sweeper reads the route table and removes dedicated tenants and certificates; each box names the pattern it carries](./diagrams/tenant-front-door.components.drawio.svg)

A tenant user's request reaches the distribution, the router looks the tenant
up in the route table, and CloudFront sends the request, signed, to the
tenant's cell, while the control plane's route hook calls the registrar, which
checks the record with the control plane and then writes the route table.

![Architecture: a tenant user calls the CloudFront multi-tenant distribution, whose Function looks the tenant up in the KeyValueStore and signs the request to the cell's Lambda function URL, or reads the SPA from S3; the control plane's CodeBuild route hook reads the hook parameter, calls the registrar's API Gateway, and the registrar Lambda reads the cell or deployment from the control plane API and writes the KeyValueStore; an optional EventBridge Scheduler runs the sweeper Lambda; the certificate, web ACL and access log are in us-east-1](./diagrams/tenant-front-door.drawio.svg)

A request goes from the tenant user through CloudFront and the router function
to the cell's Lambda function URL, and a route goes from the control plane's
CodeBuild route hook through the registrar's API Gateway and Lambda into the
CloudFront KeyValueStore.

The components:

- **Edge stack** (`us-east-1`): the ACM certificate for `<appDomain>` and the
  CloudFront web ACL with its rate rules.
- **Main stack**: the multi-tenant distribution with one pooled distribution
  tenant, the tenant router, the route table, the response headers policy,
  the SPA bucket and the route registrar (API Gateway and Lambda). With
  `dedicatedDomains` on it also holds the sweeper.
- **Edge logging stack** (`us-east-1`): CloudFront standard logging v2.
- **`RouteHookAccess` stack**, in the control plane's account: the front door
  hook parameter and the IAM policy that lets the control plane's global hook
  role read it and call the registrar.
- **Route hook** (`hooks/route-hook.sh`): runs in the control plane's global
  hook project and calls the registrar on cell and deployment events.
- **`CellRouteAccess`**, in each cell's stack: lets only the edge
  distribution invoke the cell's Lambda function URL.

The data path: a tenant user's request reaches CloudFront, the router names
the tenant and its cell from the route table, and CloudFront sends the
request to that cell's API with origin access control, which verifies the
token. Routes flow the other way: the control plane's route hook calls the
registrar, which checks the control plane and then writes the route table.

## How it works

1. **Deploy once.** The deployer deploys the front door, then its
   `RouteHookAccess` stack in the control plane's account, adds that stack's
   policy to the control plane's `globalHookManagedPolicyArns`, and registers
   the two global hooks with `scripts/register-hooks.sh` (see Deploy).
2. **A cell is created.** The control plane runs the application's cell
   create script. The script writes the cell's API host as the output
   `frontDoorApiDomain`. The `front-door-post` hook sends it to the
   registrar's `PutCellRoute`. The registrar reads the cell from the control
   plane, takes the account from that record, and accepts the host only as a
   Lambda function URL host in the control plane's Region.
3. **A tenant is placed.** When the control plane creates the tenant's
   deployment, the same hook calls `PutTenantRoute`. The registrar reads the
   deployment and the tenant from the control plane and writes
   `tenant#<tenantId>`, naming the cell. The route is live at the edge in
   about 30 seconds.
4. **A request arrives.** The router strips any client `x-tenant-*` header,
   finds the tenant (token claim in `single` mode, host in `host` mode),
   refuses an unknown tenant with 403 and a suspended one with 503, and sends
   the request to the cell's API with the token in `x-tenant-token` and the
   tenant in `x-tenant-route`.
5. **The cell decides.** The cell verifies the token's signature and refuses a
   tenant that differs from `x-tenant-route` or that its cell does not host.
6. **A tenant is removed.** The `front-door-pre` hook deletes the route
   before the delete script runs.

[`architecture.md`](./architecture.md) has the router steps, the registrar's
checks, the data model and the sign-in flows in depth.

## Deploy

### Prerequisites

- **Two non-production AWS accounts**, the edge account and the control
  plane's account. One account can play both roles, but the edge account
  should be the vendor's alone: a tenant-owned account's role pair deploys
  stacks, so a tenant-owned account in the edge account would hold the
  rights this design keeps from tenants.
- **CDK bootstrap** in the edge account for the control plane's Region and
  for `us-east-1`, and in the control plane's account for its Region.
- **A public Route 53 hosted zone** for `appDomain` in the edge account. In
  `single` mode `appDomain` is below the zone apex, because its record is a
  CNAME.
- **Node.js 24**, the [Smithy CLI](https://smithy.io/2.0/guides/smithy-cli/cli_installation.html)
  (`npx projen build` runs `smithy build`), `jq` and `curl` for
  `scripts/register-hooks.sh`, and the AWS CLI. Docker is not needed.
- **An API Gateway CloudWatch Logs role** already set for the edge account in
  the control plane's Region. The registrar's stage writes an access log, and
  the stack does not create the account-wide role (see
  [tenant-identity's Deploy prerequisites](../tenant-identity/README.md#deploy)
  for the check and the commands). Check with
  `aws apigateway get-account --region <REGION>`.
- **The [`control-plane`](../control-plane/) sample**, deployed from
  [its Deploy section](../control-plane/README.md#deploy), with:
  - `fleetName`, which is the `fleet` input below;
  - global hooks and two of its five global hook slots free;
  - a reader role in `readerRoles` for the registrar, and the registrar's
    vendor IdP client id in `vendorIdpClientIds` (and
    `vendorIdpRequiredScope` when that client can call another API). That
    client uses the client credentials flow, and the vendor IdP adds a
    `role` claim to its tokens (on Cognito, a pre token generation trigger
    on the V3 event, which needs the Essentials or Plus feature plan);
  - the application registered with `PutApplication`, whose cell create and
    update scripts write `frontDoorApiDomain` to `OUTPUTS_FILE`: the host
    name of the cell's API, a Lambda function URL host in the control
    plane's Region. [`test/integ/app/cell/create.sh`](./test/integ/app/cell/create.sh)
    is a worked script.
- **A secret** in the edge account and the control plane's Region, in Secrets
  Manager, that holds the registrar client's secret as a plain string. Its
  full ARN is `controlPlane.vendorIdp.clientSecretArn`.
- **An issuer** that meets the token contract and accepts the app's callback
  URL: `https://<appDomain>/` in `single` mode, which is also the sign-out
  URL; `https://login.<appDomain>/callback` in `host` mode, with no sign-out
  URL. [`tenant-identity`](../tenant-identity/) `shared-pool` or
  `shared-pool-multi-tenant` is the demo issuer. For
  `shared-pool-multi-tenant`, deploy it with `allowedOrigins` set to
  `https://<appDomain>` (`single`) or `https://*.<appDomain>` (`host`), in
  lower case, and set `exchangeEndpoint` in the `issuer` input to its
  `POST /oauth2/token` URL.
- **Cells** whose API verifies the token in `x-tenant-token` and refuses a
  tenant that differs from `x-tenant-route`
  ([`src/demo-cell/`](./src/demo-cell/) is the reference), with
  `CellRouteAccess` on the function (see "Use the constructs" below).
- Optional: [`agentic-runtime-isolation`](../agentic-runtime-isolation/)
  `api-gateway` ingress for `/agents/*`. Its published parameter
  `/application-plane/shared/agent-runtime/ingress` has `baseUrl`, the
  value of `agentIngress`.

### Inputs

The front door takes these inputs as CDK context (`--context name=value`;
structured inputs take JSON). Every input is checked at synth, with no
network call, and a wrong one fails with a message that names it. The
section marks (§) in the table refer to the
[specification](./design/tenant-front-door.spec.md).

| Input | Required | Default | Meaning |
|---|---|---|---|
| `appDomain` | yes | | Domain the app is served at, for example `app.example.com`. At most 64 characters, ACM's limit on a certificate's primary name. In `single` mode it sits below the `hostedZone` apex, because its record is a CNAME. Validated at synth |
| `hostedZone` | yes | | Public Route 53 zone for `appDomain`, in the edge account, as `{zoneId, zoneName}`. `appDomain` is `zoneName` or a name below it |
| `addressing` | no | `single` | `single`: one URL, tenant from the token. `host`: one host per tenant |
| `applicationId` | yes | | The control-plane application this front door serves |
| `controlPlane` | yes | | Control plane API URL, account id and Region, and the vendor IdP token URL and client the registrar uses to get a reader token. The client secret is a plain secret string in Secrets Manager, in the edge account and the control plane's Region, where the registrar reads it. The deployer lists that client id in the control plane's `vendorIdp.clientIds` (§6.1). The account id names the global hook role the registrar admits; the Region is the one every cell origin must be in (§3.4 step 3) |
| `fleet` | yes | | The control plane's fleet name (`fleetName`, `[a-z0-9][a-z0-9-]{0,31}`, control-plane §3.3), which names its global hook role, `<fleet>-global-hook`, the one control-plane role the registrar admits |
| `edgeOperatorRoleArn` | yes | | ARN of a role in the edge account that the registrar admits for the vendor-only calls: suspend and resume, `customDomain`, backfill, origin changes and clearing leftovers (§3.4). The deployer brings the role; the stack does not create it. Its account and partition are the edge account and partition that the secret and `alarmTopicArn` are checked against |
| `issuer` | yes | | The SPA's client id and scopes, and the issuer's authorize, token and logout endpoints as `https` URLs, or a Cognito user-pool domain they are derived from (`/oauth2/authorize`, `/oauth2/token`, `/logout`). Optionally `exchangeEndpoint`, an `https` URL, for an issuer that serves the multi-tenant token exchange on a URL other than its token endpoint (§3.5); omit it when the issuer serves the exchange at its token endpoint or no user holds a `tenants` token. Validated at synth, with no network call (§7.1) |
| `signinKeys` | no | `{ids: ["k1"], current: "k1"}` | `host` mode only: `{ids: string[], current: string}`, the `kid`s the `signin` key holds and the one that signs. Synth checks that `ids` holds one or two unique ids, each matching `[a-z0-9]{1,8}`, and that `current` is one of them (§4.1) |
| `tenantClaim` | no | `tenant_id` | Name of the claim that holds the tenant id. The router, the SPA and the origin read it (below) |
| `spaSource` | no | `build/spa` | Path of the built SPA, with `index.html` and `csp.json` at its root. The default is where `npx projen spa:build` writes the demo SPA |
| `agentIngress` | no | off | Agent ingress endpoint; omit to leave `/agents/*` off, and the router then answers 404 for every `/agents` path (§3.3 step 3) |
| `dedicatedDomains` | no | off | Lets the edge operator role set a tenant's `customDomain` (§3.4 step 5, ADR-0018). Off: any `customDomain` gets 400, the registrar role holds no ACM or distribution-tenant action, and the sweeper, its role, its table, its schedules and the starter are not deployed. A stack update that turns it off fails while any `tenant#` entry holds a `d` or the sweeper has a distribution tenant or certificate left to delete; the operator drops every dedicated domain first (§3.4) |
| `tenantRequestsPer5Min` | no | 2,000 | Per-tenant rate: at the edge per host in `host` mode, at the origin per verified tenant in `single` mode (ADR-0009). An integer from 10 to 2,000,000,000 |
| `ipRequestsPer5Min` | no | 500 | `host` mode only: the most requests one client IP may send to one tenant host's `/api/*` and `/agents/*` in 5 minutes before the edge answers 429, counted ahead of the per-host count (ADR-0021). One value for every tenant host; there is no per-tenant setting. A chosen value, not a measured one. Keep it below `tenantRequestsPer5Min`. A tenant whose users all reach the edge through one office NAT address shares one count: at 500 its whole user base gets about 1.7 requests per second before `tenantRequestsPer5Min` applies. Raising it raises it for every host. An integer from 10 to 2,000,000,000; set in `single` mode, synth fails |
| `reportingEndpoint` | no | off | URL for CSP and other browser reports, on for the whole session in both modes. No report carries the callback's code, because the first inline script removes it from the URL before anything loads (§7.1 Reports) |
| `registrarUrl` | no | none | The `registrarUrl` of this front door's edge parameter (§6.4), `https://<api id>.execute-api.<control plane Region>.amazonaws.com/v1/`, known once the main stack is deployed. Set, the app adds the `RouteHookAccess` stack in the control plane's account and Region (§3.1, ADR-0027); validated at synth |
| `alarmTopicArn` | no | none | ARN of an SNS topic in the main stack's account and Region. The construct adds it as the ALARM action of every alarm this specification defines: the three-miss, `unverifiable`, queue-depth, missing-pages and no-lister alarms of the sweeper (§3.4 step 5) and the 80 % route table alarm on the registrar's `RouteTableBytes` metric (§4.1). Every one of these alarms is in the main stack's Region, so one topic serves them all. The deployer owns the topic, its policy (it must allow CloudWatch to publish) and its subscribers. With no topic the alarms exist and notify no one |

`tenant_id` in the table means the claim that `tenantClaim` names.

### Build

```bash
npm ci
npx projen build
```

The build runs `smithy build`, compiles, runs the unit tests, builds the demo
SPA into `build/spa` (the default `spaSource`) and synthesises the app with
cdk-nag, using placeholder inputs that cannot reach a deployment. The tests of
the integration driver also need `npm ci` once in `../control-plane`.

### Step 1: deploy the front door

With credentials for the edge account. Put the inputs in a shell array once,
so the later commands reuse them. Replace the placeholders:

```bash
export AWS_REGION=<REGION>
FD_CONTEXT=(
  --context appDomain=app.example.com
  --context 'hostedZone={"zoneId":"<ZONE_ID>","zoneName":"example.com"}'
  --context applicationId=<APPLICATION_ID>
  --context 'controlPlane={"apiUrl":"https://<CONTROL_PLANE_API_HOST>/","accountId":"<CONTROL_PLANE_ACCOUNT_ID>","region":"<REGION>","vendorIdp":{"tokenUrl":"https://<VENDOR_IDP_HOST>/oauth2/token","clientId":"<REGISTRAR_CLIENT_ID>","clientSecretArn":"arn:aws:secretsmanager:<REGION>:<EDGE_ACCOUNT_ID>:secret:<SECRET_NAME>-<SUFFIX>"}}'
  --context fleet=<FLEET_NAME>
  --context edgeOperatorRoleArn=arn:aws:iam::<EDGE_ACCOUNT_ID>:role/<EDGE_OPERATOR_ROLE>
  --context 'issuer={"clientId":"<APP_CLIENT_ID>","scopes":"openid","cognitoDomain":"https://<COGNITO_DOMAIN>"}'
)
npx cdk deploy --all "${FD_CONTEXT[@]}"
```

This deploys `TenantFrontDoor-edge`, `TenantFrontDoor-main` and
`TenantFrontDoor-edge-logging` in the edge account. The stacks go to the
account of `edgeOperatorRoleArn`. Add `--context addressing=host` for one host
per tenant, and the optional inputs you need. The deployer brings the edge
operator role: the stack only names it.

### Step 2: deploy `RouteHookAccess` with the registrar's URL

The registrar's URL exists only once the main stack is deployed, and a stack
in another account cannot read it, so the app runs a second time with
`registrarUrl` (ADR-0027). Read the URL with the edge account's credentials:

```bash
aws ssm get-parameter --region <REGION> --name /application-plane/shared/front-door/edge --query Parameter.Value --output text | jq -r .registrarUrl
```

Then, with credentials for the control plane's account:

```bash
npx cdk deploy TenantFrontDoor-route-hook-access "${FD_CONTEXT[@]}" --context registrarUrl=<REGISTRAR_URL>
```

The stack writes the hook parameter
`/application-plane/applications/<applicationId>/shared/front-door-hook` and
the managed policy `tenant-front-door-route-hook-<applicationId>`. Read the
policy ARN from the stack's `RouteHookPolicyArn` output:

```bash
aws cloudformation describe-stacks --region <REGION> --stack-name TenantFrontDoor-route-hook-access --query "Stacks[0].Outputs[?OutputKey=='RouteHookPolicyArn'].OutputValue" --output text
```

A main stack update that replaces the registrar's REST API gives a new URL.
Deploy this stack again with the new URL before the application's next create
or update.

### Step 3: update the control plane's `globalHookManagedPolicyArns`

Add the policy ARN to the control plane's `globalHookManagedPolicyArns`
(keep the entries already there) and deploy the control plane again with the
context you deployed it with. Only a customer-managed policy in the control
plane's own account and partition is accepted. Without this step the hook
cannot read the parameter or call the registrar.

### Step 4: register the global hooks

With an operator token for the control plane, from this sample's directory:

```bash
export CONTROL_PLANE_URL=https://<CONTROL_PLANE_API_HOST>/
export CONTROL_PLANE_TOKEN=<OPERATOR_ACCESS_TOKEN>
export HOOK_SOURCE_VERSION=<40_CHARACTER_COMMIT_SHA>
bash scripts/register-hooks.sh
```

The script puts `front-door-pre` and then `front-door-post` with `PutHook`,
and checks them with `ListHooks`. It is safe to rerun. `HOOK_SOURCE_VERSION`
pins `samples/tenant-front-door/hooks/route-hook.sh` to a full commit SHA.
`HOOK_SOURCE_LOCATION` (default this repository's clone URL),
`HOOK_SOURCE_TYPE` (default `GITHUB`; `S3` takes a zip in a versioned bucket)
and `HOOK_TIMEOUT_MINUTES` (5 to 30, default 10) change the source. A
private repository or a fork needs the source credentials of the control
plane's provisioning projects. Run it before the application's first cell. The
two hooks serve every front door on the control plane, so one pin moves them
all.

### Cells that existed before the hooks

A cell created before the hooks has no route. The edge operator role backfills
it with `PutCellRoute` and each tenant with `PutTenantRoute`.

### Verify

In `single` mode the edge answers the SPA settings with no tenant:

```bash
curl -s https://app.example.com/config.json
curl -s -o /dev/null -w '%{http_code}\n' https://app.example.com/api/whoami
```

The first call returns the issuer's public settings. The second prints `401`:
no token, no tenant. In `host` mode the apex answers 404 and a tenant host
answers `/config.json` once its route is live.

Then create an application, a cell and a tenant through the control plane (see
the control plane's [README](../control-plane/README.md#deploy)), sign the
tenant's user in at the issuer, and call the demo cell:

```bash
curl -s -H "Authorization: Bearer <ACCESS_TOKEN>" https://app.example.com/api/whoami
```

The answer holds `tenantId`, `cellId` and `routeHint`. A route needs about 30
seconds to reach every edge location after the tenant's deployment is
`ACTIVE`; the hook waits up to 45 seconds for it. If the call answers 403, the
route is not live, or the tenant has no route: check that the hook parameter
exists in the control plane's account and that `ListHooks` names both hooks.

### Teardown

The front door has three pieces outside its own stacks: the two global hooks,
the `globalHookManagedPolicyArns` entry, and the hook parameter, which
`RouteHookAccess` keeps when its stack is deleted. The order matters. Out of
order, every create and update of the application fails and every delete waits
through three hook attempts, and `RouteHookAccess` cannot be deleted while its
policy is attached.

1. Delete the application's deployments, then its cells, through the control
   plane. The `front-door-pre` hooks remove their routes.
2. When this is the last front door on the control plane, run
   `scripts/register-hooks.sh --delete` (with the same
   `CONTROL_PLANE_URL` and `CONTROL_PLANE_TOKEN`).
3. Take the policy out of the control plane's `globalHookManagedPolicyArns`
   and deploy the control plane again.
4. With credentials for the control plane's account, destroy
   `TenantFrontDoor-route-hook-access`. It needs `registrarUrl` in the context,
   as in step 2:

   ```bash
   npx cdk destroy TenantFrontDoor-route-hook-access "${FD_CONTEXT[@]}" --context registrarUrl=<REGISTRAR_URL>
   ```

5. Delete the hook parameter it kept, in the control plane's account:

   ```bash
   aws ssm delete-parameter --region <REGION> --name /application-plane/applications/<APPLICATION_ID>/shared/front-door-hook
   ```

6. With credentials for the edge account, destroy the three front door
   stacks, last stack first:

   ```bash
   npx cdk destroy TenantFrontDoor-edge-logging "${FD_CONTEXT[@]}"
   npx cdk destroy TenantFrontDoor-main "${FD_CONTEXT[@]}"
   npx cdk destroy TenantFrontDoor-edge "${FD_CONTEXT[@]}"
   ```

   A custom resource on the distribution disables and deletes every dedicated
   distribution tenant and the certificates the registrar requested, then the
   distribution goes. This takes time, because CloudFront cannot delete a
   distribution that still has distribution tenants.

Then remove the cells' own stacks in their accounts, the issuer client's
callback URLs, and the registrar's secret. A parameter left behind in step 5
names a registrar that step 6 removes, so the application's next create or
update fails.

### Use the constructs

The pattern ships as constructs, exported from [`src/index.ts`](./src/index.ts).
Instantiate the front door in your own app with the inputs above as props:

```ts
import { App } from 'aws-cdk-lib';
import { TenantFrontDoor } from './src/index';

const app = new App();
new TenantFrontDoor(app, 'TenantFrontDoor', {
  appDomain: 'app.example.com',
  hostedZone: { zoneId: '<ZONE_ID>', zoneName: 'example.com' },
  applicationId: '<APPLICATION_ID>',
  controlPlane: {
    apiUrl: 'https://<CONTROL_PLANE_API_HOST>/',
    accountId: '<CONTROL_PLANE_ACCOUNT_ID>',
    region: '<REGION>',
    vendorIdp: {
      tokenUrl: 'https://<VENDOR_IDP_HOST>/oauth2/token',
      clientId: '<REGISTRAR_CLIENT_ID>',
      clientSecretArn: 'arn:aws:secretsmanager:<REGION>:<EDGE_ACCOUNT_ID>:secret:<SECRET_NAME>-<SUFFIX>',
    },
  },
  fleet: '<FLEET_NAME>',
  edgeOperatorRoleArn: 'arn:aws:iam::<EDGE_ACCOUNT_ID>:role/<EDGE_OPERATOR_ROLE>',
  issuer: { clientId: '<APP_CLIENT_ID>', scopes: 'openid', cognitoDomain: 'https://<COGNITO_DOMAIN>' },
});
```

It exposes `distributionId`, `distributionArn`, `routeTableArn`,
`registrarUrl`, `appDomain`, `addressing`, `pooledTenantId` and
`routingEndpoint`. A cell stack, in the cell's account, grants the edge
distribution access to its Lambda function URL with `CellRouteAccess`:

```ts
import { CellRouteAccess } from './src/index';

new CellRouteAccess(this, 'RouteAccess', { function: cellApiFunction, applicationId: '<APPLICATION_ID>' });
```

Without `distributionArn` it reads the ARN from the cell account's parameter
`/application-plane/applications/<applicationId>/shared/front-door`, which the
application's shared stack writes there as a plain string (ADR-0026).
`RouteHookAccess` is the third construct. The front door's published
parameters:

| Parameter | Account | Holds |
|---|---|---|
| `/application-plane/shared/front-door/edge` | edge | One JSON document: `version`, `appDomain`, `addressing`, `applicationId`, `distributionArn`, `registrarUrl`, `tenantClaim`, `reservedLabels` |
| `/application-plane/applications/<applicationId>/shared/front-door` | each cell account, copied by the application | The distribution ARN as a plain string |
| `/application-plane/applications/<applicationId>/shared/front-door-hook` | control plane's | One JSON document: `version`, `registrarUrl`, `appDomain`, `addressing` |

The main stack also has the output `RoutingEndpoint`, the CNAME target a
tenant gives its dedicated domain.

## Costs

Deploying creates billable resources in two accounts. The ones that grow
with use are CloudFront requests and data transfer, AWS WAF web ACL rules
and requests, CloudWatch Logs delivery and storage, API Gateway and Lambda
requests for the registrar, and, with `dedicatedDomains`, the sweeper's
Lambda, DynamoDB and SQS use, EventBridge Scheduler invocations and one ACM
certificate per dedicated domain. The control plane's cell builds are the
control plane's cost. The sample sets no prices: see the pricing pages of
CloudFront (multi-tenant distributions), AWS WAF and CloudWatch for current
figures.

Per-tenant attribution: a dedicated domain's certificate and distribution
tenant carry the cost allocation tag `TenantId`, which you activate. Pooled
tenants share one distribution tenant, so their requests and bytes come from
the access log's `viewer-request-log-data` field, which names the tenant the
router routed on. The fixed parts (registrar, route table, logging delivery,
web ACL) are not attributable per tenant. Apportion them, for example by
request count. The integration test records each stack's deploy and destroy
time.

## Deployment integration test

```bash
npx projen integ
```

It deploys the front door, its own control plane and two cells in two
accounts, runs the steps of `single` mode (1 to 16 and 19 to 24) and tears
everything down; a `single` run takes about four and a half hours, a `host`
run (`npx projen integ:host`) about two and a half, for a few dollars, both
estimates. Its inputs, steps and shortcuts are in
[integration-test.md](./integration-test.md).

## Tests

- **Unit tests**: `npx projen test` runs them (they run in `npx projen
  build` too). They live in `test/`, one folder per component: `router/`,
  `registrar/`, `sweeper/`, `edge/` (stack assertions and cdk-nag), `hooks/`
  (the route hook and `register-hooks.sh` against stub commands),
  `demo-cell/`, `spa/` and `integ/` (the driver's scripts and stacks).
- **Smoke scripts**: `scripts/smoke.sh deploy` and `scripts/smoke.sh check`
  deploy the front door in `single` mode with one demo cell and a stand-in
  control plane (`test/smoke/`), seed routes, and check the edge, the cell and
  the registrar live; `scripts/smoke-domains.sh` does the same for dedicated
  domains. They need `SMOKE_APP_DOMAIN`, `SMOKE_ZONE_ID` and `SMOKE_ZONE_NAME`
  (and `SMOKE_DEDICATED_DOMAIN` for the second) and the `tenant-identity`
  `shared-pool` deployment, and they leave the stacks up. Conventions are in
  [`scripts/CONVENTIONS.md`](./scripts/CONVENTIONS.md).
- **Integration test**: above.

## Registrar API

The registrar is modelled in [`model/routes.smithy`](./model/routes.smithy).
Every operation uses `AWS_IAM` and is idempotent. Only the two admitted
principals can call it: the control plane's global hook role
(`<fleet>-global-hook`) and the edge operator role.

| Operation | HTTP | Caller |
|---|---|---|
| `PutCellRoute` | `PUT /cells/{cellId}` | hook role, edge operator role |
| `DeleteCellRoute` | `DELETE /cells/{cellId}` | hook role, edge operator role |
| `PutTenantRoute` | `PUT /tenants/{tenantId}` | hook role; the edge operator role to set `customDomain` |
| `DeleteTenantRoute` | `DELETE /tenants/{tenantId}` | hook role, edge operator role |
| `UpdateTenantRouteStatus` | `PUT /tenants/{tenantId}/status` | edge operator role only |
| `DeleteHostRoute` | `DELETE /hosts/{host}` | edge operator role only |

A route status is `active` or `suspended`. A suspended tenant gets 503 with
`Retry-After: 300` at the edge. Only `UpdateTenantRouteStatus` changes it; a
hook's write keeps the stored status. Errors, and the dedicated domain
challenge, are in the specification §5.1.

## Security notes

- **Identity model.** A tenant user holds a token from the issuer. The router
  reads its tenant claim to choose a route and never trusts it (P-1); the
  cell verifies the signature and checks the route hint and its own tenants
  (P-4). The registrar admits the control plane's global hook role and the
  edge operator role, and no role a cell account holds, a tenant-owned
  account's role pair included (ADR-0017). It reads the control plane on
  every write and takes the cell and account from the control plane's record,
  never from a request.
- **Trust boundaries.** The edge account is the vendor's alone. The edge
  operator role is the vendor's own, and the stack only names it. Origin
  access control admits only the distribution to a cell's function URL
  (ADR-0011). A dedicated domain is routed only after a DNS challenge and
  never receives a sign-in code (ADR-0018).
- **Web baseline.** One response headers policy sets a hash-based CSP with
  Trusted Types, HSTS and the other headers on every response.
- **Static analysis.** cdk-nag runs at synth with every acknowledgement
  carrying its reason. The scan results and their dispositions are in the
  threat model's "Security review".

The full threat model, with every threat, mitigation and accepted risk, is in
[`threat-model.md`](./threat-model.md).

## Production hardening checklist

- [ ] **Keep the edge account the vendor's alone** and never register it as
      `owner: TENANT` (AR-6).
- [ ] **Protect the edge operator role** with the vendor's usual sign-in and
      multi-factor rule, and watch its calls in CloudTrail (AR-20).
- [ ] **Protect the hook parameter.** Only an administrator of the control
      plane's account can delete it, and deleting it switches routing off for
      that application without an alarm (AR-30).
- [ ] **Subscribe to the alarm topic** (`alarmTopicArn`). With no topic the
      alarms exist and notify no one (AR-25).
- [ ] **Admit only the distribution at the agent ingress.** A request sent
      straight to it skips the edge's refusals, a suspension included (AR-3).
- [ ] **Stop issuing tokens to a suspended tenant at the issuer.** A
      suspension holds at the edge only (spec §6.2).
- [ ] **Raise the ACM certificate quota** before routing more than a few
      hundred dedicated domains (spec §4.1; AR-18).
- [ ] **Add an edge rate rule in `single` mode, and size `ipRequestsPer5Min`**
      in `host` mode. The default is chosen, not measured (AR-8, AR-9).
- [ ] **Rotate the sign-in key** in `host` mode on a schedule (spec §4.1).
- [ ] **Ask the control plane for a role per global hook.** Every global hook
      runs under one role the registrar admits (AR-1).
- [ ] **Pin the hook source to a reviewed commit**, and move the pin for every
      front door at once.
- [ ] **Change the removal policies** of the SPA bucket and the log groups
      (`DESTROY` in this sample) and set retention to your policy.

## Known limitations

Open items and shortcuts. Each accepted risk is an `AR-n` in the
[threat model](./threat-model.md).

- **The integration test has no recorded green run.** The status block of
  [`architecture.md`](./architecture.md) holds the date, Region and coverage
  when one exists.
- **No end-to-end demo script.** The smoke scripts and the integration test
  are the runnable walk-throughs; no `scripts/demo.sh` exists.
- **The registrar retries a control-plane read once, inside 10 s.** A read
  that still fails answers 503 "control plane cannot be read" and writes
  nothing (spec §3.4 step 2). The caller retries; the integration driver does,
  up to three times.
- **One front door per edge account and Region**, because the edge
  parameter's name is fixed, and **one control plane per account and Region**.
- **A changed registrar URL goes stale.** A main stack update that replaces the
  registrar's API needs `RouteHookAccess` deployed again with the new URL
  (ADR-0027).
- **The hook parameter's name is fixed.** After a stack delete outside the
  ordered teardown, or a first create that rolled back, the next
  `RouteHookAccess` deploy fails until the parameter is deleted. A changed
  `applicationId` keeps the old application's parameter, and that
  application's creates and updates fail until it is deleted (spec §6.2).
- **A suspension holds at the edge only.** A cell in a tenant-owned account
  can serve its users while the tenant is suspended, and a token already
  issued stays valid until it expires (AR-4, AR-7).
- **Agent traffic that bypasses the edge** is not refused (AR-3).
- **A deployment deleted and created again resets its suspension** to
  `active` (AR-31). A skipped delete hook leaves a route (AR-23).
- **Route writes share one store ETag.** Sustained writes above about one a
  second, or a burst above about 100, fail creates (AR-29; estimates).
- **`single` mode has no edge rate rule.** The cell's per-tenant limit counts
  verified requests only (AR-8). In `host` mode a flood from many addresses
  can still reach a tenant host's limit (AR-9).
- **The tenant in the access log is the claimed tenant.** Billing-grade counts
  come from the cell's log (AR-10).
- **`/config.json` on a tenant host** confirms that the tenant exists and when
  its deployment was created (AR-11).
- **Not built** (spec §1.2): several Regions per tenant, failover between
  cells, moving a tenant between cells with no downtime, server-side
  rendering or a backend-for-frontend that holds tokens, per-tenant SPA
  versions, a collector for browser security reports, and origins other than
  Lambda function URLs and S3.
- **Per-tenant cost attribution of the fixed parts is not built**: only a
  dedicated domain's resources carry the `TenantId` tag.
- **Integration test shortcuts**, such as the edge account registered as
  tenant-owned and a throwaway vendor IdP, are listed in
  [`integration-test.md`](./integration-test.md#test-only-shortcuts). A
  deployment does not copy them.
- **Scans.** The threat model's security review records the ProtoShield
  scans of the sample, the integration test's stacks included, and the
  outcome of each finding. Rescan after your own changes.
- **The integration driver needs bash 4.4, GNU coreutils, curl 7.75, jq 1.6
  and AWS CLI v2** or later, and a unit test of the driver needs `npm ci` in
  `../control-plane`.

## Design trail

- Specification: [`design/tenant-front-door.spec.md`](./design/tenant-front-door.spec.md)
  and the [spike record](./design/spikes.md)
- Decisions: [`adr/`](./adr/) (indexed in [`adr/README.md`](./adr/README.md))
- Implemented state: [`architecture.md`](./architecture.md)
- Threats and mitigations: [`threat-model.md`](./threat-model.md)
- Integration test: [`integration-test.md`](./integration-test.md)
