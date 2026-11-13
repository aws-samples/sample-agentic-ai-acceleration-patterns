# The Cell-Based Control Plane

A control plane that deploys a vendor's applications for tenants into cells
across either the vendor's or the customer's AWS accounts. An
**application** is registered through the API: a source, the scripts that
deploy it, and how many tenants share one deployment. A **tenant** is a
customer; each application it uses is a **deployment**, placed into a cell of
that application. A cell is one **shared application deployment** plus up to
`maxTenants` deployments, each a tenant's **own per-tenant deployment**
inside the cell; `maxTenants: 1` yields dedicated tenant cells. Accounts are
**registered through the API** too: a vendor account holds one to many cells
up to a cell limit, may be shared by every application or dedicated to some,
and when every vendor account an application may use is full the fleet moves
on to the next registered one; a customer account receives only the
deployments that name it. Each account is reached through a role pair
installed in that account, which the account owner can revoke. One service,
one API (22 operations), one DynamoDB table, one Step Functions workflow, two
shared AWS CodeBuild projects, one role pair per account — for any number of
applications.

- Design: [`architecture.md`](./architecture.md)
- Decisions and their reasoning trail: [`adr/`](./adr/) (one file per ADR, indexed in [`adr/README.md`](./adr/README.md))
- Threats and mitigations: [`threat-model.md`](./threat-model.md)
- Working specification the sample was built from: [`design/control-plane.spec.md`](./design/control-plane.spec.md)

## Architecture

![Components: a vendor operator's JWT reaches the control-plane API, which passes a caller context to the tenant service; the service claims a tenant slot and a cell slot atomically and starts the provisioning workflow, which runs the cell build (new cell only) and then the tenant build; each build assumes the provisioning role pair in its account (Account A vendor-owned, or Account B tenant-owned) to write and read that account's SSM namespaces; at registration the tenant service itself probes both roles and discards the credentials; each box names the pattern it carries](./diagrams/control-plane.components.drawio.svg)

A control plane that places deployments into cells across accounts it never
holds credentials for: every account's owner installs one role pair, and
that trust policy is the only thing the builds can act through.

![Architecture: a vendor operator calls API Gateway (the Lambda Authorizer validates the vendor IdP JWT), which invokes the Tenant Service Lambda; the service writes the DynamoDB table of accounts, cells and tenants and starts Step Functions, which runs the cell-scripts and tenant-scripts CodeBuild projects; each project calls sts:AssumeRole (with an external id) into the cell-provisioning or tenant-provisioning role of Account A or Account B, which writes or reads and writes that account's SSM Parameter Store namespaces; the Tenant Service's own role also assumes both roles once at PutAccount as a registration probe](./diagrams/control-plane.drawio.svg)

What a cell runs comes from its **application**, registered with
`PutApplication`: a CodeBuild source (`type`, `location`, optional
`sourceVersion`), two script sets, `cellScripts` and `tenantScripts`, each
with `create`, `update` and `delete`, `maxTenants`, a
`placementStrategy` (`FILL` or `ROUND_ROBIN`), and optionally the
parameters its scripts take: `parameters` for tenant scripts and
`cellParameters` for cell scripts (ADR-039, ADR-040). Lifecycle operations run the
matching script: `CreateDeployment` runs cell create (new cell only) then
tenant create, `UpdateCell` and `UpdateDeployment` run the update scripts,
`DeleteCell` and `DeleteDeployment` the delete scripts. A full commit SHA in
`sourceVersion` pins the source; a branch or tag is accepted and
`PutApplication` logs a warning. The definition is stamped onto each cell at
creation, so a replaced definition applies to new cells only and existing
cells keep their version. One control plane serves any number of
applications: their cells share the registered accounts, each account's role
pair and the two build projects. Diagram source:
[`diagrams/control-plane.drawio`](./diagrams/control-plane.drawio).

## How it works

```
PutApplication (200)   ─► register an application: source, cell and tenant
                          scripts, maxTenants, placementStrategy
PutAccount (200)       ─► register an account: verify its role pair (handshake),
                          record owner (VENDOR | TENANT), maxCells and the
                          applications it admits
CreateTenant (200)     ─► record a customer; nothing is provisioned
CreateDeployment (202) ─► placement: claim a slot in an ACTIVE cell of the
                          application with capacity, or claim a cell slot on an
                          eligible account and create a new cell record there,
                          atomically (implicit creation)
                       ─► Step Functions ─► CodeBuild assumes the account's
                                            provisioning role, runs the
                                            application's cell create script
                                            (new cell only), then its tenant
                                            create script
GetDeployment        ◄─ poll until ACTIVE / CREATE_FAILED
```

**Applications.** An application is registered with `PutApplication`
(ADR-032) and owns the definition every one of its cells is stamped from,
plus the authoritative count of those cells. Neither the definition nor the
application list is a deployment input: a new application needs no
redeploy. An application with cells cannot be deleted (409).

**Parameters.** An application declares the values its scripts take per
deployment or per cell. A tenant parameter is `{name, required, default?,
description?}`; a cell parameter is `{name, default, description?}` and
always has a default, because placement creates cells with no operator
present. Names are upper case (`[A-Z][A-Z0-9_]{0,63}`), at most 20 per list,
and a name appears in one list only. `CreateDeployment` and
`UpdateDeployment` take `parameters` for the deployment, `UpdateCell` for
the cell; the values are checked against the declarations (an undeclared
name, a missing required value, a value over 1,024 bytes or holding a
control character is a 400) and stored on the record. Every build of that
record gets each stored value, plus the default of each declared name
without one, as `PARAM_<NAME>`. Defaults are resolved per build and never
stored, so a changed default reaches existing deployments and cells on
their next build. Values are plain text, readable in the table, the
workflow history and the build's environment: never put a secret there;
pass a secret's name and let the script read it (spec N-11).

**Tenants and deployments.** A tenant (`CreateTenant`) is a customer record:
a name, a description, and the count of its deployments. Its operations are
synchronous. A **deployment** (`CreateDeployment` on
`/tenants/{tenantId}/deployments`) is that tenant in one application,
addressed by tenant and application id; it owns the cell placement and the
build state (ADR-037). A tenant has at most one deployment per application
(a second is a 409), and a tenant with deployments cannot be deleted (409).

**Accounts.** Every cell lives in an account an operator registered with
`PutAccount` (ADR-024). A **vendor-owned** account (`owner: VENDOR`) is fleet
capacity: an untargeted `CreateDeployment` places into vendor-owned accounts
that admit the application, up to each one's `maxCells`, so registering a
second account is how the fleet grows past the first. An account without
`applicationIds` is **shared** and admits every application; one with
`applicationIds` is **dedicated** to those (ADR-033). New cells go to
dedicated accounts before shared ones (ADR-035); inside each group the
application's `placementStrategy` decides: `FILL` fills the oldest registered
account first, `ROUND_ROBIN` picks the one with the fewest cells (ADR-036). A
**tenant-owned** account (`owner: TENANT`) is a customer's: placement never
chooses it, and a deployment lands there only when `CreateDeployment` names
it (`accountId`); naming an account that does not admit the application is a
400. When every eligible account is full, `CreateDeployment` fails with
`InsufficientCapacityError` (409) and writes nothing — capacity is an
operator decision, never created implicitly. The control plane's own account
is registered the same way.

**The role pair.** Every account that hosts cells — including the control
plane's own — installs two IAM roles, `<fleet>-cell-provisioning` and
`<fleet>-tenant-provisioning` (ADR-025). Each trusts the control plane's
matching build role and its API role, behind an external id (required for a
customer's account, optional for the vendor's own), and carries only the SSM
namespace grants below. The CodeBuild build assumes the
role before your script runs, so the script executes **in** the cell's
account with exactly what that account's owner installed. One pair serves
every application the account admits. A customer installs
the pair with the `CellAccountStack` in their own account, registers it (or
has the vendor register it) with the same external id, and can revoke the
control plane at any time by deleting the pair; the control plane holds no
customer credentials, only the account id. `PutAccount` checks the handshake
up front by assuming both roles and discarding the credentials, and proves
the pair enforces a supplied external id by assuming each role once more
without it and requiring a refusal (ADR-027, ADR-030).

Cells are homogeneous by construction per application: tenants and
deployments carry no source or scripts of their own, and a deployment is only
ever placed into a cell of its own application. There is no explicit
cell-create API — a cell is created implicitly when a deployment finds no
free capacity among its application's cells.

Scripts run in shared CodeBuild projects via per-execution `StartBuild`
overrides, under the cell account's provisioning role. Cell scripts receive
`APPLICATION_ID`, `CELL_ID`, `CELL_ACCOUNT_ID`, `OPERATION`, and
`OPERATOR_ID`; tenant scripts receive `TENANT_ID` (the same id in every
application the tenant uses), `TENANT_NAME` (the tenant's stored name, on
every operation — ADR-023), `APPLICATION_ID`, `CELL_ID`, `CELL_ACCOUNT_ID`,
`OPERATION`, `OPERATOR_ID`, and (on create) `ADMIN_EMAIL` for
application-plane user bootstrap. Each script also gets `PARAM_<NAME>` for
its own set only: cell scripts the cell's parameters, tenant scripts the
deployment's; a declared name with neither a value nor a default is unset,
not empty. All four SSM namespaces live in the cell's
account: both script sets read the account-wide `/application-plane/shared/*`
(infrastructure every application in the account may use, such as an
identity platform) and their application's
`/application-plane/applications/<applicationId>/shared/*` (ADR-034, ADR-038);
the cell create script publishes shared resource identifiers to
`/application-plane/cells/<cellId>/*`; tenant scripts read that namespace and
write their own state under
`/application-plane/tenants/<tenantId>/<applicationId>/*` (ADR-037).

Every API operation requires a JWT from your **vendor IdP**, validated by a
Lambda Authorizer. The token's `role` claim decides what the caller may do
(spec R-36): a value in `allowedRoles` (`operator` by default) holds every
operation, and a value in `readerRoles` (none by default) holds the ten
`GET` operations only. A token whose role is in neither list is denied
(403), so configure your IdP to mint `role: "operator"` on operator tokens
(ADR-018) and your reader value on reader tokens (ADR-042).
Customer identity is an application plane decision made by
your provisioning scripts, not the control plane.

## Deploy

Prerequisites: an AWS account, Node.js 22+, the [Smithy CLI](https://smithy.io/2.0/guides/smithy-cli/cli_installation.html),
`jq` for the demo below, and an OIDC vendor IdP (any issuer with OIDC
discovery works — a Cognito user pool is the quickest to stand up).

Build first (Smithy build, compile, tests and synth), then deploy with the
two required context inputs. The optional `demoApplicationIds` publishes, in
the stack's own account, the demo shared parameter
`/application-plane/applications/<applicationId>/shared/base-domain` that the
sample cell script reads, once per listed application id (a real application
plane publishes its own, ADR-010):

```bash
npm ci
npx projen build
npx cdk deploy \
  --context vendorIdpIssuerUrl=https://YOUR_ISSUER \
  --context vendorIdpAudience=YOUR_AUDIENCE \
  --context demoApplicationIds='["demo"]'
```

The stack carries no application: register one after the deploy with
`PutApplication`. The definition is validated by the API (400 on a missing
script path, `maxTenants` below one, or an id outside `[a-z0-9-]{1,32}`) and
stamped onto every cell of the application created afterwards; replacing it
never affects existing cells.

```bash
API_URL=$(aws ssm get-parameter --name /control-plane/tenant-api-url --query Parameter.Value --output text)
TOKEN="<a JWT from your vendor IdP>"
curl -s -X PUT "${API_URL}applications/demo" \
  -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" \
  -d '{
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
    "maxTenants": 10,
    "placementStrategy": "FILL"
  }'
```

The stack also installs the role pair in its own account, so the next step
is to register that account (the stack's `ControlPlaneAccountId` output is
its id). Without `applicationIds` the account is shared and admits every
application:

```bash
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
curl -s -X PUT "${API_URL}accounts/${ACCOUNT_ID}" \
  -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" \
  -d '{ "owner": "VENDOR", "maxCells": 10 }'
```

Without a registered vendor-owned account that admits the application, the
first `CreateDeployment` is a 409 `InsufficientCapacityError` that says so.

### Teardown

Teardown runs the lifecycle backwards through the API, then removes the
stacks. The control plane refuses shortcuts: a tenant with deployments, a
cell with deployments, an account with cells, an application with cells, and
an in-flight record are all 409s, so nothing is orphaned in an account the
control plane can no longer reach.

1. `DeleteDeployment` every deployment (poll `GetDeployment` until 404), then
   `DeleteCell` every cell (poll `GetCell` until 404): the delete scripts run
   in each cell's account and the account's and application's cell slots are
   released.
2. `DeleteTenant` every tenant, `DeleteAccount` every account
   (`ListAccounts` shows them all at `0/n`), and `DeleteApplication` every
   application (`ListApplications` shows `cellCount` 0).
3. `npx cdk destroy` the control plane stack with the same context inputs
   you deployed with.
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
`/application-plane/applications/<applicationId>/shared/base-domain`
parameter, which `"demoApplicationIds": ["demo"]` inside the `cellAccount`
value adds for each listed application (a real application plane publishes
its own, ADR-010). A customer is running the vendor's CDK app with
administrative rights in their account (T33): review the template with
`npx cdk synth --context cellAccount='{...}'` first, or deploy that
synthesized template directly. Then register the account with the same
external id; `PutAccount` fails with a 400 if a tenant-owned account has no
external id, with a 404 if `applicationIds` names an unregistered
application, and with a 400 naming the role if the pair is missing, the
external id does not match, or the pair was installed without one and so
does not require it:

```bash
curl -s -X PUT "${API_URL}accounts/<ACCOUNT_B_ID>" \
  -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" \
  -d '{ "owner": "TENANT", "maxCells": 1, "externalId": "<the same value>", "applicationIds": ["demo"] }'
```

A vendor-owned account (`"owner": "VENDOR"`) joins the fleet and fills
automatically for the applications it admits; a tenant-owned one receives
only deployments whose `CreateDeployment` carries
`"accountId": "<ACCOUNT_B_ID>"` and names an application it admits. Leave
`applicationIds` out to admit every application; re-run `PutAccount` to
change the list (existing cells stay). `fleetName` is the one deployment
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
  --context demoApplicationIds='["demo"]' \
  --context tenantBuildManagedPolicyArns='["arn:aws:iam::123456789012:policy/PlatformInvokePolicy"]'
```

Two optional context inputs choose which `role` claim values the authorizer
admits and what each may do (spec R-36, ADR-042). `allowedRoles` (default
`["operator"]`) gets every operation. `readerRoles` (default none) gets the
ten `GET` operations and nothing else, for a system that only looks
placement up, such as a route registrar or a dashboard. Use a namespaced
reader value, not a word a broader issuer may already mint. A value in both
lists, or outside `[A-Za-z0-9:._-]{1,64}`, fails synth:

```bash
npx cdk deploy \
  --context vendorIdpIssuerUrl=https://YOUR_ISSUER \
  --context vendorIdpAudience=YOUR_AUDIENCE \
  --context readerRoles='["control-plane:reader"]'
```

### Example: mounting tenant-identity

The [`tenant-identity`](../tenant-identity/) sample is the worked consumer of
`TENANT_NAME` and `tenantBuildManagedPolicyArns`: its control-plane mount
runs as the tenant scripts, reads `TENANT_NAME` to name the tenant it
onboards, and is granted the platform API through a `PlatformInvokePolicy` it
publishes and that the deployer passes here as
`tenantBuildManagedPolicyArns`. Deploy steps are in its README,
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

A run takes about 55 minutes across two non-production accounts and two
applications and costs well under a dollar in throwaway resources; see
[integration-test.md](./integration-test.md) for the second account's
bootstrap, what the run stands up in each account, its steps and its knobs.

## End-to-end demo

The sample scripts provision a deliberately tiny cell: the cell scripts in
[`scripts/sample-cell/`](./scripts/sample-cell/) read their application's
shared parameter, then publish and clean up the cell's SSM namespace, and the
tenant scripts in [`scripts/sample-tenant/`](./scripts/sample-tenant/) read it
and write one parameter per deployment.
[`scripts/sample-noop/`](./scripts/sample-noop/) is an explicit no-op set for
sides of the model that provision nothing. Host the scripts in a repo or S3
bucket CodeBuild can reach and deploy with `demoApplicationIds` naming the
application id used below (`demo`), as in Deploy.

Set the API URL, an operator token and the home account id:

```bash
API_URL=$(aws ssm get-parameter --name /control-plane/tenant-api-url --query Parameter.Value --output text)
TOKEN="<a JWT from your vendor IdP>"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
```

Register the application. Its definition is the only place the source and
scripts are named; `maxTenants: 2` lets two tenants share one cell:

```bash
curl -s -X PUT "${API_URL}applications/demo" \
  -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" \
  -d '{
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
    "maxTenants": 2
  }'
```

Register this account as vendor-owned, shared fleet capacity. The call
verifies the role pair the stack installed here and answers 400 if the
handshake fails:

```bash
curl -s -X PUT "${API_URL}accounts/${ACCOUNT_ID}" \
  -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" \
  -d '{ "owner": "VENDOR", "maxCells": 2 }'
curl -s -H "Authorization: Bearer ${TOKEN}" "${API_URL}accounts"
```

Create the tenant. This is a synchronous 200 that records the customer and
provisions nothing:

```bash
TENANT_ID=$(curl -s -X POST "${API_URL}tenants" \
  -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" \
  -d '{ "name": "acme", "description": "demo tenant" }' | jq -r .tenant.tenantId)
echo "${TENANT_ID}"
```

Create the tenant's deployment of `demo`. The 202 response carries no
resource definition; placement picks or creates a cell of `demo` in a
vendor-owned account that admits it and returns its `cellId`. Adding
`"accountId": "<ACCOUNT_B_ID>"` places it into a customer's account instead
(registered as tenant-owned after the customer deployed the role pair there;
see "Adding an account"), and a `"clientToken"` makes a retry return the same
deployment:

```bash
CELL_ID=$(curl -s -X POST "${API_URL}tenants/${TENANT_ID}/deployments" \
  -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" \
  -d '{
    "applicationId": "demo",
    "adminEmail": "success+acme-admin@simulator.amazonses.com",
    "clientToken": "acme-demo-1"
  }' | jq -r .deployment.cellId)
echo "${CELL_ID}"
```

Poll the deployment until `status` is `ACTIVE`, or `CREATE_FAILED`, in which
case `statusReason` and `lastBuildId` say why. A new cell runs two builds, so
expect a few minutes:

```bash
curl -s -H "Authorization: Bearer ${TOKEN}" "${API_URL}tenants/${TENANT_ID}/deployments/demo"
```

Inspect the result: the tenant's deployment count, its deployments, the
implicitly created cell with its application, account and stamped
definition, the fleet, and the counters on the account and the application:

```bash
curl -s -H "Authorization: Bearer ${TOKEN}" "${API_URL}tenants/${TENANT_ID}"
curl -s -H "Authorization: Bearer ${TOKEN}" "${API_URL}deployments?tenantId=${TENANT_ID}"
curl -s -H "Authorization: Bearer ${TOKEN}" "${API_URL}cells/${CELL_ID}"
curl -s -H "Authorization: Bearer ${TOKEN}" "${API_URL}cells?applicationId=demo"
curl -s -H "Authorization: Bearer ${TOKEN}" "${API_URL}accounts/${ACCOUNT_ID}"
curl -s -H "Authorization: Bearer ${TOKEN}" "${API_URL}applications/demo"
```

The provisioned deployments are SSM parameters in the cell's account:

```bash
aws ssm get-parameters-by-path --path "/application-plane/cells/${CELL_ID}"
aws ssm get-parameter --name "/application-plane/tenants/${TENANT_ID}/demo"
```

Re-apply the deployment. The 202 runs the tenant update script; repeat the
`GetDeployment` call until the status is back at `ACTIVE`:

```bash
curl -s -X PUT -H "Authorization: Bearer ${TOKEN}" "${API_URL}tenants/${TENANT_ID}/deployments/demo"
curl -s -H "Authorization: Bearer ${TOKEN}" "${API_URL}tenants/${TENANT_ID}/deployments/demo"
```

Re-apply the shared cell deployment. The 202 runs the cell update script;
repeat the `GetCell` call until the status is back at `ACTIVE`:

```bash
curl -s -X PUT -H "Authorization: Bearer ${TOKEN}" "${API_URL}cells/${CELL_ID}"
curl -s -H "Authorization: Bearer ${TOKEN}" "${API_URL}cells/${CELL_ID}"
```

Delete in reverse order. First the deployment: the 202 runs the tenant
delete script and frees the cell slot and the tenant's count; poll until
`GetDeployment` answers 404:

```bash
curl -s -X DELETE -H "Authorization: Bearer ${TOKEN}" "${API_URL}tenants/${TENANT_ID}/deployments/demo"
curl -s -H "Authorization: Bearer ${TOKEN}" "${API_URL}tenants/${TENANT_ID}/deployments/demo"
```

Then the now-empty cell, which persists until it is deleted (409 while
occupied). The 202 runs the cell delete script and frees the account's cell
slot and the application's count; poll until `GetCell` answers 404:

```bash
curl -s -X DELETE -H "Authorization: Bearer ${TOKEN}" "${API_URL}cells/${CELL_ID}"
curl -s -H "Authorization: Bearer ${TOKEN}" "${API_URL}cells/${CELL_ID}"
```

Finally the tenant, the account and the application, each a synchronous 200
that is a 409 while it still has deployments or cells:

```bash
curl -s -X DELETE -H "Authorization: Bearer ${TOKEN}" "${API_URL}tenants/${TENANT_ID}"
curl -s -X DELETE -H "Authorization: Bearer ${TOKEN}" "${API_URL}accounts/${ACCOUNT_ID}"
curl -s -X DELETE -H "Authorization: Bearer ${TOKEN}" "${API_URL}applications/demo"
```

## API

| Operation | HTTP | Returns |
|---|---|---|
| PutApplication | `PUT /applications/{applicationId}` | 200 — register or replace the definition (`source`, `cellScripts`, `tenantScripts`, `maxTenants`), `placementStrategy` and the declarations `parameters` and `cellParameters`; an absent list keeps the current one, `[]` clears it; 400 on an invalid definition or declaration; 409 when a kept list changed during the call (retry); existing cells keep their stamp |
| GetApplication | `GET /applications/{applicationId}` | 200 — the definition, `placementStrategy`, `parameters`, `cellParameters`, `cellCount` |
| ListApplications | `GET /applications` | 200 — paginated: `maxTenants`, `placementStrategy`, `cellCount` per application |
| DeleteApplication | `DELETE /applications/{applicationId}` | 200 — empty applications only (409 while it has cells) |
| CreateTenant | `POST /tenants` | 200 — a customer record (`name`, `description`), nothing provisioned |
| GetTenant | `GET /tenants/{tenantId}` | 200 — `name`, `description`, `deploymentCount` |
| UpdateTenant | `PUT /tenants/{tenantId}` | 200 — metadata only, no build |
| DeleteTenant | `DELETE /tenants/{tenantId}` | 200 — empty tenants only (409 while it has deployments) |
| ListTenants | `GET /tenants` | 200 — paginated |
| CreateDeployment | `POST /tenants/{tenantId}/deployments` | 202 — placement into a cell of `applicationId` + tenant create build (cell create build first if a new cell is needed); optional `parameters` (400 on an undeclared name, a bad value or a missing required one, before placement); optional `accountId` pins the account (400 if it does not admit the application); optional `clientToken`; 409 when the tenant already has a deployment of the application; 409 `InsufficientCapacityError` when no eligible account has room |
| GetDeployment | `GET /tenants/{tenantId}/deployments/{applicationId}` | 200 — the polling endpoint: status, `cellId`, the account, the effective definition (from the cell) and the stored `parameters` (no defaults) |
| UpdateDeployment | `PUT /tenants/{tenantId}/deployments/{applicationId}` | 202 — optional body `{parameters?, removeParameters?}` merged into the stored values, then runs the tenant update script; 400 on a validation failure, nothing written; 409 when the deployment or its cell is not in a state to re-apply, or the stored values changed during the call (retry) |
| DeleteDeployment | `DELETE /tenants/{tenantId}/deployments/{applicationId}` | 202 — runs the tenant delete script with the stored values (never validated), frees the slot and the tenant's count |
| ListDeployments | `GET /deployments[?tenantId=\|?cellId=\|?applicationId=]` | 200 — paginated, at most one filter (400 for two) |
| ListCells | `GET /cells[?accountId=\|?applicationId=]` | 200 — fleet topology: `applicationId`, `accountId`, status, `tenantCount`/`maxTenants`; at most one filter (400 for two) |
| GetCell | `GET /cells/{cellId}` | 200 — full record including the application, the account, the stamped definition and the stored cell `parameters` (no defaults; empty for a new cell) |
| UpdateCell | `PUT /cells/{cellId}` | 202 — optional body `{parameters?, removeParameters?}` merged into the cell's stored values (removing one returns the cell to the default), then runs the cell update script; 400 on a validation failure, nothing written |
| DeleteCell | `DELETE /cells/{cellId}` | 202 — empty cells only (409 while occupied); frees the account's cell slot and the application's count |
| PutAccount | `PUT /accounts/{accountId}` | 200 — register or replace `maxCells`, `applicationIds` (absent: shared), `externalId` (required for `TENANT`); `owner` is set on first write and immutable (409 on change); 404 for an unregistered application id; verifies the role pair first (400 if not assumable) |
| GetAccount | `GET /accounts/{accountId}` | 200 — `owner`, `applicationIds`, `cellCount`/`maxCells`, whether an external id is set |
| ListAccounts | `GET /accounts` | 200 — the capacity view above `ListCells` |
| DeleteAccount | `DELETE /accounts/{accountId}` | 200 — empty accounts only (409 while it holds cells) |

Twenty-two operations; there is deliberately no `POST /cells` — cells are
created implicitly by placement — and no implicit account registration. A
list filter with an unknown id returns an empty page, not a 404.
`CreateDeployment` accepts an optional `clientToken` for retry safety:
resending the same token returns the originally created deployment instead of
a 409 (reuse with different parameters, another application or other
parameter values included, is rejected with a 409). A 409 whose message
says "retry the request" can succeed on a retry; any other 409 needs an
operator act first, such as a delete or more capacity. The API contract is the Smithy model in
[`model/`](./model/) — the OpenAPI spec and TypeScript server SDK are
generated from it (`smithy build`).

## Security notes

- The **account role pair** in each account is the provisioning blast radius
  — it bounds what lifecycle scripts may do there, and its asymmetry is the
  boundary: the cell role writes `/application-plane/cells/*`; the tenant
  role reads that namespace but can only write `/application-plane/tenants/*`.
  The sample scopes both to the demo SSM namespaces; the account owner widens
  them deliberately for real provisioning (this is THE hardening point). The
  CodeBuild roles themselves hold nothing but `sts:AssumeRole` on those two
  role names, so the owner's trust policy — not a vendor-side list — decides
  which accounts the fleet can reach (ADR-025). One pair serves every
  application an account admits, so the scripts of one application can read
  another's namespaces in that account; they are trusted vendor code.
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

The sample authenticates every operation and has two grants: an operator
is full admin, and an optional reader can call the `GET` operations only
(see the identity model in [`architecture.md`](./architecture.md), ADR-015
in [`adr/0015-authentication-only-gating.md`](./adr/0015-authentication-only-gating.md)
and ADR-042 in
[`adr/0042-a-read-only-role-beside-the-operator.md`](./adr/0042-a-read-only-role-beside-the-operator.md)).
That makes the issuer
configuration and the API edge the two controls a deployer must get right.
These items are operational — IdP-side, repository-side, and edge — and map
to threats T1 (stolen
operator token), T2 (issuer misconfiguration), T5 (poisoned provisioning
source), T20 (over-broad issuer population), T34 (operator-registered
code), and the cross-account items
T22, T23, T26, T27, and mitigations M9, M10, M11, M19, M20 in
[`threat-model.md`](./threat-model.md).

- **Watch `PutApplication` (T34).** An application's definition names the
  code every one of its cells will run, in every account that admits it.
  Alert on the operation (API Gateway access logs carry the operator
  principal and the path), treat a definition change as a release with the
  same review as a deployment, and require a full commit SHA in
  `source.sourceVersion` so a changed branch cannot change what builds.

### Identity (M9)

- [ ] Use a **dedicated control-plane issuer**. It must issue tokens
      exclusively to vendor operators and, when `readerRoles` is set, to the
      reader systems you name — verify that no other application reuses its
      clients or its audience value.
- [ ] Give readers a **namespaced role value** (`control-plane:reader`) and
      their own app client. A stolen reader token changes nothing but reads
      the whole fleet: tenant names, account ids, application sources and
      parameter values (T36).
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

Each application's definition names a git source that CodeBuild fetches
fresh on every lifecycle build of that application and executes under the
fleet roles — a poisoned commit is arbitrary code execution across the
application's cells (threat T5, the highest-consequence open item).

- [ ] **Pin every application's source to a full 40-character commit SHA**
      via `source.sourceVersion` in `PutApplication`. `PutApplication` logs
      a warning when the ref is absent or mutable (branch or tag); a commit
      SHA is the only immutable git ref.
- [ ] Enable **branch protection with mandatory review** on the provisioning
      repository — no direct pushes to the ref the fleet builds from.
- [ ] Require **commit/tag signing** on the provisioning repository and
      verify signatures in your release process before updating the pinned
      SHA.
- [ ] Use **read-only, narrowly scoped deploy credentials** for CodeBuild's
      source access (CodeConnections / deploy key limited to the one
      repository) — the build must never hold credentials that can push.
- [ ] Treat a `PutApplication` that replaces a definition (including the
      pinned SHA) as a **deployment**: review, roll out, and be ready to roll
      back like any other release artifact.

### Edge protection (M11)

- [ ] Attach an **AWS WAF web ACL** to the REST API stage, with rate-based
      rules and the IP reputation managed rule group.
- [ ] Add **per-method throttling via usage plans**, sized to real operator
      traffic. The sample's stage-wide 20 rps / 40 burst limit is a
      starting point; operator traffic on a control plane is low-volume,
      so tighter per-method limits on the build-starting operations
      (`POST /tenants/{tenantId}/deployments`, the `PUT`/`DELETE` operations
      on deployments and cells) further cap the cost amplification a leaked
      token can cause.
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
      has one fully privileged operator population, and a tenant-owned
      account is not bound to the tenant it belongs to. `applicationIds`
      narrows which applications may land in an account, not which tenants.
      Before a broader population connects, add finer operator roles with
      account scoping (spec §11) so a deployment of customer A's tenant
      cannot be placed into customer B's account.
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
