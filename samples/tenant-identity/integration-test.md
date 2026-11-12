# Tenant Identity with Amazon Cognito: deployment integration tests

This sample has two deployment integration tests. The
[topologies test](#topologies-test) deploys the three topologies and `tiered`
and drives the spec §10 scenario against them. The
[joint control-plane mount test](#joint-control-plane-mount-test) mounts the
sample under control-plane and drives the mounting spec §10 scenario. Both
follow [sample standard §5.3](../../docs/sample-standard.md#53-integration-test-document-integration-testmd).

## Topologies test

### What it is

[`test/integ.identity.ts`](./test/integ.identity.ts), driven by
[`scripts/integ.sh`](./scripts/integ.sh), deploys temporary infrastructure into
a real account and drives the full lifecycle. The assertions are the e2e suite
in [`test/e2e/`](./test/e2e/README.md). The CDK CLI drives the run rather than
integ-runner, which deploys a test's stacks one at a time (ADR-0023).

### How to run it

Use a non-production, CDK-bootstrapped account. Run it in exactly one Region:
the script fails fast when `AWS_REGION` is unset.

```bash
export AWS_REGION=eu-central-1
npx projen integ
```

Only the `shared-pool-multi-tenant` stack publishes the shared
`/application-plane/shared/identity/*` parameters during the test, because
those names are fixed per account and Region and two stacks cannot own the
same name (ADR-0017). To run beside another deployment of this sample in the
same account, set `E2E_STACK_PREFIX` (renames the four stacks) and
`E2E_PUBLISHER=none` (no integ stack publishes the parameters):

```bash
E2E_STACK_PREFIX=TenantIdentityScopes E2E_PUBLISHER=none AWS_REGION=eu-central-1 scripts/integ.sh
```

| Variable | Default | Effect |
|---|---|---|
| `AWS_REGION` | none (required) | the single Region the run deploys to and tests in |
| `E2E_STACK_PREFIX` | `TenantIdentity` | stack name prefix: `${prefix}-${deployment}` |
| `E2E_PUBLISHER` | `shared-pool-multi-tenant` | the deployment that publishes the shared parameters; `none` publishes from no stack |

### What it stands up

It deploys **all four stacks at once** (the three topologies and `tiered`)
with `cdk deploy --all`, runs the scenario against them, then destroys them at
once. The destroy always runs, also when the deploy or the scenario fails.
Nothing is reused: every stack the run deploys, it destroys.

### Steps

The four stack files run in parallel, one jest worker each. Against each
topology stack the spec §10 scenario runs steps 1b–9 and 11, plus the R-6
parameter check. It registers `sample/read` and `sample/write` in the stack's
catalogue, entitles tenant A to both and B to read only, and proves on real
tokens that B cannot narrow to write, that a tenant admin's cut shows in the
user's next token, that `UpdateTenant` widens B, and that `DeleteScope` drops
the scope from every token within the 60 s catalogue cache (ADR-0034,
ADR-0035, ADR-0036). In the `tiered` stack the scenario creates one tenant per
tier and adds the binding-rule refusals (§10 step 12, ADR-0027). The e2e
[README](./test/e2e/README.md#the-tiered-scenario-adr-0027) details the tiered
steps.

| Step | Checks |
|---|---|
| 1b | register the two scopes; the reserved owner and a malformed name are refused |
| R-6 | the shared discovery parameters name the publishing stack (skipped with `E2E_PUBLISHER=none`) |
| 2 | `CreateTenant` A and B, each `ACTIVE` with an admin and a temporary password |
| ADR-0025 | `CreateTenant` gave A and B one enabled key each, in the `/tenant` usage plan |
| ADR-0026 | pools carry their tenant tag; a session tagged A is denied pool B (`pool-per-tenant`) |
| 3 | `CreateUser` u1/u2; topology-specific conflicts; R-12 isolation |
| 4 | token contract: tenant claim per topology, ID token has none |
| 5 | claim integrity: the tenant claim cannot be chosen by the caller |
| 6 | refresh re-runs the trigger (`shared-pool-multi-tenant`) |
| 7 | narrowing: one tenant, subset scopes, refusals, direct bypass; B cannot narrow to write |
| 8 | tenant admin: the narrowed admin token manages only tenant A; the admin's cut shows in u1's next token |
| 8b | `UpdateTenant` widens B; `DeleteScope` drops a scope from every token |
| 9 | offboard A: issuance stops, cached verification still works |
| 11 | teardown B and assert full operation coverage; one tenant is left in the stack on purpose |
| 12a | `tiered`: `CreateTenant` without `tier` → 400 `InvalidInput` |
| 12b | `tiered`: `CreateTenant` S (standard) and P (premium): tier echoed, S in the shared pool, P in its own |
| 12c | `tiered`: S's API key is in the standard plan and P's in the premium plan, not the other way round |
| 12d | `tiered`: u (in S) and v (in P) get `tenant_id` from their own pool; verified against that pool |
| 12e | `tiered`: each tenant admin narrows through its own client and manages only its own tenant |
| 12f | `tiered`: a tenant is reachable only through its own pool: cross-tier reads 404, cross-tier exchanges fail |
| 12f2 | `tiered`: a shared-pool user whose `custom:tenantId` names premium P cannot get a token |
| 12g | `tiered`: a single-topology stack refuses `tier` → 400 `UnsupportedInTopology` |
| 12h | `tiered`: `DeleteTenant` S and P → 204; P's pool and both keys are gone; S2 stays for the drain |
| alarm actions | each stack's alarms are forced into `ALARM`; the run fails unless the alarm history shows a successful publish to the alarm topic (M-31) |
| `TenantDrain` | `cdk destroy` offboards the tenant step 11 and step 12h leave in every stack; a tagged user pool left after the destroy fails the run (ADR-0022) |
| REST API shell | after destroy, no stack-named REST API remains; if a failed `PutRestApi` left an untracked API shell, the run fails and deletes it at API Gateway's allowed rate (T-33/M-32) |
| log groups | no log group the stacks owned remains after destroy (ADR-0024) |

### Runtime and cost

One run with all four stacks took **about 10.5 minutes** (the last green run
was 630 s, of which two 60 s waits per stack let a `DeleteScope` and a
re-registration reach the catalogue cache) and cost well under 1 USD. Last
green run: 2026-11-10, eu-central-1, all four stacks deployed as
`TenantIdentityScopes-*` beside a standing deployment, 51/51 e2e assertions,
11.5 minutes, no leftovers;
coverage is in the [`architecture.md`](./architecture.md) status block.

### After an interruption

The destroy runs from an exit trap. If it fails, the script prints the
command to run again: `AWS_REGION=<region> npx cdk --app cdk.integ.out destroy
--all --force --concurrency 4`. If the run stopped before the trap, destroy the
four `${E2E_STACK_PREFIX}-*` stacks, then look for what the leftover check
reports: user pools carrying the sample tag and an integ stack's tag, a REST
API named after an integ stack, and the stacks' log groups.

### Test-only shortcuts

The scenario obtains real tokens through the `IssueToken` and `RefreshToken`
test-aid routes (ADR-0006). A consumer removes them before production, the
first item of the README's
[production hardening checklist](./README.md#production-hardening-checklist),
and signs users in through Cognito instead.

## Joint control-plane mount test

### What it is

[`test/integ.control-plane.ts`](./test/integ.control-plane.ts), driven by
[`scripts/integ-control-plane.sh`](./scripts/integ-control-plane.sh), proves
the mount end to end and, per
[sample standard §5.2](../../docs/sample-standard.md#52-integration-test), is
the **reference implementation of the control-plane wiring**: it deploys
control-plane through control-plane's own deploy path, never by importing its
`src/`, and drives the whole flow with only the published parameters and the
public APIs.

### How to run it

Use a non-production, CDK-bootstrapped account, in exactly one Region
(`AWS_REGION`). Build `../control-plane` first (`npx projen build` there) so
its `src/smithy` exists. The script aborts if
`/application-plane/shared/identity/topology` or the `control-plane-dev` stack
already exists in the Region, so it never takes over a running deployment
(ADR-0017).

```bash
export AWS_REGION=eu-central-1
npx projen integ:control-plane
```

### What it stands up

It stands up `TenantIdentity-shared-pool`, a `TenantIdentityCpSetup` stack (a
throwaway vendor IdP minting `role: operator` and an S3 bucket holding
`scripts/control-plane/`), and control-plane itself, then runs the scenario in
[`test/e2e/control-plane/mount.cp-e2e.test.ts`](./test/e2e/control-plane/mount.cp-e2e.test.ts).
The script hands the setup stack's `ScriptSourceLocation` output to the
scenario in `E2E_CP_SCRIPT_SOURCE`. The scenario first registers the mount as
the control-plane application `identity-mount` (`PutApplication` with that
S3 source, the six scripts and `maxTenants: 2`; control-plane ADR-032), then
the home account (`PutAccount`, vendor-owned and shared; control-plane
ADR-024: cells live in registered accounts), and removes the tenant, cell,
account and application again once the deployment is gone. The teardown
destroys all three stacks: control-plane first, then setup and identity.

### Steps

| # | Step | Expected |
|---|---|---|
| 0 | control-plane `PutApplication identity-mount`, then `PutAccount` (home account) | 200, 200 |
| 1–2 | control-plane `CreateTenant {name}`, then `CreateDeployment {applicationId: identity-mount, adminEmail=success+…@simulator.amazonses.com}` | 200 with `tenantId`, then 202 with `cellId`; `GetDeployment` polls to `ACTIVE`; the cell is `ACTIVE` with `applicationId: identity-mount`; `cell/create.sh` found the identity parameters |
| 3 | tenant-identity `GetTenant(T)` via the test's own SigV4 | 200 `ACTIVE`, same `name` |
| 4 | tenant-identity `ListUsers(T)` | exactly one user, `admin: true`; `GetTenant` leaks no `firstAdminEmail` |
| 5 | the parked parameter | `SecureString`, `KeyId` = `adminPasswordKeyArn`; value never printed |
| 5b | IAM policy simulator, tenant provisioning role, `kms:Decrypt` on the key | `implicitDeny` |
| 6 | `IssueToken` for the admin with the parked password | 200; access token's `tenant_id` is `T` |
| 7 | control-plane `UpdateDeployment(T, identity-mount)` (re-runs `tenant/update.sh`) | 202, polls to `ACTIVE`; still one admin; parked parameter version unchanged |
| 8 | run `tenant/create.sh` a second time with the build's env (`APPLICATION_ID` included) | exit 0, `already has its first admin`; still one user and one parameter version |
| 9 | tenant-identity `CreateTenant` with the existing `tenantId` | 409, nothing changed |
| 9b | `CreateUser {firstAdmin: true}` (taken slot) then `CreateUser {admin: true}` | 409, then 201 — a second *first* admin is refused, a second admin is allowed |
| 10–11 | control-plane `DeleteDeployment(T, identity-mount)` | 202, `GetDeployment` polls to 404; tenant-identity `GetTenant(T)` 404; parked parameter gone |
| 11b | control-plane `DeleteTenant(T)`, `DeleteCell`, `DeleteAccount`, `DeleteApplication` | `deploymentCount` 0, then 200, 202 (polls to 404), 200, 200 |
| 12 | teardown from an exit trap: control-plane, setup, identity | no stack, parameter, user pool, REST API or log group of the run remains; a leftover parked parameter or orphan REST API is deleted and still fails the run |

Every AWS call in the teardown trap is guarded, so the trap always reaches its
final report. One known issue it works around: control-plane's API access log
group is recreated while its stack is being deleted, because control-plane has
no log drain like this sample's (ADR-0024). The trap deletes that group and
prints a `WARNING` naming the control-plane issue instead of failing the run;
a recreated tenant-identity log group still fails it.

### Runtime and cost

The run takes **about 11 minutes** observed (the spec estimated 25–35) and
costs under 1 USD. Last green run: 2026-11-10, eu-central-1, mounting spec §10
steps 1–12 including 5b and 9b, 11/11 e2e assertions, 11 minutes; coverage is in the
[`architecture.md`](./architecture.md) status block.

### After an interruption

If the control-plane destroy fails, the script prints the command to rerun in
`../control-plane` (`npx cdk destroy control-plane-dev --force` with the same
context); if the tenant-identity destroy fails, it prints
`AWS_REGION=<region> npx cdk --app cdk.integ-cp.out destroy --all --force
--concurrency 2`. Look for a leftover parked parameter under
`/application-plane/tenants/` (`<T>/identity-mount/admin-temporary-password`), user pools, REST APIs and log groups of the
run. The `AdminPasswordKey` stays `PendingDeletion` for 7 days after teardown
(ADR-0033); that is expected, not a leftover.

### Test-only shortcuts

Step 6 **needs the test-aid routes** (`IssueToken`, ADR-0006, the first item
of the README's
[production hardening checklist](./README.md#production-hardening-checklist)):
the test asserts they exist and fails with a clear message if they were
removed. The setup stack's vendor IdP is throwaway; a consumer points
control-plane at its own vendor IdP and its own script bucket, as
[Mounting under the control plane](./README.md#mounting-under-the-control-plane)
describes.
