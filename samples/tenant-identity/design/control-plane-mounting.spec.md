# Specification: Mounting Tenant Identity under the Control Plane

> **Status:** Proposed, 2026-10-26. Not implemented. This is an addendum to
> [`tenant-identity.spec.md`](tenant-identity.spec.md): it specifies how the
> `control-plane` sample onboards and offboards tenant identity through its
> provisioning scripts, filling the "Control-plane mounting" seam of
> tenant-identity §11. It changes both samples; each change is recorded as a
> Proposed ADR in the sample it touches (tenant-identity ADR-0028 to
> ADR-0033, control-plane ADR-0022 and ADR-0023).
>
> Revised 2026-10-26 after a blind review: `tenantId` is typed `TenantId`
> (§5.1), the first admin is a conditional write (§5.3, ADR-0032), the parked
> password is encrypted with a key the build role cannot decrypt (§6.5,
> ADR-0033), the park happens before any other work (M-R-10), and §10 names
> the test-aid dependency.
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
  the temporary password for the vendor, encrypted with a key the build role
  cannot decrypt (ADR-0031, ADR-0033); real delivery is a hardening item.

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
| `CreateUser` optional `firstAdmin` input; registry `firstAdminUsername` | tenant-identity | changed (ADR-0032) |
| `PlatformInvokePolicy` managed policy (API routes + encrypt) + its SSM parameter | tenant-identity | new (ADR-0030) |
| `AdminPasswordKey` KMS key + its SSM parameter | tenant-identity | new (ADR-0033) |
| `tenantBuildManagedPolicyArns` deployment input | control-plane | new (ADR-0022) |
| `TENANT_NAME` in the tenant script environment | control-plane | new (ADR-0023) |
| `test/integ.control-plane.ts` + `scripts/integ-control-plane.sh` | tenant-identity | new (§10) |

### 3.2 Data path

```
vendor ──JWT──▶ control-plane CreateTenant (202, tenantId=T)
                 └─▶ Step Functions ─▶ CodeBuild tenant project
                       └─▶ tenant/create.sh
                             ├─ read /application-plane/shared/identity/{apiUrl,topology,adminPasswordKeyArn}
                             ├─ SigV4 POST {apiUrl}/platform/tenants {tenantId:T, name, adminEmail}
                             └─ put /application-plane/tenants/T/identity/admin-temporary-password
                                (SecureString, key = AdminPasswordKey)
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
| first admin's temporary password, until collected | SSM SecureString `/application-plane/tenants/<T>/identity/admin-temporary-password`, encrypted with `AdminPasswordKey` | the tenant scripts (ADR-0031, ADR-0033) |
| which user is the first admin | tenant-identity registry row, `firstAdminUsername` | tenant-identity (ADR-0032) |

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
        /// Typed `TenantId` (not a fresh string) so the ULID pattern applies.
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

**M-R-3:** The `tenantId` member MUST reuse the `TenantId` shape from
`__global.smithy`, so its pattern (`^[0-9A-HJKMNP-TV-Z]{26}$`) rejects a bad
id with 400 before any write. A new string shape would not carry the pattern.

Neither the tenant API nor the token contract changes.

### 5.2 control-plane script environment gains `TENANT_NAME` (ADR-0023)

| Variable | Cell scripts | Tenant scripts |
|---|---|---|
| `TENANT_NAME` | — | ✓ every operation; the tenant's `name` as stored on the control-plane record |

Same boundary test as `ADMIN_EMAIL` (control-plane ADR-004): onboarding
input, not application-plane configuration. Unlike `ADMIN_EMAIL` it is
already persisted on the record, so it is passed on every operation.

### 5.3 tenant-identity `CreateUser` takes an optional `firstAdmin` (ADR-0032)

```smithy
operation CreateUser {
    input := {
        @required
        @httpLabel
        tenantId: TenantId
        @required
        email: EmailAddress
        /// Also add the user to `admin-<tenantId>`.
        admin: Boolean
        /// Optional. When true, the call claims the tenant's single
        /// first-admin slot. 409 ConflictError if the slot is taken.
        /// Implies admin: true.
        firstAdmin: Boolean
    }
    // output and errors unchanged; ConflictError already modelled
}
```

**M-R-8:** The registry row gains `firstAdminUsername`. A `firstAdmin`
create MUST first claim it with one conditional write
(`attribute_not_exists(firstAdminUsername)`, value = the email, which is the
Cognito username in every topology). A failed condition is 409
`ConflictError` and changes nothing. Only after the claim does the Cognito
user get created; if that fails, the claim is released with a conditional
delete (`firstAdminUsername = :email`) and the original error is returned.

**M-R-9:** `CreateTenant` creates its first admin through the same path, so
the admin it makes also holds the slot. `DeleteUser` on the slot holder MUST
release the slot in the same way, so the vendor can replace a lost admin.

The guard is a conditional write on the authoritative record, not a
read-then-write (control-plane P-5). Two racing `firstAdmin` creates get one
201 and one 409, whatever order Cognito sees them in. Ordinary
`CreateUser {admin: true}` is unchanged: a tenant may have more admins; it has
one *first* admin.

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
| `/application-plane/shared/identity/adminPasswordKeyArn` | tenant-identity stack (new, ADR-0033) | `tenant/create.sh` |
| `/application-plane/tenants/<T>/identity/admin-temporary-password` | `tenant/create.sh` | the vendor, out of band; deleted by `tenant/delete.sh` |

All reads and writes stay inside the namespaces control-plane already grants
its tenant build role (control-plane spec §6.2). No grant changes there.

### 6.3 `PlatformInvokePolicy` (ADR-0030)

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "execute-api:Invoke",
      "Resource": [
        "arn:<partition>:execute-api:<region>:<account>:<apiId>/<stage>/POST/platform/tenants",
        "arn:<partition>:execute-api:<region>:<account>:<apiId>/<stage>/GET/platform/tenants/*",
        "arn:<partition>:execute-api:<region>:<account>:<apiId>/<stage>/DELETE/platform/tenants/*",
        "arn:<partition>:execute-api:<region>:<account>:<apiId>/<stage>/POST/platform/tenants/*/users"
      ]
    },
    {
      "Effect": "Allow",
      "Action": ["kms:Encrypt", "kms:GenerateDataKey"],
      "Resource": "<AdminPasswordKey ARN>",
      "Condition": { "StringEquals": { "kms:ViaService": "ssm.<region>.amazonaws.com" } }
    }
  ]
}
```

`POST .../users` is for M-R-6 (claim the first-admin slot on replay).
`GET /platform/tenants/*` is for `GetTenant`; it also matches `GET .../users`
and `GetUser`, which the scripts never call. The second statement lets SSM
encrypt the parked password with `AdminPasswordKey` (ADR-0033) and nothing
else: no `kms:Decrypt`, and only through SSM.

**M-R-4:** The policy MUST NOT grant `ListTenants`, `IssueToken`,
`RefreshToken`, user updates, memberships, or `kms:Decrypt`.
`DELETE /platform/tenants/*` also matches `DeleteUser`; the scripts never
call it, and `threat-model.md` records the over-grant in the same PR that
adds the policy (execute-api ARNs cannot tell a tenant path from a user path
under it).

### 6.4 What the mount promises

- After control-plane `CreateTenant` reaches `ACTIVE`, tenant-identity
  `GetTenant(T)` returns `ACTIVE`, with the same `name`, and the tenant has
  exactly one first admin, `ADMIN_EMAIL`, held by the conditional slot of
  M-R-8. No replay, race or retry can make a second one.
- The parked password can be read only by a principal holding
  `kms:Decrypt` on `AdminPasswordKey`. The control-plane tenant build role
  holds none (§6.5).
- After control-plane `DeleteTenant` completes, tenant-identity `GetTenant(T)`
  returns 404 and no `/application-plane/tenants/<T>/identity/*` parameter
  remains.
- A failure inside tenant-identity surfaces as control-plane
  `CREATE_FAILED`/`DELETE_FAILED` with the operation and HTTP status in the
  build log (never the body), and re-running the control-plane operation
  finishes the job (M-P-3).

### 6.5 `AdminPasswordKey` (ADR-0033)

A symmetric customer-managed KMS key owned by the tenant-identity stack that
publishes the shared parameters (ADR-0017), alias
`alias/application-plane/identity/admin-password`, rotation on, ARN at
`/application-plane/shared/identity/adminPasswordKeyArn`.

Key policy: the default (account root, so IAM policies decide) plus nothing
else. Who may do what then follows from identity policies:

| Principal | Can | Because |
|---|---|---|
| control-plane tenant build role | encrypt, through SSM only | `PlatformInvokePolicy` second statement |
| the vendor's reader (whoever collects the password) | decrypt | its own `kms:Decrypt` on the key ARN; the deployer grants it |
| anything else with `ssm:GetParameter` on `/application-plane/tenants/*` | nothing useful | `--with-decryption` fails without `kms:Decrypt` |

**M-R-11:** `tenant/create.sh` MUST pass `--key-id` with this ARN on every
`put-parameter`; a park with the default SSM key is a failure (exit 1 before
the write). Deleting the parameter needs no KMS permission.

---

## 7. Script Behaviour (normative)

Common to all: `set -euo pipefail`; `: "${VAR:?}"` guards; every platform
call through one `platform_call METHOD PATH [BODY]` function in `lib.sh` that
prints only `"<METHOD> <path-template> -> HTTP <code>"` and returns the
status and body to the caller in variables.

### 7.1 `tenant/create.sh`

1. Read `apiUrl`, `topology` and `adminPasswordKeyArn`. Missing → exit 1
   naming the parameter.
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
   - 201 → **M-R-10:** park `admin.temporaryPassword` (step 6) as the very
     next call, before any log line, read or other work, so the window of
     §9 gap 1 is one call wide. Then done.
   - 409 → a racing create won; go to 3 once more, then fail if still not
     `ACTIVE`.
   - other → exit 1.
5. **M-R-6** (replay after a create that left no admin, tenant-identity §5.1
   last sentence, or a build killed before the park): `POST
   /platform/tenants/{T}/users {email: ADMIN_EMAIL, firstAdmin: true}`:
   - 201 → park the returned password (step 6), done.
   - 409 → the slot is held; an admin exists. Do nothing; never re-park.
   - other → exit 1.

   No `GET .../users` first: the slot (M-R-8) decides, not a read.
6. Park: `aws ssm put-parameter --type SecureString --key-id "$KEY_ARN"
   --overwrite --name
   /application-plane/tenants/{T}/identity/admin-temporary-password
   --value "$PW" > /dev/null`, then `unset PW`. `KEY_ARN` is
   `adminPasswordKeyArn`, read in step 1 (missing → exit 1, M-R-11). Log
   the parameter name only.

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
| build killed after 201, before park | `CREATE_FAILED` | re-run: step 3 sees `ACTIVE`, step 5 gets 409 and does not re-park. The password is lost; the vendor recovers with `DeleteUser` (releases the slot, M-R-9) then `CreateUser {firstAdmin: true}` by hand, or control-plane `DeleteTenant` + `CreateTenant` (residual gap, §9) |
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
- **Closed gap (was 3):** the parked password was readable by the shared
  tenant build role, which runs every tenant's script. `AdminPasswordKey`
  (§6.5, ADR-0033) closes it: the build role can encrypt through SSM and
  cannot decrypt. What remains is the deployer's choice of who holds
  `kms:Decrypt`; §10 step 5b checks the build role does not.
- **Closed gap (was the §6.4 single-admin promise):** the first admin is a
  conditional write (M-R-8), not a read-then-write.
- **Cost:** one customer-managed KMS key per account and Region (about
  $1/month) plus a few encrypt calls per tenant.

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
| 4 | tenant-identity `ListUsers(T)` | exactly one user, `admin: true`; `GetTenant(T)` is unchanged (no registry field leaks into the API) |
| 5 | parked parameter exists, type `SecureString`, `KeyId` = `adminPasswordKeyArn` | true; value never printed |
| 5b | `iam simulate-principal-policy` for the control-plane tenant build role, action `kms:Decrypt`, resource `adminPasswordKeyArn` | `implicitDeny` |
| 6 | `IssueToken` for the admin with the parked password | access token whose `tenant_id` claim is `T`. **Needs the test-aid routes deployed** (`IssueToken` is a test aid, tenant-identity ADR-0006, removed by README hardening item 1); the test asserts they exist and fails with a clear message if not |
| 7 | control-plane `UpdateTenant(T)` | `ACTIVE`; still one admin; parameter not re-written (version unchanged) |
| 8 | run `tenant/create.sh` locally a second time with the build's env | exit 0; still one registry row, one admin |
| 9 | tenant-identity `CreateTenant` with an existing `tenantId` | 409, nothing changed |
| 9b | tenant-identity `CreateUser(T) {email: other@example.com, firstAdmin: true}` | 409, no user created; then `CreateUser {admin: true}` for the same email → 201 (a second admin is allowed, a second *first* admin is not); delete it |
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
| tenant-identity: `firstAdmin` slot (ADR-0032) + unit tests | yes | — |
| tenant-identity: `AdminPasswordKey` + parameter (ADR-0033) | yes | — |
| tenant-identity: `PlatformInvokePolicy` + parameter + `threat-model.md` entry, one PR (ADR-0030) | yes | ADR-0033 (key ARN) |
| control-plane: `tenantBuildManagedPolicyArns` (ADR-0022) | yes | — |
| control-plane: `TENANT_NAME` env (ADR-0023) | yes | — |
| tenant-identity: mount scripts + stub unit tests | yes | contracts in §5-§7 only |
| integ test (§10) | no | all of the above |
| README, architecture.md, threat model, diagrams in both samples | no | integ green |
