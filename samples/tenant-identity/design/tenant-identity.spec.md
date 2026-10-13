# Specification: Tenant Identity with Amazon Cognito, Three Topologies

> **Status:** This document is the *requirements and principles* layer of the
> tenant-identity sample: it states what a correct implementation must do and
> why, without prescribing every implementation detail. An implementer (human
> or LLM) should be able to build a functionally equivalent sample from this
> spec alone. Where a requirement is a deliberate design position rather than
> an obvious necessity, the reasoning is given inline; the spec is also a
> teaching document.

The keywords MUST, MUST NOT, SHOULD, and MAY are to be interpreted as in
RFC 2119.

---

## 1. Problem Statement

Every multi-tenant application has to answer one question on every
request: **which tenant is this caller acting for, and is the caller allowed
to act for it?** Cognito answers the first half of that question for *users*
out of the box: a signed token proves who authenticated. It has no notion of a
tenant, but it offers three places where tenant information can be overlaid
onto a user pool: the pool itself, a user attribute, or a group. Whichever is
chosen, the overlay ends up inside the token the user presents, and that is
why the choice matters.

Once tenant identity rides in the token, **Cognito becomes the trusted source
of tenant identity**, not only of user identity. The application reads the
tenant from a claim that Cognito signed, so the claim carries the same
guarantee as the user's identity: it cannot be forged by the client, it can be
checked offline against the pool's public keys, and it is the same on every
request without a lookup. The alternative, keeping a user-to-tenant mapping in
an application table and consulting it per request, puts a second source of
truth on the request path that can drift from the directory and that every
service must be trusted to query correctly. Overlaying on Cognito instead
means tenant assignment is made once, at onboarding, by the party that
controls the user pool (the operator, P-8), and every service downstream
inherits it from the token (P-3, P-5).

The three overlays differ in how the tenant boundary is drawn, and the choice
shapes onboarding, token verification, offboarding, per-tenant customisation,
and what happens when one person works for several tenants.

This sample builds the three topologies **side by side** behind one
application-facing contract, so that the trade-offs can be seen by running the
same scenario against each:

| Topology (context value) | Where the tenant boundary lives | A user can belong to |
|---|---|---|
| `pool-per-tenant` | One user pool per tenant; the token's issuer *is* the tenant | exactly one tenant per account |
| `shared-pool` | One user pool; the tenant is an immutable user attribute | exactly one tenant |
| `shared-pool-multi-tenant` | One user pool; tenants are groups (`t-<tenantId>`); a user may hold several | one or more tenants |

The topology is chosen **once, at deploy time**. The application code and the
platform API are identical across topologies; only the strategy that
provisions tenant identity and the strategy that resolves a token to a tenant
differ (P-1).

### 1.1 The deployment model

This is an **application-plane** sample: it is the identity layer a deployed
multi-tenant application uses to authenticate end users and scope their requests to a
tenant. It assumes a **pooled application plane** (one deployment serves many
tenants) and shows how the identity boundary can still be silo
(`pool-per-tenant`) or pool (`shared-pool*`) independently of the compute
boundary. It complements the `control-plane` sample, which deliberately treats
customer identity as an application-plane concern (control-plane ADR-004).

Two actor classes exist:

- **Operators** (the application provider) onboard tenants and manage users and
  memberships through the **platform API**.
- **End users** (tenant staff) authenticate against Cognito and call the
  **application API**, which resolves their tenant context.

### 1.2 What this sample is NOT

Out of scope, deliberately:

- **A login UI.** Managed login / hosted UI, federation to tenant IdPs (SAML,
  OIDC, social), passwordless, MFA. Tokens are obtained with a server-side
  password flow for demonstration; the verification and resolution logic does
  not depend on how the token was issued.
- **Authorisation within a tenant.** Roles and permissions (`admin`,
  `member`) are an extension seam (§11), not built.
- **The vendor's own identity.** Operators authenticate to the platform API
  with IAM (SigV4); the vendor IdP question is answered by the
  `control-plane` sample.
- **A user directory of its own.** Cognito is the only user store (P-5).
- **Tenant migration between topologies**, billing, tiers, quotas per tenant.
- **A front door.** Routing a request to the right tenant deployment is the
  `tenant-front-door` sample.

### 1.3 Comparison the sample must make visible

| Dimension | `pool-per-tenant` | `shared-pool` | `shared-pool-multi-tenant` |
|---|---|---|---|
| Blast radius of a pool misconfiguration | one tenant | all tenants | all tenants |
| Per-tenant password policy, MFA, federated IdP | native (per pool) | not per tenant (one pool; per-tenant IdPs possible but share the pool's 300-IdP quota) | as `shared-pool` |
| A person in several tenants | separate accounts, separate sign-ins | not supported | supported (groups) |
| Onboarding cost | create pool + client + trigger (seconds, more moving parts) | create nothing in Cognito | create one group |
| Offboarding | delete pool: tokens die with the issuer | disable + delete users, keep pool | delete group; delete users whose only tenant it was |
| Token verification | multi-issuer: registry maps `iss` → tenant, JWKS cached per pool | single issuer | single issuer |
| Hard ceilings (defaults, per Region) | 1,000 user pools (adjustable to 10,000) | 40,000,000 users per pool; 50 custom attributes | 10,000 groups per pool; 100 groups per user; 5,000 total changes in pre-token-generation output |
| Where the tenant lives in the token | `iss` | `tenant_id` claim from `custom:tenantId` | `tenants` claim from `cognito:groups` |

Quota figures are from the Cognito quotas page at the time of writing; the
README MUST link the page rather than restate figures as permanent.

---

## 2. Guiding Principles

These principles generated every decision in the design. When this spec is
silent on a detail, resolve it by applying these principles; they are the
spec's extension mechanism and the facts the ADRs appeal to.

### P-1. One contract, three strategies

The application sees one type, `TenantContext`, and one platform API,
regardless of topology. Everything topology-specific lives behind two
strategy interfaces: a **provisioner** (what onboarding a tenant, creating a
user, and changing a membership mean in this topology) and a **resolver**
(how a verified token becomes a `TenantContext`). An implementation MUST NOT
let topology-specific branches leak into handlers, the data model, or the
API model. The test of the principle: the integration scenario (§10) runs
unchanged against all three stacks.

### P-2. Token verification is offline; tenant status is authoritative in the registry

A request MUST be verified without calling Cognito: signature against cached
JWKS, issuer, audience (`client_id`), expiry, `token_use`. Offline
verification keeps Cognito's authentication quotas out of the request path
and makes latency predictable. What offline verification cannot know is
whether the tenant still exists: offboarding does not revoke issued tokens.
So the resolver MUST additionally confirm the tenant's status in the
**tenant registry** (§4), through a short-lived in-memory cache (reference:
60 s). A token for a tenant that is `DELETING` or absent is rejected even if
it is cryptographically valid. The registry is a DynamoDB read, not a Cognito
call; "offline" means offline *from the identity provider*.

### P-3. Tenant identity is a claim the caller cannot choose

Whatever the client sends about its tenant (a header, a path segment) is a
**selection**, never an assertion. The tenant a request is scoped to MUST be
derived from the verified token (issuer, attribute claim, or group claim) and
a client selection MAY only narrow that set, never widen it. In
`pool-per-tenant` and `shared-pool` the token names exactly one tenant and a
contradicting selection is a 403. In `shared-pool-multi-tenant` the token
names a set and the selection picks one member of it; a selection outside the
set is a 403, and a missing selection with more than one member is a 400
(`TenantSelectionRequired`), never a silent default.

### P-4. Onboarding and offboarding are symmetric and total

Every topology MUST implement all of: create tenant, delete tenant, create
user, delete user, add membership, remove membership. Where an operation has
no meaning in a topology (membership changes outside
`shared-pool-multi-tenant`) it MUST fail explicitly with
`UnsupportedInTopology` (400), not succeed as a no-op, so a deployer who
picks the wrong topology finds out from the API, not from a missing effect.
Delete tenant MUST remove everything create tenant and its users produced:
the pool (`pool-per-tenant`), or the group and the users whose only tenant
it was (`shared-pool*`). The integration scenario ends with no pools, groups,
or users attributable to the test.

### P-5. Cognito is the only user store

The sample MUST NOT persist users, memberships, or credentials in its own
table. Users live in Cognito; memberships are Cognito groups or attributes;
the registry holds **tenants only** (and, for `pool-per-tenant`, the
pool/issuer the tenant owns). Duplicating the user directory creates a second
source of truth that drifts; the trade is that listing "users of tenant X" is
a Cognito call, which is acceptable for a platform API that operators call
rarely.

### P-6. Minimal claims, stable shape

The access token carries at most two tenant claims added by the pre-token-
generation trigger: `tenant_id` (string, topologies 1 and 2) or `tenants`
(array of strings, topology 3). Nothing else is added: no names, no roles,
no e-mail. Claims are read from the **access** token, not the ID token,
because the access token is what an API should accept (P-2). The shape of
`TenantContext` is fixed across topologies:

```
TenantContext {
  tenantId:    string        // the tenant this request is scoped to
  memberships: string[]      // every tenant the token entitles the caller to; length 1 in topologies 1 and 2
  userId:      string        // Cognito `sub`
  username:    string        // Cognito `username` (the e-mail in this sample)
  issuer:      string        // the pool that issued the token
}
```

### P-7. Explicit deploy-time choice, fail fast

`topology` is a required CDK context value with exactly three accepted
strings. Synthesis MUST fail with a message listing the accepted values if it
is missing or misspelled. A topology is never inferred, defaulted, or
switched at runtime (ADR-0001).

### P-8. Least privilege expressed as role asymmetry

The platform function creates and deletes user pools, groups, and users; the
application function verifies tokens and reads the registry. They MUST be
separate functions with separate roles: the application role MUST NOT hold
any `cognito-idp:*` write action, and the platform role MUST NOT be invokable
by end-user tokens. In `pool-per-tenant` the platform role necessarily holds
`cognito-idp:CreateUserPool` and `DeleteUserPool`, which are account-wide
actions; this is the documented hardening point of that topology (N-4).

### P-9. Say what each topology costs

Each topology trades isolation for operational simplicity in a different
place. The README MUST carry the comparison in §1.3 of this spec, kept true
after implementation, including the service quotas that bound each design,
because the quotas are the first thing a real deployment hits.

---

## 3. System Shape

### 3.1 Required components

| # | Component | Requirement |
|---|---|---|
| R-1 | **HTTP API** | One API Gateway HTTP API, generated from the interface model (Smithy), two route families: `/platform/*` (IAM authorisation) and `/app/*` (no gateway authoriser; the application function verifies the bearer token itself, because `pool-per-tenant` has many issuers and a JWT authoriser is bound to one). |
| R-2 | **Platform function** | Implements the platform API through the topology's provisioner. Role per P-8. |
| R-3 | **Application function** | Implements `/app/*` through the topology's resolver. Verifies tokens offline with a JWKS-caching verifier (reference: `aws-jwt-verify`). Role per P-8. |
| R-4 | **Tenant registry** | One DynamoDB table (§4). Point-in-time recovery on; `DESTROY` removal for the sample. |
| R-5 | **Pre-token-generation function** | Cognito Lambda trigger, version 2 event (`V2_0`), adds the claim(s) of P-6 to the access token. Attached to every pool the sample creates. Pools MUST use the **Essentials** feature plan (the default for new pools); access-token customisation is not available on Lite without advanced security features. |
| R-6 | **User pool(s)** | `shared-pool*`: exactly one pool created by the stack. `pool-per-tenant`: zero pools at deploy time; one pool, one app client, and the trigger attachment per tenant at onboarding. Every pool: self sign-up off, admin-create only, e-mail as username, access token lifetime 5 minutes (N-1), no hosted UI domain. |
| R-7 | **Parameter publication** | The stack publishes `/application-plane/shared/identity/{apiUrl,topology}` and, for `shared-pool*`, `/application-plane/shared/identity/userPoolId` and `appClientId`, so the sample mounts into the `control-plane` sample's shared namespace. |

### 3.2 Caller and identity model

- **Operator → platform API:** SigV4 with any principal the deployer grants
  `execute-api:Invoke` on `/platform/*`. The sample grants the deploying
  principal nothing implicitly; the integration test signs with its own
  credentials and the stack's resource policy allows the account.
- **End user → application API:** `Authorization: Bearer <access token>`;
  optional `X-Tenant-Id: <tenantId>` selection (P-3).
- **Sign-in in the sample:** `ADMIN_USER_PASSWORD_AUTH` through
  `AdminInitiateAuth` from the platform function (`POST
  /platform/tenants/{tenantId}/users/{username}/token`) **for the
  demonstration only**, so the integration test can obtain real Cognito
  tokens without a browser. This route MUST be documented as a test aid and
  the README's hardening checklist MUST say to remove it in production.

### 3.3 Deployment inputs

| Context key | Required | Values / default | Effect |
|---|---|---|---|
| `topology` | yes | `pool-per-tenant` \| `shared-pool` \| `shared-pool-multi-tenant` | selects provisioner and resolver (P-7) |
| `tenantHeader` | no | `X-Tenant-Id` | name of the selection header (P-3) |
| `registryCacheSeconds` | no | `60` | resolver's tenant-status cache TTL (P-2) |

Synthesis MUST fail on an unknown `topology` with the accepted values in the
message. The stack name MUST embed the topology
(`TenantIdentity-<topology>`) so all three can coexist in one account and
Region, which the integration test relies on.

---

## 4. Data Model

One table, `TenantRegistry`. Single-table, two item types.

### 4.1 Tenant

| Field | Requirement |
|---|---|
| `tenantId` | generated ULID |
| `name` | required; not unique |
| `status` | `ACTIVE` \| `DELETING` |
| `topology` | the stack's topology, stamped for diagnostics |
| `userPoolId`, `appClientId`, `issuer` | `pool-per-tenant` only: the tenant's own pool |
| `groupName` | `shared-pool-multi-tenant` only: `t-<tenantId>` |
| `createdAt`, `updatedAt` | ISO-8601 |

Key: `PK=TENANT#<tenantId>`, `SK=META`.

**R-8:** No user, membership, credential, or token material is ever written
to the table (P-5).

**R-9:** `DeleteTenant` MUST flip `status` to `DELETING` with a conditional
write *before* touching Cognito, so the resolver starts rejecting the
tenant's tokens within one cache TTL even if the Cognito clean-up is slow or
fails part-way. The item is removed only after clean-up succeeds; a failed
clean-up leaves a `DELETING` tenant that `DeleteTenant` can be re-run against
(idempotent, P-4).

### 4.2 Issuer index (`pool-per-tenant` only)

A GSI `byIssuer` on `issuer` → `tenantId`, so the resolver can map the
`iss` claim of an incoming token to its tenant with one read. An issuer not
in the index is an unknown pool: the request is rejected **before** any JWKS
fetch, so an attacker cannot make the sample download keys from arbitrary
pools (T-3 in the threat model).

### 4.3 Listing

`ListTenants` scans the single table with pagination (the registry is
operator-scale, not user-scale). An implementation MAY add a status GSI; it
MUST NOT add a user item type to make listing users cheaper (P-5).

---

## 5. API Surface

Defined first in Smithy; OpenAPI, server SDK, and gateway wiring are
generated from the model.

### 5.1 Platform operations (`/platform`, IAM)

| Operation | Method / path | Effect by topology |
|---|---|---|
| `CreateTenant` | `POST /platform/tenants` `{name}` → 201 Tenant | 1: create pool + client + trigger, write registry. 2: write registry. 3: create group `t-<id>`, write registry. |
| `GetTenant` | `GET /platform/tenants/{tenantId}` | registry read |
| `ListTenants` | `GET /platform/tenants?nextToken=` | registry scan |
| `DeleteTenant` | `DELETE /platform/tenants/{tenantId}` → 204 | R-9, then: 1: delete pool. 2: delete users with `custom:tenantId=<id>`. 3: delete users whose only group is `t-<id>`, remove the group from the rest, delete the group. |
| `CreateUser` | `POST /platform/tenants/{tenantId}/users` `{email}` → 201 User | 1: `AdminCreateUser` in the tenant's pool. 2: `AdminCreateUser` with `custom:tenantId`. 3: `AdminCreateUser` (if absent) + `AdminAddUserToGroup`. Returns a temporary password only in the response, never logged. |
| `DeleteUser` | `DELETE /platform/tenants/{tenantId}/users/{username}` → 204 | 1, 2: `AdminDeleteUser`. 3: remove from `t-<id>`; delete the user if no `t-*` group remains. |
| `AddMembership` | `PUT /platform/tenants/{tenantId}/users/{username}/membership` → 204 | 3: `AdminAddUserToGroup`. 1, 2: 400 `UnsupportedInTopology`. |
| `RemoveMembership` | `DELETE /platform/tenants/{tenantId}/users/{username}/membership` → 204 | 3: `AdminRemoveUserFromGroup`; 409 if it is the user's last tenant (use `DeleteUser`). 1, 2: 400 `UnsupportedInTopology`. |
| `IssueToken` (test aid) | `POST /platform/tenants/{tenantId}/users/{username}/token` `{password}` → 200 `{accessToken, expiresIn}` | `AdminSetUserPassword` (permanent) then `AdminInitiateAuth` with `ADMIN_USER_PASSWORD_AUTH` against the topology's pool. §3.2. |

Platform mutations are **synchronous**. The slowest, creating a user pool, is
seconds, not minutes; a 202/polling model would add machinery without adding
a capability (contrast control-plane P-8, where builds take minutes).

### 5.2 Application operations (`/app`, bearer token)

| Operation | Method / path | Response |
|---|---|---|
| `WhoAmI` | `GET /app/whoami` | 200 `TenantContext` (P-6) |

One operation is enough to prove the resolver; the sample's value is in the
resolver, not in an application. `WhoAmI` MUST echo the `TenantContext` the
resolver produced, unmodified, so the test can assert on it.

### 5.3 Resolution algorithm (`/app/*`)

1. Extract the bearer token; absent or malformed → 401.
2. Read `iss` **without verifying**. `pool-per-tenant`: look up `byIssuer`;
   unknown → 401 (no JWKS fetch). `shared-pool*`: `iss` must equal the
   stack's pool issuer; else 401.
3. Verify offline (P-2): signature via cached JWKS for that issuer,
   `client_id` equals the pool's app client, `token_use == "access"`, not
   expired. Failure → 401.
4. Derive `memberships`: 1: `[tenantId from step 2]`. 2: `[tenant_id
   claim]`. 3: `tenants` claim (array). Empty → 403.
5. Apply the selection header (P-3): absent and one membership → that
   tenant; absent and several → 400 `TenantSelectionRequired`; present and
   in `memberships` → that tenant; present and not in `memberships` → 403.
6. Confirm the selected tenant is `ACTIVE` in the registry (cached, P-2);
   else 403.
7. Build `TenantContext` and dispatch.

Steps 1-3 are shared across topologies; 4 is the only topology-specific
line, and 5-7 are shared again. An implementation MUST keep that shape.

### 5.4 Error model

| Error | HTTP | Triggers |
|---|---|---|
| `ValidationError` | 400 | malformed input; `UnsupportedInTopology`; `TenantSelectionRequired` |
| `UnauthorizedError` | 401 | missing, malformed, unverifiable, expired token; unknown issuer |
| `ForbiddenError` | 403 | selection outside memberships; tenant not `ACTIVE`; empty memberships |
| `ResourceNotFoundError` | 404 | unknown tenant or user |
| `ConflictError` | 409 | tenant `DELETING` on mutation; removing a user's last membership; e-mail already exists in a shared pool for a different tenant (topology 2) |
| `InternalServerError` | 500 | everything else |

**R-10:** 401 and 403 responses MUST NOT reveal which check failed beyond the
status code; the reason goes to the function's log at `WARN` without the
token.

---

## 6. Contracts

### 6.1 What the deployer supplies

- The `topology` context value (P-7) and, optionally, the header name and
  cache TTL (§3.3).
- Credentials with `execute-api:Invoke` on `/platform/*` for whoever operates
  tenants.
- Nothing else. No pre-existing pool, no domain, no certificate.

### 6.2 What the sample promises

- The `TenantContext` shape (P-6) on every successful `/app/*` request,
  identical across topologies.
- The platform API of §5.1 with the per-topology effects stated there,
  including explicit `UnsupportedInTopology` failures (P-4).
- Rejection of tokens for deleted tenants within `registryCacheSeconds`
  (P-2, R-9).
- Clean teardown: `cdk destroy` after deleting all tenants leaves no pools,
  groups, users, parameters, or log groups with the sample's prefix.
- Parameters under `/application-plane/shared/identity/*` (R-7).

### 6.3 Parameter namespace

| Parameter | Topologies | Written by |
|---|---|---|
| `/application-plane/shared/identity/topology` | all | stack |
| `/application-plane/shared/identity/apiUrl` | all | stack |
| `/application-plane/shared/identity/userPoolId` | 2, 3 | stack |
| `/application-plane/shared/identity/appClientId` | 2, 3 | stack |

`pool-per-tenant` publishes no pool identifiers at the shared level because
pools are per tenant; a consumer resolves them through `GetTenant`.

---

## 7. Topology Mechanics (normative detail)

### 7.1 `pool-per-tenant`

- `CreateTenant` creates a pool named `tenant-identity-<tenantId>`, one app
  client (no secret, `ALLOW_ADMIN_USER_PASSWORD_AUTH` and
  `ALLOW_REFRESH_TOKEN_AUTH` only, access token 5 min), attaches the shared
  pre-token-generation function (one function, many pools; the function
  grants `cognito-idp.amazonaws.com` invoke scoped to the account), and
  writes `userPoolId`, `appClientId`, `issuer` to the registry in one item.
- The trigger adds `tenant_id` from a pool-level mapping: the function reads
  the tenant for the event's `userPoolId` from the registry (cached). This
  keeps the claim present in all topologies so the resolver's step 4 reads a
  claim in topologies 1 and 2 alike; in topology 1 the resolver MUST still
  trust the issuer lookup over the claim (the issuer is cryptographically
  bound; the claim is a convenience) and MUST reject a mismatch as 401.
- `DeleteTenant` deletes the pool. Because the pool is gone, its JWKS
  endpoint disappears and its issuer is removed from the registry; tokens
  die at once. This is the topology's strongest property and MUST be
  demonstrated (§10 step 8).

### 7.2 `shared-pool`

- Pool created by the stack with a **mutable: false** custom attribute
  `tenantId` (string, 26 chars). Immutability is enforced by Cognito; the
  platform API never attempts to change it (moving a user between tenants is
  delete + create, by design).
- The trigger copies `custom:tenantId` into the access token as `tenant_id`.
- E-mail is the username and usernames are pool-unique, so one person cannot
  exist in two tenants; `CreateUser` for an e-mail already present under a
  different `tenantId` → 409.

### 7.3 `shared-pool-multi-tenant`

- Pool created by the stack. `CreateTenant` creates group `t-<tenantId>`
  with the tenant name as description. No custom attribute.
- The trigger reads `request.groupConfiguration.groupsToOverride`, keeps the
  entries matching `^t-[0-9A-HJKMNP-TV-Z]{26}$`, strips the prefix, and
  writes the result as the `tenants` array claim. Groups not matching the
  convention are ignored (reserved for the roles seam, §11).
- `AdminAddUserToGroup` is idempotent, so `AddMembership` is safe to retry.
- A user's groups are capped at 100 (service quota, not adjustable); the
  sample does not pre-check the cap and surfaces Cognito's error as 400.

---

## 8. Pre-Token-Generation Contract

| Field | Requirement |
|---|---|
| Trigger version | `V2_0` (access-token customisation). |
| Input used | `userPoolId`, `request.userAttributes["custom:tenantId"]`, `request.groupConfiguration.groupsToOverride`. |
| Output | `response.claimsAndScopeOverrideDetails.accessTokenGeneration.claimsToAddOrOverride` = `{tenant_id}` (1, 2) or `{tenants: [...]}` (3). ID token untouched. No `claimsToSuppress`, no scope changes, no group overrides. |
| Failure mode | Any exception → Cognito fails the sign-in. The function MUST NOT swallow errors and return a token without the claim; a token without the tenant claim would be rejected by the resolver anyway (step 4, empty → 403), so failing early is the clearer behaviour. |
| Idempotency | Pure function of the event; no side effects, no writes. The registry lookup in topology 1 is read-only. |

**R-11:** The trigger function's role MUST hold only `dynamodb:GetItem` on
the registry (topology 1) and logging; it MUST NOT hold any `cognito-idp`
permission.

---

## 9. Non-Functional Requirements

| # | Requirement | Rationale |
|---|---|---|
| N-1 | Access token lifetime MUST be the Cognito minimum (5 minutes) in every pool the sample creates; refresh tokens 1 day. | Offline verification (P-2) means revocation is bounded by token lifetime plus the registry cache; keep both short. Documented trade: more refresh traffic. |
| N-2 | `registryCacheSeconds` defaults to 60 and MUST be exposed, not hard-coded. | It is the offboarding latency bound a deployer tunes against DynamoDB read cost. |
| N-3 | The registry table MUST have point-in-time recovery; sample uses `DESTROY` removal. | Operator-facing registry; in `pool-per-tenant` losing it orphans pools. |
| N-4 | Platform role scoped to `cognito-idp` actions on pools the sample created (resource tag `sample=tenant-identity` as the condition where the action supports resource ARNs; `CreateUserPool` has no resource, so it is the accepted account-wide action, documented in the threat model). | P-8: this is the hardening point of `pool-per-tenant`. |
| N-5 | JWKS caching per issuer with a bounded number of cached issuers (reference: 100 LRU) in the application function. | A long-lived function in `pool-per-tenant` would otherwise grow its JWKS cache with every tenant ever seen. |
| N-6 | Structured logs; the resolver logs `tenantId`, `userId`, the step that rejected a request, and never the token or the temporary password. | R-10; synthetic data still deserves hygiene the reader will copy. |
| N-7 | The `/platform/*` stage MUST be throttled (reference: 10 rps / 20 burst). | `CreateTenant` in topology 1 creates account-wide resources; cap the rate of a leaked operator credential. |
| N-8 | Pools MUST be created with deletion protection **inactive** and tagged `sample=tenant-identity`. | Teardown must be total (P-4); a real deployment flips protection on and is told so in the hardening checklist. |

---

## 10. Acceptance Criteria

A correct implementation passes this scenario against real infrastructure,
**once per topology, with the same test code**, in one Region. The
integration test deploys the three stacks in parallel, runs the scenario
against each, and destroys them.

1. **Deploy inputs:** synth without `topology` fails naming the three values;
   synth with a misspelling fails the same way.
2. **Onboard:** `CreateTenant` A and B → both `ACTIVE`; `GetTenant` returns
   the topology-specific fields (pool ids for 1, `groupName` for 3, neither
   for 2). Topology 1: two pools exist, each with the trigger attached.
3. **Users:** `CreateUser` u1 in A, u2 in B. Topology 2: `CreateUser` with
   u1's e-mail in B → 409. Topology 3: `AddMembership` u1 → B succeeds;
   topologies 1 and 2: `AddMembership` → 400 `UnsupportedInTopology`.
4. **Sign in and resolve:** `IssueToken` for u1; `GET /app/whoami` →
   `tenantId = A`, `memberships` = `[A]` (1, 2) or `[A, B]` (3), `userId`
   equals the Cognito `sub`.
5. **Selection (P-3):** u1 with `X-Tenant-Id: B` → 403 (1, 2) or 200 with
   `tenantId = B` (3). Topology 3: u1 without the header → 400
   `TenantSelectionRequired`; u2 without the header → 200 (`tenantId = B`,
   single membership). u1 with `X-Tenant-Id: <unknown ULID>` → 403 in all
   topologies.
6. **Rejections (P-2):** no token → 401; tampered signature → 401; token
   from a pool the sample did not create (the test creates a throwaway pool
   and signs in) → 401 **without** a JWKS fetch from that pool (asserted via
   the function's log line for step 2). ID token presented as bearer → 401
   (`token_use`).
7. **Membership removal (3):** `RemoveMembership` u1 from B → u1 re-signs in
   → `memberships = [A]`; `RemoveMembership` u1 from A → 409 (last tenant).
8. **Offboard:** `DeleteTenant` A. Within `registryCacheSeconds` u1's
   still-unexpired token → 403. Topology 1: pool A is gone (`DescribeUserPool`
   → `ResourceNotFound`). Topologies 2 and 3: u1 is deleted; topology 3:
   group `t-A` is gone and u2 is unaffected. `GetTenant` A → 404.
9. **Teardown:** `DeleteTenant` B; no pools (1) or groups and users (2, 3)
   tagged or prefixed by the test remain; `cdk destroy` leaves no stack, no
   parameters under `/application-plane/shared/identity/`, no log groups
   with the sample's prefix. Every platform operation has run at least once
   in every topology.

Plus unit-level assertions that: the resolver's step 4 is the only
topology-specific branch in the request path (P-1); the application role's
policy contains no `cognito-idp:*` action (P-8); the trigger returns the
claim shape of §8 for each topology's event; the registry never receives a
user item (R-8).

---

## 11. Extension Seams (documented, not built)

| Extension | Seam |
|---|---|
| Roles within a tenant | Groups not matching `^t-` in topology 3 (`role-admin`, `role-member`); a second custom attribute in topology 2; per-pool groups in topology 1. Add a `roles` claim in the trigger and a `roles: string[]` field to `TenantContext`. |
| Federation to a tenant's own IdP | Topology 1: an IdP per pool, the natural fit. Topologies 2 and 3: an IdP per tenant in the shared pool with attribute/group mapping, bounded by the 300-IdP quota. |
| Tenant-scoped tokens at sign-in (alternative to the selection header) | Pass the chosen tenant as `clientMetadata` to `InitiateAuth`; the trigger emits a single `tenant_id` instead of `tenants`. Trades a per-request choice for a per-session one. |
| Hosted UI / managed login | Add a domain and OAuth flows to the app client; nothing in the resolver changes. |
| Async onboarding | Wrap `CreateTenant` in the control-plane sample's workflow when onboarding grows beyond Cognito calls (e.g. also provisioning tenant storage). |
| Control-plane mounting | A `scripts/control-plane/` lifecycle set that calls `CreateTenant`/`DeleteTenant` so this sample runs as a cell's identity component. |
| Audit trail of platform operations | CloudTrail already records every `cognito-idp` call; a first-class audit table would duplicate it (P-5 spirit). |

---

## 12. Reading Order for Implementers

1. §1.3 and §2 (what the three topologies trade and the principles).
2. §5.3, the resolution algorithm; it is the sample.
3. §7 and §8, the per-topology mechanics and the trigger contract.
4. §4 and §5.1, registry and platform API.
5. §10, then build the integration test first.
6. `adr/README.md` for the decisions and their rejected alternatives.
