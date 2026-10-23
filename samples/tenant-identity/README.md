# Tenant Identity with Amazon Cognito

A minimal identity layer for a pooled, multi-tenant application. It makes
**Amazon Cognito the trusted source of tenant identity**, not only of user
identity: every access token a tenant user presents carries the tenant the
vendor assigned at onboarding, signed by Cognito, so a downstream service
reads the tenant from a claim it can verify offline instead of consulting a
user-to-tenant table on every request.

Cognito has no notion of a tenant, but it offers three places to overlay one
onto a user pool: the pool itself, a user attribute, or a group. This sample
builds all three **side by side behind one API**, chosen once at deploy time,
so the trade-offs can be seen by running the same scenario against each:

| Topology (`--context topology=`) | Where the tenant boundary lives | A user can belong to |
|---|---|---|
| `pool-per-tenant` | one user pool per tenant; the token's issuer *is* the tenant | one tenant per account |
| `shared-pool` | one pool; the tenant is an immutable user attribute | exactly one tenant |
| `shared-pool-multi-tenant` | one pool; tenants are groups (`t-<tenantId>`); a user may hold several | one or more tenants |
| `tiered` | both of the first two in one stack: each tenant is created as `standard` (`shared-pool`) or `premium` (`pool-per-tenant`), see [Tiered deployment](#tiered-deployment) | exactly one tenant |

### Choosing a topology

Start from one question: can one person belong to more than one tenant with
the same sign-in? If yes, only `shared-pool-multi-tenant` fits. If no, choose
between the other two by how much each tenant needs its own pool settings.

| Choose | When | You give up |
|---|---|---|
| `pool-per-tenant` | Tenants need their own pool settings (password policy, MFA, their own identity provider, custom domain), or a contract asks for a separate identity store per tenant | One issuer per tenant, so token checks must look the issuer up in the registry; a pool, app client and trigger wiring per tenant to onboard; the per-account user pool quota (1,000 by default, adjustable) caps the tenant count; a person in two tenants needs two accounts |
| `shared-pool` | Every user belongs to exactly one tenant and all tenants share the same sign-in rules | Per-tenant pool settings; moving a user to another tenant (the attribute is immutable, so it means a new user) |
| `shared-pool-multi-tenant` | One person works across tenants (consultants, agencies, support staff, a parent company over subsidiaries) | Un-narrowed tokens name every tenant the user holds, so services must only accept narrowed tokens; groups cap a pool at 5,000 tenants (two groups each) and a user at 100 groups |
| `tiered` | Most tenants fit `shared-pool` and a few pay for their own pool (settings, issuer, IAM wall), and one API and registry must serve both | Two strategies in one runtime, bound to each tenant's row (the ADR-0027 binding rule); the stack carries `pool-per-tenant`'s account-wide `CreateUserPool` even with no premium tenant; clients must look a tenant's pool up before sign-in; no `shared-pool-multi-tenant` tier |

Two rules hold in every topology:

- **Narrow before calling a service for one tenant.** In
  `shared-pool-multi-tenant` this is required: a service must never get a
  token that names several tenants. In the other two it still cuts the scopes
  to what the call needs.
- **The topology is fixed at deploy time.** This sample does not move tenants
  between topologies, so pick for the tenant mix you expect, not only today's.
  `tiered` fixes the pair at deploy time and the tier per tenant at
  `CreateTenant`; moving a tenant between tiers is specified in ADR-0027 but
  not built.

**Cognito request-rate quotas sit on the token path.** Every sign-in, refresh
and exchange is one call in Cognito's `UserAuthentication` category
(`InitiateAuth`, `AdminInitiateAuth`, `GetTokensFromRefreshToken`, refresh at
the token endpoint; 120 RPS by default, adjustable), plus one trigger
invocation and one registry read. Cognito measures these quotas per account
per Region, summed over every user pool and every workload in the account, so
the stage throttles (N-5..N-7) bound only this API: another application in the
same account can use up the quota this one needs, and the reverse. With
5-minute access tokens (N-1) an active session makes about 12 calls an hour,
so the default 120 RPS carries roughly 36,000 concurrently active sessions per
account and Region before sign-ins are counted. User management sits in other
categories: `AdminCreateUser` in `UserCreation` (50, adjustable);
`AdminDeleteUser`, `AdminAddUserToGroup` and `AdminRemoveUserFromGroup` in
`UserUpdate` (25, not adjustable); `AdminListGroupsForUser` in
`UserResourceRead` (50); `ListUsers` and `ListUsersInGroup` in `UserList` (30,
not adjustable). `pool-per-tenant` onboarding and offboarding also spend
`UserPoolUpdate` (`CreateUserPool`, `DeleteUserPool`), `UserPoolClientUpdate`
(`CreateUserPoolClient`) and `UserPoolResourceUpdate` (`CreateGroup`,
`DeleteGroup`), 15 RPS each and not adjustable, so bulk onboarding is paced by
them. To raise an adjustable category, request a higher account-level maximum
in Service Quotas, then set the rate with `UpdateProvisionedLimit` or the
console's **Provisioned limits** tab; capacity above the default is billed per
RPS-month. Watch the per-category `CallCount` and `ThrottleCount` metrics.
Figures from [Quotas in Amazon Cognito](https://docs.aws.amazon.com/cognito/latest/developerguide/quotas.html),
read 2026-10-22.

**API Gateway and STS quotas sit on the tenant door.** Every tenant gets one
API Gateway key for per-tenant throttling (ADR-0025), and API keys are capped
at **10,000 per account per Region, not adjustable**, shared with every other
workload in the account; that caps tenants per account and Region in every
topology. Usage plans are 300 per account and Region (adjustable); the sample
uses one per stack, two in `tiered` (one per tier). Onboarding and offboarding call `CreateApiKey` and
`DeleteApiKey`, **5 requests per second per account** each, inside an
account-wide limit of 10 control-plane requests per second (burst 40), none of
them adjustable, so bulk onboarding is paced by them
([REST API quotas](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-execution-service-limits-table.html),
[API Gateway quotas](https://docs.aws.amazon.com/apigateway/latest/developerguide/limits.html),
read 2026-10-22). In `pool-per-tenant` the tenant-user function assumes a
tenant-scoped role per tenant and execution environment, about every 13
minutes per warm environment (ADR-0026); `AssumeRole` shares STS's default
**600 requests per second per account and Region** with `GetCallerIdentity`,
`GetSessionToken` and every other caller in the account
([IAM and AWS STS quotas](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_iam-quotas.html),
read 2026-10-22).

**Shared-pool offboarding is O(pool), not O(tenant).** In `shared-pool`,
`DeleteTenant` also scans the whole pool with `ListUsers` (60 users a page,
`UserList` quota) to catch users missing from the tenant's group
(`deprovisionTenant` in [`src/topology/shared-pool.ts`](./src/topology/shared-pool.ts)).
The call must finish inside API Gateway's 29-second integration timeout (the
platform function's own is 30 seconds). At 100–200 ms a page that is roughly
8,000–17,000 pool users, and the 30 RPS quota caps it near 50,000 even at no
latency, less the time spent deleting the tenant's own users (`UserUpdate`,
25 RPS). Beyond that, `DeleteTenant` times out and leaves the tenant
`DELETING`: the trigger already refuses it, and re-running `DeleteTenant`
resumes the clean-up, but each run rescans from the start, so a large enough
pool never completes. Move deletion behind an asynchronous workflow before
that point (the seam in [ADR-0004](./adr/0004-synchronous-platform-api.md)).
`shared-pool-multi-tenant` lists only the tenant's group, and
`pool-per-tenant` deletes one pool, so their offboarding grows with the tenant,
not the pool.

The vendor manages tenants and users through a `/platform/*` API authorised
with IAM. A tenant admin manages the users of its own tenant through a
`/tenant/*` API. Because a token in `shared-pool-multi-tenant` names every
tenant the user belongs to, the sample also issues **narrowed tokens** through
an OAuth 2.0 Token Exchange (RFC 8693) endpoint: a client trades a refresh
token for an access token that names one tenant and a subset of scopes, which
Cognito re-signs, so it verifies the same way.

**What this is NOT.** It is not a token *consumer*: verifying a token and
scoping a request to the tenant it names belongs to the service or gateway
that receives it, and none is built here (the one exception is the sample's
own `/tenant/*` authoriser, which is identity work). It is not a login UI —
managed login, hosted UI, federation, passwordless, and MFA are out of scope;
tokens are obtained with a server-side password flow for the demonstration. It
builds one role, tenant admin, and no others. It narrows tenant and scopes
only, not RFC 8693 delegation (`act`) or audience. It does not answer the
vendor's own identity (that is the [`control-plane`](../control-plane/)
sample), route a request to the right tenant deployment (a front-door sample),
persist users of its own (Cognito is the only user store), or migrate tenants
between topologies. It runs in one Region with no disaster recovery: the
pools do not use Cognito multi-Region replication (an Essentials/Plus add-on
that needs a multi-Region KMS customer-managed key, a multi-Region issuer and a
trigger configured per replica), and the registry table, which every token
issuance reads, has no replicas. Going multi-Region is a redesign of the
token path, not a setting: replicated pools plus a global registry table, or
a pool per Region with every Region's issuer in the allowlist.

- Design: [`architecture.md`](./architecture.md)
- Decisions and their reasoning: [`adr/`](./adr/) (one file per ADR, indexed in [`adr/README.md`](./adr/README.md))
- Threats and mitigations: [`threat-model.md`](./threat-model.md)
- Working specification the sample was built from: [`design/tenant-identity.spec.md`](./design/tenant-identity.spec.md)

### Tiered deployment

`--context topology=tiered` deploys `shared-pool` and `pool-per-tenant` side
by side in one stack: one API, one registry, one trigger, one authoriser
([ADR-0027](./adr/0027-mixed-tier-deployment.md)). The tier is a tenant
attribute, chosen once:

- `CreateTenant` takes a required `tier`, `standard` or `premium`. `standard`
  tenants live in the stack's shared pool (`shared-pool` mechanics);
  `premium` tenants get a pool, app client and issuer of their own
  (`pool-per-tenant` mechanics). The registry row's `topology` records the
  tier's topology, and `GetTenant`/`ListTenants` return `tier`. Sending
  `tier` to any other stack is a 400 `UnsupportedInTopology`; omitting it in
  `tiered` is a 400.
- **Consumers check tokens one way.** Both tiers issue the same claims
  (`tenant_id`, the sample scopes), so a verifier does not know or care which
  tier a token came from. The issuer allowlist is the shared pool plus the
  registry's premium issuers (`ListTenants`).
- **Sign-in needs the pool first.** A client must know which pool to
  authenticate against, so the vendor maps its login hint (tenant URL,
  e-mail domain, an "organisation" step) to a tenant and calls `GetTenant`
  from its own backend for `userPoolId` and `appClientId`. Standard tenants
  return nothing there; the client uses the shared pool's ids from the
  published parameters. The sample builds no public discovery route, because
  one would reveal which tenants exist.
- **What premium buys.** Its own pool settings and issuer, the IAM wall of
  ADR-0026 (the tenant-user function reaches a premium pool only on a session
  tagged with that tenant), and a higher per-tenant throttle on `/tenant/*`:
  25 rps / 50 burst against the standard tier's 10 / 20, through a second
  usage plan on the same stage (both under the shared 50 / 100 limit).
- **The binding rule.** A premium tenant is reachable only through its own
  pool, every other tenant only through the shared pool. The trigger and the
  authoriser read the tenant's row and refuse a mismatch (`pool_mismatch`),
  so a premium tenant's id written into the shared pool's `custom:tenantId`
  by a vendor bug yields no token, and a token from a premium pool cannot
  reach a standard tenant (threat T-32, mitigation M-30).
- **Tier change is specified, not built.** Cognito cannot export passwords,
  so moving a tenant between tiers is a user migration; ADR-0027 gives the
  steps.

## Architecture

![Architecture: a vendor signs /platform/* calls with IAM; a client posts a refresh token to /oauth2/token; the token-exchange function calls Cognito GetTokensFromRefreshToken with a narrowing request in ClientMetadata; the pre-token-generation trigger reads the tenant registry and narrows the access token to one tenant; the narrowed token is then presented to the tenant API through its Lambda authoriser](./diagrams/tenant-identity.drawio.svg)

The vendor manages tenants through `/platform/*` with IAM. A client trades its refresh token at `/oauth2/token`. Cognito runs the trigger, which narrows the token to one tenant. The client sends only that narrowed token to the service.

Components (one stack per deployment, [`src/identity.cdk.ts`](./src/identity.cdk.ts)):

- **One REST API** (`SpecRestApi`) built from three merged Smithy OpenAPI
  documents (ADR-0016): `/platform/*` (IAM), `POST /oauth2/token` (no gateway
  authoriser), `/tenant/*` (Lambda authoriser). Each route family has its own
  function and role, so least privilege falls out of the model split (P-8).
- **Pre-token-generation trigger** — the sample. A V2 Cognito trigger that
  reads the registry, enforces tenant status, adds the tenant claim(s) and
  scopes, and applies narrowing. Its role holds registry reads and logging
  only — no `cognito-idp` action (ADR-0003, ADR-0008, ADR-0010).
- **Platform function** — the vendor's door: tenant and user lifecycle
  through the tenant's provisioner, picked per request from the registry
  row's `topology` (one strategy per stack, two in `tiered`).
- **Token-exchange function** — `POST /oauth2/token`: parses the form, calls
  `GetTokensFromRefreshToken`, and checks Cognito actually narrowed the token
  (ADR-0012). Its role holds logging only.
- **Tenant authoriser** and **tenant-user function** — the tenant admin's
  door, with the tenant taken only from the verified, narrowed token
  (ADR-0007, ADR-0014). The authoriser also names the tenant's API key, so
  `/tenant/*` is throttled per tenant through a usage plan (ADR-0025; two
  plans in `tiered`, one per tier). In
  `pool-per-tenant`, and for premium tenants in `tiered`, the tenant-user
  function calls Cognito on a session tagged with the tenant, which IAM lets
  reach only that tenant's pool (ADR-0026). Both functions apply the ADR-0027
  binding rule: a tenant is reached only through its own pool.
- **Tenant registry** — one DynamoDB table holding tenants only (ADR-0002);
  Cognito is the only user store.
- **User pool(s)** — one for the shared topologies, created by the stack;
  none at deploy time for `pool-per-tenant`, where the platform function
  creates one per tenant at onboarding. `tiered` has both: the stack's shared
  pool for standard tenants and one pool per premium tenant.

## How it works

The primary flow is: the vendor onboards a tenant, a tenant user signs in, a
client narrows the token, and the service (or the sample's own tenant API)
receives a token that names exactly one tenant.

1. **Onboard.** `POST /platform/tenants {name, adminEmail}` (plus `tier` in
   `tiered`) runs the tenant's provisioner. `pool-per-tenant` creates a pool, an app client,
   attaches the shared trigger, and creates `admin-<tenantId>`;
   `shared-pool*` create groups in the stack's one pool. The registry gets one
   tenant item; the tenant's first admin is created with a temporary password
   returned once.
2. **Sign in.** A tenant user authenticates against the topology's pool. On
   every token issuance — sign-in and refresh alike — Cognito runs the
   pre-token-generation trigger. The trigger finds the user's tenant(s), drops
   any that are not `ACTIVE`, and writes `tenant_id` (topologies 1 and 2) or a
   sorted `tenants` array (topology 3) into the **access** token, along with
   the sample scopes. A token without a tenant claim is never issued: any
   trigger error fails the token request.
3. **Narrow.** A client that acts for one tenant posts the user's refresh
   token to `POST /oauth2/token` with `resource=<tenant>` and the scopes it
   needs. The exchange function forwards the request to Cognito in
   `ClientMetadata`; the trigger **intersects** it with what the user holds
   and refuses unless the result is exactly the request — it never widens. The
   narrowed access token names one tenant, carries exactly the requested
   scopes, and drops `aws.cognito.signin.user.admin`. The exchange function
   then decodes the returned token and refuses it unless it matches the
   request (ADR-0012), so narrowing fails closed. No refresh token is issued
   with it.
4. **Use it.** The client sends only the narrowed token to the service. The
   sample's own consumer is its tenant admin door: a tenant admin exchanges
   for `scope=tenant-admin/users` on its tenant, then calls `/tenant/users`.
   The tenant authoriser verifies the token, takes the tenant from the
   verified claim (never the request), and refuses a tenant that is not
   `ACTIVE` with no result cache — so offboarding stops this route at once.

Offboarding is enforced where identity is issued, not on a request path the
sample does not build: `DeleteTenant` flips the tenant to `DELETING` before
touching Cognito, and the trigger then refuses it on every new token. Full
detail, including the per-topology mechanics and the narrowing intersection,
is in [`architecture.md`](./architecture.md).

## Cost per tenant

Approximate, eu-central-1 on-demand prices read on 2026-10-22 from the AWS
Price List (publication dates 2026-09-11 to 2026-10-20); excludes the
account-level free tiers except where stated. Build your own estimate with the
[AWS Pricing Calculator](https://calculator.aws/).

**Worked assumption.** A tenant with 100 monthly active users (MAU); each user
has 20 one-hour sessions a month (2,000 sessions). A session is one direct
Cognito sign-in, then a narrowed token from `POST /oauth2/token` every
5 minutes (N-1), so 12 exchanges. Each sign-in is one Cognito call, one
trigger invocation and one registry read; each exchange adds one API request
and one exchange-function invocation. Per tenant per month: 2,000 sign-ins,
24,000 exchanges, 26,000 trigger invocations and registry reads. Functions run
on ARM at 256 MB; assumed durations are 50 ms (trigger) and 150 ms (exchange,
which waits on Cognito).

| Item | Price (eu-central-1) | Arithmetic | $/tenant/month |
|---|---|---|---|
| Cognito Essentials MAU | $0.015/MAU after 10,000 free MAU per account or organisation | 100 × $0.015 | 1.50 |
| API Gateway REST requests | $3.70 per million | 24,000 × $3.70/M | 0.09 |
| Lambda requests + compute | $0.20 per million; $0.0000133334/GB-s (ARM) | 50,000 × $0.20/M + (26,000 × 0.05 s + 24,000 × 0.15 s) × 0.25 GB × $0.0000133334 | 0.03 |
| DynamoDB on-demand reads | $0.1525 per million RRU | 26,000 strongly consistent reads × $0.1525/M | <0.01 |
| CloudWatch Logs ingestion | $0.63/GB | ~3.5 KB per exchange (access log, INFO execution log, two functions) + ~1 KB per sign-in ≈ 0.086 GB | 0.05 |
| X-Ray traces recorded | $5.00 per million | ~2 traces per exchange (stage, Cognito-invoked trigger) + 1 per sign-in = 50,000 (low rates are fully sampled) | 0.25 |
| Contributor Insights matched events | $0.025 per million | 4 rules × ~26,000 events | <0.01 |
| **Variable total** | | | **≈ 1.9** |
| Contributor Insights rules (per stack, not per tenant) | $0.50 per rule-month | 4 × $0.50 = $2 per stack, divided by the tenant count | 2 / tenants |

Cognito is about 80% of the bill, so the MAU count drives cost; the log and
trace sizes are estimates to replace with measured values from a deployed
stack. The 10,000 free Essentials MAU cover the first ~100 such tenants per
account. Moving the pools to **Plus** for MFA and threat protection (T-23) changes
the MAU rate to $0.020 with no free tier: $2 for Cognito, ≈ $2.4 in total.

The per-tenant API key and usage plan (ADR-0025) and the tenant-scoped STS
sessions (ADR-0026) carry no charge of their own. API keys cap tenants at
10,000 per account and Region in every topology (see the quotas above).

MAU are billed per user-pool user, so the topology changes what one person
costs:

| | `pool-per-tenant` | `shared-pool` | `shared-pool-multi-tenant` |
|---|---|---|---|
| A person in k tenants | k users in k pools: k MAU | k users (one e-mail each): k MAU | one user: 1 MAU |
| Registry reads per token | GSI query + item read (~1.5 RRU) | 1 RRU | 1 RRU per tenant the user holds |
| Fixed cost per tenant | none (no per-pool fee) | none | none |
| Worked example | ≈ $1.9 | ≈ $1.9 | ≈ $1.9; a consultant in 5 tenants costs $0.015, not $0.075 |
| Ceiling before cost matters | 1,000 pools per account and Region (adjustable to 10,000) | 5,000 tenants per pool (groups) | 5,000 tenants per pool (groups) |

In `tiered` each tenant costs what its tier's column says: a standard tenant
the `shared-pool` figures, a premium tenant the `pool-per-tenant` ones. The
ceilings apply per tier (standard tenants share the shared pool's group
ceiling, premium tenants the pool quota).

On tiering: `pool-per-tenant` is the natural premium or silo tier (own pool
settings, own issuer, blast radius of one), and `shared-pool` the default
tier. `tiered` runs both from one stack, chosen per tenant at `CreateTenant`
(ADR-0027, [Tiered deployment](#tiered-deployment)); a deployment that needs
`shared-pool-multi-tenant` as a tier still runs it as its own stack.

## Deploy

Prerequisites:

- An AWS account, non-production, bootstrapped for AWS CDK.
- **Node.js 24** (the Lambda functions run on the Node.js 24 runtime).
- The [Smithy CLI](https://smithy.io/2.0/guides/smithy-cli/cli_installation.html)
  — `npx projen build` runs `smithy build` to generate the server SDKs.
- **Docker is not needed**: functions bundle locally with esbuild.
- **An API Gateway CloudWatch Logs role already set on the account and
  Region.** The stack enables execution logging but does **not** create the
  account-wide `AWS::ApiGateway::Account` role, because that is one setting
  per account and Region and CDK retains the role on destroy — so the sample
  would leave an account-wide change behind every time (ADR-0019). Without a
  role already set, the stage fails to create. Check:

  ```bash
  aws apigateway get-account
  ```

  If `cloudwatchRoleArn` is null, set one once (any account-wide API Gateway
  CloudWatch role will do):

  ```bash
  cat > apigw-trust.json <<'JSON'
  { "Version": "2012-10-17", "Statement": [{
      "Effect": "Allow",
      "Principal": { "Service": "apigateway.amazonaws.com" },
      "Action": "sts:AssumeRole" }] }
  JSON
  ROLE_ARN=$(aws iam create-role \
    --role-name apigw-cloudwatch-logs \
    --assume-role-policy-document file://apigw-trust.json \
    --query Role.Arn --output text)
  aws iam attach-role-policy --role-name apigw-cloudwatch-logs \
    --policy-arn arn:aws:iam::aws:policy/service-role/AmazonAPIGatewayPushToCloudWatchLogs
  aws apigateway update-account \
    --patch-operations op=replace,path=/cloudwatchRoleArn,value="$ROLE_ARN"
  ```

Build, then deploy one topology:

```bash
npm ci
npx projen build    # smithy build + compile + unit tests + synth (synths shared-pool-multi-tenant)
npx cdk deploy --context topology=<pool-per-tenant | shared-pool | shared-pool-multi-tenant | tiered>
```

For example, the tiered deployment:

```bash
npx cdk deploy --context topology=tiered
```

`topology` is the one deployment input and is required: synthesis fails fast,
naming the four accepted values, if it is missing or misspelled (P-7,
ADR-0001, ADR-0027). It selects the provisioner(s) and is stamped into the stack name
(`TenantIdentity-<topology>`), so all four can coexist in one account and
Region. The deployed stack publishes
`/application-plane/shared/identity/{apiUrl,topology}` (and, for
`shared-pool*` and `tiered`, `userPoolId` and `appClientId`; in `tiered`
those are the shared pool's, which serves the standard tier) so the sample mounts into the
`control-plane` sample's shared namespace.

Teardown:

```bash
npx cdk destroy --context topology=<the topology you deployed>
```

The stack offboards every tenant still in its registry on the way out: a
`TenantDrain` custom resource runs the `DeleteTenant` sequence per tenant
before the registry table and the shared pool are deleted, so `pool-per-tenant`
leaves no pools, the shared topologies leave no groups or users, and `tiered`
leaves neither, whether or
not you deleted the tenants first (ADR-0022). It also takes about 90 seconds
longer than a bare stack would: a `LogDrain` custom resource holds back
log-group deletion until the API stage and `TenantDrain` are gone and nothing
invokes the functions, so late log delivery cannot recreate a group outside
the stack (ADR-0019, ADR-0024). The
teardown is total — no stack, pool, table, parameter, role, or log group with
the sample's prefix remains. If the drain fails (for example a Cognito throttle
on a large registry), the stack stays `DELETE_FAILED`; run `cdk destroy` again.

## Deployment integration test

The deployment integration test ([`test/integ.identity.ts`](./test/integ.identity.ts),
driven by [`scripts/integ.sh`](./scripts/integ.sh)) deploys temporary
infrastructure into a real account and drives the full lifecycle. Use a
non-production, CDK-bootstrapped account. Run it in exactly one Region: the
script fails fast when `AWS_REGION` is unset.

```bash
export AWS_REGION=eu-central-1
npx projen integ
```

It deploys **all four stacks at once** (the three topologies and `tiered`) with
`cdk deploy --all`, runs the spec §10 scenario (steps 2–9 and
11, plus the R-6 parameter check) against each, then destroys them at once.
In the `tiered` stack the scenario creates one tenant per tier and adds the
binding-rule refusals (§10 step 12). After the scenario it forces each
stack's alarms into `ALARM` and fails unless the alarm history shows a
successful publish to the alarm topic (M-31). The destroy
always runs, also when the deploy or the scenario fails. Step 11
leaves one tenant in every stack on purpose, so the destroy also proves the
stack's own `TenantDrain` (ADR-0022). The CDK CLI drives the run rather than
integ-runner, which deploys a test's stacks one at a time (ADR-0023). One run
with three stacks took **about 7 minutes** (the last green run was 408 s) and
cost well under 1 USD; the fourth stack adds to both. Only the `shared-pool-multi-tenant` stack publishes
the shared `/application-plane/shared/identity/*` parameters during the test,
because those names are fixed per account and Region and two stacks cannot own
the same name (ADR-0017); the scenario checks that the publisher's parameters
name its own stack.

## End-to-end demo

[`scripts/demo.sh`](./scripts/demo.sh) walks the primary flow against one
deployed stack and checks each answer as it goes:

```bash
export AWS_REGION=eu-central-1
./scripts/demo.sh                     # shared-pool-multi-tenant (default)
./scripts/demo.sh pool-per-tenant     # or shared-pool
```

| Step | Call | Expect |
|---|---|---|
| 1 | read stack outputs | `ApiUrl`, `AppClientId` |
| 2 | `CreateTenant` (SigV4) | 201, `ACTIVE` |
| 3 | `IssueToken` test aid (ADR-0006) | 200, broad token |
| 3b | `ListTenantUsers`, broad token | 403 |
| 4 | `POST /oauth2/token`, narrow (RFC 8693) | 200, `tenant_id` + `tenant-admin/users` |
| 4b | narrow to a foreign tenant | 400 `invalid_target` |
| 5 | `CreateTenantUser`, `ListTenantUsers` | 201, 200 |
| 6 | `DeleteTenant` (SigV4) | 204 |
| 6b | fresh narrow; old narrowed token | 400; 403 |

Prerequisites: `aws` CLI v2, `curl` 7.75 or later (it signs `/platform/*`
with `--aws-sigv4`), and `jq`. Your credentials must hold
`execute-api:Invoke` on the deployed API. `STACK_PREFIX` overrides the
`TenantIdentity` stack-name prefix. The script prints status codes, tenant ids
and claims, never a token or password. It uses SES simulator e-mails and
deletes its tenant on exit, also when a step fails. One run takes about
15 seconds.

## API

Three Smithy services ([`model/`](./model/)) merged into one REST API
(ADR-0016). The OpenAPI and TypeScript server SDK are generated from the model
(`smithy build`); this table is derived from it.

### Platform (`/platform/*`, IAM / SigV4)

| Operation | HTTP | Returns |
|---|---|---|
| `CreateTenant` | `POST /platform/tenants` | 201 — onboards a tenant and its first admin; `tier` required in `tiered`, 400 `UnsupportedInTopology` elsewhere |
| `GetTenant` | `GET /platform/tenants/{tenantId}` | 200 — registry read (topology fields vary; `tier` in `tiered`) |
| `ListTenants` | `GET /platform/tenants` | 200 — paginated registry scan; the issuer allowlist for topology 1 and for premium tenants in `tiered` |
| `DeleteTenant` | `DELETE /platform/tenants/{tenantId}` | 204 — `DELETING` first, then Cognito clean-up; idempotent |
| `CreateUser` | `POST /platform/tenants/{tenantId}/users` | 201 — creates/attaches the user; temporary password once |
| `GetUser` | `GET /platform/tenants/{tenantId}/users/{username}` | 200 |
| `ListUsers` | `GET /platform/tenants/{tenantId}/users` | 200 — paginated |
| `UpdateUser` | `PATCH /platform/tenants/{tenantId}/users/{username}` | 200 — sets the admin flag |
| `DeleteUser` | `DELETE /platform/tenants/{tenantId}/users/{username}` | 204 |
| `CreateMembership` | `PUT /platform/tenants/{tenantId}/users/{username}/membership` | 204 — topology 3 only; 400 `UnsupportedInTopology` otherwise |
| `DeleteMembership` | `DELETE /platform/tenants/{tenantId}/users/{username}/membership` | 204 — topology 3 only; 409 on last tenant |
| `IssueToken` (test aid) | `POST /platform/tenants/{tenantId}/users/{username}/token` | 200 — sets a password, signs in; remove before production (ADR-0006) |
| `RefreshToken` (test aid) | `POST /platform/tenants/{tenantId}/users/{username}/token/refresh` | 200 — refresh re-runs the trigger; remove before production (ADR-0006) |

### Tenant admin (`/tenant/*`, narrowed admin token)

| Operation | HTTP | Returns |
|---|---|---|
| `CreateTenantUser` | `POST /tenant/users` | 201 |
| `GetTenantUser` | `GET /tenant/users/{username}` | 200 |
| `ListTenantUsers` | `GET /tenant/users` | 200 — paginated |
| `UpdateTenantUser` | `PATCH /tenant/users/{username}` | 200 — 409 on self-demotion (R-13) |
| `DeleteTenantUser` | `DELETE /tenant/users/{username}` | 204 — 409 on self-deletion (R-13) |

The tenant is taken from the verified token, never from the request. Each
operation runs the same provisioner method as its platform twin, with the
same per-topology effects. Each tenant is throttled on its own at 10 rps / 20
burst through the stack's usage plan (in `tiered`, premium tenants at
25 rps / 50 burst through a second plan), under the route's shared limit of
50 rps / 100 burst for all tenants together (ADR-0025, ADR-0027). Clients send no API key: the authoriser supplies the tenant's,
and an `x-api-key` header is ignored. `/platform/*` and `POST /oauth2/token`
need no key; the token route has no authoriser, so the gateway knows no
tenant there. A new tenant's key goes live after a short delay: until it
does, `/tenant/*` answers `403 {"message":"Forbidden"}`, so retry that with
backoff (ADR-0025).

### Token exchange (`POST /oauth2/token`, no gateway authoriser)

`POST /oauth2/token` 200 — RFC 8693 token exchange, form-encoded, Cognito as
the signer (ADR-0009, ADR-0011). Form fields: `grant_type`
(`urn:ietf:params:oauth:grant-type:token-exchange`), `client_id`,
`subject_token` (a refresh token), `subject_token_type`
(`urn:ietf:params:oauth:token-type:refresh_token`), `requested_token_type`
(optional; access token only), `resource`
(`urn:tenant-identity:tenant:<ULID>`, required in topology 3), and `scope`
(required, a non-empty subset of the sample scopes). `audience`, `actor_token`,
and `actor_token_type` are refused. Success returns
`{access_token, issued_token_type, token_type, expires_in, scope}` with
`Cache-Control: no-store` and no refresh token.

### Error model

Platform and tenant: `ValidationError` 400 (malformed input, or
`UnsupportedInTopology`), `ResourceNotFoundError` 404 (unknown tenant or user,
or a user outside the path's tenant), `ConflictError` 409 (tenant `DELETING`
on mutation, last-membership removal, duplicate e-mail in a shared pool, a
tenant admin demoting or deleting themselves), `InternalServerError` 500. IAM
401/403 on `/platform/*` and the authoriser's 401/403 on `/tenant/*` are API
Gateway's own. The exchange returns RFC 6749 §5.2 codes instead:
`invalid_request`, `unsupported_grant_type`, `invalid_target` (tenant not held,
not `ACTIVE`, or absent), `invalid_scope` (scope not held), `invalid_grant`
(anything else Cognito rejects), and `server_error` (500 — Cognito returned a
token that does not match the request, ADR-0012). `error_description` is fixed
text per code and never echoes Cognito's message or a token.

## Security notes

- **Identity model per door.** `/platform/*` is authorised with IAM (SigV4),
  so a tenant-user token can never reach it (ADR-0005); the account root may
  invoke it through the API's resource policy and the deployer grants
  `execute-api:Invoke` to whoever operates tenants. `POST /oauth2/token` has
  no gateway authoriser because the refresh token in the body is the
  credential, validated by Cognito (ADR-0011). `/tenant/*` is behind a Lambda
  authoriser that verifies a narrowed admin token on every request, with no
  result cache (ADR-0007).
- **Trust boundaries.** The tenant claim a token carries is the asset every
  downstream service scopes by; a tenant user cannot choose it (immutable
  attribute, admin-only groups, self sign-up off). The trigger role holds no
  `cognito-idp` action and the exchange role holds no `cognito-idp` or
  DynamoDB action, so the hottest and the unauthenticated code paths cannot
  mutate identity or read the registry beyond what they need.
- **Token contract.** A consumer may rely on one claim shape across
  topologies: `tenant_id` (topologies 1 and 2, and every narrowed token) or a
  `tenants` array (topology 3, un-narrowed), in the **access** token, plus the
  sample scopes. A single-tenant consumer should require `tenant_id` and the
  scope it serves, which rejects every un-narrowed topology-3 token.
- **The offboarding bound is 5 minutes.** Issued access tokens cannot be
  withdrawn; the access token lifetime (the Cognito minimum, 5 minutes) is the
  bound on how long an offboarded tenant's already-issued tokens keep working
  elsewhere. New tokens stop immediately (the trigger refuses a `DELETING`
  tenant), and `/tenant/*` stops immediately (the authoriser re-reads status).
  A consumer that needs a tighter bound adds a status check of its own.
- **Where IAM draws the tenant boundary on the tenant door.** In
  `pool-per-tenant` every pool carries a `tenant-identity:tenant` tag, and the
  tenant-user function calls Cognito on a session of `TenantScopedRole` tagged
  with the authoriser's tenant; the role reaches only the pool whose tag
  matches, so a code bug cannot reach another tenant's pool (ADR-0026, M-28).
  In `shared-pool*` IAM cannot scope users inside one pool, so the tenant
  boundary there is the R-12 membership check in code only (T-18, P-8). In
  `tiered` premium tenants get the IAM wall and standard tenants the code-only
  one, chosen per request from the tenant's row.
- **A tenant is reachable only through its own pool (`tiered`).** A premium
  tenant's row names its pool; a standard row names none. The trigger and the
  authoriser refuse a premium tenant reached through the shared pool and a
  standard tenant reached through a premium pool (`pool_mismatch`), so a
  vendor bug that writes a premium id into `custom:tenantId` yields no token
  (ADR-0027, T-32, M-30). The exchange endpoint applies no `client_id` check
  in `tiered`; a foreign client's pool is not in the registry, so the trigger
  refuses it (M-5).
- **Per-tenant throttling is not a security control.** The usage plan stops
  one tenant from spending every tenant's `/tenant/*` budget (T-31). The API
  key is not a credential (the authoriser picks it after verifying the token),
  and API Gateway applies usage-plan limits on a best-effort basis.
- **Deleting a `pool-per-tenant` pool does not stop its JWKS (ADR-0018).**
  Cognito keeps serving a deleted pool's keys, so a verifier that checks
  signatures only keeps trusting outstanding tokens until they expire. Use the
  **registry as the issuer allowlist**: `ListTenants` carries each tenant's
  issuer, and `DeleteTenant` removes it, so a consumer that checks the issuer
  against the registry stops trusting the pool at once.

The full threat model, with every mitigation pointing at an ADR, a code
location, or a cdk-nag suppression, is in [`threat-model.md`](./threat-model.md).

## Production hardening checklist

Each item maps to a threat-model mitigation (M-n) or threat (T-n).

- [ ] **Remove the `IssueToken` and `RefreshToken` test aids** from the
      platform API — they mint tokens, including 1-day refresh tokens, for any
      user (T-6, M-6; the largest accepted risk).
- [ ] **Attach an AWS WAF web ACL** to the REST API stage, with rate-based and
      IP-reputation rules — especially in front of the unauthenticated
      `POST /oauth2/token` route (T-9, M-9; the sample throttles but does not
      WAF).
- [ ] **Enable MFA and Cognito threat protection** on the pools (the **Plus**
      feature tier) — the sample uses Essentials, which is the minimum for
      access-token customisation (T-23, cdk-nag COG2/COG3/COG8; out of scope
      for the identity-topology subject).
- [ ] **Turn deletion protection on** for the pools, set a non-`DESTROY`
      removal policy on the registry, and **remove the `TenantDrain`
      resource** — the sample keeps protection off and offboards every tenant
      on `cdk destroy` so teardown is total (N-8; M-14 for the registry;
      ADR-0022, M-27).
- [ ] **Add a custom domain and managed login / hosted UI** if tenant users
      sign in through a browser — the sample has no domain and uses a
      server-side password flow for the demo only (spec §1.2 seam).
- [ ] **Decide on refresh token rotation.** The sample keeps it off so the
      exchange does not consume the client's refresh token (ADR-0009); a
      deployment that needs rotation revisits that trade (T-11).
- [ ] **Subscribe to the alarm topic.** The 4XX alarm (probing, leaked token,
      amplification) and the 5XX alarm (the service failing) notify the
      stack's `AlarmTopicArn` SNS topic (M-31), which has no subscriber.
      Point it at your on-call path, and add per-function `Errors` alarms if
      you need to know which function failed.
- [ ] **Use a KMS customer-managed key for the log groups** if your compliance
      regime requires it — the sample relies on default CloudWatch Logs
      encryption at rest (the W84/CKV_AWS_158 suppressions).
- [ ] **Tighten the API resource policy principals.** The sample allows the
      account root on `/platform/*`; narrow it to the specific vendor-operator
      principals and, optionally, source IP ranges (T-7, M-7).
- [ ] **Narrow the vendor IAM grant** to `/platform/*` and review CloudTrail;
      in `pool-per-tenant` and `tiered` the platform role holds account-wide
      `cognito-idp:CreateUserPool` (N-3, M-7, the documented hardening point of
      those deployments; `tiered` carries it even with no premium tenant, T-7).
- [ ] **Size the stage's shared `/tenant/*` limit to your tenant count.** The
      sample sets it to 50 rps / 100 burst, five times the per-tenant 10 / 20,
      so five busy tenants together reach it (T-31, ADR-0025); in `tiered`
      the premium plan is 25 / 50, so two premium tenants reach it. Adjust
      the per-tier limits and add quotas if the business needs them.

## Design trail

- Specification: [`design/tenant-identity.spec.md`](./design/tenant-identity.spec.md)
- Decisions: [`adr/`](./adr/) (indexed in [`adr/README.md`](./adr/README.md))
- Implemented state: [`architecture.md`](./architecture.md)
- Threats and mitigations: [`threat-model.md`](./threat-model.md)

Cognito service quotas (user pools, groups, custom attributes, the
pre-token-generation output limit, IdPs per pool) bound each topology
differently; they are the first thing a real deployment hits. See the
[Amazon Cognito quotas page](https://docs.aws.amazon.com/cognito/latest/developerguide/limits.html)
for current figures rather than treating any number here as permanent.
