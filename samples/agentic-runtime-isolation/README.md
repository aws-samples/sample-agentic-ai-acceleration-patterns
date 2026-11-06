<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# Agentic runtime isolation: runtime, tools and entitlements for multi-tenant agents

## Use cases

Use this sample when one agent fleet serves many tenants and every request
must answer: which compute unit may the caller reach, which agents and tools
does this tenant user hold, and whose permissions does each tool call use.

- **A pooled agent platform for many tenants.** Each request runs in a fresh
  microVM session (or one per tenant or user) with a five-minute transaction
  token naming one tenant, one user and one agent, and tenant-scoped
  credentials. The identity token never leaves the ingress, so a stolen token
  or a prompt-injected agent cannot reach another tenant's conversation,
  tools or data.
- **Agents and tools sold as subscriptions and plans.** An entitlement store
  and API hold what each tenant subscribed to. A tenant admin can narrow
  their own users (cuts) but never widen them. One person may act for
  several tenants, one per request.
- **Tools that see only the caller's tenant.** Each tool call passes two
  walls (a REQUEST interceptor and AgentCore Policy) and reaches the tool
  with a signed context the tool turns into its own tenant-scoped
  credentials.

Not a fit: one agent per tenant on dedicated infrastructure (silo), or a
single-tenant agent. There the walls below separate nothing.

## What it is

One shared ingress fronts every agent. Per request it verifies the tenant
user's identity token, selects the tenant, applies the grant rule over the
tenant's subscription, the tenant admin's cuts and the agent product, mints
a five-minute transaction token carrying exactly that grant, vends
`TenantId`-tagged credentials and invokes the agent's AgentCore Runtime as
the one principal the Runtime trusts (ADR-0031).

CDK constructs, exported from [`src/index.ts`](./src/index.ts):
**`SharedIngress`** (ingress, token vending machine (TVM), tenant limits,
entitlement store and Entitlements API, token signer, tools gateways),
**`AgentBackend`** (one agent, added or drained without redeploying the
ingress, ADR-0024), **`ToolTarget`** (one group of tools on one tools
gateway, ADR-0035), and the reusable **`TokenSigner`** and
**`EntitlementStore`**. The ingress is an API Gateway REST API
(`api-gateway`, recommended, ADR-0029) or an AgentCore Gateway
(`agentcore-gateway`). The demo adds agents `default` and `billing` and tool
targets `crm` (gateway `default`) and `invoices` (gateway `finance`).

## What this sample is NOT

Spec §1.2 has the full list.

- Not a backend catalogue: only the AgentCore Runtime backend is built
  (ADR-0011).
- Not an identity provider. It consumes identity tokens from tenant-identity
  (`shared-pool`, or `shared-pool-multi-tenant` for users in several
  tenants); any OIDC issuer meeting spec §6.2.1 works. It issues the
  transaction token only and never accepts it as an identity token.
- Not a general token service: no `/token` endpoint, no RFC 8693 exchange,
  no refresh tokens.
- Not a billing or plan-management product: it stores subscriptions, plans
  and cuts only to enforce them.
- Not a data-layer sample: the demo table only proves the vended
  credentials work.
- Not a model gateway, a Gateway per tenant, cross-Region, or a session
  store.

## Architecture

![Architecture: a tenant user calls the shared ingress with an identity token; the ingress grants, mints a transaction token and invokes the agent's AgentCore Runtime, which calls each tools gateway with that token, where a REQUEST interceptor and AgentCore Policy admit the call and the tool reads only that tenant's data. Frames mark the three trust zones and IAM badges mark the walls IAM enforces](./diagrams/agentic-runtime-isolation.drawio.svg)

A tenant user's identity token reaches the ingress, which mints a per-agent
transaction token and passes it to the agent in the AgentCore Runtime; the
agent presents it to a tools gateway, whose interceptor signs a tenant
context for the one tool call, and the tool verifies that context and reads
only that tenant's data. The long-form data path, frame by frame, is
[`diagrams/CAPTION.md`](./diagrams/CAPTION.md); components and their code
locations are in [`architecture.md`](./architecture.md#components).

## Tenant isolation

Everything is pooled: one ingress, one Runtime per agent, one entitlement
table, one tools gateway per tool domain and one tenant-data table serve
every tenant. Three trust zones hold the material: the ingress alone sees
the identity token, the agent is untrusted code holding only tenant-scoped
material, and a tool trusts the signed tool context (`_ri_ctx`) alone. An
**IAM** wall is refused by the service even when the code is wrong; a
**check** runs in the ingress's or the gateway's code, in front of an IAM
wall. The trust-zone table, the walls per layer with boundary ids, code
locations and integ steps are in [`architecture.md`](./architecture.md#tenant-isolation).

| Layer | Wall | Kind |
|---|---|---|
| Identity | the ingress takes the tenant from the verified identity token (`tenant_id`, or `tenants` plus `X-Tenant-Id`); nothing in a body or header names a tenant | check |
| Invocation and session | each Runtime's resource policy allows `InvokeAgentRuntime` to the ingress role only, so only the ingress picks the unit (a Runtime session, one microVM; ADR-0001, ADR-0002) | IAM |
| Delegation | a 300 s transaction token for one tenant, user and agent; only the minting role holds `kms:Sign`, in the key policy (ADR-0031, ADR-0037) | IAM |
| Tools | the REQUEST interceptor refuses a tool outside `scope`; AgentCore Policy holds one star permit per target (ADR-0041) | check |
| Data | the agent's and each tool's tenant role are assumed with `TenantId` from verified material and scope data by `${aws:PrincipalTag/TenantId}` (ADR-0012, ADR-0018) | IAM |

Entitlement writes add one more IAM wall: `TenantAdminRole` reaches only its
own tenant's items and may write only the cut row's attributes and version
(ADR-0033). Prompt injection can make the agent ask for another tenant's data
or tool; the walls answer with IAM denies and interceptor refusals, not with
code in the agent (threat model T-22, T-63).

## How it works

Both ingresses run one pipeline, [`src/shared/request.ts`](./src/shared/request.ts),
in this order ([`architecture.md`](./architecture.md#request-flow) has the
per-ingress split):

1. **Verify** the identity token and select the tenant; a transaction token
   (`typ: txn+jwt` or the ingress's own `iss`) never passes (ADR-0015, ADR-0038).
2. **Check the scope floor** (`requiredScopes`) and **resolve the agent**
   from `/{backend}/invocations` through the backend registry (ADR-0005, ADR-0024).
3. **Check the tenant limit**: one conditional `UpdateItem`, 429 over it (ADR-0020).
4. **Grant**: `A.needs ∪ (A.tools ∩ T.tools ∩ U.tools)`, only if the agent is
   in `T.agents ∩ U.agents` (agent `A`, tenant `T`, user `U`; ADR-0030, ADR-0032).
5. **Mint** the transaction token with KMS `Sign`, cached per tenant, user,
   agent and the entitlement versions (ADR-0031, ADR-0036).
6. **Choose the unit** from the verified claims, then **vend credentials** for the tenant role with `TenantId` (ADR-0039, ADR-0012).
7. **Invoke the Runtime** with the unit id and two allowlisted headers, the
   transaction token and the credentials; the identity token is not among them.
8. **At a tools gateway**, the agent's call passes `CUSTOM_JWT` on the ingress
   issuer, the REQUEST interceptor (tool in `scope`, signs `_ri_ctx`) and
   AgentCore Policy; the tool verifies `_ri_ctx` and assumes its own tenant role.

A refused request costs no STS call. On `agentcore-gateway` it also costs no
KMS call, except a `claim_missing` refusal (a `tvm.claimTags` claim absent),
which the TVM raises after the mint. On `api-gateway` the authoriser mints
before the integration Lambda checks the tenant limit, so a 429 can follow
one `kms:Sign` on a mint cache miss (a cost, not an isolation effect; ADR-0043).

## Deploy

### Prerequisites

- An AWS account, non-production, CDK-bootstrapped, in a Region with
  AgentCore Runtime, Gateway and Policy. The integration test runs in
  `eu-central-1`. **Node.js 24**; no Docker (esbuild bundles locally).
- **An API Gateway CloudWatch Logs role** on the account and Region (the
  construct sets `cloudWatchRole: false`); if `aws apigateway get-account`
  shows no `cloudwatchRoleArn`, set one as [tenant-identity's Deploy
  section](../tenant-identity/README.md#deploy) describes.
- **Bedrock model access** to Amazon Nova Lite through the Region's
  cross-Region inference profile (ADR-0028), or `--context modelId=<id>`.
- **tenant-identity, topology `shared-pool`, deployed and published** in the
  same account and Region, at a version with the scope catalogue
  (`GET|PUT|DELETE /platform/scopes/{scope}`, tenant-identity
  [ADR-0034](../tenant-identity/adr/0034-backends-register-their-scopes-in-a-catalogue.md)).
  This sample reads `/application-plane/shared/identity/{userPoolId,appClientId}`
  for the issuer (ADR-0004). Deploy it from [`../tenant-identity`](../tenant-identity/README.md#deploy):

  ```bash
  cd ../tenant-identity
  npm ci
  npx projen build
  npx cdk deploy --context topology=shared-pool
  cd ../agentic-runtime-isolation
  ```

  For tenant users in several tenants, use `shared-pool-multi-tenant` and
  `--context multiTenant=true`.
- **Two vendor application scopes registered** in tenant-identity's
  catalogue, once: `app/use` (the scope floor every tenant user holds) and
  `entitlements/admin` (held by tenant admins). Agents and tools register
  nothing with the identity provider (ADR-0030). The calls are SigV4 under a
  principal with tenant-identity's `platformInvokePolicyArn`:

  ```bash
  export AWS_REGION=eu-central-1
  IDENTITY_API="$(aws ssm get-parameter --name /application-plane/shared/identity/apiUrl --query Parameter.Value --output text)"
  eval "$(aws configure export-credentials --format env)"
  ```

  Check the deployed tenant-identity has the catalogue: a `GET` answers 200
  (registered) or 404 (not yet); a 403 `Missing Authentication Token` means
  the route does not exist and tenant-identity needs redeploying:

  ```bash
  curl -s -w '\n%{http_code}\n' --aws-sigv4 "aws:amz:${AWS_REGION}:execute-api" --user "${AWS_ACCESS_KEY_ID}:${AWS_SECRET_ACCESS_KEY}" -H "x-amz-security-token: ${AWS_SESSION_TOKEN}" "${IDENTITY_API%/}/platform/scopes/app%2Fuse"
  ```

  Then register each scope (200 when stored):

  ```bash
  for s in app%2Fuse entitlements%2Fadmin; do curl -s -o /dev/null -w '%{http_code}\n' -X PUT --aws-sigv4 "aws:amz:${AWS_REGION}:execute-api" --user "${AWS_ACCESS_KEY_ID}:${AWS_SECRET_ACCESS_KEY}" -H "x-amz-security-token: ${AWS_SESSION_TOKEN}" -H 'Content-Type: application/json' --data '{"description":"agentic-runtime-isolation"}' "${IDENTITY_API%/}/platform/scopes/${s}"; done
  ```

  A tenant then holds `app/use` (and `entitlements/admin` for its admin)
  through tenant-identity's `CreateTenant.scopes`.

### Build and deploy the demo

```bash
npm ci
npx projen build
npx cdk deploy --context ingress=api-gateway --context session=tenant --context tvm=true --context billingBackend=true --context requiredScopes=app/use
```

`npx projen build` compiles, runs the unit tests and cdk-nag, and synthesises
with `--context ingress=api-gateway --context identityParameterPlaceholders=true`,
so it needs no AWS account; a placeholder template carries a CloudFormation
rule that refuses to deploy. The demo's inputs are CDK context keys, parsed
by `parseDemoContext` in [`src/demo.cdk.ts`](./src/demo.cdk.ts); synthesis
fails fast naming a missing or malformed key. The demo always creates two
tools gateways (`default`, and `finance` with `responseFilter`) so the
integration test covers an `aud` with two gateways.

| Context key | Values | Default | What it does |
|---|---|---|---|
| `ingress` | `api-gateway`, `agentcore-gateway` | required | The ingress (ADR-0003); part of the stack name `RuntimeIsolation-<ingress>` |
| `session` | `tenant`, `user`, `off` | `off` | Session mapping (ADR-0013, ADR-0039) |
| `requiredScopes` | comma-separated scopes | unset | The scope floor, for example `app/use` (ADR-0005) |
| `multiTenant` | `true`, `false` | `false` | Accept `tenants` with `X-Tenant-Id` (ADR-0038) |
| `tvm` (demo tenant data) | `true`, `false` | `false` | A tenant-partitioned demo table, a data-bearing tenant role and a tool tenant role per target. The TVM itself is always on; with `false` it vends the model-only `TenantModelRole` (ADR-0018) |
| `includeUserIdTag` | `true`, `false` | `false` | Add `UserId = sub` as a session tag (ADR-0022) |
| `modelId` | a model or inference profile id | the Region's Nova Lite profile | The one model the tenant role may invoke |
| `perTenantMetrics` | `true`, `false` | `false` | Per-tenant metrics and the cost dashboard (ADR-0021) |
| `requestsPerMinute` | non-negative integer | 60 | Tenant limit per minute; `0` turns it off |
| `outputTokensPerMinute` | non-negative integer | unset | Output tokens per tenant per minute; `api-gateway` only |
| `billingBackend` | `true`, `false` | `false` | Add the `billing` agent |
| `keyGeneration` | positive integer | 1 | Bump to rotate the signing key |
| `owner` | a string | per resource | Owner marker of the name reservations (ADR-0035) |
| `publishParameters` | `true`, `false` | `true` | `false` on a second demo stack beside the first: its registry and document then live under `/application-plane/shared/agent-runtime/<stackName>/` |

**Outputs** include `EndpointUrl`, `RuntimeArn`, `Issuer`,
`EntitlementsApiUrl`, `EntitlementsTableName`, the roles, and
`ToolsGatewayUrl<Name>` and `PolicyEngineId<Name>` per tools gateway (the
full list is at the end of [`src/demo.cdk.ts`](./src/demo.cdk.ts)). Check
the Runtime ARN's account before you send tokens to `EndpointUrl` (M-20).

### Published document

The ingress publishes **one JSON parameter**,
`/application-plane/shared/agent-runtime/ingress` (`<registryPrefix>ingress`,
Intelligent-Tiering, up to 8 KB), the published document, instead of one
parameter per value: Parameter Store allows 3 writes per second per account
(ADR-0042). The name is account-wide, so one stack per account and Region
publishes; `publish: false` writes none.

| Field | Value |
|---|---|
| `version` | `2` |
| `ingress` | `api-gateway` or `agentcore-gateway` |
| `endpointUrl` | The invocation URL: the default agent's when `defaultBackend` is set, else the base URL |
| `baseUrl` | The ingress base URL; an agent is at `<baseUrl>/<backend>/invocations` |
| `ingressRoleArn` | The one principal every Runtime behind this ingress trusts |
| `ingressId` | The `ri:ingress` tag value every Runtime behind it carries |
| `tenantRoleArn` | The role every model call is signed by |
| `gatewayIdentifier` | `agentcore-gateway` only: the Gateway an agent adds its target to |
| `issuer`, `jwksUrl` | The transaction-token issuer and `<issuer>/.well-known/jwks.json` |
| `entitlementsTableName` | The entitlement store, for name reservations |
| `entitlementsApiUrl` | The Entitlements API base URL |
| `toolContextKeyId` | With a tools gateway: the key that signs tool contexts |
| `toolsGateways` | `{ <name>: { url, identifier, roleArn, policyEngineId } }` |

Under the same prefix each `AgentBackend` writes its registry entry
`backends/<name>` and each `ToolTarget` its pointer `tools/<target>`
([`architecture.md`](./architecture.md#constructs-routes-and-the-registry)).
**Consumed interface**: tenant-identity's
`/application-plane/shared/identity/{userPoolId,appClientId}`, read by the
demo app only (the constructs take the issuer as props).

### First request

A tenant reaches no agent until the vendor writes its subscription through
the Entitlements API (SigV4). The demo agents are products: `default` needs
`default/chat` and may use `crm/*`; `billing` needs `billing/read` and
`billing/invoke` and may use `invoices/*`.

1. Create a tenant with scope `app/use` and a user, and get an identity
   token through tenant-identity's platform API (`CreateTenant`,
   `CreateUser`, then its test aid `IssueToken`; see [its API
   section](../tenant-identity/README.md#api) and `create_tenant`,
   `create_user` and `issue_token` in [`scripts/lib.sh`](./scripts/lib.sh)).
   Put the tenant id in `TENANT_ID` and the `accessToken` in `TOKEN`.
2. Subscribe the tenant to `default` and two `crm` tools:

   ```bash
   DOC="$(aws ssm get-parameter --name /application-plane/shared/agent-runtime/ingress --query Parameter.Value --output text)"
   ENT_API="$(jq -r .entitlementsApiUrl <<<"$DOC")"
   BASE_URL="$(jq -r .baseUrl <<<"$DOC")"
   curl -s -w '\n%{http_code}\n' -X PUT --aws-sigv4 "aws:amz:${AWS_REGION}:execute-api" --user "${AWS_ACCESS_KEY_ID}:${AWS_SECRET_ACCESS_KEY}" -H "x-amz-security-token: ${AWS_SESSION_TOKEN}" -H 'Content-Type: application/json' --data '{"agents":["default"],"tools":["crm/get_account","crm/list_cases"]}' "${ENT_API%/}/tenants/${TENANT_ID}"
   ```

3. Call the agent. The demo deploy has `session=tenant`, so the body carries
   a `conversationId` (`[A-Za-z0-9]{16,64}`); without session mapping send
   only `prompt`:

   ```bash
   curl -N -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -H 'Accept: text/event-stream' "${BASE_URL%/}/default/invocations" -d '{"prompt":"hi","conversationId":"firstConversation01"}'
   ```

   The model's text streams as `data:` events and the stream ends with:

   ```text
   event: usage
   data: {"inputTokens":<n>,"outputTokens":<n>,"modelId":"<model id>"}
   ```

[`scripts/integ.sh`](./scripts/integ.sh) (`stack_fixtures`) writes a plan,
two subscriptions and a cut the same way.

### Use the construct in your own app

Declare this sample as a local dependency (`file:../agentic-runtime-isolation`)
in your `.projenrc.ts` and import from its package entry (standard §1.1).

```ts
import * as path from 'node:path';
import { Duration } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { AgentBackend, SharedIngress, ToolTarget } from 'agentic-runtime-isolation/src';

const userPoolId = ssm.StringParameter.valueForStringParameter(this, '/application-plane/shared/identity/userPoolId');
const appClientId = ssm.StringParameter.valueForStringParameter(this, '/application-plane/shared/identity/appClientId');

const ingress = new SharedIngress(this, 'Ingress', {
  identity: {
    discoveryUrl: `https://cognito-idp.${this.region}.amazonaws.com/${userPoolId}/.well-known/openid-configuration`,
    allowedClientIds: [appClientId],
  },
  ingress: 'api-gateway',
  requiredScopes: ['app/use'],
  defaultBackend: 'support',
  stageThrottle: { rateLimit: 200, burstLimit: 100 },
  toolsGateways: { default: {}, finance: { responseFilter: true } },
});

new AgentBackend(this, 'Support', {
  name: 'support',
  ingress,
  agent: { codePath: 'path/to/agent-bundle', modelId: 'eu.amazon.nova-lite-v1:0' },
  needs: ['support/chat'],
  tools: ['crm/*', 'invoices/get_invoice'],
});

// The tool function and its tenant role are yours: the handler wraps toolHandler (Tool contract below).
const crmFunction = new NodejsFunction(this, 'CrmFunction', {
  entry: path.join(__dirname, 'tools', 'crm.function.ts'),
  timeout: Duration.seconds(10),
});
const crmTenantRole = new iam.Role(this, 'CrmTenantRole', {
  assumedBy: new iam.ArnPrincipal(crmFunction.role!.roleArn)
    .withConditions({
      'StringLike': { 'aws:RequestTag/TenantId': '?*' },
      'ForAllValues:StringEquals': { 'aws:TagKeys': ['TenantId'] },
    })
    .withSessionTags(),
  maxSessionDuration: Duration.hours(1),
});
// Then grant crmTenantRole your data actions with dynamodb:LeadingKeys = TENANT#${aws:PrincipalTag/TenantId}.

new ToolTarget(this, 'Crm', {
  name: 'crm',
  ingress,
  kind: 'lambda',
  function: crmFunction,
  tools: [{ name: 'get_account', description: 'Read the tenant account', inputSchema: { type: 'object' } }],
  tvm: { role: crmTenantRole },
});
```

A `ToolTarget` joins gateway `default` unless `gateway` names another
(changing it replaces the target). `kind` is `lambda` (with `function` and
`tools`, at most 1,000), `openApi` or `smithy` (with `spec`) or `mcpServer`
(with `endpoint`); the last three need `outboundAuth`: `gatewayIamRole`,
`oauth` (grant `3LO`, `OBO` or `M2M`) or `apiKey`. A non-Lambda target is
**filtered** isolation unless it uses `3LO` or `OBO`, and synth warns so
(ADR-0034).

**In another stack**, `SharedIngress.fromParameters(scope, id, registryPrefix,
ingress?, { toolsGateway?, toolsGateways? })` returns a `SharedIngressRef`
through a synth-time context lookup (ADR-0042): the stack needs
`env: { account, region }` and credentials at synth, and the value is cached
in `cdk.context.json`. After the ingress changes, reset it:

```bash
npx cdk context --reset "ssm:account=111122223333:parameterName=/application-plane/shared/agent-runtime/ingress:region=eu-central-1"
```

**Options.** Every prop is validated at synth, failing with the prop's
name. The full props table with defaults is in
[`architecture.md`](./architecture.md#construct-props); the TSDoc in
[`src/shared-ingress.cdk.ts`](./src/shared-ingress.cdk.ts),
[`src/agent-backend.cdk.ts`](./src/agent-backend.cdk.ts) and
[`src/tool-target.cdk.ts`](./src/tool-target.cdk.ts) has the rest.

#### Agent contract

What the Runtime hands your agent, and what the ingress expects back
(spec §3.4; the demo agent is [`src/agent/app.ts`](./src/agent/app.ts)):

| | |
|---|---|
| Endpoint | The AgentCore Runtime HTTP contract: `POST /invocations` and `GET /ping` on port 8080 |
| Body | `{"prompt": "..."}`; the ingress forwards nothing else from the request |
| `X-Amzn-Bedrock-AgentCore-Runtime-Session-Id` | The unit id, derived by the ingress from verified claims |
| `X-Amzn-Bedrock-AgentCore-Runtime-Custom-Transaction-Token` | The transaction token, a raw JWT |
| `X-Amzn-Bedrock-AgentCore-Runtime-Custom-Tenant-Credentials` | Base64 JSON `{ accessKeyId, secretAccessKey, sessionToken, expiration }` for the tenant role (`decodeCredentials` in [`src/backend/agentcore-runtime.transport.ts`](./src/backend/agentcore-runtime.transport.ts)) |
| Environment | `MODEL_ID`; `RI_TOOLS_GATEWAY_URLS`, JSON `{ <gateway>: <MCP URL> }`; `RI_ISSUER` |

The agent must:

- Sign every model and data call with the vended credentials, built per
  request. The execution role holds logs and traces only, so there is no
  fallback (ADR-0018).
- End every response, a `text/event-stream`, with `event: usage` and
  `data: {"inputTokens":<n>,"outputTokens":<n>,"modelId":"<id>"}`; zeros and
  no `modelId` when no model was called. A model failure sends
  `event: error` and no usage event (ADR-0017).
- Call tools over MCP (streamable HTTP) with the transaction token as
  bearer, holding one MCP client per `tools-gateway:<name>` entry in the
  token's `aud` (ADR-0041).
- Never log or echo a header value.

#### Tool contract

A Lambda tool wraps its handler with `toolHandler` (exported from
[`src/index.ts`](./src/index.ts), code in [`src/tools/context.ts`](./src/tools/context.ts)):

```ts
import { toolHandler } from 'agentic-runtime-isolation/src';

export const handler = toolHandler(async ({ context, args, credentials }) => {
  return { tenantId: context.tenantId };
});
```

`toolHandler` reads the signed tool context (`_ri_ctx`) from the arguments,
verifies it with the public half of `ToolContextKey` (`RI_CONTEXT_KEY_ID`,
set by `ToolTarget`), checks `typ`, `exp`, that `tool` is the tool called and
that `argsHash` matches the arguments, and strips it. It then assumes the
target's `tvm.role` (`RI_TOOL_TVM_ROLE_ARN`) with `TenantId` from the
context and passes `context` (`tenantId`, `sub`, `user`, `agent`, `tool`,
`txn`, `exp`), the arguments without `_ri_ctx`, and those `credentials`. A
missing or invalid context returns `{ "error": "context_invalid" }`, vends
nothing and runs nothing. `verifyToolContext` and `withTenantCredentials`
are the same two steps for a handler you write yourself. The tool tenant
role trusts the tool function's role only, requires a `TenantId` request
tag and no other tag key, and scopes data by `${aws:PrincipalTag/TenantId}`
(the `crmTenantRole` above; spec §6.1).

## Deployment integration test

The deployment integration test ([`test/integ.runtime.ts`](./test/integ.runtime.ts),
driven by [`scripts/integ.sh`](./scripts/integ.sh)) is the reference
implementation of this sample's wiring ([sample standard
§5.2](../../docs/sample-standard.md#52-integration-test)): it deploys or
reuses tenant-identity through its own deploy path, registers the vendor
scopes, wires the stacks through the published document where a consumer
would and reads stack outputs for the values a step needs (the
non-publishing stacks write no parameters; ADR-0044), writes subscriptions,
a plan and a cut through the Entitlements API, drives every step through
the public routes, and tears everything down. Its steps are named and
ordered as the table below.

Use a non-production, CDK-bootstrapped account, in exactly one Region: the
script fails fast when `AWS_REGION` is unset.

```bash
AWS_PROFILE=<profile> AWS_REGION=eu-central-1 npx projen integ
```

Optional knobs: `INTEG_PREFIX` (stack prefix, default
`RuntimeIsolationInteg`), `INTEG_PUBLISHER` (the stack that writes the
published document, default `api-gateway`, or `none`), `INTEG_MODEL_ID`, and
`INTEG_REPLACE_STALE_IDENTITY=1`, which replaces a tenant-identity without
the scope catalogue and so deletes every other consumer's tenants and users.

It deploys six stacks at once (`--concurrency 6`):

| Stack suffix | Ingress | Modules |
|---|---|---|
| `api-gateway` | `api-gateway` | everything on, both agents, both tools gateways, demo tenant data, per-tenant metrics; publishes the document |
| `agentcore-gateway` | `agentcore-gateway` | the same, not publishing, per-tenant metrics off |
| `session-off` | `api-gateway` | session off, the default `TenantModelRole` |
| `session-user` | `api-gateway` | `session: { scope: 'user' }` |
| `limits` | `api-gateway` | tenant limit 5 per minute, the scope floor `app/use` |
| `multi-tenant` | `api-gateway` | `identity.multiTenant` on a second tenant-identity, `shared-pool-multi-tenant` |

A run takes **about 45 minutes** and costs **about $3 per run** at on-demand
rates, mostly AgentCore Runtime session time and the Gateways across six
stacks. Last green integration run: run 15, 2026-11-06, eu-central-1,
58/58 steps; timings and coverage are in the
[`architecture.md` status block](./architecture.md).

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

## End-to-end demo

[`scripts/demo.sh`](./scripts/demo.sh) walks the flow against a deployed
`RuntimeIsolation-<ingress>` stack. It needs the full demo deploy from
[Build and deploy the demo](#build-and-deploy-the-demo) and the two vendor
scopes registered in tenant-identity ([Prerequisites](#prerequisites)); it
checks both before it starts.

```bash
AWS_REGION=eu-central-1 scripts/demo.sh
```

| Step | What it shows | Needs |
|---|---|---|
| 1 | Tenants A (`app/use entitlements/admin`, admin AA) and B (`app/use`), users A1, A2, B1; the vendor writes plan `demo-standard` and both subscriptions; AA cuts A2 from `crm/update_case` | |
| 2 | A1's `report`: unit prefix, nonce, the transaction token's `typ`, `iss`, `sub`, `user`, and the header names: no identity token reached the agent | |
| 3 | A2 sending c1 lands in A1's unit; B1 with c1 and A1's unit id gets its own | `session=tenant` |
| 4 | A1 resumes c1 on the same microVM (same nonce) | `session` |
| 5 | No token, a tampered token, an ID token: 401 or 403; the transaction token's `iss` is the ingress's, which the ingress refuses as an identity token | |
| 6 | Grants: A1 `crm/* default/chat`, A2 `crm/get_account crm/list_cases default/chat`, B1 the same, B1 on `billing` 403 `agent_not_subscribed`, A1 on `billing` `billing/invoke billing/read invoices/*` | `billingBackend` for the billing rows |
| 7 | `tools` on `default` lists the three `crm` tools (target grain); A2's `crm/update_case` is `tool_not_granted`, its `crm/get_account` is served; `finance` lists A1's two invoice tools (RESPONSE filter) | `billingBackend` for `finance` |
| 8 | `crm/get_account` returns tenant A's account for A1 and B's for B1; A1's `read` of tenant B is refused by IAM | `tvm` |
| 9 | The vendor drops `crm/list_cases` from B; B1's next request (fresh identity token, ADR-0043) carries `crm/get_account default/chat` | |
| 10 | `stream 10` arrives as `text/event-stream` | |
| 11 | A one-word model prompt ends with `event: usage` | |

A step whose module is off is skipped. The script prints statuses, ids,
claim names and timings, never a token or credential, and deletes what it
wrote on every exit. [`scripts/perf.sh`](./scripts/perf.sh) measures
client-side TTFB and total time per scenario.

## Operate

### Limits

The design targets 10,000s of tenants, 100,000s of tenant users, 100s of
agents and 1,000s of tools; none of those counts grows a policy, a Gateway, a
role or a token per tenant or per user (P-16). The bounds that do apply, the
shared pools every tenant draws on and the known limitations are in
[`architecture.md`](./architecture.md#scale-limits). The ones a deployer
meets first:

- The `api-gateway` stage throttle is one bucket for every tenant: size
  `stageThrottle.rateLimit` to at least tenants x tenant limit / 60.
- The streaming Lambda is held for the whole stream: set
  `ingressReservedConcurrency` to about rps x average stream seconds.
- KMS `Sign` (one per mint miss and one per admitted tool call) shares the
  account's RSA request quota: `toolContextKey.algorithm: 'ES256'` moves tool
  contexts onto the ECC quota.
- The `agentcore-gateway` ingress caps at 100 agents (Gateway targets);
  a tools gateway at 300 tools (`maxToolsPerGateway`, the Cedar schema bound).
- A grant whose transaction token would exceed 10,240 bytes is refused with
  502 `grant_too_large` (ADR-0045).

### Change lag

A subscription change or a cut lands on the next request, an agent product
or plan change within `registryTtl`, and a token in flight keeps its grant
until `exp`. No revocation list is kept; lower `transactionToken.ttl` for a
faster stop. The table per change is in [`architecture.md`](./architecture.md#change-lag).

### Rotate the signing key

1. Bump `transactionToken.keyGeneration` (demo: `--context keyGeneration=2`)
   and deploy. Key N+1 signs from that deploy; key N stays in the JWKS
   without `kms:Sign`, so tokens it signed verify until `exp`.
2. Wait at least `transactionToken.ttl` + 5 minutes (20 minutes at the 900 s
   maximum).
3. Bump to N+2 and deploy: key N leaves the JWKS and is scheduled for
   deletion (30 days).

### Costs

A deployment adds two customer-managed KMS keys per ingress (three during a
rotation), about $1/month each, plus AgentCore Policy at $0.025 per 1,000
authorisations (one per `tools/call` and per `tools/list` page), and pooled
Gateway, Runtime, Lambda, DynamoDB and CloudWatch usage. Model cost is
attributed per tenant from the bill by IAM principal (`iamPrincipal/TenantId`,
ADR-0018), the rest from the ingress's per-tenant log lines; the formula,
the drivers and the unattributable remainder are in
[`architecture.md`](./architecture.md#per-tenant-cost-attribution).

### Laying out tools gateways

A gateway is a tool partition, not a tenant partition; one gateway for all
domains is the default. When to split by domain, pack by count or give each
agent its own gateway, and what each extra gateway costs, is in
[`architecture.md`](./architecture.md#laying-out-tools-gateways).

### Teardown

```bash
npx cdk destroy --context ingress=api-gateway
```

Every resource has `RemovalPolicy.DESTROY`; policies go before their
targets (ADR-0040), the log drain waits about 90 s (ADR-0019), and KMS keys
enter their deletion window. Afterwards remove the two vendor scopes
(`DELETE /platform/scopes/{scope}`) if you added them, and check that no
`/aws/bedrock-agentcore/runtimes/<runtimeId>-DEFAULT` log group is left:
the stack deletes it (ADR-0047), but a line the Runtime writes in the
seconds between that delete and its own recreates the group outside the
stack, with no retention. The same check applies after a deploy that
replaced the Runtime: the old Runtime's group is deleted while it drains.

## API

### Ingress routes

| Route | Auth | What |
|---|---|---|
| `POST <baseUrl>/<backend>/invocations` | `Authorization: Bearer <identity token>`; `X-Tenant-Id` when the token carries `tenants` | Invoke an agent; `text/event-stream`, last event `event: usage` |
| `POST <baseUrl>/invocations` | same | The `defaultBackend` (`api-gateway`; on `agentcore-gateway` the name is always in the path) |
| `GET <baseUrl>/.well-known/openid-configuration` | none | `{ issuer, jwks_uri, ... }`; `issuer` = `<baseUrl>` |
| `GET <baseUrl>/.well-known/jwks.json` | none | One key, two during rotation; `Cache-Control: public, max-age=300` |
| `<baseUrl>/entitlements/*` | SigV4 or identity token | The Entitlements API, below |

On `agentcore-gateway` the issuer and entitlement routes are on the small
REST API beside the Gateway, named by `issuer` and `entitlementsApiUrl` in
the published document. The body is `{"prompt": "..."}`, plus
`conversationId` (`[A-Za-z0-9]{16,64}`) with `session` on.

Errors are fixed bodies that never echo the token, the unit id or the
input. On `api-gateway` every authoriser refusal is 403 `forbidden` (or
`forbidden: <reason>`), and only a missing `Authorization` header (or, with
`multiTenant`, a missing `X-Tenant-Id`) is API Gateway's own 401; the 401,
404 and 502 statuses of the authoriser's checks apply as such on
`agentcore-gateway`. The error catalogue, the transaction token's claims and
the signed tool context's format are in [`architecture.md`](./architecture.md#api).

### Entitlements API

Smithy service `Entitlements` ([`model/entitlements.smithy`](./model/entitlements.smithy)),
`restJson1`, under `<baseUrl>/entitlements`. Vendor operations use SigV4
(`execute-api:Invoke`); tenant-admin operations use the identity token with
scope `entitlements/admin`, for the tenant the token names or `X-Tenant-Id`
selects among its `tenants`. No operation adds to a user's set (ADR-0033).

| Operation | Method and path | Caller | Notes |
|---|---|---|---|
| `PutTenantSubscription` | `PUT /entitlements/tenants/{tenantId}` | vendor | `{ agents, tools, plan?, status? }`; bumps `version` |
| `GetTenantSubscription` | `GET /entitlements/tenants/{tenantId}` | vendor | |
| `DeleteTenantSubscription` | `DELETE /entitlements/tenants/{tenantId}` | vendor | 204; also deletes the tenant's cuts |
| `PutPlan` | `PUT /entitlements/plans/{planName}` | vendor | `{ agents, tools }` |
| `GetPlan` | `GET /entitlements/plans/{planName}` | vendor | |
| `DeletePlan` | `DELETE /entitlements/plans/{planName}` | vendor | 204; 409 `plan_in_use` while a tenant names it |
| `ListPlans` | `GET /entitlements/plans` | vendor | `nextToken` |
| `PutUserCut` | `PUT /entitlements/users/{sub}/cut` | tenant admin | `{ cutAgents, cutTools }`; only names the tenant holds (400 `not_subscribed`) |
| `GetUserCut` | `GET /entitlements/users/{sub}/cut` | tenant admin | 404 when the user has no cut |
| `DeleteUserCut` | `DELETE /entitlements/users/{sub}/cut` | tenant admin | 204; the user holds the full tenant set again |
| `ListUserCuts` | `GET /entitlements/users` | tenant admin | the caller's tenant only |

A vendor write naming anything that is neither a reserved agent nor a
catalogued tool (or `<target>/*` of a catalogued target) is 400
`unknown_name`; a tenant-admin call without `entitlements/admin` is 403
`forbidden: admin_scope_missing`. The tenant-admin handler runs under
credentials tagged with the caller's `TenantId`, so a cut for another tenant
fails in IAM.

## Security notes

Threats, mitigations and accepted risks: [`threat-model.md`](./threat-model.md).

- **Identity model.** The identity token is the only source of tenant
  context (P-3) and never leaves the ingress: the agent sees the transaction
  token, a tool the signed tool context (integ step 11).
- **One trusted principal.** Each Runtime trusts the ingress role alone, so
  a leaked token cannot reach a unit directly (ADR-0001, ADR-0002).
- **Two walls at `tools/call`.** The REQUEST interceptor decides per tool
  and fails closed; AgentCore Policy, default deny, decides per target
  (ADR-0040, ADR-0041).
- **Tool data.** A tool reaches tenant data only through its own TVM, bound
  by its tenant role's trust policy; the agent role has no `sts:AssumeRole`,
  no model permission and no data.
- **Signing keys.** `kms:Sign` is granted only in the key policies, grants
  are denied and the account root has no `kms:Create*`, so no IAM policy can
  add a signer; the residual is `kms:PutKeyPolicy` (ADR-0046, T-97).
- **Token lifetime.** Every verifier requires `exp` and `iat`.
- **No token in any log.** Header-free access logs, `dataTraceEnabled:
  false`, allowlisted log fields, Gateway application logs off; the integ
  sweep checks every log group on the path.
- cdk-nag `AwsSolutionsChecks` runs on every synth; each suppression cites an
  ADR or a mitigation (ADR-0014).

## Production hardening checklist

The constructs are hardened components; a deployment adds the following.
Each item is a deployer action or an accepted risk in
[`threat-model.md`](./threat-model.md#mitigations).

- [ ] **Rotate the signing key** on a schedule ([procedure](#rotate-the-signing-key); M-64).
- [ ] **Alarm on KMS**: `Sign` rate and errors, `Sign` by any principal but
      the minting role or the interceptor, `PutKeyPolicy` outside a deploy
      (M-40, M-68, M-78, T-52, T-84, T-97).
- [ ] **Keep Gateway application logs off**: they record the signed tool
      context and every tool result (ADR-0040, M-67).
- [ ] **Use OBO only with authorisation servers you trust**, and prefer 3LO
      or OBO over 2LO and API keys (M-74, M-66, T-92, T-82).
- [ ] **Turn on `responseFilter`** where products grant partial targets (M-70).
- [ ] **Split tools over gateways by domain**, below `maxToolsPerGateway` (M-72).
- [ ] **Own the tenant roles' trust and ABAC**: `tvm.role` trusts
      `tvmCallerRole` only, each tool tenant role its one function's role;
      require `aws:RequestTag/TenantId`, pin `aws:TagKeys`, scope data by
      `${aws:PrincipalTag/TenantId}`, map only vendor-set claims in
      `tvm.claimTags` (M-10, M-11, T-16, T-17).
- [ ] **Use the tenant `suspended` status as the kill switch** for new
      requests (`PutTenantSubscription` with `status: suspended`); tokens in
      flight live to `exp` (plus the 60 s authoriser cache on `api-gateway`)
      and credentials to `tvm.durationSeconds`, so lower both if they must
      stop sooner (M-14, M-41, T-19).
- [ ] **Keep PITR on the entitlement table** and decide its retention (M-48).
- [ ] **Restrict `lambda:InvokeFunction` on the request-path functions** to
      the service principals (an SCP or permission boundary) and alarm on any
      other invoker; Lambda resource policies cannot deny (M-22; accepted
      risk T-102).
- [ ] **Add edge protection and size the shared limits**: AWS WAF,
      `stageThrottle`, `ingressReservedConcurrency`, Bedrock and Gateway
      quotas, the tenant limit and the tool rate limit per tier (M-19, M-25, M-60).
- [ ] **Restrict `ssm:PutParameter` under the registry prefix** and
      `bedrock-agentcore:TagResource` on Runtimes to the deploying roles
      (M-20, M-29, M-30, T-39, T-40).
- [ ] **Alarm on any other principal** calling `InvokeAgentRuntime` or
      assuming a tenant role (M-22, T-32).
- [ ] **Leave `perTenantMetrics` off at scale**, or accept 9 × (1 + agents)
      custom metrics per tenant per ingress (M-28, T-38).
- [ ] **Change the removal policies** from `DESTROY` (M-23).
- [ ] **Alarm on `LogEventsWithFindings`** (AWS/Logs, dimension `LogGroupName`)
      for the Runtime log groups: one finding means a header value reached
      a log line and was masked (T-18, ADR-0047). Data protection is billed
      per GB scanned; keep `logs:Unmask` off every role but the responders'.

## Design trail

- Specification: [`design/agentic-runtime-isolation.spec.md`](./design/agentic-runtime-isolation.spec.md);
  spike and integration results in §7
- Decisions: [`adr/`](./adr/), one file per record, indexed in
  [`adr/README.md`](./adr/README.md)
- Threats and mitigations: [`threat-model.md`](./threat-model.md)
- Implemented state: [`architecture.md`](./architecture.md)
- Diagram: [`diagrams/agentic-runtime-isolation.drawio`](./diagrams/agentic-runtime-isolation.drawio),
  rendered as [`agentic-runtime-isolation.drawio.svg`](./diagrams/agentic-runtime-isolation.drawio.svg),
  long-form data path in [`diagrams/CAPTION.md`](./diagrams/CAPTION.md)
