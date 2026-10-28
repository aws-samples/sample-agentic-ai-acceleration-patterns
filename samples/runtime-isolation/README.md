<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# Runtime Isolation

A pooled agent backend where each tenant user's conversation runs in its own
compute unit, and the backend trusts exactly one ingress. The ingress verifies
the caller's access token, chooses the unit from the verified claims, vends
tenant-scoped credentials for every model call, limits each tenant's share,
and attributes cost per tenant. The backend is Amazon Bedrock AgentCore
Runtime (one microVM per session); the ingress is a deploy-time choice between
an API Gateway REST API and an AgentCore Gateway. Session mapping, scope checks
and delegation are optional modules, off by default. The token vending
machine (TVM) is always on (ADR-0018). It ships as CDK constructs:
`IsolatedRuntime` for one backend behind one ingress, and `SharedIngress`
plus `AgentBackend` for several backends behind one ingress (ADR-0024,
proposed), plus a thin demo stack.

**What this sample is NOT** (spec §1.2):

- Not a backend catalogue. Only the AgentCore Runtime backend is built
  (ADR-0011).
- Not an identity provider. It consumes tenant-identity `shared-pool`; any
  OIDC issuer that meets the token contract (spec §6.2) works.
- Not a data-layer sample. The TVM vends tenant-scoped credentials; what they
  unlock (memory, retrieval, tools) belongs to later samples. The demo table
  exists only to prove the credentials work.
- Not multi-tenant-per-user. A user belongs to exactly one tenant; a token
  with a `tenants` claim is refused.
- Not a tool gateway. AgentCore Gateway is used only as an ingress to the
  Runtime, never as an MCP aggregator.
- Not an RFC 8693 token service. Downscoping reuses tenant-identity's
  `/oauth2/token` (ADR-0007).
- Not a session store. No table lists or revokes sessions.

## Architecture

![Architecture: a tenant user signs in to the tenant-identity Cognito shared pool and calls the ingress with a bearer JWT. The ingress, either API Gateway REST with a Lambda authoriser and a streaming Lambda, or AgentCore Gateway with a CUSTOM_JWT authoriser and a REQUEST interceptor, verifies the JWT, derives the session id from tenant_id and sub, assumes the tenant role with a TenantId session tag, and invokes the AgentCore Runtime with SigV4 as the one principal its resource policy allows. The agent in the microVM calls the Bedrock model and the tenant's data with the tenant-scoped credentials, and IAM enforces ABAC on TenantId](./diagrams/runtime-isolation.drawio.svg)

A request carries a bearer token to the ingress, which verifies it, picks the
microVM from `tenant_id` and `sub`, vends `TenantId`-tagged credentials, and
invokes the Runtime as the only principal it trusts; the agent then reaches
the model and tenant data only with those credentials.

Since ADR-0018 the execution role holds no model permission and the TVM is
always on. Every model call is signed by the tenant role, not the execution
role.

Components ([`architecture.md`](./architecture.md#components) has the code
locations):

- **Ingress, `api-gateway`**: a REST API with a REQUEST Lambda authoriser and
  a streaming integration Lambda that calls `InvokeAgentRuntime` and forwards
  the stream (ADR-0003, ADR-0009, ADR-0015).
- **Ingress, `agentcore-gateway`**: an AgentCore Gateway with a `CUSTOM_JWT`
  authoriser and a REQUEST interceptor Lambda that re-verifies the token and
  sets the session id and credential headers (ADR-0010, ADR-0015).
- **Backend**: an AgentCore Runtime whose resource policy allows
  `InvokeAgentRuntime` to the ingress role only (ADR-0001, ADR-0011). One
  ingress fronts one Runtime with `IsolatedRuntime`, or one Runtime per
  registered backend with `SharedIngress` and `AgentBackend` (ADR-0024; see
  [Several backends behind one ingress](#several-backends-behind-one-ingress)).
- **Agent**: the code in the microVM. It builds its AWS clients per request
  from the vended credentials and ends each stream with a `usage` event
  (ADR-0008, ADR-0017, ADR-0018).
- **TVM**: `AssumeRole` plus `TagSession` on the tenant role with `TenantId`
  from the verified claim, cached per instance in a bounded LRU cache with
  single flight (ADR-0012, ADR-0022).
- **Tenant limits**: a DynamoDB fixed-window counter per tenant per minute,
  shared by every ingress instance (ADR-0020).
- **Logs and metrics**: one structured log line per request with `tenantId`
  and the cost figures; per-tenant EMF metrics only with `perTenantMetrics`
  (ADR-0017, ADR-0021).

## How it works

Both ingresses run the same checks in the same order, from one shared
pipeline ([`src/shared/request.ts`](./src/shared/request.ts)):

1. **Verify the token**: signature, `iss`, `client_id`, `exp`,
   `token_use: access`, and a single `tenant_id` (ADR-0004, ADR-0015). On
   `api-gateway` the authoriser checks it and the integration Lambda checks it
   again; on `agentcore-gateway` the `CUSTOM_JWT` authoriser checks it and the
   interceptor checks it again.
2. **Check scopes** when `requiredScopes` is set, and the narrowed-token rule
   when `delegation.requireNarrowedToken` is on (ADR-0005, ADR-0007).
3. **Parse the body**: `prompt` must be a string; `conversationId` must match
   `[A-Za-z0-9]{16,64}` with `session` on and must be absent with it off
   (ADR-0013).
4. **Check the tenant limit**: one conditional `UpdateItem`. A limited tenant
   gets 429 before any STS, Runtime or model call (ADR-0020).
5. **Vend credentials**: the TVM assumes the tenant role tagged
   `TenantId = tenant_id`, from the cache when it can (ADR-0012, ADR-0022).
6. **Choose the unit**: with `session` off, a fresh random session id per
   request; with it on, a session id derived from `tenant_id` and `sub` (or
   `tenant_id` alone with `scope: 'tenant'`) plus `conversationId`. Any
   session header the client sends is ignored or overwritten (ADR-0002).
7. **Invoke the Runtime** with the session id and the credential header. On
   `api-gateway` the integration Lambda forwards the stream.
8. **Meter**: on `api-gateway` the Lambda reads the closing `usage` event,
   adds the output tokens to the tenant's counter and logs `request served`.
   The interceptor logs `request admitted` before the Gateway calls the
   Runtime, because it never sees the response.

The forwarded user token (`delegation.forwardUserToken`) travels raw in
`X-Amzn-Bedrock-AgentCore-Runtime-Custom-User-Token`; the vended credentials
travel as base64 JSON in
`X-Amzn-Bedrock-AgentCore-Runtime-Custom-Tenant-Credentials`. Each header is
on the Runtime's allowlist only when its module needs it (ADR-0006,
ADR-0012). Depth: [`architecture.md`](./architecture.md#request-flow) and
spec §3.

## Deploy

Prerequisites:

- An AWS account, non-production, bootstrapped for AWS CDK, and a Region
  where AgentCore Runtime and AgentCore Gateway are available. The
  integration test runs in `eu-central-1`.
- **Node.js 24**. Docker is not needed: the functions bundle locally with
  esbuild.
- **tenant-identity, topology `shared-pool`, deployed first** in the same
  account and Region. This sample reads its published
  `/application-plane/shared/identity/{userPoolId,appClientId}` parameters at
  deploy time (ADR-0004). Deploy it from
  [`../tenant-identity`](../tenant-identity/README.md#deploy):

  ```bash
  cd ../tenant-identity
  npm ci
  npx projen build
  npx cdk deploy --context topology=shared-pool
  cd ../runtime-isolation
  ```

- **An API Gateway CloudWatch Logs role already set on the account and
  Region** (`api-gateway` ingress). The construct enables execution logging
  but does not create the account-wide `AWS::ApiGateway::Account` role
  (`cloudWatchRole: false`), because that setting is one per account and
  Region and CDK retains it on destroy. Check with `aws apigateway
  get-account`; if `cloudwatchRoleArn` is null, set one as described in
  [tenant-identity's Deploy section](../tenant-identity/README.md#deploy).
- **Amazon Bedrock model access** to Amazon Nova Lite. The demo's default
  model is the Region's cross-Region inference profile, for example
  `eu.amazon.nova-lite-v1:0` in `eu-*` Regions (`us.` and `apac.` elsewhere;
  any other Region gets the base id `amazon.nova-lite-v1:0`). Override with
  `--context modelId=<id>`.

Build, then deploy one ingress:

```bash
npm ci
npx projen build
npx cdk deploy --context ingress=api-gateway
```

`npx projen build` compiles, runs the unit tests and cdk-nag, and synthesises
with `--context ingress=api-gateway --context identityParameterPlaceholders=true`
so it needs no AWS account. A template synthesised with placeholders carries a
CloudFormation rule that refuses to deploy.

The demo stack's inputs are CDK context keys, parsed by `parseDemoContext` in
[`src/demo.cdk.ts`](./src/demo.cdk.ts). Synthesis fails fast and names the
key when a value is missing or malformed.

| Context key | Values | Default | What it does |
|---|---|---|---|
| `ingress` | `api-gateway`, `agentcore-gateway` | required | The ingress (ADR-0003). It is in the stack name, `RuntimeIsolation-<ingress>`, so both can be deployed side by side (see [Two ingresses in one account](#two-ingresses-in-one-account)) |
| `session` | `user`, `tenant`, `off` | `off` | Session mapping (ADR-0013). `user` keys the unit on `tenant_id` and `sub`; `tenant` on `tenant_id` only |
| `requiredScopes` | comma-separated scopes, e.g. `tenant-api/read` | unset (no check) | Scopes every token must carry (ADR-0005) |
| `forwardUserToken` | `true`, `false` | `false` | Forward the user's token to the agent (ADR-0006) |
| `requireNarrowedToken` | `true`, `false` | `false` | Refuse a token whose scopes are not a subset of `allowedScopes`; needs `forwardUserToken=true` (ADR-0007) |
| `allowedScopes` | comma-separated scopes | unset | The scopes a forwarded token may carry; required with `requireNarrowedToken` |
| `tvm` | `true`, `false` | `false` | "Demo tenant data": adds a tenant-partitioned DynamoDB table and a data-bearing tenant role with ABAC. With `false` the TVM still runs, using the construct's model-only `TenantModelRole` (ADR-0016, ADR-0018) |
| `includeUserIdTag` | `true`, `false` | `false` | Add `UserId = sub` as a session tag (multiplies the TVM cache keys, ADR-0022) |
| `modelId` | a Bedrock model id or inference profile id | the Region's Nova Lite profile (above) | The one model the tenant role may invoke |
| `perTenantMetrics` | `true`, `false` | `false` | Per-tenant CloudWatch metrics and the cost dashboard; synth prints a cost warning (ADR-0021) |
| `requestsPerMinute` | non-negative integer | construct default, 60 | Requests per tenant per minute; `0` turns the limit off (ADR-0020) |
| `outputTokensPerMinute` | non-negative integer | unset (off) | Output tokens per tenant per minute; `api-gateway` only (ADR-0020) |
| `identityParameterPlaceholders` | `true`, `false` | `false` | Build only: synthesise with placeholder pool and client ids instead of reading tenant-identity's parameters |
| `publishParameters` | `true`, `false` | `true` | Write the `/application-plane/shared/agent-runtime/*` parameters. Set `false` on a second ingress deployed beside the first |

The demo deploy that turns every module on (used by
[`scripts/demo.sh`](./scripts/demo.sh)):

```bash
npx cdk deploy --context ingress=api-gateway --context session=user --context requiredScopes=tenant-api/read --context forwardUserToken=true --context tvm=true
```

### Two ingresses in one account

The published parameter names are account-wide, so only one stack per account
and Region may write them. The first deploy publishes; the second sets
`publishParameters=false`, or CloudFormation refuses it with
`IngressParameter already exists`:

```bash
npx cdk deploy --context ingress=api-gateway
npx cdk deploy --context ingress=agentcore-gateway --context publishParameters=false
```

The parameters then describe the first stack (`ingress` says which); a
consumer that wants the other reads that stack's `EndpointUrl` output.
The integration test deploys several stacks this way (`test/integ.runtime.ts`).
A `SharedIngress` publishes under its own `registryPrefix` instead, so two of
them in one account each take a distinct prefix (ADR-0024).

After deploy, turn on the two account-level billing options in
[Costs](#turn-on-model-cost-attribution-one-time-account-level) so model cost
splits by tenant.

Teardown, with the same `ingress` you deployed:

```bash
npx cdk destroy --context ingress=api-gateway
```

Every resource has `RemovalPolicy.DESTROY`. The destroy waits about 90 s for
the log drain, so late log delivery cannot recreate a log group outside the
stack (ADR-0019). Destroy tenant-identity afterwards from its own directory if
nothing else uses it.

### Use the construct in your own app

Declare this sample as a local dependency (`file:../runtime-isolation`) in
your `.projenrc.ts` and import from its package entry,
[`src/index.ts`](./src/index.ts) (standard §1.1). The construct reads no SSM
parameter; it takes the issuer, the agent and an optional tenant role as
props:

```ts
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { IsolatedRuntime } from 'runtime-isolation/src';

const userPoolId = ssm.StringParameter.valueForStringParameter(this, '/application-plane/shared/identity/userPoolId');
const appClientId = ssm.StringParameter.valueForStringParameter(this, '/application-plane/shared/identity/appClientId');

const runtime = new IsolatedRuntime(this, 'IsolatedRuntime', {
  identity: {
    discoveryUrl: `https://cognito-idp.${this.region}.amazonaws.com/${userPoolId}/.well-known/openid-configuration`,
    allowedClientIds: [appClientId],
  },
  agent: { codePath: 'path/to/agent-bundle', modelId: 'eu.amazon.nova-lite-v1:0' },
  ingress: 'api-gateway',
  session: { scope: 'user' },
  tvm: { role: myTenantDataRole },
});
```

- **Consumes**: an OIDC issuer meeting spec §6.2 (here tenant-identity
  `shared-pool` through `/application-plane/shared/identity/{userPoolId,appClientId}`);
  an agent bundle (a directory with `app.js`, a Node HTTP server on port
  8080) that ends each stream with the `usage` event; and, optionally,
  `tvm.role`, a tenant role that also reaches your tenant data. Its trust and
  ABAC policies are yours (spec §6.1, M-10). An imported `tvm.role` must
  already carry `bedrock:InvokeModel` and `bedrock:InvokeModelWithResponseStream`
  on the model, because the construct cannot add a policy to a role it did
  not create. Without `tvm.role` the construct creates `TenantModelRole`,
  which may invoke only the one model.
- **Hands on** (read-only properties): `endpointUrl`, `runtimeArn`,
  `ingressRole`, `executionRole`, `tvmCallerRole` (the role that validates the
  token and assumes the tenant role; trust it from your tenant role),
  `tenantRole` (the role every model call is signed by), `limitsTable` (unset
  when `tenantLimits` is `false`) and `options`.
- **Published parameters**, written under
  `/application-plane/shared/agent-runtime/` (the ingress's `registryPrefix`):

  | Parameter | Written by | Value |
  |---|---|---|
  | `endpointUrl` | the ingress | The invocation URL (`POST`, bearer token): the default backend's when `defaultBackend` is set (`IsolatedRuntime`, as today), else the ingress base URL |
  | `baseUrl` | the ingress | The ingress base URL (`https://<api>/prod`, or the Gateway URL); a backend is at `<baseUrl>/<backend>/invocations` (ADR-0024). `SharedIngress.fromParameters` reads this one |
  | `ingress` | the ingress | `api-gateway` or `agentcore-gateway` |
  | `ingressRoleArn` | the ingress | The one role every Runtime behind this ingress trusts; `AgentBackend` reads it to write the Runtime's resource policy (ADR-0024) |
  | `ingressId` | the ingress | The value of the `ri:ingress` tag every Runtime behind this ingress carries (ADR-0024) |
  | `tenantRoleArn` | the ingress | The role every model call is signed by |
  | `gatewayIdentifier` | the ingress, `agentcore-gateway` only | The Gateway a backend adds its target to (ADR-0024) |
  | `backends/<name>` | each backend | The backend's registry entry (below) |
  | `runtimeArn` | the one-backend demo stack | The AgentCore Runtime ARN. Check its account before you send tokens to `endpointUrl` (M-20) |

Every prop, its default and its validation are in the TSDoc of
[`src/runtime-isolation.cdk.ts`](./src/runtime-isolation.cdk.ts) and in
[Scale and limits](#scale-and-limits).

### Several backends behind one ingress

`IsolatedRuntime` is one ingress and one backend. A vendor with several
agents (a support agent, a billing agent) can deploy it once per agent, and
then has one API, one authoriser, one stage throttle, one counter table and
one hostname per agent, while the token check, the TVM, the tenant limit and
the metering are the same in every copy. ADR-0024 (proposed) splits the
construct in two so one ingress serves several Runtimes:

- **`SharedIngress`** is the ingress alone: API or Gateway, authoriser, TVM,
  limits, log drain, and the registry prefix it reads. It takes the
  `IsolatedRuntime` props minus `agent`, plus `registryPrefix`,
  `registryTtl` and `defaultBackend`. Its `endpointUrl` is the ingress base
  URL; `urlFor(name)` gives a backend's route.
- **`AgentBackend`** is one backend: it creates the Runtime, tagged
  `ri:ingress = <ingressId>`, writes the Runtime's resource policy naming the
  ingress role (P-1 per Runtime, ADR-0001), creates the Gateway target of the
  same name on `agentcore-gateway`, and writes its registry entry. On delete
  it sets the entry to `draining`, waits `registryTtl` plus 120 s so running
  streams finish, and removes the entry.
- **`IsolatedRuntime`** stays as the one-backend wrapper over both: default
  backend `agent`, the bare `/invocations` URL and today's published values
  unchanged.

Two backends in one stack:

```ts
import { AgentBackend, SharedIngress } from 'runtime-isolation/src';

const ingress = new SharedIngress(this, 'Ingress', {
  identity: { discoveryUrl, allowedClientIds: [appClientId] },
  ingress: 'api-gateway',
  requiredScopes: ['tenant-api/read'],
  session: { scope: 'user' },
  tvm: { role: myTenantDataRole },
});

new AgentBackend(this, 'Support', {
  name: 'support',
  ingress,
  agent: { codePath: 'path/to/support-bundle', modelId: 'eu.amazon.nova-lite-v1:0' },
});

new AgentBackend(this, 'Billing', {
  name: 'billing',
  ingress,
  agent: { codePath: 'path/to/billing-bundle', modelId: 'eu.amazon.nova-lite-v1:0' },
  requiredScopes: ['tenant-api/write'],
});
```

A backend in its own stack, deployed after the ingress and on its own release
train. It finds the ingress through the published parameters, so
CloudFormation sees no dependency between the two stacks:

```ts
import { AgentBackend, SharedIngress } from 'runtime-isolation/src';

const ingress = SharedIngress.fromParameters(this, 'Ingress', '/application-plane/shared/agent-runtime/');

new AgentBackend(this, 'Billing', {
  name: 'billing',
  ingress,
  agent: { codePath: 'path/to/billing-bundle', modelId: 'eu.amazon.nova-lite-v1:0' },
  requiredScopes: ['tenant-api/write'],
});
```

**Route.** `POST /{backend}/invocations` on both ingresses, one API Gateway
resource and one Gateway. A name is `[a-z0-9-]{1,32}`;
`ingress.urlFor('billing')` returns the backend's URL,
`${endpointUrl}/billing/invocations`, where a `SharedIngress`'s `endpointUrl`
is the base URL without a route. The authoriser looks
the name up and refuses an unknown or `draining` name with 404 before the
body is read; a token missing one of the backend's `requiredScopes` gets 403;
a registry entry the ingress cannot read or parse gets 502. On `api-gateway`
the authoriser's Deny surfaces as API Gateway's own 403, as in
[API](#api).

**Registry.** SSM Parameter Store, one parameter per backend at
`<registryPrefix>backends/<name>`, a JSON string:

```json
{ "runtimeArn": "arn:aws:bedrock-agentcore:eu-central-1:111122223333:runtime/support-abc123", "requiredScopes": ["tenant-api/write"], "status": "active" }
```

`status` is `active` or `draining`. The ingress caches an entry per process
for `registryTtl` (60 s default) and serves the stale entry while it
refreshes, so a change is live within one TTL and a cold instance pays one
`GetParameter` per backend. The ingress-wide `requiredScopes` is the floor
every token must meet (and the Gateway authoriser's `allowedScopes`); the
backend's `requiredScopes` are required on top, per route (ADR-0005,
ADR-0024).

**Backend lifecycle.** No row redeploys the ingress (ADR-0024):

| Operation | Effect | Live after | Ingress deploy |
|---|---|---|---|
| Create | Runtime, resource policy, Gateway target, then the registry entry | one `registryTtl` | no |
| Read, list | `GetParameter` on the name; `GetParametersByPath` on `<registryPrefix>backends/` | immediate | no |
| Update | overwrite `runtimeArn` (or `requiredScopes`); streams already running finish on the old Runtime, new requests move | one `registryTtl` | no |
| Delete | set `draining`, wait one `registryTtl` plus the longest stream (2 min on `api-gateway`), delete the Runtime and target, remove the entry | one `registryTtl` to refuse new requests | no |

**Props.**

| Prop | Default | What it does |
|---|---|---|
| `registryPrefix` | `/application-plane/shared/agent-runtime/` | The SSM prefix the ingress publishes under and reads `backends/<name>` from. One per account and Region; set it when one account runs several ingresses |
| `registryTtl` | `Duration.seconds(60)` | How long an entry is served from the per-process cache before a refresh; bounds both propagation delay and SSM read rate |
| `defaultBackend` | unset (`agent` in `IsolatedRuntime`) | The backend the bare `/invocations` route resolves to; unset, that route is 404 |

**What the shared form costs** (ADR-0024 consequences):

- A registry lookup joins the hot path. SSM standard throughput is 40 TPS
  per account and Region, shared with every other SSM caller, so the cache
  is not optional: misses are ingress instances × backends ÷ `registryTtl`.
  See [Scale and limits](#scale-and-limits).
- The registry is a trust boundary. Whoever writes `backends/<name>` chooses
  which Runtime answers that route, so each backend role may `PutParameter`
  and `DeleteParameter` on its own name only and the ingress role reads the
  prefix only. A wrong `runtimeArn` sends a tenant to the wrong backend, not
  to another tenant's data: the vended credentials and the session prefix
  come from the verified claims alone (ADR-0002, ADR-0012; threat model T-39).
- The ingress role's `InvokeAgentRuntime` grant is a Runtime ARN pattern
  with an `aws:ResourceTag/ri:ingress` condition instead of a list, because
  the Runtimes do not exist at the ingress deploy. The Runtime's resource
  policy remains the hard gate (threat model T-40).
- On `api-gateway` the stage throttle and the one integration Lambda's
  concurrency are shared by every backend: 50 rps × 120 s is 6,000
  concurrent executions for all backends together, so one slow backend can
  starve the rest. Use one `IsolatedRuntime` per backend, or ADR-0024
  Option 4, when backends must not share concurrency.
- One `tvm.role` serves every backend; a backend cannot be given a narrower
  tenant role than its siblings. One tenant limit counts the tenant's
  requests across all backends (ADR-0020).

The demo deploys a second backend, `billing`, with its own required scope on
each all-on integration stack; the integration test's registry step
(`9-registry` in [`scripts/integ.sh`](./scripts/integ.sh)) checks the scope
split, an unknown name, and a backend added and drained after the ingress
deploy.

## Integration test

```bash
export AWS_REGION=eu-central-1
npx projen integ
```

[`scripts/integ.sh`](./scripts/integ.sh) reuses a published tenant-identity
`shared-pool`, or deploys and later destroys it. It deploys the four stacks of
[`test/integ.runtime.ts`](./test/integ.runtime.ts) at once, runs spec §8,
runs `scripts/demo.sh`, destroys everything from an exit trap, and fails if a
stack, parameter or log group is left behind.

Last green run: 2026-10-27, a sandbox account, eu-central-1: deploy 107 s,
steps 223 s, then the destroy (which waits about 90 s for the ADR-0019 log drain).

| Spec §8 step | api-gateway | agentcore-gateway |
|---|---|---|
| 3 direct `InvokeAgentRuntime` with the runner's credentials denied | pass | pass |
| 4a session off: `conversationId` is 400; two requests, two units | pass | not run |
| 4b A2/B1 with A1's `conversationId` and session header: own units | pass | pass |
| 5 A1 resumes on the same microVM | pass | pass |
| 6 no token 401; tampered token, ID token 403; malformed id 400 | pass | pass |
| 7 token narrowed to `tenant-api/write` refused | pass | pass |
| 8 forwarded scope reported; `requireNarrowedToken` refuses un-narrowed | pass | forwarded scope only |
| 8a A reads A; A reads B and B reads A denied by IAM; runner cannot assume the tenant role | pass | pass |
| 8b usage event on the stream; `ModelOutputTokens` per tenant in CloudWatch | pass | usage event only |
| ADR-0018 default `TenantModelRole` signs a model call | pass | not run |
| 9-registry (ADR-0024): floor-scope token 200 on the default backend, 403 on `billing`; token with the billing scope 200; `/nosuch/invocations` refused; a backend added by a registry write serves within one TTL and is refused once `draining` | not yet run | not yet run (add and drain on `api-gateway` only) |

Not covered yet: step 3 with a second, non-ingress role (the spike's V-1
covered it); the CloudTrail check of one `AssumeRole` per tenant per credential
lifetime; the CUR 2.0 `iamPrincipal/TenantId` line items (they arrive a day later);
the ADR-0024 step on a green run.

### Latency (20 `report` calls, no model, warm)

| Ingress | TTFB p50 | TTFB p95 | `stream 10` TTFB | `stream 10` total |
|---|---|---|---|---|
| api-gateway | 0.193 s | 0.206 s | 0.204 s | 10.19 s |
| agentcore-gateway | 0.295 s | 0.334 s | 0.262 s | 10.23 s |

Both ingresses stream: the first event of `stream 10` arrives after about
0.2 s and the last after about 10 s. This is one run from one client; it is
an input to ADR-0009, not a benchmark.

[`scripts/perf.sh`](./scripts/perf.sh) measures the shapes a caller sees
against a deployed stack: the first request of a run (cold ingress Lambda
and a new microVM), a new conversation per request, a warm conversation,
the same with a one-word model prompt, and N parallel requests. It creates
one tenant and deletes it on exit. The server-side split (Lambda init, the
ingress's own work, the Runtime's microVM boot) is in the ingress log group,
as the script's last line says (ADR-0023).

```bash
AWS_REGION=eu-central-1 scripts/perf.sh
ENDPOINT=<EndpointUrl output> AWS_REGION=eu-central-1 scripts/perf.sh
```

The second form measures a stack deployed with `publishParameters=false`.
Measured 2026-10-27 in `eu-central-1`, client p50 of one run per ingress, same build:

| Step | api-gateway | agentcore-gateway |
|---|---|---|
| New conversation, `report` probe (microVM start) | 1.4 s | 1.5 s |
| Warm conversation, `report` probe | 0.20 s | 0.29 s |
| Warm conversation, one-word model prompt (Nova Lite) | 0.5 s | 0.6 s |
| Ingress Lambda's own work on the first request of a cold environment, server-side, after the ~0.33 s init and excluding the microVM start (ADR-0023; was 0.55 s) | ~0.2 s | not measured |

The microVM start is the Runtime's and is the same on both ingresses. On
`agentcore-gateway` the first byte and the last byte arrive together on
every call: the Gateway buffers the Runtime's stream (spike V-4).

## Demo

[`scripts/demo.sh`](./scripts/demo.sh) walks the primary flow against a
deployed stack. It needs tenant-identity `shared-pool` deployed in the same
account and Region, and reads both samples' published parameters.

```bash
export AWS_REGION=eu-central-1
npx cdk deploy --context ingress=api-gateway --context session=user --context requiredScopes=tenant-api/read --context forwardUserToken=true --context tvm=true
scripts/demo.sh
```

| Step | Shows |
|---|---|
| 1 | two tenants, three users (tenant-identity platform API) |
| 2 to 4 | the session follows the token: A2 and B1 reuse A1's `conversationId` and fake A1's session header, and land in their own units; A1 resumes on the same microVM |
| 5 | no token, a tampered token, an ID token: 401/403 |
| 6 | the forwarded token's scope (forwarding on) |
| 7 | A1 reads tenant A's item; tenant B's is `AccessDeniedException` from IAM |
| 8 | `stream 10` arrives as `text/event-stream` |
| 9 | a model prompt ends with the `usage` event; the per-tenant metric command |

Steps whose module is off are skipped. The script creates two tenants and
deletes them on exit, also on failure. It prints status codes, tenant ids
and report fields, never a token, password or header value
([`scripts/CONVENTIONS.md`](./scripts/CONVENTIONS.md)).

## API

One operation, the same contract on both ingresses (spec §5). The route is
`invocations` (`ROUTE` in [`src/index.ts`](./src/index.ts)), under a backend
name: `POST /{backend}/invocations`. `IsolatedRuntime` also serves its one
backend at the bare URL below (ADR-0024).

| | `api-gateway` | `agentcore-gateway` |
|---|---|---|
| URL (`endpointUrl`) | `POST https://<api>/prod/invocations` | `POST https://<gw>.gateway.bedrock-agentcore.<region>.amazonaws.com/agent/invocations` |
| URL of a named backend (`urlFor(name)`) | `POST https://<api>/prod/<backend>/invocations` | `POST https://<gw>.gateway.bedrock-agentcore.<region>.amazonaws.com/<backend>/invocations` |
| Auth | `Authorization: Bearer <access token>` | same |
| Body | `{"prompt": "..."}`; with `session` on, `{"conversationId": "...", "prompt": "..."}` | same |
| Response | `200`, `text/event-stream`, streamed; the last event is `event: usage` ([the usage event](#the-usage-event-agent-to-ingress-contract)) | same |

Errors. The ingress returns fixed bodies from
[`src/shared/request.ts`](./src/shared/request.ts) that never echo the token,
the unit id or the input:

| Status | Body | When |
|---|---|---|
| 400 | `bad request` | `prompt` not a string; malformed JSON; malformed `conversationId`; `conversationId` sent with `session` off |
| 401 | `unauthorized` | No token; a bad signature, issuer, client or expiry; not an access token |
| 403 | `forbidden` | No `tenant_id`, a `tenants` claim, a required scope missing (ingress-wide or the backend's, ADR-0024), the narrowed-token rule failed, or a `claimTags` claim missing |
| 404 | `not found` | The backend name has no registry entry, or its entry is `draining` (ADR-0024) |
| 429 | `too many requests` | The tenant's request or output-token limit for the current minute is reached (ADR-0020) |
| 502 | `upstream error` | The TVM's STS call, the Runtime or the ingress itself failed; the registry could not be read or its entry is malformed (ADR-0024) |

On `api-gateway` the authoriser runs first, and its Deny surfaces as API
Gateway's own 403: a tampered token or an ID token is 403 there (integ step
6), while a missing token is 401. The same applies to an unknown or draining
backend when the authoriser is what refuses it. API Gateway's request validation and stage throttle return API Gateway's JSON
body, not the fixed text. On `agentcore-gateway` the `CUSTOM_JWT` authoriser
refuses before the interceptor runs, with the Gateway's own body, and the
Gateway itself refuses a target name it has no target for.

## Security notes

- **Identity model.** The access token is the only source of tenant context
  (P-3). The ingress reads `tenant_id` and `sub` from the verified token only,
  never from a header or the body. A user belongs to one tenant.
- **One trusted principal.** Each Runtime's resource policy allows
  `InvokeAgentRuntime` to the ingress role only, so a leaked JWT cannot reach a
  unit directly and a caller cannot name another tenant's session (ADR-0001,
  ADR-0002). Behind a `SharedIngress` the route picks the Runtime through the
  registry; a wrong entry can send a tenant to the wrong backend, never to
  another tenant's data, because credentials and session prefix come from
  the verified claims alone (ADR-0024, T-39).
- **Credentials, not code, isolate data and model.** The execution role holds
  logs and traces only: no `bedrock:Invoke*`, no data, no STS (ADR-0008,
  ADR-0018). The agent reaches the model and tenant data only with the
  vended `TenantId`-tagged credentials, and IAM refuses a cross-tenant read
  (`AccessDeniedException`, integ step 8a).
- **Trust boundaries** (threat model): B1 client to ingress (bearer token,
  verified twice); B2 ingress to Runtime (SigV4, resource policy); B3 Runtime
  to microVM (session id, allowlisted headers); B4 ingress to tenant role and
  agent to tenant data (trust policy and ABAC on `TenantId`); B5 telemetry and
  parameters (IAM, field-allowlisted loggers that never log a token,
  credential or header value).
- **Larger residual on `agentcore-gateway`.** What the Gateway does when the
  interceptor Lambda times out or is throttled is not documented and was not
  probed (T-11). In-code failures short-circuit to 403.
- cdk-nag `AwsSolutionsChecks` runs on every synth; each suppression carries
  a reason citing an ADR or a mitigation (ADR-0014).

Threats, mitigations and accepted risks: [`threat-model.md`](./threat-model.md).

## Production hardening checklist

Each item is a "Deployer action" in [`threat-model.md`](./threat-model.md#mitigations)
(M-n) or an accepted risk (T-n).

- [ ] **Own the tenant role's trust and ABAC** when you pass `tvm.role`: trust
      `tvmCallerRole` only, require `aws:RequestTag/TenantId`, pin
      `aws:TagKeys` to the tags you use, and scope every data statement by
      `${aws:PrincipalTag/TenantId}`. The demo's `TenantRole` in
      [`src/demo.cdk.ts`](./src/demo.cdk.ts) is the worked example (M-10,
      T-16).
- [ ] **Map only vendor-set claims to session tags** in `tvm.claimTags`,
      never a user-writable attribute (M-11, T-17, T-20).
- [ ] **Plan offboarding against the credential lifetime.** Keep
      `tvm.durationSeconds` at 900 where offboarding latency matters, and
      attach a `TenantId` deny to the tenant role to cut a tenant off before
      its vended credentials expire (M-14, T-19).
- [ ] **Add edge protection and size the shared limits**: AWS WAF on the
      `api-gateway` stage, per-tenant usage plans keyed from the authoriser,
      Lambda reserved concurrency on the ingress function sized to the
      Runtime quota, Bedrock quota per model, and `tenantLimits` per tier.
      `agentcore-gateway` has no stage throttle in the sample (M-19, M-25,
      T-26, T-35).
- [ ] **Alarm on the interceptor's errors and throttles** on
      `agentcore-gateway`, until a probe shows the Gateway fails closed (M-5,
      T-11).
- [ ] **Alarm on any other principal** calling `InvokeAgentRuntime` on the
      Runtime or assuming the tenant role, from CloudTrail (M-22, T-32).
- [ ] **Restrict `ssm:PutParameter` on `/application-plane/shared/*`** to the
      deploying roles, so nobody can repoint the issuer or the endpoint
      (M-20, T-29, T-30).
- [ ] **Give each backend role write access to its own registry name only**
      (`<registryPrefix>backends/<name>`) and keep the ingress role
      read-only on the prefix; alarm on `PutParameter` under `backends/` by
      any other principal. Keep `bedrock-agentcore:TagResource` on Runtimes
      to the backend-deploying roles, because the ingress role's grant is
      conditioned on the `ri:ingress` tag (M-29, M-30, T-39, T-40).
- [ ] **Leave `perTenantMetrics` off at scale**, or accept about 9 custom
      metrics per tenant per ingress (M-28, T-38).
- [ ] **Change the removal policies.** The sample sets `DESTROY` on every
      resource so teardown is total (M-23).

## Design trail

- Specification: [`design/runtime-isolation.spec.md`](./design/runtime-isolation.spec.md)
- Decisions: [`adr/`](./adr/) (indexed in [`adr/README.md`](./adr/README.md))
- Implemented state: [`architecture.md`](./architecture.md)
- Threats and mitigations: [`threat-model.md`](./threat-model.md)
- Diagram source: [`diagrams/runtime-isolation.drawio`](./diagrams/runtime-isolation.drawio)

## Scale and limits

The pool is shared, so the construct limits each tenant's share and keeps its
own cost flat as tenants grow. Every value, the AWS quota it protects and the
deployer action are in [`architecture.md`](./architecture.md#scale-limits).

| Prop | Default | What it does |
|---|---|---|
| `tenantLimits.requestsPerMinute` | 60 | Requests per tenant per minute, counted fleet-wide in a DynamoDB table; a hit is 429 before STS, the Runtime or the model (ADR-0020). `0` turns it off |
| `tenantLimits.outputTokensPerMinute` | unset (off) | Model output tokens per tenant per minute; `api-gateway` only, synth fails otherwise (ADR-0020) |
| `tenantLimits: false` | | No table and no per-tenant limit |
| `stageThrottle` | `{ rateLimit: 50, burstLimit: 25 }` | The API Gateway stage throttle; `api-gateway` only; shared by all tenants (ADR-0020) |
| `perTenantMetrics` | `false` | Per-tenant CloudWatch metrics (ADR-0017, ADR-0021) |
| `tvm.cacheMaxEntries` | 1000 | Credential cache entries per Lambda instance, LRU, about 1.5 KB each (ADR-0022) |
| `registryTtl` | `Duration.seconds(60)` | How long a backend registry entry is served from the per-process cache before a refresh; a miss serves the stale entry while refreshing. SSM standard throughput is 40 TPS per account and Region, so misses (instances × backends ÷ `registryTtl`) must stay well under it (ADR-0024) |
| `registryPrefix` | `/application-plane/shared/agent-runtime/` | The SSM prefix of the published parameters and the `backends/<name>` entries; one per account and Region (ADR-0024) |
| `defaultBackend` | unset (`agent` in `IsolatedRuntime`) | The backend the bare `/invocations` route resolves to (ADR-0024) |

| Shared resource | Shared by | Deployer action |
|---|---|---|
| API Gateway stage throttle and the one integration Lambda's concurrency (50 rps × 120 s = 6,000 concurrent) | every tenant and, behind a `SharedIngress`, every backend (ADR-0024) | reserved concurrency on the ingress function; one `IsolatedRuntime` per backend when backends must not share |
| SSM Parameter Store reads, 40 TPS standard per account and Region | every ingress instance's registry misses, plus every other SSM caller in the account | raise `registryTtl`; turn on higher throughput for very large fleets (ADR-0024) |

**Cost warning: `perTenantMetrics: true` adds about 9 CloudWatch custom
metrics per tenant per ingress, billed monthly. At 10,000 tenants that is
about 90,000 metrics.** The synth prints a warning when it is on. The ingress
log line carries the same figures, so use Logs Insights or Contributor
Insights at scale.

The limit is a fixed one-minute window: a tenant can reach up to twice the
limit across a window boundary. If DynamoDB errors, requests are admitted and
an error is logged. Demo: `--context requestsPerMinute=<n>`,
`--context outputTokensPerMinute=<n>`, `--context perTenantMetrics=true`.

## Costs

The backend, the model, the gateway and the ingress Lambda are pooled across
tenants, so nothing in the bill carries a tenant tag. Two mechanisms make
cost attributable per tenant:

- **Model tokens come from the bill, by IAM principal (ADR-0018).** The agent
  signs every model call with credentials vended from the verified token and
  tagged `TenantId`, so AWS attributes the model cost to
  `iamPrincipal/TenantId` in CUR 2.0 and Cost Explorer — the bill is the
  source of truth for model cost, independent of what the agent reports.
- **Everything else the ingress meters per tenant.** For the consumption each
  other pooled service bills for (requests, ingress compute, backend seconds,
  bytes), the ingress writes the figures with `tenantId` on its structured
  log line (`request served` on `api-gateway`, `request admitted` on the
  interceptor). Per-tenant CloudWatch metrics (namespace `RuntimeIsolation`,
  dimensions `TenantId` and `Ingress`) are opt-in with `perTenantMetrics`
  (ADR-0021).

The agent still reports its model token usage in the last event of its
response stream; the ingress reads the figures and never stores the content
(P-10, ADR-0017). Those figures and the `ModelInputTokens` / `ModelOutputTokens`
metrics are a near-real-time **cross-check** against the bill, not the billing
source.

### Turn on model-cost attribution (one-time, account level)

CUR 2.0 does not split cost by IAM principal until the deployer turns it on.
Both settings are account-level, so the construct cannot set them; do them
once per account:

1. In **Billing → Cost allocation tags**, activate the `iamPrincipal/TenantId`
   cost allocation tag.
2. In the CUR 2.0 data export, enable **"Include caller identity (IAM
   principal) allocation data"**.

Model cost per tenant is then one query over CUR 2.0's `line_item_iam_principal`
and `iamPrincipal/TenantId` columns.

### The usage event (agent-to-ingress contract)

Every agent response is a `text/event-stream`. Its last event is:

    event: usage
    data: {"inputTokens":123,"outputTokens":45,"modelId":"<model id>"}

- `inputTokens`, `outputTokens`: non-negative integers from the model call
  (Bedrock ConverseStream `metadata.usage`); zero, with no `modelId`, when no
  model was called (the `report`, `read <tenant>` and `stream N` probes).
- `modelId`: the id the agent called; anything not shaped like a model id,
  inference-profile id or ARN is dropped by the ingress.
- On a model failure the agent sends `event: error` with the error name and
  no usage event, so those tokens show as unattributed, never as zero.
- The ingress forwards the stream unchanged. A consumer's own agent keeps
  the metering by emitting this event last.

### The metrics

Emitted only with `perTenantMetrics: true` (ADR-0021). With it off, the log
line carries the same figures as `ttfbMs`, `streamedBytes`,
`backendInvokeSeconds`, `usageInput`, `usageOutput` and `modelId`, so every
row below can be summed per tenant with Logs Insights.

| Metric | Unit | Source | api-gateway | agentcore-gateway |
|---|---|---|---|---|
| `Requests` | Count | ingress, one per request, refusals included | yes | yes |
| `IngressDurationMs` | Milliseconds | ingress handler wall time | yes | yes |
| `BackendInvokeSeconds` | Seconds | ingress: invoke call to end of stream | yes | no |
| `ModelInputTokens` | Count | agent usage event | yes | no |
| `ModelOutputTokens` | Count | agent usage event | yes | no |
| `StreamedBytes` | Bytes | bytes forwarded to the caller | yes | no |

`Errors4xx`, `Errors5xx` and `TtfbMs` are emitted alongside (P-9). On the
agentcore-gateway ingress the REQUEST interceptor returns before the Runtime
is invoked and never sees the response, so backend seconds, tokens and bytes
are not attributed there; the dashboard says so. On `api-gateway` the demo
adds four Contributor Insights rules: top tenants by requests and by errors
(from the access log), and by backend seconds and by output tokens (from the
ingress log line, `$.backendInvokeSeconds` and `$.usageOutput`). All four
work with metrics off. The `agentcore-gateway` demo has none. The dashboard `RuntimeIsolation-<ingress>`, with one
per-tenant line per metric, is added only with
`--context perTenantMetrics=true`.

### Attribution formula

    cost(tenant) = Σ over metrics ( metric(tenant) × unit price )
                 + share of the unattributable remainder

Plug in the current prices for the deployment Region:

| Metric | Price to apply |
|---|---|
| `BackendInvokeSeconds` | AgentCore Runtime vCPU-hour and GB-hour. The Runtime bills active CPU and memory per second, so wall time is an upper bound; treat it as the share key for the Runtime's billed total rather than an exact figure |
| `ModelInputTokens`, `ModelOutputTokens` | Cross-check only (ADR-0018). The billed model cost per tenant is read from CUR 2.0 by `iamPrincipal/TenantId`, not computed from these metrics; use them to spot drift, not to bill |
| `IngressDurationMs` | Lambda GB-second (milliseconds × the ingress function's memory) |
| `Requests` | Lambda request price, plus the API Gateway REST request price or the AgentCore Gateway per-call price |
| `StreamedBytes` | Data transfer out, where billed |

Model cost itself is the CUR 2.0 figure keyed on `iamPrincipal/TenantId`
(above), added to the metered total per tenant.

**Unattributable remainder**: log storage and ingestion, the dashboard and
Contributor Insights rules, the custom metrics themselves, X-Ray traces, and
the backend time of requests whose stream broke before the usage event.
Apportion it equally across active tenants or by `Requests`, and say which.
CloudWatch bills each custom metric-dimension pair: with `perTenantMetrics`
on, the monthly metric count grows with tenants × ingresses × 9, which is why
it is off by default (ADR-0021). Contributor Insights bills per rule and per
matched log event, not per tenant.
