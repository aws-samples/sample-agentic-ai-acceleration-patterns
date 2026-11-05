<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# Agentic runtime isolation: runtime, tools and entitlements for multi-tenant agents

A pooled agentic platform where each tenant user's agent runs in its own
compute unit, reaches only the tools its tenant subscribed to, and acts with
a token that names one tenant, one user and one agent. One shared ingress
fronts every agent backend. For each request it verifies the tenant user's
identity token, selects the tenant, decides what this agent may do for this
tenant and this user (the grant rule over subscriptions, tenant admin cuts
and the agent product), mints a five-minute transaction token carrying
exactly that grant, vends tenant-scoped AWS credentials, limits each
tenant's share, and invokes the agent's Amazon Bedrock AgentCore Runtime as
the one principal it trusts. The agent calls tools through one or more
shared AgentCore Gateways (the tools gateways) with the transaction token;
each tool call passes two walls, a REQUEST interceptor per tool and
AgentCore Policy per target, and reaches the tool with a signed tenant
context the tool turns into its own tenant-scoped credentials. The identity
token never leaves the ingress (ADR-0031).

The ingress is a deploy-time choice: an API Gateway REST API
(`api-gateway`, recommended, ADR-0029) or an AgentCore Gateway
(`agentcore-gateway`). The token vending machine (TVM), the entitlement
check and the transaction token are always on; per-tenant limits and one
tools gateway are on by default; session mapping, the scope floor and
per-tenant metrics are opt-in.

It ships as CDK constructs, exported from [`src/index.ts`](./src/index.ts):
**`SharedIngress`** (the ingress, authoriser, TVM, limits, entitlement store
and API, token signer and issuer routes, tools gateways); **`AgentBackend`**
(one agent product: a Runtime plus its `needs` and `tools`, added, changed
or drained without redeploying the ingress, ADR-0024, ADR-0032);
**`ToolTarget`** (one group of tools on one tools gateway, with its
catalogue rows and Cedar permit, ADR-0035, ADR-0041); and **`TokenSigner`**
and **`EntitlementStore`**, which `SharedIngress` creates and a consumer
building its own ingress can reuse. A thin demo stack adds two agents
(`default`, `billing`) and two tool targets (`crm` on gateway `default`,
`invoices` on gateway `finance`).

**What this sample is NOT** (spec §1.2):

- Not a backend catalogue: only the AgentCore Runtime backend is built
  (ADR-0011).
- Not an identity provider. It consumes identity tokens from tenant-identity
  (`shared-pool`, or `shared-pool-multi-tenant` for users in several
  tenants); any OIDC issuer meeting spec §6.2.1 works. It issues the
  transaction token only and never accepts it as an identity token.
- Not a general token service: no `/token` endpoint, no RFC 8693 exchange,
  no refresh tokens.
- Not a billing or plan-management product: it stores subscriptions, plans
  and cuts to enforce them.
- Not a data-layer sample: the demo table only proves the vended
  credentials work.
- Not a model gateway, a Gateway per tenant, cross-Region, or a session
  store.

## Architecture

![Architecture: a tenant user signs in to tenant-identity and calls the shared ingress with an identity token, plus X-Tenant-Id when the user is in several tenants. The ingress, API Gateway REST with a Lambda authoriser and a streaming Lambda, or AgentCore Gateway with a CUSTOM_JWT authoriser and a REQUEST interceptor, verifies the token, selects the tenant, checks the per-tenant limit in a DynamoDB counter, resolves the backend from the SSM registry (backends/<name>: runtimeArn, needs, tools, version, status), reads the tenant subscription and the user cut from the entitlement table, applies the grant rule, mints a transaction token with KMS Sign, assumes the tenant role with a TenantId session tag, and invokes the agent's AgentCore Runtime as the one principal its resource policy allows, passing the credentials and the transaction token in allowlisted headers. The ingress serves its own JWKS and OIDC discovery routes and the Entitlements API. The agent calls each tools gateway named in the token's aud with the token as bearer; the gateway checks the token against the ingress issuer, the REQUEST interceptor checks the tool against scope and signs a tenant context into _ri_ctx, AgentCore Policy permits the target, and the tool Lambda verifies the context, assumes its own tenant role with TenantId and reads only that tenant's data. Frame titles name the three trust zones (the ingress is trusted and alone sees the identity token, the agent is untrusted code, a tool trusts the signed context only) and IAM badges mark the walls IAM enforces: the Runtime resource policy, the two KMS key policies, the tenant roles behind the TVMs and the entitlement store's tenant-admin role](./diagrams/agentic-runtime-isolation.drawio.svg)

A tenant user's identity token reaches the ingress, which mints a
per-agent transaction token and passes it to the agent in the AgentCore
Runtime, the agent presents it to the tools gateway, the gateway's
interceptor signs a tenant context for the one tool call, and the tool
verifies that context and reads only that tenant's data. Three trust
zones: the ingress alone sees the identity token, the agent is untrusted
code holding only tenant-scoped material, and a tool trusts the signed
context alone; the `IAM` badges mark the walls IAM enforces (next
section).

Components ([`architecture.md`](./architecture.md#components) has the code
locations):

- **Ingress, `api-gateway`** (recommended): a REST API with a REQUEST Lambda
  authoriser that verifies, selects the tenant, grants and mints, and a
  streaming integration Lambda that calls `InvokeAgentRuntime` (ADR-0003,
  ADR-0009, ADR-0015). The same API carries the issuer routes and the
  Entitlements API.
- **Ingress, `agentcore-gateway`**: an AgentCore Gateway with `CUSTOM_JWT`
  and a REQUEST interceptor doing the same work (ADR-0010); the issuer and
  entitlement routes live on a small REST API beside it.
- **Backend registry**: one SSM parameter per agent,
  `<registryPrefix>backends/<name>`, cached per instance for `registryTtl`.
- **Entitlement store**: one DynamoDB table per ingress (PITR on): tenant
  subscriptions, plans, user cuts, the tool catalogue and name reservations
  (ADR-0030, ADR-0035). Beside it the **token signer**, a KMS asymmetric
  key whose public half is served as a JWKS (ADR-0037).
- **Backend and agent**: an AgentCore Runtime whose resource policy allows
  the ingress role only (ADR-0001). The agent's execution role holds logs
  and traces only; the agent builds its clients from the vended credentials,
  holds one MCP client per tools gateway in the token's `aud`, and ends each
  stream with a `usage` event (ADR-0008, ADR-0017, ADR-0018).
- **Tools gateways**: one AgentCore Gateway per entry of `toolsGateways`,
  each with its own Policy engine, REQUEST interceptor, per-tenant rate
  limit and optional RESPONSE list filter; a second KMS key,
  `ToolContextKey`, signs tool contexts (ADR-0034, ADR-0041). Targets are
  Lambda, OpenAPI, Smithy or MCP servers.
- **TVM**: `AssumeRole` plus `TagSession` with `TenantId` from the verified
  claim, in a bounded LRU cache with single flight (ADR-0012, ADR-0022).
- **Tenant limits, logs, metrics**: a DynamoDB fixed-window counter per
  tenant (ADR-0020); one structured line per request with `tenantId`,
  `backend` and `txn`; per-tenant EMF metrics only on opt-in (ADR-0021).

## Tenant isolation

Everything is pooled: one ingress, one Runtime per agent, one entitlement
table, one tools gateway per tool domain and one table of tenant data serve
every tenant. What separates tenants is the material each request carries
and the walls that material meets. Three trust zones hold it:

| Zone | Trusts | Holds |
|---|---|---|
| Ingress (`SharedIngress`) | the identity provider | the identity token, the signing keys, the entitlement store; the only code that sees the identity token |
| Agent (`AgentBackend`) | the ingress, through the Runtime resource policy | untrusted code: a transaction token for one tenant, user and agent, and `TenantId`-tagged credentials; nothing else (ADR-0018, ADR-0031) |
| Tool (`ToolTarget`) | the signed tenant context `_ri_ctx` alone | its own tenant role, assumed with the context's `TenantId` (P-15) |

Each layer of the repository's isolation model
([`ARCHITECTURE.md` §3.3](../../ARCHITECTURE.md#33-the-isolation-layers))
has one wall. An **IAM** wall is enforced isolation: the service refuses a
cross-tenant call even when the code is wrong. A **check** runs in the
ingress's or the gateway's own code and decides what the agent may do; it
sits in front of an IAM wall, never in place of one. The boundary ids are
the [threat model's](./threat-model.md#assets-and-trust-boundaries); the
proof is the [integration test](#deployment-integration-test) step.

| Layer | Boundary | Wall | Kind | Proof |
|---|---|---|---|---|
| Identity: which tenant is calling? | B1 | the ingress verifies the identity token and takes the tenant from its `tenant_id` claim (or `tenants` plus `X-Tenant-Id`); nothing in a body or header names a tenant | check | 6, 18, 19 |
| Invocation: who may call the agent? | B2 | each Runtime's resource policy allows `InvokeAgentRuntime` to the ingress role only and denies every other principal (ADR-0001) | IAM | 3 |
| Session: which microVM? | B3 | the ingress derives the unit id from verified claims; a client session header is ignored; only the ingress can set it, by the same resource policy (ADR-0002, ADR-0039) | IAM | 4a, 4b, 5 |
| Delegation: what may the agent do? | B2, B8, B13 | a transaction token naming one tenant, user and agent with exactly the granted set, 300 s; signed by a KMS key whose key policy lets only the minting role `kms:Sign`; the identity token never leaves the ingress (ADR-0031, ADR-0037) | IAM (key policy) | 7, 11, 15, 17, 18, 21 |
| Tools: which tools, for this tenant user? | B8 | AgentCore Policy, one Cedar star permit per target on `scope`; the REQUEST interceptor refuses any tool outside `scope` and signs the tenant context (ADR-0041) | check | 13, 14, 22, 24 |
| Data, from the agent | B4 | the TVM assumes the tenant role with `TenantId` from the verified claim; the role scopes every model and data call by `${aws:PrincipalTag/TenantId}` (ADR-0012, ADR-0018) | IAM | 8a |
| Data, from a tool | B9 | the tool verifies `_ri_ctx`, assumes its own tenant role with the context's `TenantId`, and reaches `TENANT#<id>` items only; a `lambda` target with no valid context assumes no role | IAM; **filtered** for `openApi`, `smithy` and `mcpServer` targets with 2LO or an API key (ADR-0034) | 15, 20, 20-cloudtrail |
| Entitlement writes | B10, B11 | `TenantAdminRole` reaches `TENANT#${aws:PrincipalTag/TenantId}` items only and may write the cut attributes only; vendor routes are SigV4; deploy rows carry an owner marker (ADR-0033, ADR-0035) | IAM | 12 |

The diagram marks the IAM walls with an `IAM` badge. The "two walls"
at `tools/call` are both checks: Policy at target grain and the interceptor
per tool. The tenant wall for tool data is the tool's tenant role, whichever
gateway the call came through. Prompt injection can make the agent ask for
another tenant's data or tool; the walls answer with IAM denies and
interceptor refusals, not with code in the agent (threat model T-22, T-63).

## How it works

Both ingresses run the same checks in the same order from one shared
pipeline ([`src/shared/request.ts`](./src/shared/request.ts)). A refused
request costs no STS call and, on `agentcore-gateway`, no KMS call (on
`api-gateway` the authoriser mints before the integration applies the
per-tenant limit, M-50). On
`api-gateway` the authoriser mints before the integration Lambda checks the
per-tenant limit, so a 429 can follow one `kms:Sign` when the mint cache
misses (a cost, not an isolation effect; ADR-0043).

1. **Verify the identity token**: signature, `iss`, `client_id`, `exp`,
   `token_use: access` (ADR-0004, ADR-0015). A token whose `iss` is the
   ingress's own issuer, or whose header `typ` is `txn+jwt`, is refused: a
   transaction token never passes as an identity token.
2. **Select the tenant** (ADR-0038). A token with one `tenant_id` acts for
   it; an `X-Tenant-Id` that disagrees is 403 `tenant_not_allowed`. With
   `identity.multiTenant` on, a token with `tenants` must name one with
   `X-Tenant-Id` (without it: 400 `tenant_required` on `agentcore-gateway`,
   API Gateway's own 401 on `api-gateway`; 403 when it is not in the list). One request always acts for exactly one tenant.
3. **Check the floor**: every scope in `requiredScopes` (for example
   `app/use`) must be in the token (ADR-0005). The identity token carries no
   agent and no tool names.
4. **Resolve the backend**: `/{backend}/invocations` names a registry entry;
   an unknown or `draining` name is 404 (ADR-0024).
5. **Check the tenant limit**: one conditional `UpdateItem`; over it is 429.
6. **Grant**. One `BatchGetItem` reads the tenant row and the user's cut row
   (usually a miss: no cut); the plan, the agent entry and the tool
   catalogue come from the per-process cache. Then:

   ```text
   granted(agent, tenant, user) = A.needs ∪ (A.tools ∩ T.tools ∩ U.tools)
       only if agent ∈ T.agents ∩ U.agents
   ```

   `A` is the agent product (its registry entry's `needs` and `tools`), `T`
   the tenant's subscription (direct entries plus its plan), `U` the tenant
   set minus the tenant admin's cuts for this user. Outside
   `T.agents ∩ U.agents` is 403 `agent_not_subscribed`; a `suspended` tenant
   is 403 `tenant_suspended`. `<target>/*` entries are expanded against the
   catalogue, the rule runs, and the result is compressed back per whole
   target and sorted, so the same inputs give the same `scope` (ADR-0030,
   ADR-0032). A tenant admin can only cut, never add (ADR-0033).
7. **Mint the transaction token**: KMS `Sign`, `RS256`, 300 s, `kid` = the
   KMS key id. It is cached per tenant, user and agent plus the tenant,
   agent and plan versions, so a subscription change or a cut changes the key
   and is seen by the next request (ADR-0031, ADR-0036).
8. **Vend credentials**: the TVM assumes the tenant role tagged
   `TenantId = tenant_id` (ADR-0012, ADR-0022).
9. **Choose the unit**: a fresh session id per request with `session` off;
   with it on, one derived from `tenant_id` (default `scope: 'tenant'`,
   ADR-0039) or `tenant_id` and `sub` (`'user'`) plus `conversationId`. A
   client session header is ignored or overwritten (ADR-0002, ADR-0013).
10. **Invoke the Runtime** with two allowlisted headers:
    `X-Amzn-Bedrock-AgentCore-Runtime-Custom-Tenant-Credentials` (base64
    JSON) and `X-Amzn-Bedrock-AgentCore-Runtime-Custom-Transaction-Token`
    (the raw JWT). The identity token is not among them.
11. **Meter**: on `api-gateway` the Lambda reads the closing `usage` event
    and logs `request served`; the interceptor logs `request admitted`.

**At the tools gateway.** The agent sends the transaction token as bearer
to each tools gateway its `aud` names. On `tools/call`:

1. The Gateway's `CUSTOM_JWT` authoriser checks the token against the
   ingress's discovery URL and `allowedAudience: ['tools-gateway:<name>']`:
   an identity token fails on `iss`, a token for another gateway on `aud`.
   The Gateway refuses tokens with 60 s or less left, so a token works at a
   gateway until `exp − 60 s` (hence `ttl` ≥ 120 s).
2. The **REQUEST interceptor**, the per-tool wall, re-verifies the token
   (`typ`, `iss`, `aud` with `agent:<agent>` and `tools-gateway:<name>`,
   `act.sub` = the ingress role, `exp`), checks the tool against `scope`
   (exact `<target>/<tool>` or `<target>/*`), signs a tenant context with
   `ToolContextKey` into the reserved argument `_ri_ctx`, overwriting any
   client value. Any failure is a refusal: it fails closed (ADR-0040).
3. **AgentCore Policy**, the per-target wall: one Cedar star permit per
   target on the `scope` claim, default deny (ADR-0041). The same permit
   filters `tools/list` at target grain; with `responseFilter` a RESPONSE
   interceptor trims each page to the exact granted tools, only removing.
4. **The tool** verifies `_ri_ctx` (signature, `tool`, `argsHash`, `exp`),
   strips it, and assumes its own tool tenant role with `TenantId` from the
   context. A call without a valid context assumes no role.

Change lag (ADR-0036): a subscription change or a cut lands for the next
mint and for tokens in flight at their `exp`; a plan or agent-product
change within `registryTtl`; a tool removed from a target at once. On
`api-gateway` the authoriser caches its decision for at most 60 s
(ADR-0043), so a change for a caller whose identity token is still cached
lands within that window. Depth: [`architecture.md`](./architecture.md#request-flow),
spec §3.6 and §4.6.

## Deploy

### Prerequisites

- An AWS account, non-production, CDK-bootstrapped, in a Region with
  AgentCore Runtime, Gateway and Policy. The integration test runs in
  `eu-central-1`. **Node.js 24**; no Docker (esbuild bundles locally).
- **An API Gateway CloudWatch Logs role set on the account and Region**: the
  construct turns on execution logging but not the account-wide role
  (`cloudWatchRole: false`). If `aws apigateway get-account` shows no
  `cloudwatchRoleArn`, set one as [tenant-identity's Deploy
  section](../tenant-identity/README.md#deploy) describes.
- **Bedrock model access** to Amazon Nova Lite, which the demo calls through
  the Region's cross-Region inference profile (`eu.`, `us.` or `apac.`;
  ADR-0028). Override with `--context modelId=<id>`.
- **tenant-identity, topology `shared-pool`, deployed and published** in the
  same account and Region, at a version with the scope catalogue
  (`GET|PUT|DELETE /platform/scopes/{scope}`). This sample reads
  `/application-plane/shared/identity/{userPoolId,appClientId}` for the
  issuer (ADR-0004). Deploy it from [`../tenant-identity`](../tenant-identity/README.md#deploy):

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
  catalogue, once: `app/use` (the floor every tenant user holds) and
  `entitlements/admin` (held by tenant admins). Backends and tools register
  nothing with the identity provider (ADR-0030). The calls are SigV4 under a
  principal with tenant-identity's `platformInvokePolicyArn`. Read the API
  URL and export your credentials for curl:

  ```bash
  export AWS_REGION=eu-central-1
  IDENTITY_API="$(aws ssm get-parameter --name /application-plane/shared/identity/apiUrl --query Parameter.Value --output text)"
  eval "$(aws configure export-credentials --format env)"
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
rule that refuses to deploy.

The demo's inputs are CDK context keys, parsed by `parseDemoContext` in
[`src/demo.cdk.ts`](./src/demo.cdk.ts); synthesis fails fast naming a missing
or malformed key. The demo always creates two tools gateways (`default`, and
`finance` with `responseFilter`) and the `crm` and `invoices` targets; two,
so that the integration test covers a multi-gateway `aud` (see "Laying out
tools gateways" below).

| Context key | Values | Default | What it does |
|---|---|---|---|
| `ingress` | `api-gateway`, `agentcore-gateway` | required | The ingress (ADR-0003); part of the stack name `RuntimeIsolation-<ingress>` |
| `session` | `tenant`, `user`, `off` | `off` | Session mapping (ADR-0013, ADR-0039) |
| `requiredScopes` | comma-separated scopes | unset | The floor, for example `app/use` (ADR-0005) |
| `multiTenant` | `true`, `false` | `false` | Accept `tenants` with `X-Tenant-Id` (ADR-0038) |
| `tvm` | `true`, `false` | `false` | "Demo tenant data": a tenant-partitioned table, a data-bearing tenant role, a tool tenant role per target. With `false` the TVM still runs with the model-only `TenantModelRole` (ADR-0018) |
| `includeUserIdTag` | `true`, `false` | `false` | Add `UserId = sub` as a session tag (ADR-0022) |
| `modelId` | a model or inference profile id | the Region's Nova Lite profile | The one model the tenant role may invoke |
| `perTenantMetrics` | `true`, `false` | `false` | Per-tenant metrics and the cost dashboard (ADR-0021) |
| `requestsPerMinute` | non-negative integer | 60 | Requests per tenant per minute; `0` turns it off |
| `outputTokensPerMinute` | non-negative integer | unset | Output tokens per tenant per minute; `api-gateway` only |
| `billingBackend` | `true`, `false` | `false` | Add the `billing` agent |
| `keyGeneration` | positive integer | 1 | Bump to rotate the signing key |
| `owner` | a string | per resource | Owner marker of the name reservations (ADR-0035) |
| `publishParameters` | `true`, `false` | `true` | `false` on a second demo stack beside the first: its registry and document then live under `/application-plane/shared/agent-runtime/<stackName>/` |

The demo agents are products: `default` needs `default/chat` and may use
`crm/*`; `billing` needs `billing/read` and `billing/invoke` and may use
`invoices/*`. A tenant reaches neither until the vendor writes its
subscription through the Entitlements API (SigV4). Read the API's base URL
from the published document's `entitlementsApiUrl` (see
[Published interface](#published-interface)), then send the subscription
there. For example, tenant `<tenantId>` subscribed to `default` and two
`crm` tools:

```bash
ENT_API="$(aws ssm get-parameter --name /application-plane/shared/agent-runtime/ingress --query Parameter.Value --output text | jq -r .entitlementsApiUrl)"
curl -s -w '\n%{http_code}\n' -X PUT --aws-sigv4 "aws:amz:${AWS_REGION}:execute-api" --user "${AWS_ACCESS_KEY_ID}:${AWS_SECRET_ACCESS_KEY}" -H "x-amz-security-token: ${AWS_SESSION_TOKEN}" -H 'Content-Type: application/json' --data '{"agents":["default"],"tools":["crm/get_account","crm/list_cases"]}' "${ENT_API%/}/tenants/<tenantId>"
```

[`scripts/integ.sh`](./scripts/integ.sh) (`stack_fixtures`) writes a plan,
two subscriptions and a cut the same way.

**Outputs** include `EndpointUrl`, `RuntimeArn`, `Issuer`,
`EntitlementsApiUrl`, `EntitlementsTableName`, the roles, and
`ToolsGatewayUrl<Name>` and `PolicyEngineId<Name>` per tools gateway (the
full list is at the end of [`src/demo.cdk.ts`](./src/demo.cdk.ts)). Check
the Runtime ARN's account before you send tokens to `EndpointUrl` (M-20).

### Published interface

The ingress publishes **one JSON parameter**,
`/application-plane/shared/agent-runtime/ingress` (`<registryPrefix>ingress`,
Intelligent-Tiering, up to 8 KB), instead of one parameter per value:
Parameter Store allows 3 writes per second per account, and several stacks
writing 20-odd parameters each failed to delete (ADR-0042). The names are
account-wide, so one stack per account and Region publishes; `publish: false`
writes none.

| Field | Value |
|---|---|
| `version` | `2` |
| `ingress` | `api-gateway` or `agentcore-gateway` |
| `endpointUrl` | The invocation URL: the default backend's when `defaultBackend` is set, else the base URL |
| `baseUrl` | The ingress base URL; a backend is at `<baseUrl>/<backend>/invocations` |
| `ingressRoleArn` | The one principal every Runtime behind this ingress trusts |
| `ingressId` | The `ri:ingress` tag value every Runtime behind it carries |
| `tenantRoleArn` | The role every model call is signed by |
| `gatewayIdentifier` | `agentcore-gateway` only: the Gateway a backend adds its target to |
| `issuer`, `jwksUrl` | The transaction-token issuer and `<issuer>/.well-known/jwks.json` |
| `entitlementsTableName` | The entitlement store, for name reservations |
| `entitlementsApiUrl` | The Entitlements API base URL |
| `toolContextKeyId` | With a tools gateway: the key that signs tool contexts |
| `toolsGateways` | `{ <name>: { url, identifier, roleArn, policyEngineId } }` |

Under the same prefix each `AgentBackend` writes its registry entry
`backends/<name>` = `{runtimeArn, needs, tools, version, status}` (spec
§4.3), and each `ToolTarget` its pointer `tools/<target>` =
`{gatewayTargetId, gateway, kind, status, version}` (spec §4.4); the tool
names live in the entitlement store's catalogue rows.

**Consumed interface**: tenant-identity's
`/application-plane/shared/identity/{userPoolId,appClientId}`, read by the
demo app only (the constructs take the issuer as props); the integration
driver also reads `apiUrl` to register the vendor scopes and create tenants.

### Teardown

```bash
npx cdk destroy --context ingress=api-gateway
```

Every resource has `RemovalPolicy.DESTROY`; policies go before their
targets (ADR-0040), the log drain waits about 90 s (ADR-0019), and KMS keys
enter their deletion window. Afterwards remove the two vendor scopes
(`DELETE /platform/scopes/{scope}`) if you added them.

### Use the construct in your own app

Declare this sample as a local dependency (`file:../agentic-runtime-isolation`)
in your `.projenrc.ts` and import from its package entry (standard §1.1).

```ts
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
  toolsGateways: { default: {}, finance: { responseFilter: true } },
});

new AgentBackend(this, 'Support', {
  name: 'support',
  ingress,
  agent: { codePath: 'path/to/agent-bundle', modelId: 'eu.amazon.nova-lite-v1:0' },
  needs: ['support/chat'],
  tools: ['crm/*', 'invoices/get_invoice'],
});

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
`oauth` (grant `3LO`, `OBO` or `M2M`) or `apiKey`. Targets with 2LO or an API
key are **filtered** isolation (one vendor-shared credential) and synth
warns so (ADR-0034). A Lambda tool wraps its handler with `toolHandler`, or
calls `verifyToolContext` and `withTenantCredentials`; its `tvm.role` trusts
that function's role only, requires the `TenantId` request tag, and scopes
data by `${aws:PrincipalTag/TenantId}` (spec §6.1).

**In another stack.** `SharedIngress.fromParameters(scope, id, registryPrefix,
ingress?, { toolsGateway?, toolsGateways? })` returns a `SharedIngressRef`
for `AgentBackend` and `ToolTarget`. CloudFormation cannot parse JSON at
deploy time, so it is a **synth-time context lookup**, like `Vpc.fromLookup`
(ADR-0042): the consuming stack needs `env: { account, region }`, synth
needs credentials for that account, and the value is cached in
`cdk.context.json`. After the ingress is replaced or its values change,
reset the cached key so the next synth reads it again:

```bash
npx cdk context --reset "ssm:account=111122223333:parameterName=/application-plane/shared/agent-runtime/ingress:region=eu-central-1"
```

A `ToolTarget` in another stack also takes `maxToolsPerGateway` for its
deploy-time check.

**Options.** Every prop is validated at synth and an invalid combination
fails naming the prop. The TSDoc in
[`src/shared-ingress.cdk.ts`](./src/shared-ingress.cdk.ts),
[`src/agent-backend.cdk.ts`](./src/agent-backend.cdk.ts) and
[`src/tool-target.cdk.ts`](./src/tool-target.cdk.ts) has the rest.

| Prop (`SharedIngress`) | Default | Meaning |
|---|---|---|
| `identity.discoveryUrl`, `identity.allowedClientIds` | required | The identity issuer |
| `identity.multiTenant` | `false` | Accept `tenants` with `X-Tenant-Id` (ADR-0038) |
| `ingress` | required | `api-gateway` or `agentcore-gateway` |
| `session` | off: a fresh unit per request | `{ scope: 'tenant' }` when set; `'user'` is the option (ADR-0039) |
| `requiredScopes` | off | The floor (AND) |
| `tvm` | always on: model-only `TenantModelRole`, `TenantId` tag, 900 s, 1,000 cached sets | `role`, `includeUserIdTag`, `claimTags`, `durationSeconds` (900 to 3,600), `cacheMaxEntries` |
| `tenantLimits` | `{ requestsPerMinute: 60 }` | `outputTokensPerMinute` on `api-gateway` only; `false` turns limits off |
| `stageThrottle` | 50 rps, burst 25 | `api-gateway` only, shared by every tenant |
| `perTenantMetrics` | `false` | EMF metrics per tenant (ADR-0021) |
| `registryPrefix` | `/application-plane/shared/agent-runtime/` | Where the registry and the document live |
| `publish` | `true` | Write the published document (ADR-0042) |
| `registryTtl` | 60 s | Cache life of registry entries, plans and the catalogue, 1 s to 750 s |
| `defaultBackend` | unset | The backend at the bare `/invocations` route |
| `transactionToken.ttl` | 300 s | 120 s to 900 s |
| `transactionToken.algorithm` | `RS256` | `ES256` is also accepted by the Gateway (V-8) |
| `transactionToken.keyGeneration` | 1 | Bump to rotate (spec §6.2.3) |
| `transactionToken.cacheMaxEntries` | 1,000 | Minted tokens per ingress instance, LRU |
| `entitlements.adminScope` | `entitlements/admin` | Scope of the tenant-admin operations |
| `entitlements.maxAgentsPerTenant`, `maxToolsPerTenant` | 1,000 each | Entries in a tenant or plan row (`<target>/*` counts once) |
| `toolsGateways` | `{ default: {} }` | Named gateways; `toolsGateway: {...}` is shorthand for `default`, `toolsGateway: false` creates none |
| `toolsGateways.<name>.maxToolsPerGateway` | 300 | Synth fails above it (Cedar schema bound) |
| `toolsGateways.<name>.tenantRateLimit` | `{ requestsPerSecond: 10 }` | Native bucket per `tenant_id`; `tenantRateLimitOverrides` for up to 1,000 named tenants |
| `toolsGateways.<name>.contextLifetime` | 60 s | `exp` of the signed tool context, 10 s to 300 s |
| `toolsGateways.<name>.interceptorProvisionedConcurrency` | 1 | On that gateway's interceptor; 0 turns it off |
| `toolsGateways.<name>.responseFilter` | `false` | Trim `tools/list` to the exact granted tools |

**Laying out tools gateways.** A gateway is a tool partition, not a tenant
partition: every tenant shares every gateway, and the tenant wall is the
tool's tenant role (spec §6.1), whichever gateway the call came through.
Several domains on one gateway is the default and is fine; the split exists
because one Policy engine's Cedar schema holds about 330 tools (ADR-0041),
and because the per-tenant rate limit and `responseFilter` are set per
gateway. Each extra gateway costs one more Policy engine, one more
interceptor (provisioned concurrency 1 unless turned off), one more MCP
client in each agent that uses it, and another 10 rps of per-tenant budget.
Deploy time does not change: a `ToolTarget` is one star permit either way.

| Layout | When | Trade |
|---|---|---|
| One gateway, all domains (`{ default: {} }`) | under `maxToolsPerGateway` and one `responseFilter` setting fits all | one rate bucket per tenant, one MCP client per agent |
| One gateway per tool domain (the demo: `crm` on `default`, `invoices` on `finance`) | a domain needs `responseFilter` or its own rate budget, or a domain nears the bound | a tenant's budget is per domain; an agent holds one client per domain in its `aud` |
| Pack by count | thousands of tools, no per-domain rules | leave a margin: a target that grows past the bound fails its deploy, and moving a target changes every granted token's `aud` |
| One gateway per agent | agents use disjoint tool sets | shortest `tools/list`; a tool two agents share needs a target on each gateway, under two names (target names are unique per ingress) |

Pick the first that fits, in that order. The demo uses two gateways only to
exercise the second layout: an `aud` with two entries, a token for one
gateway refused by the other, and `responseFilter` on one of them.

`AgentBackend` takes `name` (`[a-z0-9-]{1,32}`), `ingress` (a
`SharedIngress` or `SharedIngressRef`), `agent` (`{ codePath, modelId,
environment? }`), `needs` (required, `<name>/<action>`, always granted with
the agent), `tools` (default `[]`, `<target>/<tool>` or `<target>/*`, at most
64) and `owner` (default `<StackId>#<LogicalResourceId>`; stacks sharing one
are destroyed together). `TokenSigner` takes `algorithm`, `keyGeneration`
and `signer` and offers `grantSign(grantee)`, which only the integration
stacks' test mint uses. `EntitlementStore` takes `maxAgentsPerTenant` and
`maxToolsPerTenant`.

## Deployment integration test

The deployment integration test ([`test/integ.runtime.ts`](./test/integ.runtime.ts),
driven by [`scripts/integ.sh`](./scripts/integ.sh)) is the reference
implementation of this sample's wiring ([sample standard
§5.2](../../docs/sample-standard.md#52-integration-test)): it deploys or
reuses tenant-identity through tenant-identity's own deploy path, registers
the vendor scopes, wires the stacks through the published document where a
consumer would and reads stack outputs for the values a step needs (the
non-publishing stacks write no parameters and the test-only hooks are never
published; ADR-0044), writes subscriptions, a plan and a cut through the public Entitlements API,
drives every step through the public routes, and tears everything down. Its
steps are named and ordered as the table below, so the two read side by
side.

Use a non-production, CDK-bootstrapped account, in exactly one Region: the
script fails fast when `AWS_REGION` is unset.

```bash
AWS_PROFILE=<profile> AWS_REGION=eu-central-1 npx projen integ
```

Optional knobs: `INTEG_PREFIX` (another stack prefix, default
`RuntimeIsolationInteg`, to deploy beside stacks an earlier run left
`DELETE_FAILED`); `INTEG_PUBLISHER` (the stack that writes the published
document, default `api-gateway`; `none` when the names are taken, which the
script also detects); `INTEG_REPLACE_STALE_IDENTITY=1` (replace a published
tenant-identity without the scope catalogue; this deletes the shared user
pool and every other consumer's tenants, users and tokens, so set it only
where that is acceptable); `INTEG_MODEL_ID` (the model).

It deploys six stacks at once (`--concurrency 6`):

| Stack suffix | Ingress | Modules |
|---|---|---|
| `api-gateway` | `api-gateway` | everything on, both agents, both tools gateways, demo tenant data, per-tenant metrics; publishes the document |
| `agentcore-gateway` | `agentcore-gateway` | the same, not publishing, per-tenant metrics off |
| `session-off` | `api-gateway` | session off, the default `TenantModelRole` |
| `session-user` | `api-gateway` | `session: { scope: 'user' }` |
| `limits` | `api-gateway` | 5 requests per tenant per minute, the floor `app/use` |
| `multi-tenant` | `api-gateway` | `identity.multiTenant` on a second tenant-identity, `shared-pool-multi-tenant` |

A run takes **about 45 minutes** and costs **under about $3** at on-demand
rates, mostly AgentCore Runtime session time and the Gateways across six
stacks; KMS keys bill pro rata, and API Gateway, Lambda, DynamoDB, SSM,
CloudWatch and the few Nova Lite calls add cents.

**Last run: run 9, 2026-11-04, eu-central-1: all 57 steps PASS**, deploy
278 s, steps 1,669 s, teardown clean (no stack, parameter, log group, table,
Gateway or Policy engine left; KMS keys pending deletion). Run 11 (2026-11-04, eu-central-1), after the review fixes: 57 steps PASS,
deploy 272 s, steps 1,814 s, teardown clean; the three tenant-admin
negatives added to step 12 pass; the rotated JWKS was served 10 s after the
key-generation deploy returned.

Steps 3 to 24 run on both all-on stacks except 9-drain and 12-late, which
run on `api-gateway` only (a backend added there is not also a Gateway
target).

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
| 9-registry | registry entries in the v2 shape; unknown backend refused; on `api-gateway` a backend added after the deploy is served within 90 s |
| 12-late | an agent with `needs` only is served; its token names no tools gateway |
| 9-drain | the late backend, once `draining`, is refused within 90 s |
| 11 | the identity token stays at the ingress: header names, `typ: txn+jwt`, `iss` the ingress; the tool's context holds no token |
| 12 | agent subscription: B1 on `billing` 403; AA cuts A1 from `billing` (next request 403), deletes the cut (200); on `api-gateway` the tenant-admin door refuses a token without the admin scope (403 `admin_scope_missing`), an `X-Tenant-Id` naming a foreign tenant (403) and an unsigned vendor call (403) |
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
| limits | `limits`: tenant A limited at 5 a minute, B served; the floor `app/use` admits both |
| 19 | `multi-tenant`: user MU in tenants A' and M: no header refused, B' not allowed, M and A' each their own grant and data |
| 21 | key rotation on `api-gateway` (redeploy with `keyGeneration` 2): the JWKS lists both `kid`s; the old token is accepted until `exp`; new tokens carry the new `kid` |
| 20-cloudtrail | no `AssumeRole` on the `crm` tool tenant role for the direct invoke (with a positive control) |
| sweep | no token, signature segment or `_ri_ctx` value in any log group on the path |
| 8b-metrics | per-tenant `ModelOutputTokens` for tenant A on `api-gateway`; none on `agentcore-gateway` |
| 10 | destroy from the exit trap (also on failure) and verify nothing is left |

That is 35 rows; the 22 per-ingress rows run on both all-on stacks, so the
table the script prints holds 57 steps.

Measured in run 9 (one run from one client; an input to ADR-0009 and
ADR-0029, not a benchmark):

| Measure | api-gateway | agentcore-gateway |
|---|---|---|
| `report` TTFB, warm mint cache, p50 / p95 | 0.203 / 0.244 s | 0.265 / 0.327 s |
| `report` TTFB, cold mint cache, p50 / p95 | 0.227 / 0.248 s | 0.297 / 0.349 s |
| Star permit, `CreatePolicy` to ACTIVE (step 23) | 10.6 to 15.7 s | |
| Key rotation redeploy (step 21) | 151 s | |
| Log sweep | 139 log groups, 0 token hits | |

## End-to-end demo

[`scripts/demo.sh`](./scripts/demo.sh) walks the v2 flow against a deployed
`RuntimeIsolation-<ingress>` stack. It needs the full demo deploy from
[Build and deploy the demo](#build-and-deploy-the-demo) and the two vendor
scopes `app/use` and `entitlements/admin` registered in tenant-identity
([Prerequisites](#prerequisites)); it checks both before it starts.

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

A step whose module is off is skipped with a note. The script prints
statuses, ids, claim names and timings, never a token, credential or header
value, and on every exit, also on failure, deletes what it wrote: the
subscriptions, the plan, the demo table items and the tenants.

[`scripts/perf.sh`](./scripts/perf.sh) measures client-side latency on one
tenant subscribed to `default` with `crm/*` (deleted on exit): scenarios 0 to
5 (first request, new and warm conversations with `report` and a model
prompt, parallel requests) and 6 (`tool crm/get_account {}`, the
tools-gateway path); arguments `[N_COLD] [N_WARM] [N_MODEL] [N_PAR]`
(default 8 20 8 10), `PERF_OUT=<dir>` keeps the raw samples, and
`ENDPOINT` with `ENTITLEMENTS_API` measures an unpublished stack.

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

Errors carry fixed bodies that never echo the token, the unit id or the
input; a v2 refusal adds a reason code that is also the log line's `reason`:

| Status | Body | When |
|---|---|---|
| 400 | `bad request` | malformed `prompt`, `conversationId` or `X-Tenant-Id`; `conversationId` with `session` off |
| 400 | `bad request: tenant_required` | `agentcore-gateway`: the token carries `tenants` and no `X-Tenant-Id` was sent. On a multi-tenant `api-gateway` ingress the header is an authoriser identity source, so a request without it is API Gateway's own 401 before the authoriser runs, also for a single-tenant token, whose value must equal `tenant_id` (ADR-0043) |
| 401 | `unauthorized` | missing or invalid token, or a transaction token presented as identity token (403 on `api-gateway`, ADR-0015) |
| 403 | `forbidden` | no tenant claim, `tenants` without `multiTenant`, a floor scope or a `claimTags` claim missing |
| 403 | `forbidden: tenant_not_allowed` | `X-Tenant-Id` not in `tenants`, or not the token's `tenant_id` |
| 403 | `forbidden: tenant_suspended` | the tenant row is `suspended` |
| 403 | `forbidden: agent_not_subscribed` | the agent is not in `T.agents ∩ U.agents`, including a tenant with no row |
| 404 | `not found` | no registry entry, or it is `draining` |
| 429 | `too many requests` | over `tenantLimits` |
| 502 | `upstream error` | backend invoke failed; registry or store unreadable; a registry entry in the old shape (`registry_entry_v1`); `grant_too_large`; `mint_failed` |

An agent whose grant holds only its `needs` is served (`no_tools_granted`
is a log reason, not an error); its tool calls are refused at the gateway.

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
| `DeletePlan` | `DELETE /entitlements/plans/{planName}` | vendor | 409 `plan_in_use` while a tenant names it |
| `ListPlans` | `GET /entitlements/plans` | vendor | `nextToken` |
| `PutUserCut` | `PUT /entitlements/users/{sub}/cut` | tenant admin | `{ cutAgents, cutTools }`; only names the tenant holds (400 `not_subscribed`) |
| `GetUserCut` | `GET /entitlements/users/{sub}/cut` | tenant admin | 404 when the user has no cut |
| `DeleteUserCut` | `DELETE /entitlements/users/{sub}/cut` | tenant admin | 204; the user holds the full tenant set again |
| `ListUserCuts` | `GET /entitlements/users` | tenant admin | the caller's tenant only |

A vendor write naming anything that is neither a reserved agent nor a
catalogued tool (or `<target>/*` of a catalogued target) is 400
`unknown_name`; a tenant-admin call without `entitlements/admin` is 403
`forbidden: admin_scope_missing`. The tenant-admin handler runs under
credentials tagged with the caller's `TenantId`, and IAM limits its writes to
that tenant's rows: a cut for another tenant fails in IAM.

### Transaction token

JOSE header `{ "alg": "RS256", "typ": "txn+jwt", "kid": "<KMS key id>" }`
(ADR-0031, ADR-0037):

| Claim | Value |
|---|---|
| `iss` | the ingress issuer, `<baseUrl>` |
| `sub` | `<tenant_id>#<sub>` (tenant-qualified, ADR-0040) |
| `user` | the identity token's `sub` |
| `tenant_id` | the one selected tenant |
| `agent` | the backend name |
| `scope` | the granted set, space-separated, sorted, compressed per target |
| `aud` | `agent:<name>` plus `tools-gateway:<gw>` for each gateway the agent's tools live on |
| `act.sub` | the ingress role ARN |
| `txn` | a unique id per mint |
| `iat`, `exp`, `jti` | issue time, `iat + ttl`, unique id |

No refresh token, and no claim of the identity token beyond `sub` and the
tenant. Rotation: bumping `keyGeneration` from N to N+1 makes N+1 the signer
and leaves N in the JWKS without `kms:Sign`; bumping to N+2 drops N and
schedules its deletion. Wait at least `transactionToken.ttl` + 5 minutes
between bumps (20 minutes at the 900 s maximum).

### Signed tool context and tools gateway

The tool context is a compact JWS in the reserved argument `_ri_ctx`,
`typ: ri-ctx+jwt`, signed by `ToolContextKey` (never in the JWKS, so a
context can never pass as a transaction token): `tenant_id`, `sub`, `agent`,
`tool` (`<target>/<tool>`), `argsHash` (base64url SHA-256 of the canonical
arguments without `_ri_ctx`), `txn`, `iat`, `exp` (`iat + contextLifetime`).
The tool-side library refuses a missing, expired, mismatched or foreign
context with `context_invalid` and assumes no role.

Each tools gateway speaks MCP over streamable HTTP, bearer = the transaction
token. A bad signature, `aud`, `iss` or `exp` is 403 `insufficient_scope`
from the Gateway; only a missing bearer or an unknown `kid` is 401. The
interceptor refuses with 403 `act_missing`, `aud_mismatch`,
`tool_not_granted`, `token_invalid` or `malformed_request` (a JSON-RPC
batch, an unknown method, or non-object `arguments`); Policy refuses a target the token
names no entry of; an empty tenant bucket is 429; an interceptor error or
timeout is a Gateway 5xx, never a pass-through.

## Scale and limits

The design targets 10,000s of tenants, 100,000s of tenant users, 100s of
agents and 1,000s of tools; none of those counts grows a policy, a Gateway, a
role or a token per tenant or per user (P-16). What grows with agents and
tools is bounded here (spec §3.6; the quotas each value protects are in
[`architecture.md`](./architecture.md#scale-limits)):

| Grows with | Where | Bound |
|---|---|---|
| Agents | registry entries in SSM | SSM standard tier, 10,000 parameters; read per name, cached |
| Agents | Runtimes | AgentCore Runtime quota per account |
| Agents on `agentcore-gateway` | one Runtime target each on the ingress Gateway | **100 targets per Gateway: that ingress caps at 100 agents**; `api-gateway` has no such cap |
| Agents per tenant | `agents` on the tenant row | `maxAgentsPerTenant`, 1,000 |
| Tools | catalogue rows | 1,000 per target; queried one target at a time, cached `registryTtl` |
| Tools | Cedar policy per target | one star permit, about 450 bytes, whatever the tool count |
| Tools | Policy engine schema | 400 KB per engine, about 330 tools: `maxToolsPerGateway` 300; add gateways by tool domain |
| Targets | per Gateway | 100 |
| Tools | `tools/list` pages | about 30 tools a page; an agent lists only the gateways in its `aud` |
| Tools per tenant | `tools` on the tenant row | `maxToolsPerTenant`, 1,000 entries; subscribe by `<target>/*` |
| Tools in a token | `scope` after compression | 6,144 bytes; over it is 502 `grant_too_large` |
| Tools in a token | the encoded transaction token | 10,240 bytes, the Runtime's custom header cap; over it is 502 `grant_too_large` |

Pooled resources every tenant shares, in the order they give out (scale
review 2026-11-05; T-105). Each has a prop or a formula:

| Pool | Default | Gives out at | Size it with |
|---|---|---|---|
| `api-gateway` stage throttle | 50 rps, burst 25, one bucket for every tenant and every refusal; the per-tenant limit runs behind it | 50 tenants at the default 60/min; one tenant at 50 rps starves the rest | `stageThrottle.rateLimit` >= tenants x `tenantLimits.requestsPerMinute` / 60 (synth warns when unset); WAF rate rules for an edge limit per tenant |
| Lambda concurrency | account pool (1,000); the integration function is held for the whole stream | rps x average stream seconds (50 rps at 20 s, 8 rps at 120 s) | `ingressReservedConcurrency` on the streaming function; raise the account quota |
| KMS `Sign` | 1,000 RSA requests/s per account per Region, shared by the mint, one `Sign` per admitted `tools/call` and every other RSA key | about active (tenant, user, agent) triples / 120 s + tool calls/s | `toolContextKey.algorithm: 'ES256'` (the ECC quota); `transactionToken.algorithm: 'ES256'`; a quota increase |
| STS `AssumeRole` | 600 rps per account per Region; the ingress TVM, every tool's TVM and the tenant-admin TVM share it | cold-start fan-out: new instances x tenants each; steady state is instances x tag sets / 780 s | reserved concurrency to bound fan-out; `tvm.includeUserIdTag` off |
| SSM `GetParameter` | 40 TPS; a throttled cold registry read is cached as `registry_unavailable` for one TTL on that instance | 40 cold reads in one second (a deploy, a burst) | Parameter Store higher throughput; fewer distinct backends per instance |
| Per-tenant limiter item | one conditional `UpdateItem` per request on `TENANT#<id>#<minute>` | 1,000 writes/s from one tenant, then the limiter fails open | reachable only above the stage throttle |

Spike findings behind those bounds (spec §7):

- The Cedar schema caps an engine at 400 KB (about 330 tools), hence
  `maxToolsPerGateway` 300 and several gateways.
- A per-tool policy holds 28 tools per statement and takes 2 to 3 minutes to
  ACTIVE at 15 or more policies, so each target gets one star permit and the
  interceptor decides per tool.
- Policy names are unique per account and policy writes must be sequential:
  `ToolTarget` creates one at a time with retry, and deletes its policy
  before its target.
- Both ingresses forward the transaction token to the Runtime in a custom
  header, and `InvokeAgentRuntime` refuses a header value over 10,240 bytes
  (spike V-17), so the mint refuses a token longer than that
  (`MAX_TOKEN_BYTES`) and `scope` is bounded at 6,144 bytes
  (`MAX_SCOPE_BYTES`, checked before the KMS call; ADR-0045). The token is
  about 4/3 of `scope` plus 1.3 to 1.6 KB of other claims and signature, so
  a full `scope` gives a token of about 9.7 KB. Whole targets compress to
  one entry, and `scope` holds about 600 short names (`crm/t0001`). A user
  cut from one tool of a 300-tool target expands to 299 names (about
  2.7 KB): two such targets still fit, three overflow, and one 300-tool
  target with 24-byte tool names overflows alone (about 7.5 KB). Every
  overflow fails loud with 502 `grant_too_large` before any Runtime call.
- The Runtime's header-allowlist page documents 4 KB per header value; the
  service enforces 10,240 bytes, and the sample relies on the enforced
  figure (threat model T-101). If the Runtime starts enforcing 4 KB, a
  token over it fails at the Runtime with a 400 (`scope` of about 2 KB);
  lower `MAX_TOKEN_BYTES` and `MAX_SCOPE_BYTES` to match.
- The API Gateway REQUEST authoriser's context is not a limit: it carried
  24,000 bytes to the integration, cached and uncached (V-17).
- The Gateway refuses a token with 60 s or less left: a token works at a
  gateway until `exp − 60 s`, so `ttl` is at least 120 s.
- KMS `Sign` takes 8.2 ms at p50; Parameter Store allows 3 writes per second
  per account (hence one JSON parameter); STS `AssumeRole` allows 600
  requests per second per account per Region, shared by every TVM, whose
  per-tag-set caches keep the rate per tenant, not per request.

Every tenant shares the stage throttle and the integration Lambda's
concurrency, each tools gateway's quotas (200 TPS, 5,000 connections), and
SSM's 40 read TPS for registry misses. The tenant limit is a fixed
one-minute window (up to twice the limit across a boundary) and admits
requests if DynamoDB errors.

**Known limitations**:

- Revocation lags: a cut or an unsubscription reaches tokens in flight only
  at their `exp` (300 s by default); no revocation list is kept. Lower
  `transactionToken.ttl` for a faster stop.
- On `api-gateway` the authoriser caches its decision for up to 60 s per
  identity token and path (ADR-0043). On a single-tenant ingress the cache
  key does not include `X-Tenant-Id`, so within that window a disagreeing
  header is not re-checked; the request still acts for the token's own
  `tenant_id`.
- Without `responseFilter`, `tools/list` shows every tool of a target the
  user holds any entry of; the call is still refused per tool.
- Policy refusals carry no tenant in its logs. The interceptor runs first and
  logs every refusal it makes; a Policy denial after an admitted call means
  the two disagree and should be alarmed on.
- OpenAPI and Smithy targets with 2LO or an API key are filtered isolation,
  and a tools gateway's per-tenant rate limit fails open by design.
- The `agentcore-gateway` ingress never sees the response, so backend
  seconds, tokens and bytes are not attributed there.
- A grant whose token would exceed 10,240 bytes is refused, not served
  (502 `grant_too_large`): resolved by spike V-17 and ADR-0045 (threat
  model T-100). The bound rests on the Runtime's enforced header limit,
  which is above its documented 4 KB (T-101).

## Costs

What one deployment adds, pooled across tenants:

- **KMS**: two customer-managed keys per ingress (the token signer and
  `ToolContextKey`, three during a rotation), about $1.0/month each, plus
  `Sign` calls: one per mint (the mint cache reuses a token for most of its
  life) and one per admitted tool call.
- **AgentCore Policy**: $0.025 per 1,000 authorisation requests, one per
  `tools/call` and per `tools/list` page.
- **AgentCore Gateway and Runtime**: per MCP operation on each tools
  gateway (and per invocation on the `agentcore-gateway` ingress); active
  vCPU and memory per second of each Runtime session.
- **Lambda**: the authoriser and ingress functions, one interceptor per tools
  gateway (one provisioned-concurrency instance each by default), the
  optional list filter and the tool functions.
- **DynamoDB**: on-demand tables (entitlements, tenant limits), PITR on
  every table.
- **Per-tenant metrics** (opt-in): 9 × (1 + agents) CloudWatch custom
  metrics per tenant per ingress, billed monthly; 180,000 metrics at 10,000
  tenants on one agent.

Nothing in the bill carries a tenant tag, so two mechanisms attribute cost
per tenant. **Model tokens come from the bill, by IAM principal**
(ADR-0018): the agent signs every model call with credentials tagged
`TenantId`, so CUR 2.0 and Cost Explorer attribute model cost to
`iamPrincipal/TenantId`. **Everything else the ingress meters**: its log
line carries `tenantId`, `backend`, `ttfbMs`, `streamedBytes`,
`backendInvokeSeconds`, `usageInput`, `usageOutput` and `modelId`, and the
interceptor's `tool admitted` line carries `tenantId`, `gateway` and the
tool, so tool calls count per tenant too.

**Turn on model-cost attribution** (one-time, account level): in **Billing →
Cost allocation tags**, activate `iamPrincipal/TenantId`; in the CUR 2.0
data export, enable **"Include caller identity (IAM principal) allocation
data"**. Model cost per tenant is then one query over
`line_item_iam_principal` and `iamPrincipal/TenantId`.

**The usage event** (agent-to-ingress contract). Every agent response is a
`text/event-stream` whose last event is:

    event: usage
    data: {"inputTokens":123,"outputTokens":45,"modelId":"<model id>"}

The figures are integers from the model call (zero, with no `modelId`, for
a probe). A model failure sends `event: error` and no usage event, so those
tokens show as unattributed, never as zero. The ingress forwards the stream
unchanged and reads the event as a cross-check against the bill, not the
billing source (ADR-0017); your own agent keeps the metering by emitting it.

**The metrics**, only with `perTenantMetrics` (namespace `RuntimeIsolation`,
dimension sets `[TenantId, Ingress]` and `[TenantId, Ingress, Backend]`,
ADR-0021): `Requests`,
`IngressDurationMs`, `Errors4xx`, `Errors5xx` and `TtfbMs` on both
ingresses; `BackendInvokeSeconds`, `ModelInputTokens`, `ModelOutputTokens`
and `StreamedBytes` on `api-gateway` only. The demo's four Contributor
Insights rules on `api-gateway` (top tenants by requests, errors, backend
seconds and output tokens) work with metrics off.

**Attribution formula**:

    cost(tenant) = Σ over metered figures ( figure(tenant) × unit price )
                 + model cost from CUR 2.0 by iamPrincipal/TenantId
                 + share of the unattributable remainder

Price `BackendInvokeSeconds` at Runtime vCPU-hour and GB-hour (wall time is
an upper bound, so treat it as the share key), `IngressDurationMs` at Lambda
GB-seconds, `Requests` at the Lambda plus API Gateway or AgentCore Gateway
request price, each `tool admitted` line at the gateway operation, Policy
authorisation, interceptor and tool Lambda and KMS `Sign` prices, and
`StreamedBytes` at data transfer out where billed.

The **unattributable remainder** is KMS key-months, provisioned
concurrency, log storage and ingestion, dashboards and Contributor Insights
rules, custom metrics, and the backend time of streams that broke before the
usage event. The sample apportions it by each tenant's share of
`Requests`, refusals included ([`architecture.md`](./architecture.md)).

## Security notes

Threats, mitigations and accepted risks: [`threat-model.md`](./threat-model.md).

- **Identity model.** The identity token is the only source of tenant
  context (P-3): `tenant_id`, or one of `tenants` selected and checked by
  `X-Tenant-Id`. It never leaves the ingress: the agent and the tools see
  only the transaction token, the tools only the signed context, and the
  Runtime's header allowlist has no user-token header (integ step 11).
- **One trusted principal.** Each Runtime's resource policy allows
  `InvokeAgentRuntime` to the ingress role only, so a leaked token cannot
  reach a unit directly and a caller cannot name another tenant's session
  (ADR-0001, ADR-0002).
- **Two walls at `tools/call`.** The REQUEST interceptor runs first and
  decides per tool; AgentCore Policy, default deny with one star permit per
  target, decides per target. The interceptor fails closed: an in-code error
  is a refusal, a timeout or throw a Gateway error (V-11).
- **Tool data.** A tool reaches tenant data only through its own TVM:
  `AssumeRole` with `TenantId` from the verified context, bound by the tool
  tenant role's trust policy to the one tool function's role and the
  `TenantId` request tag. The agent role has no `sts:AssumeRole`, no model
  permission and no data; the model and tenant data are reached only with
  the ingress-vended credentials.
- **Signing keys.** `kms:Sign` is granted only in the key policy: on the
  token signer to the minting role, on `ToolContextKey` to the interceptor.
  Grants are denied in the key policy (`kms:CreateGrant` for every
  principal) and the account root has no `kms:Create*`, so no IAM policy can
  add a signer. The residual is `kms:PutKeyPolicy`, held by the account's
  key administrators (the deployer's own privilege), visible in CloudTrail.
  Neither private key can be exported.
- **Token lifetime.** Every verifier requires `exp` and `iat`; a token
  without them is refused whatever its signature.
- **No token in any log.** Header-free access logs, `dataTraceEnabled:
  false`, field-allowlisted loggers, and Gateway application logs off (they
  record the request body after the interceptor). The integration run's
  sweep step searches every log group on the path for token signature
  segments and `_ri_ctx` values.
- cdk-nag `AwsSolutionsChecks` runs on every synth; each suppression cites an
  ADR or a mitigation (ADR-0014).

## Production hardening checklist

The constructs are hardened components; what follows is what a deployment
must add. Each item is a deployer action or an accepted risk in
[`threat-model.md`](./threat-model.md#mitigations).

- [ ] **Rotate the signing key** by bumping `transactionToken.keyGeneration`
      on a schedule, at least `transactionToken.ttl` + 5 minutes between
      bumps, 20 minutes at the 900 s maximum (M-64).
- [ ] **Alarm on KMS `Sign`**: its rate, its errors, and any `Sign` in
      CloudTrail by a principal other than the minting role or the
      interceptor, and any `PutKeyPolicy` on either key outside a deploy
      (M-40, M-68, M-78, T-52, T-84, T-97).
- [ ] **Keep Gateway application logs off**: they record the signed context
      and every tool result (ADR-0040, M-67).
- [ ] **Use OBO only with authorisation servers you trust**: the transaction
      token they receive stays a valid tools-gateway bearer until `exp`
      (M-74, T-92). Prefer 3LO or OBO over 2LO and API keys (M-66, T-82).
- [ ] **Turn on `responseFilter`** on gateways where products grant partial
      targets, so `tools/list` shows only the granted tools (M-70).
- [ ] **Split tools over several gateways by tool domain**, below
      `maxToolsPerGateway`, each with its own rate limits (M-72).
- [ ] **Own the tenant roles' trust and ABAC**: the agent's `tvm.role`
      trusts `tvmCallerRole` only, each tool tenant role its one function's
      role; require `aws:RequestTag/TenantId`, pin `aws:TagKeys`, scope data
      by `${aws:PrincipalTag/TenantId}`, and map only vendor-set claims in
      `tvm.claimTags` (M-10, M-11, T-16, T-17).
- [ ] **Use the tenant `suspended` status as the kill switch for new
      requests**: `PutTenantSubscription` with `status: suspended` refuses
      every request for the tenant at the next mint, keeping its cuts. A
      token in flight lives to its `exp` (up to `transactionToken.ttl`, plus
      the 60 s authoriser cache on `api-gateway`) and vended credentials to
      theirs (`tvm.durationSeconds`); lower both if they must stop sooner.
- [ ] **Keep PITR on the entitlement table** and decide its retention (M-48).
- [ ] **Restrict `lambda:InvokeFunction` on the request-path functions** to
      the service principals (an SCP or permission boundary): Lambda
      resource policies cannot deny, and a direct invoke of the ingress
      interceptor returns the caller's own tenant credentials and token
      (T-102).
- [ ] **Add edge protection and size the shared limits**: AWS WAF on the
      REST API stages, reserved concurrency, Bedrock and Gateway quotas, and
      `tenantLimits` and `tenantRateLimit` per tier (M-19, M-25, M-60).
- [ ] **Restrict `ssm:PutParameter` under the registry prefix** to the
      deploying roles, give each backend and target role its own names only,
      and keep `bedrock-agentcore:TagResource` on Runtimes to the
      backend-deploying roles (M-20, M-29, M-30, T-39, T-40).
- [ ] **Alarm on any other principal** calling `InvokeAgentRuntime` or
      assuming a tenant role, from CloudTrail (M-22, T-32).
- [ ] **Leave `perTenantMetrics` off at scale**, or accept 9 × (1 + agents)
      custom metrics per tenant per ingress (M-28, T-38).
- [ ] **Change the removal policies**: the sample sets `DESTROY` everywhere
      so teardown is total (M-23).

## Design trail

- Specification: [`design/agentic-runtime-isolation.spec.md`](./design/agentic-runtime-isolation.spec.md);
  spike results in §7 (§7.1, §7.2, §7.4 for V-17)
- Decisions: [`adr/`](./adr/), ADR-0001 to ADR-0045, indexed in
  [`adr/README.md`](./adr/README.md); the latest is
  [ADR-0045, bound the transaction token at 10,240 bytes](./adr/0045-bound-the-transaction-token-at-10240-bytes.md)
- Threats and mitigations: [`threat-model.md`](./threat-model.md)
- Implemented state: [`architecture.md`](./architecture.md)
- Diagram: [`diagrams/agentic-runtime-isolation.drawio`](./diagrams/agentic-runtime-isolation.drawio),
  rendered as [`agentic-runtime-isolation.drawio.svg`](./diagrams/agentic-runtime-isolation.drawio.svg),
  caption in [`diagrams/CAPTION.md`](./diagrams/CAPTION.md)
