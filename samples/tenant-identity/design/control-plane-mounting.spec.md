# Specification: Mounting Tenant Identity under the Control Plane

> **Status:** Proposed, 2026-10-26. Not implemented. This is an addendum to
> [`tenant-identity.spec.md`](tenant-identity.spec.md): it specifies how the
> `control-plane` sample onboards and offboards tenant identity through its
> provisioning scripts, filling the "Control-plane mounting" seam of
> tenant-identity §11. It changes both samples; each change is recorded as a
> Proposed ADR in the sample it touches (tenant-identity ADR-0028 to
> ADR-0031, control-plane ADR-0022 and ADR-0023).
>
> Written against `main` at `c4023d8`. The composition rule and repository
> `ARCHITECTURE.md` on the unmerged `sample/runtime-isolation` branch
> (`1537688`, standard §1.1) say samples consume each other only through an
> exported construct or published SSM parameters. This spec already obeys
> that rule (it uses only SSM parameters and the platform API); if that
> branch merges first, add the new parameter (§6.2) to the `ARCHITECTURE.md`
> namespace table in the same PR.

The keywords MUST, MUST NOT, SHOULD, and MAY are to be interpreted as in
RFC 2119. Requirements are numbered `M-R-n` so they do not collide with the
parent specs' `R-n`.

---

## 1. Problem Statement

The two samples fit but nothing joins them. `control-plane` onboards a
tenant by running a vendor-supplied tenant script in CodeBuild; it
deliberately owns no tenant identity (control-plane ADR-004).
`tenant-identity` onboards a tenant's identity through its IAM-authorised
platform API (`POST /platform/tenants`) and publishes its API URL under
`/application-plane/shared/identity/*`. Today a vendor running both must
call each one by hand and keep two tenant ids in step.

This addendum makes **one** onboarding call do both: control-plane
`CreateTenant` runs a tenant script, shipped by tenant-identity, that calls
tenant-identity `CreateTenant` with the same tenant id. `DeleteTenant`
mirrors it.

### 1.1 The deployment model

- tenant-identity is **account-level shared infrastructure**: one stack per
  account and Region owns `/application-plane/shared/identity/*`
  (tenant-identity ADR-0017). In control-plane terms it is "shared
  infrastructure, out of band" (control-plane spec §6.2). It is not a cell's
  shared deployment.
- Every control-plane cell therefore reaches the **same** identity
  deployment. Cell scripts do nothing for identity except check that it
  exists.
- The tenant-identity topology is whatever the deployer chose
  (`pool-per-tenant`, `shared-pool`, `shared-pool-multi-tenant`). `tiered` is
  refused (§1.2).

### 1.2 What this is NOT

- Not a change to control-plane's own authentication. The vendor still signs
  in to control-plane through its OIDC vendor IdP (control-plane ADR-004,
  ADR-018). tenant-identity does not become that IdP.
- Not a new sample. The adapter scripts live in tenant-identity; control-plane
  gains two generic inputs and learns nothing about identity (control-plane
  P-3).
- Not `tiered` support. A tiered stack needs a `tier` per tenant, and
  control-plane has no per-tenant input to carry it. The seam is
  control-plane's opaque `parameters` map (control-plane spec §11); until it
  exists, the create script refuses a `tiered` deployment (M-R-7).
- Not per-cell identity (one identity stack per cell). That is a different
  deployment model, recorded as a seam in §11.
- Not delivery of the admin invitation to a real mailbox. The script parks
  the temporary password for the vendor (ADR-0031); real delivery is a
  hardening item.

---

## 2. Guiding Principles

### M-P-1. One tenant, one id

The control-plane tenant id is the tenant-identity tenant id. Both are ULIDs
with the same pattern (`^[0-9A-HJKMNP-TV-Z]{26}$`), so the control plane's id
is passed through, not mapped. A mapping table would be a second record of
the same fact, with a window where it is missing. This rules in an optional,
caller-supplied `tenantId` on tenant-identity `CreateTenant` (ADR-0029) and
rules out storing a cross-reference parameter.

### M-P-2. The producer ships the mount

The sample that owns a capability ships the scripts that mount it under the
control plane, in `scripts/control-plane/`. The control plane stays generic:
it learns how to grant a build role extra permissions and how to pass a
tenant's name, never what identity is (control-plane P-3). This rules in the
script set in tenant-identity (ADR-0028) and rules out identity-shaped
control-plane inputs.

### M-P-3. Replay is the recovery path

Every script is safe to re-run after a partial run, because control-plane
retries by re-running scripts (control-plane R-15). Each step reads state
first and only writes what is missing; "already there" is success, "already
gone" is success.

### M-P-4. The producer owns its permission

tenant-identity knows exactly which calls the mount makes, so it publishes
the least-privilege policy for them (ADR-0030). The consumer attaches it
without reading it. No `execute-api:*` wildcard is written in control-plane.

### M-P-5. Nothing secret reaches a build log

Scripts follow both samples' `scripts/CONVENTIONS.md`: no `set -x`; log
names, ids and HTTP status, never passwords, credentials, emails or response
bodies.

---

## 3. System Shape

### 3.1 Components

| Component | Sample | New or changed |
|---|---|---|
| `scripts/control-plane/tenant/{create,update,delete}.sh` | tenant-identity | new |
| `scripts/control-plane/cell/{create,update,delete}.sh` | tenant-identity | new |
| `scripts/control-plane/lib.sh` (sign and call the platform API) | tenant-identity | new |
| `CreateTenant` optional `tenantId` input | tenant-identity | changed (ADR-0029) |
| `PlatformInvokePolicy` managed policy + its SSM parameter | tenant-identity | new (ADR-0030) |
| `tenantBuildManagedPolicyArns` deployment input | control-plane | new (ADR-0022) |
| `TENANT_NAME` in the tenant script environment | control-plane | new (ADR-0023) |
| `test/integ.control-plane.ts` + `scripts/integ-control-plane.sh` | tenant-identity | new (§10) |

### 3.2 Data path

```
vendor ──JWT──▶ control-plane CreateTenant (202, tenantId=T)
                 └─▶ Step Functions ─▶ CodeBuild tenant project
                       └─▶ tenant/create.sh
                             ├─ read /application-plane/shared/identity/{apiUrl,topology}
                             ├─ SigV4 POST {apiUrl}/platform/tenants {tenantId:T, name, adminEmail}
                             └─ put /application-plane/tenants/T/identity/admin-temporary-password (SecureString)
                 ◀── build SUCCEEDED ── tenant ACTIVE in control-plane
```

`DeleteTenant` is the same path with `tenant/delete.sh` calling
`DELETE {apiUrl}/platform/tenants/T`.

### 3.3 Callers and identity

- **Vendor → control-plane:** unchanged (vendor IdP JWT, `role: operator`).
- **Tenant build → tenant-identity platform API:** SigV4 as the control-plane
  tenant build role. Its permission comes from the attached
  `PlatformInvokePolicy` (ADR-0030); tenant-identity's resource policy
  already allows the account root on `/platform/*` (tenant-identity
  `identity.cdk.ts`), so both sides allow the call only in the same account.
- **Signing:** `aws configure export-credentials --format process` into
  `curl --aws-sigv4 "aws:amz:${AWS_REGION}:execute-api" --config -`, the
  pattern `scripts/demo.sh` already uses. CodeBuild `standard:7.0` ships
  curl 7.81 (≥ 7.75 needed) and AWS CLI v2. Credentials go to curl through
  `--config -` on stdin, never on the command line (M-P-5).
- **Audit:** control-plane passes `OPERATOR_ID` to every build
  (control-plane ADR-019). The script MUST log it beside the tenant id so a
  tenant-identity access-log line (which shows only the build role) can be
  joined to the operator through the build log.

### 3.4 Deployment inputs

| Sample | Input | Value |
|---|---|---|
| tenant-identity | `topology` | unchanged; not `tiered` when mounted |
| control-plane | `cellDefinition.source` | a source holding tenant-identity's `scripts/control-plane/` |
| control-plane | `cellDefinition.cellScripts` | `scripts/control-plane/cell/{create,update,delete}.sh` |
| control-plane | `cellDefinition.tenantScripts` | `scripts/control-plane/tenant/{create,update,delete}.sh` |
| control-plane | `tenantBuildManagedPolicyArns` (new, ADR-0022) | the value of `/application-plane/shared/identity/platformInvokePolicyArn` |

Deploy order: tenant-identity first (it publishes the policy ARN), then
control-plane. control-plane MUST fail at synth if an entry of
`tenantBuildManagedPolicyArns` is not an IAM managed-policy ARN in its own
partition and account.

---

## 4. Data Model

No new tables. State lives in existing stores:

| Fact | Where | Owner |
|---|---|---|
| tenant lifecycle (control) | control-plane `Tenant` record | control-plane |
| tenant identity (registry row, pool or groups) | tenant-identity `TenantRegistry`, key `TENANT#<T>` | tenant-identity |
| first admin's temporary password, until collected | SSM SecureString `/application-plane/tenants/<T>/identity/admin-temporary-password` | the tenant scripts (ADR-0031) |

**M-R-1:** The script MUST NOT write any other identity fact to SSM. Pool
ids, client ids and issuers are read from `GetTenant` by whoever needs them
(tenant-identity §6.3).

---

## 5. API Changes

### 5.1 tenant-identity `CreateTenant` takes an optional `tenantId` (ADR-0029)

```smithy
operation CreateTenant {
    input := {
        /// Optional. When present, the registry row is written with this id
        /// instead of a generated one. Lets an upstream control plane keep
        /// one id across planes (control-plane mounting spec M-P-1).
        tenantId: TenantId
        @required
        name: TenantName
        @required
        adminEmail: EmailAddress
        tier: Tier
    }
    // output and errors unchanged; ConflictError already modelled
}
```

**M-R-2:** With `tenantId`, the registry write keeps its existing
`attribute_not_exists(PK)` condition. An existing row fails the call with
409 `ConflictError` and changes nothing. Without `tenantId`, behaviour is
unchanged (a generated ULID).

**M-R-3:** The id MUST be validated by the Smithy pattern (400 on mismatch)
before any write.

Neither the tenant API nor the token contract changes.

### 5.2 control-plane script environment gains `TENANT_NAME` (ADR-0023)

| Variable | Cell scripts | Tenant scripts |
|---|---|---|
| `TENANT_NAME` | — | ✓ every operation; the tenant's `name` as stored on the control-plane record |

Same boundary test as `ADMIN_EMAIL` (control-plane ADR-004): onboarding
input, not application-plane configuration. Unlike `ADMIN_EMAIL` it is
already persisted on the record, so it is passed on every operation.

---

## 6. Contracts

### 6.1 Script environment the mount relies on

`TENANT_ID`, `TENANT_NAME`, `CELL_ID`, `OPERATION`, `ADMIN_EMAIL` (create),
`OPERATOR_ID`, `AWS_REGION` (CodeBuild default).

### 6.2 Parameters

| Parameter | Written by | Read by |
|---|---|---|
| `/application-plane/shared/identity/apiUrl` | tenant-identity stack (existing) | all mount scripts |
| `/application-plane/shared/identity/topology` | tenant-identity stack (existing) | `tenant/create.sh`, `cell/create.sh` |
| `/application-plane/shared/identity/platformInvokePolicyArn` | tenant-identity stack (new, ADR-0030) | the deployer, once, as control-plane context |
| `/application-plane/tenants/<T>/identity/admin-temporary-password` | `tenant/create.sh` | the vendor, out of band; deleted by `tenant/delete.sh` |

All reads and writes stay inside the namespaces control-plane already grants
its tenant build role (control-plane spec §6.2). No grant changes there.

### 6.3 `PlatformInvokePolicy` (ADR-0030)

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": "execute-api:Invoke",
    "Resource": [
      "arn:<partition>:execute-api:<region>:<account>:<apiId>/<stage>/POST/platform/tenants",
      "arn:<partition>:execute-api:<region>:<account>:<apiId>/<stage>/GET/platform/tenants/*",
      "arn:<partition>:execute-api:<region>:<account>:<apiId>/<stage>/DELETE/platform/tenants/*",
      "arn:<partition>:execute-api:<region>:<account>:<apiId>/<stage>/POST/platform/tenants/*/users"
    ]
  }]
}
```

`GET /platform/tenants/*` also matches `GET .../users`, which
`tenant/create.sh` needs to check for the admin, and `POST .../users`
re-creates a missing one (M-R-6).

**M-R-4:** The policy MUST NOT grant `ListTenants`, `IssueToken`,
`RefreshToken`, user updates, or memberships. `DELETE /platform/tenants/*`
also matches `DeleteUser`; the scripts never call it, and the threat model
records the over-grant (execute-api ARNs cannot tell a tenant path from a
user path under it).

### 6.4 What the mount promises

- After control-plane `CreateTenant` reaches `ACTIVE`, tenant-identity
  `GetTenant(T)` returns `ACTIVE`, with the same `name`, and the tenant has
  exactly one admin, `ADMIN_EMAIL`.
- After control-plane `DeleteTenant` completes, tenant-identity `GetTenant(T)`
  returns 404 and no `/application-plane/tenants/<T>/identity/*` parameter
  remains.
- A failure inside tenant-identity surfaces as control-plane
  `CREATE_FAILED`/`DELETE_FAILED` with the operation and HTTP status in the
  build log (never the body), and re-running the control-plane operation
  finishes the job (M-P-3).

---

## 7. Script Behaviour (normative)

Common to all: `set -euo pipefail`; `: "${VAR:?}"` guards; every platform
call through one `platform_call METHOD PATH [BODY]` function in `lib.sh` that
prints only `"<METHOD> <path-template> -> HTTP <code>"` and returns the
status and body to the caller in variables.

### 7.1 `tenant/create.sh`

1. Read `apiUrl` and `topology`. Missing → exit 1 naming the parameter.
2. **M-R-7:** `topology == tiered` → exit 1 with
   `"tiered identity needs a per-tenant tier; not supported when mounted"`.
3. `GET /platform/tenants/{T}`:
   - 200 `ACTIVE` → go to 5.
   - 200 `PROVISIONING` → exit 1 (a concurrent or crashed create; re-run
     later). tenant-identity has no stuck-row sweep, so this is the
     documented residual gap (§9).
   - 200 `DELETING` → exit 1 (`"tenant is being offboarded"`).
   - 404 → step 4.
4. `POST /platform/tenants {tenantId: T, name: TENANT_NAME, adminEmail}`:
   - 201 → park `admin.temporaryPassword` (step 6), done.
   - 409 → a racing create won; go to 3 once more, then fail if still not
     `ACTIVE`.
   - other → exit 1.
5. **M-R-6** (replay after a create that left no admin, tenant-identity §5.1
   last sentence): `GET /platform/tenants/{T}/users`; if no user has
   `admin: true`, `POST /platform/tenants/{T}/users {email: ADMIN_EMAIL,
   admin: true}` and park the returned password. If an admin exists, do
   nothing; never re-park.
6. Park: `aws ssm put-parameter --type SecureString --overwrite --name
   /application-plane/tenants/{T}/identity/admin-temporary-password
   --value "$PW" > /dev/null`, then `unset PW`. Log the parameter name only.

### 7.2 `tenant/update.sh`

Reconcile only. `GET /platform/tenants/{T}`: `ACTIVE` → success; anything
else → exit 1 naming the status. It never creates (control-plane
`UpdateTenant` on a tenant whose identity was lost should fail loudly, not
silently re-onboard with no `ADMIN_EMAIL`).

### 7.3 `tenant/delete.sh`

1. `DELETE /platform/tenants/{T}`: 204 or 404 → success (404 covers
   `CREATE_FAILED` tenants that never reached tenant-identity). Other → exit 1.
   tenant-identity's own `DeleteTenant` is idempotent against `DELETING`
   (tenant-identity R-11), so a re-run finishes a half-done offboarding.
2. `aws ssm delete-parameter` on the parked password; `ParameterNotFound` is
   success.

### 7.4 `cell/*.sh`

`create.sh` and `update.sh` read `apiUrl` and `topology` and fail if either
is missing or `topology == tiered`, so a cell cannot be created against an
account with no usable identity deployment. `delete.sh` is an explicit
no-op (control-plane P-9).

---

## 8. Failure Modes

| Failure | control-plane result | Recovery |
|---|---|---|
| identity stack not deployed | cell `CREATE_FAILED` | deploy tenant-identity, `UpdateCell` |
| `tiered` topology | cell or tenant `CREATE_FAILED` | redeploy identity with a single topology |
| policy not attached | tenant `CREATE_FAILED`, `HTTP 403` in log | redeploy control-plane with the context, then `DeleteTenant` and `CreateTenant` again |
| build killed after 201, before park | `CREATE_FAILED` | re-run: step 3 sees `ACTIVE`, step 5 sees an admin and does not re-park. The password is lost; the vendor recovers with `DeleteUser` + `CreateUser` (residual gap, §9) |
| identity row stuck `PROVISIONING` | `CREATE_FAILED` | vendor `DeleteTenant` on tenant-identity, then control-plane `DeleteTenant` |
| identity `DeleteTenant` fails | `DELETE_FAILED` | control-plane `DeleteTenant` retry re-runs the script |

---

## 9. Non-Functional Requirements and Residual Gaps

- **Runtime:** a pool-per-tenant create is seconds inside a build of about
  one minute; well inside control-plane's build budget (control-plane R-23).
- **Residual gap 1:** a build killed between the 201 and the park loses the
  temporary password. Closing it needs tenant-identity to return the
  password again or to let Cognito deliver it (ADR-0031 Consequences).
- **Residual gap 2:** a tenant-identity row stuck in `PROVISIONING` blocks
  replay. tenant-identity has no sweep; its §11 is the place to add one.
- **Residual gap 3:** the parked password is readable by anything that can
  read `/application-plane/tenants/*` and decrypt with the default SSM key.
  In control-plane that is the tenant build role, which runs every tenant's
  script (control-plane ADR-021 bounds that blast radius). Hardening: a
  customer KMS key the build role can encrypt with but not decrypt.

---

## 10. Acceptance Criteria (integration test)

`npx projen integ:control-plane` in tenant-identity, driven by
`scripts/integ-control-plane.sh` with the CDK CLI (tenant-identity ADR-0023
pattern), in exactly one Region from `AWS_REGION`.

Setup, deployed together with `--concurrency`:

- `TenantIdentity-shared-pool` (one topology is enough; per-topology
  behaviour is the parent sample's test). If
  `/application-plane/shared/identity/topology` already exists in the
  account, abort before deploying (tenant-identity ADR-0017: one owner).
- `TenantIdentityCpSetup` from `test/integ.control-plane.ts`: a throwaway
  vendor IdP (Cognito pool + pre-token trigger minting `role: operator`, as
  control-plane's own integ does) and an S3 bucket holding
  `scripts/control-plane/` as the script source.

Then control-plane through its own deploy path (`cd ../control-plane && npx
cdk deploy` with the §3.4 context), never by importing its `src/`.

| # | Step | Expected |
|---|---|---|
| 1 | control-plane `CreateTenant` for the first tenant creates its cell (implicit, control-plane ADR-013) | cell `ACTIVE`; `cell/create.sh` found the identity parameters |
| 2 | control-plane `CreateTenant {name, adminEmail=success+admin@simulator.amazonses.com}` | 202, polls to `ACTIVE` |
| 3 | tenant-identity `GetTenant(T)` with the test's own SigV4 | 200 `ACTIVE`, same `name` |
| 4 | tenant-identity `ListUsers(T)` | exactly one user, `admin: true` |
| 5 | parked parameter exists, type `SecureString` | true; value never printed |
| 6 | `IssueToken` for the admin with the parked password (test aid) | access token whose `tenant_id` claim is `T` |
| 7 | control-plane `UpdateTenant(T)` | `ACTIVE`; still one admin; parameter not re-written (version unchanged) |
| 8 | run `tenant/create.sh` locally a second time with the build's env | exit 0; still one registry row, one admin |
| 9 | tenant-identity `CreateTenant` with an existing `tenantId` | 409, nothing changed |
| 10 | control-plane `DeleteTenant(T)` | completes |
| 11 | tenant-identity `GetTenant(T)` | 404; parked parameter gone |
| 12 | teardown from an exit trap: control-plane, setup, identity | no stacks, pools, parameters, or log groups with either prefix |

Unit tests (jest, no AWS): each mount script run with `aws` and `curl`
replaced by stubs on `PATH`, covering every branch of §7 including `tiered`
refusal, `PROVISIONING`, 409 race, and 404-on-delete; plus a check that no
stub ever receives the password or email on its command line.

Estimated run: 25-35 minutes, under $1.

---

## 11. Extension Seams (documented, not built)

| Extension | Seam |
|---|---|
| `tiered` | control-plane opaque `parameters` map → `TENANT_TIER` env → `tier` on `CreateTenant` |
| Per-cell identity | `cell/create.sh` deploys a `TenantIdentity-<topology>` stack per cell with `publishSharedParameters: false` and writes its `apiUrl` to `/application-plane/cells/<cellId>/identity/apiUrl`; tenant scripts read the cell value first |
| Real invite delivery | tenant-identity `CreateTenant` option to let Cognito send the invitation (no `SUPPRESS`), with an SES-backed sender; the script then parks nothing |
| Async onboarding | tenant-identity §11 "Async onboarding" is now this mount |

---

## 12. Parallel Readiness

| Work item | Ready | Depends on |
|---|---|---|
| tenant-identity: optional `tenantId` (ADR-0029) + unit tests | yes | — |
| tenant-identity: `PlatformInvokePolicy` + parameter (ADR-0030) | yes | — |
| control-plane: `tenantBuildManagedPolicyArns` (ADR-0022) | yes | — |
| control-plane: `TENANT_NAME` env (ADR-0023) | yes | — |
| tenant-identity: mount scripts + stub unit tests | yes | contracts in §5-§7 only |
| integ test (§10) | no | all of the above |
| README, architecture.md, threat model, diagrams in both samples | no | integ green |
