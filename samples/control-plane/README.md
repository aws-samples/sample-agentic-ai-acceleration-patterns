# The Simple Cell-Based Control Plane

A minimal multi-tenant control plane for **cell-based deployments across
accounts**. A cell is a deployment unit: one **shared application deployment**
plus up to `maxTenants` tenants, each with its **own per-tenant deployment**
inside the cell. Set `maxTenants: 1` and the model degenerates to a silo —
one tenant per cell. Cells live in **registered AWS accounts**: vendor-owned
accounts are fleet capacity with a cell limit, so the fleet scales to a second
account when the first is full; a tenant-owned account is a customer's own,
receives only the tenants that name it, and is reached through a role pair
the customer installs and can revoke. One service, one API (15 operations),
one DynamoDB table, one Step Functions workflow, two shared AWS CodeBuild
projects, one role pair per account.

- Design: [`architecture.md`](./architecture.md)
- Decisions and their reasoning trail: [`adr/`](./adr/) (one file per ADR, indexed in [`adr/README.md`](./adr/README.md))
- Threats and mitigations: [`threat-model.md`](./threat-model.md)
- Working specification the sample was built from: [`design/control-plane.spec.md`](./design/control-plane.spec.md)

## Architecture

![Components: a vendor operator's JWT reaches the control-plane API, which passes a caller context to the tenant service; the service claims a tenant slot and a cell slot atomically and starts the provisioning workflow, which runs the cell build (new cell only) and then the tenant build; each build assumes the provisioning role pair in its account (Account A vendor-owned, or Account B tenant-owned) to write and read that account's SSM namespaces; at registration the tenant service itself probes both roles and discards the credentials; each box names the pattern it carries](./diagrams/control-plane.components.drawio.svg)

A control plane that places tenants into cells across accounts it never
holds credentials for: every account's owner installs one role pair, and
that trust policy is the only thing the builds can act through.

Each box is one component and its pill names the pattern it carries. The API
gates on the vendor IdP's role claim; the tenant service claims a tenant slot
on a cell and, for a new cell, a cell slot on an account, atomically, and
answers 202; the workflow runs the cell build (shared cell deployment) only
for a new cell and then the tenant build (per-tenant deployment); each build
assumes the provisioning role pair installed in the cell's account — the
vendor's own account A or a customer's account B — and the scripts exchange
resource identifiers through that account's SSM namespaces; at registration
the tenant service probes the same pair once and discards the credentials;
the service and the workflow share one single-table record of accounts,
cells, and tenants.

![Architecture: a vendor operator calls API Gateway (the Lambda Authorizer validates the vendor IdP JWT), which invokes the Tenant Service Lambda; the service writes the DynamoDB table of accounts, cells and tenants and starts Step Functions, which runs the cell-scripts and tenant-scripts CodeBuild projects; each project calls sts:AssumeRole (with an external id) into the cell-provisioning or tenant-provisioning role of Account A or Account B, which writes or reads and writes that account's SSM Parameter Store namespaces; the Tenant Service's own role also assumes both roles once at PutAccount as a registration probe](./diagrams/control-plane.drawio.svg)

On the AWS resources the sample deploys: operator JWT -> API Gateway (Lambda
Authorizer) -> Tenant Service -> DynamoDB and, for async operations, Step
Functions -> CodeBuild cell scripts (new cell only) then tenant scripts ->
`sts:AssumeRole` (with the account's external id) into the
`<fleet>-cell-provisioning` or `<fleet>-tenant-provisioning` role of the
cell's account -> that account's SSM Parameter Store namespaces; the workflow
writes the terminal status back to DynamoDB. The dashed line from the Tenant
Service to the same roles is the `PutAccount` registration probe (ADR-027/028):
one `AssumeRole` per half under a deny-all session policy, credentials
discarded.

One service, one API, one DynamoDB table, one state machine, two shared
CodeBuild projects — and in every account that hosts cells, the control plane's
own included, one role pair whose asymmetry enforces the
cell-script/tenant-script permission boundary and whose trust policy the
account owner controls. Diagram source:
[`diagrams/control-plane.drawio`](./diagrams/control-plane.drawio).

## How it works

```
PutAccount (200)   ─► register an account: verify its role pair (handshake),
                      record owner (VENDOR | TENANT) and maxCells
CreateTenant (202) ─► placement: claim a slot in an ACTIVE cell with capacity,
                      or claim a cell slot on an eligible account and create a
                      new cell record there, atomically (implicit creation)
                   ─► Step Functions ─► CodeBuild assumes the account's
                                        provisioning role, runs your cell
                                        create script (new cell only), then
                                        your tenant create script
GetTenant       ◄─ poll until ACTIVE / CREATE_FAILED
```

**Accounts.** Every cell lives in an account an operator registered with
`PutAccount` (ADR-024). A **vendor-owned** account (`owner: VENDOR`) is fleet
capacity: an untargeted `CreateTenant` fills vendor-owned accounts oldest
first, up to each one's `maxCells`, so registering a second account is how
the fleet grows past the first. A **tenant-owned** account (`owner: TENANT`)
is a customer's: placement never chooses it, and a tenant lands there only
when `CreateTenant` names it (`accountId`). When every eligible account is
full, `CreateTenant` fails with `InsufficientCapacityError` (409) and writes
nothing — capacity is an operator decision, never created implicitly. The
control plane's own account is registered the same way.

**The role pair.** Every account that hosts cells — including the control
plane's own — installs two IAM roles, `<fleet>-cell-provisioning` and
`<fleet>-tenant-provisioning` (ADR-025). Each trusts the control plane's
matching build role and its API role, behind an external id (required for a
customer's account, optional for the vendor's own), and carries only the SSM
namespace grants below. The CodeBuild build assumes the
role before your script runs, so the script executes **in** the cell's
account with exactly what that account's owner installed. A customer installs
the pair with the `CellAccountStack` in their own account, registers it (or
has the vendor register it) with the same external id, and can revoke the
control plane at any time by deleting the pair; the control plane holds no
customer credentials, only the account id. `PutAccount` checks the handshake
up front by assuming both roles and discarding the credentials, and proves
the pair enforces a supplied external id by assuming each role once more
without it and requiring a refusal (ADR-027, ADR-030).

Provisioning is defined once, at deployment time, by a **CellDefinition**
(CDK context): a CodeBuild
[`ProjectSource`](https://docs.aws.amazon.com/codebuild/latest/APIReference/API_ProjectSource.html)
(where your provisioning code lives), two script sets — `cellScripts` for the
shared cell deployment and `tenantScripts` for per-tenant deployments — and
`maxTenants`. The definition is stamped onto each cell record at creation, so
cells are homogeneous by construction; tenants carry no source or scripts of
their own. There is no explicit cell-create API — a cell is created
implicitly when onboarding finds no free capacity.

Scripts run in shared CodeBuild projects via per-execution `StartBuild`
overrides, under the cell account's provisioning role. Cell scripts receive
`CELL_ID`, `CELL_ACCOUNT_ID`, `OPERATION`, and `OPERATOR_ID`; tenant scripts
receive `TENANT_ID`, `TENANT_NAME` (the tenant's stored name, on every
operation — ADR-023), `CELL_ID`, `CELL_ACCOUNT_ID`, `OPERATION`,
`OPERATOR_ID`, and (on create) `ADMIN_EMAIL` for application-plane user
bootstrap. All three SSM namespaces live in the cell's account: the cell
create script publishes shared resource identifiers to
`/application-plane/cells/<cellId>/*`; tenant scripts read that namespace
(plus the account's `/application-plane/shared/*`) and write their own state
under `/application-plane/tenants/<tenantId>`.

Every API operation requires a JWT from your **vendor IdP**, validated by a
Lambda Authorizer. The token must carry a `role` claim in the allowed set
(`operator` by default; configurable via the authorizer's `ALLOWED_ROLES`
environment variable) — a token without an allowed role is denied (403), so
configure your IdP to mint `role: "operator"` on operator tokens (ADR-018).
Customer identity is an application plane decision made by
your provisioning scripts, not the control plane.

## Deploy

Prerequisites: an AWS account, Node.js 22+, the [Smithy CLI](https://smithy.io/2.0/guides/smithy-cli/cli_installation.html),
and an OIDC vendor IdP (any issuer with OIDC discovery works — a Cognito user
pool is the quickest to stand up).

Build first (Smithy build, compile, tests and synth), then deploy with the
three required context inputs:

```bash
npm ci
npx projen build
npx cdk deploy \
  --context vendorIdpIssuerUrl=https://YOUR_ISSUER \
  --context vendorIdpAudience=YOUR_AUDIENCE \
  --context cellDefinition='{
    "source": { "type": "GITHUB", "location": "https://github.com/YOUR_ORG/YOUR_REPO.git" },
    "cellScripts": {
      "create": "samples/control-plane/scripts/sample-cell/create.sh",
      "update": "samples/control-plane/scripts/sample-cell/update.sh",
      "delete": "samples/control-plane/scripts/sample-cell/delete.sh"
    },
    "tenantScripts": {
      "create": "samples/control-plane/scripts/sample-tenant/create.sh",
      "update": "samples/control-plane/scripts/sample-tenant/update.sh",
      "delete": "samples/control-plane/scripts/sample-tenant/delete.sh"
    },
    "maxTenants": 10
  }'
```

The `cellDefinition` is validated at synth time and stamped onto every cell
created afterwards; changing it never affects existing cells. The stack also
installs the role pair in its own account, so the next step is to register
that account (the stack's `ControlPlaneAccountId` output is its id):

```bash
API_URL=$(aws ssm get-parameter --name /control-plane/tenant-api-url --query Parameter.Value --output text)
TOKEN="<a JWT from your vendor IdP>"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
curl -s -X PUT "${API_URL}accounts/${ACCOUNT_ID}" \
  -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" \
  -d '{ "owner": "VENDOR", "maxCells": 10 }'
```

Without a registered vendor-owned account, the first `CreateTenant` is a 409
`InsufficientCapacityError` that says so.

### Teardown

Teardown runs the lifecycle backwards through the API, then removes the
stacks. The control plane refuses shortcuts: a cell with tenants, an account
with cells, and an in-flight record are all 409s, so nothing is orphaned in
an account the control plane can no longer reach.

1. `DeleteTenant` every tenant (poll `GetTenant` until 404), then
   `DeleteCell` every cell (poll `GetCell` until 404): the delete scripts run
   in each cell's account and the account's slot is released.
2. `DeleteAccount` every account (`ListAccounts` shows them all at `0/n`).
3. `npx cdk destroy` the control plane stack with the same three context
   inputs you deployed with.
4. In every other account, its owner runs `npx cdk destroy` on the pair
   stack. `DeleteAccount` only deregistered the account on the vendor's side;
   the pair, and the trust it grants, stay until the owner removes them
   (T32).

The sample's DynamoDB table is destroyed with the stack (the hardening
checklist asks for `RETAIN` in a real deployment). The API access log group
may survive the destroy (Known issues); delete it by hand.

### Adding an account

To host cells in another account — a second fleet account, or a customer's —
its owner deploys the **account role pair** there, then an operator registers
it. The role pair stack takes the control plane's account id (the
`ControlPlaneAccountId` stack output), the same `fleetName` (default
`control-plane`), and an external id that the trust policies will then
require. A customer's account must have one: `PutAccount` refuses
`"owner": "TENANT"` without it (ADR-029); a second vendor account may omit it.
It is the standard confused-deputy guard for a role handed to a third party
(ADR-025):

```bash
npx cdk deploy control-plane-cell-account \
  --context cellAccount='{ "controlPlaneAccountId": "<CONTROL_PLANE_ACCOUNT_ID>", "externalId": "<a value the customer chooses>" }'
```

Run that with credentials for the account that will host the cells. That
account needs the same prerequisites as the control plane's (Node.js 22+,
`npm ci`, a CDK bootstrap in the target Region) plus two values from the
vendor: the control plane account id and the fleet name. With
`--context cellAccount` the app synthesizes only this stack (named
`<fleetName>-cell-account`) and needs none of the control plane inputs. The
stack installs `control-plane-cell-provisioning` and
`control-plane-tenant-provisioning` with the SSM namespace grants and nothing
else; the sample cell script also reads a demo
`/application-plane/shared/base-domain` parameter, which
`"demoSharedParameters": true` adds (a real application plane publishes its
own, ADR-010). A customer is running the vendor's CDK app with administrative
rights in their account (T33): review the template with `npx cdk synth
--context cellAccount='{...}'` first, or deploy that synthesized template
directly. Then register the account with the same external id; `PutAccount` fails with a 400
if a tenant-owned account has no external id, and with a 400 naming the role
if the pair is missing, the external id does not match, or the pair was
installed without one and so does not require it:

```bash
curl -s -X PUT "${API_URL}accounts/<ACCOUNT_B_ID>" \
  -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" \
  -d '{ "owner": "TENANT", "maxCells": 1, "externalId": "<the same value>" }'
```

A vendor-owned account (`"owner": "VENDOR"`) joins the fleet and fills
automatically; a tenant-owned one receives only tenants whose `CreateTenant`
carries `"accountId": "<ACCOUNT_B_ID>"`. `fleetName` is the one deployment
input both stacks must agree on; two control planes in one account need
different fleet names because the five role names are physical.

One optional context input, `tenantBuildManagedPolicyArns`, attaches
deployer-supplied customer-managed IAM policies to the tenant provisioning
role of the stack's own account in addition to its SSM grants, so a tenant
script can call an application-plane API with a policy that plane publishes
(ADR-022, ADR-025). Each entry must be a managed-policy ARN in the stack's
own partition and account, or synth fails; the check needs the target account
and Region, which `cdk deploy` supplies through `CDK_DEFAULT_ACCOUNT` /
`CDK_DEFAULT_REGION`, so a non-empty list on an environment-agnostic synth
(for example `cdk synth` with no credentials) also fails rather than
deferring the account check to deploy time. The `cellAccount` context accepts
the same key for another account's tenant provisioning role — the owner of
that account attaches policies there, never the control plane. The same
deploy command with the optional input added:

```bash
npx cdk deploy \
  --context vendorIdpIssuerUrl=https://YOUR_ISSUER \
  --context vendorIdpAudience=YOUR_AUDIENCE \
  --context cellDefinition='{
    "source": { "type": "GITHUB", "location": "https://github.com/YOUR_ORG/YOUR_REPO.git" },
    "cellScripts": {
      "create": "samples/control-plane/scripts/sample-cell/create.sh",
      "update": "samples/control-plane/scripts/sample-cell/update.sh",
      "delete": "samples/control-plane/scripts/sample-cell/delete.sh"
    },
    "tenantScripts": {
      "create": "samples/control-plane/scripts/sample-tenant/create.sh",
      "update": "samples/control-plane/scripts/sample-tenant/update.sh",
      "delete": "samples/control-plane/scripts/sample-tenant/delete.sh"
    },
    "maxTenants": 10
  }' \
  --context tenantBuildManagedPolicyArns='["arn:aws:iam::123456789012:policy/PlatformInvokePolicy"]'
```

### Example: mounting tenant-identity

The [`tenant-identity`](../tenant-identity/) sample is the worked consumer of
both inputs: its control-plane mount runs as the tenant scripts, reads
`TENANT_NAME` to name the tenant it onboards, and is granted the platform API
through a `PlatformInvokePolicy` it publishes and that the deployer passes here
as `tenantBuildManagedPolicyArns`. Deploy steps are in its README,
[Mounting under the control plane](../tenant-identity/README.md#mounting-under-the-control-plane).
The joint integration test
([`scripts/integ-control-plane.sh`](../tenant-identity/scripts/integ-control-plane.sh),
specified in [`design/control-plane-mounting.spec.md`](../tenant-identity/design/control-plane-mounting.spec.md))
deploys this control plane with that wiring and is the reference implementation
for it — read it rather than copying the wiring from prose.

## Deployment integration test

```bash
export AWS_REGION=eu-central-1
export CP_INTEG_ACCOUNT_B=<ACCOUNT_B_ID>
npx projen integ
```

A run takes about 35 minutes across two non-production accounts and costs
well under a dollar in throwaway resources; see
[integration-test.md](./integration-test.md) for the second account's
bootstrap, what the run stands up in each account, its steps and its knobs.

## End-to-end demo

The sample scripts provision a deliberately tiny cell: the cell scripts in
[`scripts/sample-cell/`](./scripts/sample-cell/) publish and clean up the
cell's SSM namespace, and the tenant scripts in
[`scripts/sample-tenant/`](./scripts/sample-tenant/) read it and write one
parameter per tenant. [`scripts/sample-noop/`](./scripts/sample-noop/) is an
explicit no-op set for sides of the model that provision nothing. Host the
scripts in a repo or S3 bucket CodeBuild can reach, reference them in the
`cellDefinition` at deploy time, then:

```bash
API_URL=$(aws ssm get-parameter --name /control-plane/tenant-api-url --query Parameter.Value --output text)
TOKEN="<a JWT from your vendor IdP>"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

# 0. Register this account as vendor-owned fleet capacity (verifies the role
#    pair the stack installed here; 400 if the handshake fails)
curl -s -X PUT "${API_URL}accounts/${ACCOUNT_ID}" \
  -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" \
  -d '{ "owner": "VENDOR", "maxCells": 2 }'
curl -s -H "Authorization: Bearer ${TOKEN}" "${API_URL}accounts"

# 1. Onboard a tenant (202 - no resource definition; placement picks or
#    creates the cell in a vendor-owned account and returns its cellId)
curl -s -X POST "${API_URL}tenants" \
  -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" \
  -d '{
    "name": "acme",
    "adminEmail": "success+acme-admin@simulator.amazonses.com"
  }'

# 1b. Or onboard into a customer's account (registered as TENANT-owned after
#     the customer deployed the role pair there; see "Adding an account")
curl -s -X POST "${API_URL}tenants" \
  -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" \
  -d '{
    "name": "globex",
    "adminEmail": "success+globex-admin@simulator.amazonses.com",
    "accountId": "<ACCOUNT_B_ID>"
  }'

# 2. Poll until ACTIVE (or CREATE_FAILED - statusReason and lastBuildId tell you why)
curl -s -H "Authorization: Bearer ${TOKEN}" "${API_URL}tenants/${TENANT_ID}"

# 3. Inspect the fleet: the implicitly created cell, its account and its
#    stamped definition; the accounts' occupancy
curl -s -H "Authorization: Bearer ${TOKEN}" "${API_URL}cells"
curl -s -H "Authorization: Bearer ${TOKEN}" "${API_URL}cells/${CELL_ID}"
curl -s -H "Authorization: Bearer ${TOKEN}" "${API_URL}accounts/${ACCOUNT_ID}"

# 4. The provisioned deployments (in the cell's account)
aws ssm get-parameters-by-path --path "/application-plane/cells/${CELL_ID}"
aws ssm get-parameter --name "/application-plane/tenants/${TENANT_ID}"

# 5. Re-apply the tenant deployment (runs the tenant update script)
curl -s -X PUT -H "Authorization: Bearer ${TOKEN}" "${API_URL}tenants/${TENANT_ID}/resource"

# 6. Re-apply the shared cell deployment (runs the cell update script)
curl -s -X PUT -H "Authorization: Bearer ${TOKEN}" "${API_URL}cells/${CELL_ID}"

# 7. Offboard the tenant (runs the tenant delete script, frees the slot)
curl -s -X DELETE -H "Authorization: Bearer ${TOKEN}" "${API_URL}tenants/${TENANT_ID}"

# 8. Deprovision the now-empty cell (runs the cell delete script, frees the
#    account's cell slot; 409 while occupied)
curl -s -X DELETE -H "Authorization: Bearer ${TOKEN}" "${API_URL}cells/${CELL_ID}"

# 9. Deregister the now-empty account (409 while it holds cells)
curl -s -X DELETE -H "Authorization: Bearer ${TOKEN}" "${API_URL}accounts/${ACCOUNT_ID}"
```

## API

| Operation | HTTP | Returns |
|---|---|---|
| CreateTenant | `POST /tenants` | 202 — placement + tenant create build (cell create build first if a new cell is needed); optional `accountId` pins the account; 409 `InsufficientCapacityError` when no eligible account has room |
| GetTenant | `GET /tenants/{tenantId}` | 200 — the polling endpoint (includes `cellId`) |
| UpdateTenant | `PUT /tenants/{tenantId}` | 200 — metadata only, no build |
| DeleteTenant | `DELETE /tenants/{tenantId}` | 202 — runs the tenant delete script, frees the slot |
| ListTenants | `GET /tenants[?cellId=]` | 200 — paginated, optional per-cell filter |
| GetResource | `GET /tenants/{tenantId}/resource` | 200 — effective definition (from the cell) + build state |
| UpdateResource | `PUT /tenants/{tenantId}/resource` | 202 — runs the tenant update script |
| ListCells | `GET /cells[?accountId=]` | 200 — fleet topology: `accountId`, status, `tenantCount`/`maxTenants`; optional per-account filter |
| GetCell | `GET /cells/{cellId}` | 200 — full record including the account and the stamped definition |
| UpdateCell | `PUT /cells/{cellId}` | 202 — runs the cell update script |
| DeleteCell | `DELETE /cells/{cellId}` | 202 — empty cells only (409 while occupied); frees the account's cell slot |
| PutAccount | `PUT /accounts/{accountId}` | 200 — register or replace `maxCells`, `externalId` (required for `TENANT`); `owner` is set on first write and immutable (409 on change); verifies the role pair first (400 if not assumable) |
| GetAccount | `GET /accounts/{accountId}` | 200 — `owner`, `cellCount`/`maxCells`, whether an external id is set |
| ListAccounts | `GET /accounts` | 200 — the capacity view above `ListCells` |
| DeleteAccount | `DELETE /accounts/{accountId}` | 200 — empty accounts only (409 while it holds cells) |

Fifteen operations; there is deliberately no `POST /cells` — cells are created
implicitly by tenant placement — and no implicit account registration.
`CreateTenant` accepts an optional
`clientToken` for retry safety: resending the same token returns the
originally onboarded tenant instead of creating a duplicate (reuse with
different parameters is rejected with a 409). The API contract is the Smithy
model in [`model/`](./model/) — the OpenAPI spec and TypeScript server SDK
are generated from it (`smithy build`).

## Security notes

- The **account role pair** in each account is the provisioning blast radius
  — it bounds what lifecycle scripts may do there, and its asymmetry is the
  boundary: the cell role writes `/application-plane/cells/*`; the tenant
  role reads that namespace but can only write `/application-plane/tenants/*`.
  The sample scopes both to the demo SSM namespaces; the account owner widens
  them deliberately for real provisioning (this is THE hardening point). The
  CodeBuild roles themselves hold nothing but `sts:AssumeRole` on those two
  role names, so the owner's trust policy — not a vendor-side list — decides
  which accounts the fleet can reach (ADR-025).
- The pair's trust policy names the control plane's build roles and API role
  by ARN; that pin is what keeps every other AWS account out. On top of it a
  tenant-owned account must carry an **external id** on every `AssumeRole`
  (`PutAccount` refuses one without it, ADR-029, and refuses a pair that
  admits the call without it, ADR-030): the standard guard for a
  role handed to a third party, so registering a customer's account needs a
  value only that customer handed out (T22, M19). The external id gates
  registration only; it is never returned by the API or logged by the
  sample, but it is readable by anyone who can read the build's environment
  overrides (T28). Rotate it by redeploying the pair and re-running
  `PutAccount`.
- Every `AssumeRole` into an account uses the operator's id as the session
  name, so the account owner's CloudTrail attributes each provisioning call
  to the operator who caused it (M23). Role chaining caps a script's
  credentials at one hour, which is also the build task budget.
- Private source repos need a CodeConnections/credentials setup on the
  CodeBuild projects; the sample assumes a public repo or an S3 source.
- The Lambda Authorizer result is cached for an explicit 60 seconds (not the
  implicit 300s default): the cached policy covers the whole stage per token,
  so the TTL bounds how long a revoked or expired token keeps access — a
  deliberate trade of cache hit rate for a tighter revocation window.
- The API stage is throttled (20 rps rate / 40 burst): operations that start
  CodeBuild builds make a leaked token a cost-amplification vector, so the
  sample caps request rates explicitly.
- The table is `RemovalPolicy.DESTROY` for easy cleanup — a real control
  plane retains its tenant registry.

## Production hardening checklist

The sample authenticates every operation but deliberately has no
per-operation authorization: any valid token from the configured issuer is
full admin (see the identity model in
[`architecture.md`](./architecture.md) and ADR-015 in
[`adr/0015-authentication-only-gating.md`](./adr/0015-authentication-only-gating.md)). That makes the issuer
configuration and the API edge the two controls a deployer must get right.
These items are operational — IdP-side, repository-side, and edge — and map
to threats T1 (stolen
operator token), T2 (issuer misconfiguration), T5 (poisoned provisioning
source), T20 (over-broad issuer population), and the cross-account items
T22, T23, T26, T27, and mitigations M9, M10, M11, M19, M20 in
[`threat-model.md`](./threat-model.md).

### Identity (M9)

- [ ] Use a **dedicated control-plane issuer**. It must issue tokens
      exclusively to fully privileged vendor operators — verify that no
      other application reuses its clients or its audience value.
- [ ] Verify at deployment time that `vendorIdpIssuerUrl` and
      `vendorIdpAudience` point at that dedicated issuer, not a general
      workforce or customer issuer. This is the T2 failure mode: pointing
      the authorizer at a broader issuer grants every member of that
      population full admin over the tenant fleet.
- [ ] Configure **short-lived access tokens** on the issuer. Token lifetime
      plus the 60-second authorizer cache bounds how long a stolen token
      keeps access.
- [ ] Require **MFA for all operators** on the issuer.
- [ ] **Periodically review the issuer's client registrations** — every
      registered client is an operator-grade credential; remove clients
      that are no longer needed.

### Supply-chain hardening (M10)

The CellDefinition names a git source that CodeBuild fetches fresh on every
lifecycle build and executes under the fleet roles — a poisoned commit is
arbitrary code execution across the fleet (threat T5, the highest-consequence
open item).

- [ ] **Pin the CellDefinition source to a full 40-character commit SHA** via
      `source.sourceVersion`. Synthesis warns when the ref is absent or
      mutable (branch or tag); a commit SHA is the only immutable git ref.
- [ ] Enable **branch protection with mandatory review** on the provisioning
      repository — no direct pushes to the ref the fleet builds from.
- [ ] Require **commit/tag signing** on the provisioning repository and
      verify signatures in your release process before updating the pinned
      SHA.
- [ ] Use **read-only, narrowly scoped deploy credentials** for CodeBuild's
      source access (CodeConnections / deploy key limited to the one
      repository) — the build must never hold credentials that can push.
- [ ] Treat a CellDefinition change (including the pinned SHA) as a
      **deployment**: review, roll out, and be ready to roll back like any
      other release artifact.

### Edge protection (M11)

- [ ] Attach an **AWS WAF web ACL** to the REST API stage, with rate-based
      rules and the IP reputation managed rule group.
- [ ] Add **per-method throttling via usage plans**, sized to real operator
      traffic. The sample's stage-wide 20 rps / 40 burst limit is a
      starting point; operator traffic on a control plane is low-volume,
      so tighter per-method limits on the build-starting operations
      (`POST /tenants`, the `PUT`/`DELETE` operations) further cap the
      cost amplification a leaked token can cause.
- [ ] **Review every policy in `tenantBuildManagedPolicyArns`.** The tenant
      provisioning role runs every tenant script in its account, so an
      attached policy widens all of them. Attach only a least-privilege
      policy the producing plane publishes, never a hand-written wildcard
      (T21, M18, ADR-022).
- [ ] Optionally, add an **API Gateway resource policy** restricting source
      IPs to vendor operator networks, so a stolen token alone is not
      sufficient to reach the API.

### Accounts (M19, M20)

- [ ] **Hand each tenant-owned account's external id to the operator out of
      band** (the pair and `PutAccount` both require it, T22), and treat the
      Step Functions history and CodeBuild build details as holding it (T28).
- [ ] For a fleet that never leaves the vendor's organisation, add an
      **`aws:ResourceOrgID` condition** to the build roles' and API role's
      `sts:AssumeRole` statements so the role-name wildcard cannot reach an
      account outside the organisation (T23).
- [ ] **Any operator may target any registered account** (T27): the sample
      has one fully privileged operator population. Before a broader
      population connects, add per-operation authorization with account
      scoping so an operator for customer A cannot place into customer B's
      account.
- [ ] If an owner removes the pair while cells exist there, builds in that
      account fail into `*_FAILED` and the records cannot be cleaned up
      through the API until the pair is restored (T26, accepted by design).
      Agree the revocation procedure with the customer: restore the pair for
      cleanup, or accept manual record repair.
- [ ] **Choose a fleet name the vendor owns** (`fleetName`, not the default
      `control-plane`) for any fleet that registers accounts outside the
      vendor's own: the five role names and the pair stack's name are
      physical, and a name already taken in a customer's account fails the
      install or, worse, names someone else's pair (T31; the handshake
      refuses a pair that trusts another control plane).
- [ ] **Tell customers that removing the pair is their act.** `DeleteAccount`
      deregisters the account on the vendor's side only; the trust the pair
      grants stays until the owner destroys the pair stack, including after
      the control plane itself is gone (T32).
- [ ] **Offer customers the synthesized template**, not only the CDK app:
      installing the pair runs vendor code with administrative rights in the
      customer's account (T33). `npx cdk synth --context cellAccount='{...}'`
      produces a two-role template a customer can review and deploy directly.

## Known issues

- **The API access log group can reappear after teardown.** API Gateway
  writes the stage's access logs asynchronously, so a write can land just
  after CloudFormation has deleted the log group during `cdk destroy`, and
  that late write recreates the group — left behind with no retention. The
  `tenant-identity` sample hit the same race and solved it with a log drain
  whose writers are what invoke the functions (its ADR-0024); this sample
  does not drain its log groups. After a teardown, look for a log group named
  `control-plane-dev-ApiAccessLogs...` (the CDK-generated name of
  `ApiAccessLogs` in `src/tenant/tenant.cdk.ts`) and delete it.
- **The integration test's harness leaves default Lambda log groups.** The
  sample's own functions write to explicit log groups the stack owns, so a
  teardown removes them. The test-only functions do not: the setup stack's
  CDK custom resources (bucket deployment, auto-delete), its operator-minting
  and SSM-probe functions, and integ-runner's assertion provider let Lambda
  create `/aws/lambda/control-plane-integ-setup-*` and
  `/aws/lambda/ControlPlaneIntegDefaultTest*` groups on first invoke, which
  `cdk destroy` does not know about. Delete them after a run (`aws logs
  describe-log-groups --log-group-name-prefix /aws/lambda/control-plane-integ-setup`
  and the same for `ControlPlaneIntegDefaultTest`); they hold test output
  only.
