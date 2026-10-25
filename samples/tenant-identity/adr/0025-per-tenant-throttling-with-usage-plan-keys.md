# ADR-0025: Throttle `/tenant/*` per tenant with one usage plan and an API key per tenant

- Status: Accepted
- Date: 2026-10-22
- Deciders: Dave Roberts (SA)

## Context
N-7 throttles `/tenant/*` with per-method stage settings (first 10 rps / 20
burst). Those limits are shared by every tenant: one tenant admin, or one
leaked admin token, can use the whole budget and every other tenant's admin
gets 429s. AWS Well-Architected multi-tenant guidance calls this the
noisy-neighbour problem and expects a per-tenant limit at the edge. API
Gateway REST APIs throttle per client only
through usage plans: "Throttling and quota limits apply to requests for
individual API keys that are aggregated across all API stages within a usage
plan" ([Usage plans and API keys](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-api-usage-plans.html),
read 2026-10-22). A key therefore has to stand for a tenant.

The tenant on this route is known only after the authoriser has verified the
token (ADR-0007). `POST /oauth2/token` has no authoriser (ADR-0011), so the
gateway knows no tenant there; `/platform/*` is the vendor's IAM door
(ADR-0005), with no tenant either.

## Options considered
### Option 1: Clients send a per-tenant key in `x-api-key`
Pros: the default API Gateway set-up. Cons: the key becomes a second secret
each tenant must hold and the vendor must distribute and rotate; a tenant can
send another tenant's key and spend that tenant's budget; a key without a
token still reaches the authoriser.
### Option 2: The authoriser returns the tenant's key (`apiKeySource: AUTHORIZER`)
The authoriser already reads the tenant's registry row on every request. It
returns that tenant's key value as `usageIdentifierKey`; API Gateway reads the
key only from there and ignores any header. Pros: no secret leaves the
backend; the key is bound to the verified tenant, so a caller cannot choose
whose budget to spend; nothing changes for clients. Cons: a key per tenant
to create and delete at run time; the authoriser's registry read becomes
load-bearing for throttling too; API keys are capped per account and Region.
### Option 3: Per-tenant counting in the function or a WAF rate rule keyed on a claim
Pros: no API Gateway keys. Cons: the function only sees requests the stage
already admitted, so it cannot protect the shared stage budget; WAF
rate-based rules can key on a header but cannot read a verified claim, so the
client would choose the key.

## Decision
Option 2. One usage plan per stack (`<stack>-tenant`), on the API's stage,
throttled at the N-7 per-tenant values (10 rps / 20 burst) with no quota.
The stage's shared `/tenant/*` limit is 50 rps / 100 burst, five times the
per-tenant one, so no single tenant can fill it. The merged
OpenAPI sets `x-amazon-apigateway-api-key-source: AUTHORIZER` and adds the
`api_key` requirement, AND-ed with the authoriser, to every `/tenant/*`
operation and to no other (`requireApiKey` in `src/shared/openapi.ts`).
`CreateTenant` creates an enabled key named `tenant-<tenantId>`, tagged
`tenant-identity:stack=<stack>`, with a value API Gateway generates, adds it to the plan, and stores `apiKeyId` and
`apiKeyValue` on the registry row in the same conditional write that flips
the row to `ACTIVE`. Key creation is part of ADR-0021's provision step: a key
failure deprovisions Cognito and deletes the row; an activation failure also
deletes the key. `DeleteTenant` and the teardown drain (ADR-0022) delete the
key after Cognito and before the row; the delete is idempotent. The authoriser
returns the stored value on Allow and refuses an `ACTIVE` tenant that has no
key. The platform function finds the plan by name at first use, because
naming its id in the function's environment or default policy would be a
dependency cycle (function → plan → API → function); `CreateUsagePlanKey` on
that plan's ARN sits in a separate IAM policy for the same reason.

The key value is a tenant field, not user data (R-10), and not a credential:
with the AUTHORIZER source a client cannot present a key at all, and a key
alone admits nothing. It is stored so the authoriser can return it without a
second API call.

## Consequences
Easier: each tenant has its own 10 rps / 20 burst on `/tenant/*`; one
tenant's flood is throttled per key before it reaches the function. The
plan's `ThrottleCount` per key shows which tenant is being throttled.

Harder, and stated in the README quotas:
- **API keys per account per Region: 10,000, not adjustable**
  ([REST API quotas](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-execution-service-limits-table.html),
  read 2026-10-22). Every stack and every other workload in the account
  shares it, so tenant count per account and Region is capped there.
  Usage plans: 300 per account and Region (adjustable); this sample uses one
  per stack.
- **Control-plane rates, not adjustable:** `CreateApiKey` and `DeleteApiKey`
  5 requests per second per account; all control-plane calls together 10 rps
  with a burst of 40 ([API Gateway quotas](https://docs.aws.amazon.com/apigateway/latest/developerguide/limits.html),
  read 2026-10-22). Bulk onboarding is paced by them.
- API Gateway applies usage-plan throttling "on a best-effort basis"; it is
  not a hard limit or a cost control (same page).
- The stage's per-method `/tenant/*` limits (N-7) still apply to all tenants
  together: 50 rps / 100 burst, five times the per-key limit. One tenant
  cannot reach it alone; five or more busy tenants at once can, and then all
  tenants get 429s. Raise it with the tenant count, keeping it within the
  account's Region-wide API Gateway limit (10,000 rps by default) and what the
  tenant-user function and Cognito can serve (README quotas, T-24).
- `DeleteApiKey` takes a generated key id, so the platform and drain roles
  hold `apigateway:DELETE` on `/apikeys/*`, conditioned on
  `aws:ResourceTag/tenant-identity:stack` equal to the stack name. The
  platform role may create a key only with that tag and no other tag key
  (`aws:RequestTag`, `aws:TagKeys`). API Gateway authorises that tag as
  `apigateway:PUT` on `/tags/<url-encoded /apikeys/* ARN>` (integ
  2026-10-23: `CreateApiKey` was denied without it), so the platform role
  also holds that, under the same conditions plus `StringEqualsIfExists` on
  the stack resource tag. Neither role can delete a key tagged by another
  stack. Residual: the platform role can tag an existing untagged key in the
  Region and then delete it, as with Cognito's `TagResource` (threat model
  T-7). A key created
  before this change has no tag and cannot be deleted by the roles.
- A tenant created before this change has no key and is refused at
  `/tenant/*` until it is recreated; the sample has no migration.
- **A new key is not live at once.** API Gateway propagates a new usage-plan
  key eventually: the integ run of 2026-10-22 saw `403 Forbidden` on a
  tenant's first `/tenant/*` call about 20 s after `CreateTenant`, and
  re:Post reports cases of much longer. A client must treat `403 Forbidden`
  (not the authoriser's `403 User is not authorized`) on a brand-new tenant
  as "retry with backoff". The e2e scenario does this, bounded at 5 minutes.

Revisit if tenants need tiers (one plan per tier, the key moved between
plans), quotas per tenant, or more than 10,000 tenants per account and Region.
