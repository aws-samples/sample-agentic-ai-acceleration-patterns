# The Simple Cell-Based Control Plane: deployment integration test

## What it is

[`test/integ.tenant.ts`](./test/integ.tenant.ts) is an
[AWS CDK integration test](https://docs.aws.amazon.com/cdk/api/v2/docs/integ-tests-alpha-readme.html),
driven by `@aws-cdk/integ-runner` through the projen `integ` task. It deploys
temporary infrastructure into a real AWS account and exercises the complete
cell and tenant lifecycle.

Per [sample standard §5.2](../../docs/sample-standard.md#52-integration-test)
the test is the reference implementation of this sample's wiring: how the
vendor IdP, the stamped script source and the `cellDefinition` fit together
is read from that file, not from prose.

## How to run it

Use a non-production account that is bootstrapped for AWS CDK deployments.

Run it in one explicitly selected Region. The `integ` task pins integ-runner
to `$AWS_REGION` (overriding its multi-Region defaults) and fails fast when
the variable is unset:

```bash
export AWS_REGION=eu-central-1
npx projen integ
```

| Knob | Default | Effect |
|---|---|---|
| `AWS_REGION` | none (required) | The single Region the test deploys to and runs in |

The `integ` task always runs integ-runner with `--force` and
`--update-on-failed`. The integ-runner snapshot
(`test/integ.tenant.ts.snapshot/`) is intentionally not committed: it is
generated output that would ship megabytes of bundled third-party code (a
vendored AWS CLI layer, esbuild-bundled custom-resource handlers) with the
sample. Because the task always runs with `--force`, no workflow depends on a
committed snapshot; your local snapshot is kept (gitignored) to speed up
repeated runs.

## What it stands up

| Stack | Contents |
|---|---|
| `control-plane-integ-setup` | A throwaway Cognito user pool as the vendor IdP, with a pre token generation trigger that adds the `role: "operator"` claim (ADR-018), and an S3 bucket hosting `scripts/sample-cell` and `scripts/sample-tenant` as the stamped source |
| `control-plane-integ` | The stack under test: `TenantStack` with a `cellDefinition` that points both shared CodeBuild projects at the test bucket, with `maxTenants: 2` |
| integ-tests-alpha assertion stack (`ControlPlaneInteg`) | The API calls and polls that drive the steps below |

The test reuses nothing that exists in the account. Its own steps tear down
every tenant and both cells, leaving the SSM namespaces empty; the runner then
destroys its CloudFormation stacks by default.

## Steps

Every API operation runs at least once. The steps run in this order:

| # | Step | What it checks |
|---|---|---|
| 1 | Unauthenticated request | No vendor JWT: API Gateway answers 401 before any Lambda runs |
| 2 | Mint an operator | `adminCreateUser`, `adminSetUserPassword`, `adminInitiateAuth` in the vendor IdP return an ID token (operator authentication) |
| 3 | Onboard tenant #1 | `CreateTenant` (202, with `cellId`) implicitly creates the first cell; `GetTenant` polls to ACTIVE; exactly one cell, ACTIVE, 1/2 occupied; `GetCell` returns the stamped definition; the cell namespace and the tenant parameter exist |
| 4 | Onboard tenant #2 | `CreateTenant` with a `clientToken` reuses cell #1 (now 2/2); replaying the identical request returns the original tenant, already ACTIVE; reusing the token with different parameters is a 409; still exactly one cell at 2/2 |
| 5 | Onboard tenant #3 | Cell #1 is full, so placement creates a second cell; `DeleteTenant` on #3 while CREATING is a 409 (in-flight guard); two cells, cell #1 at 2/2 and the new cell at 1/2 |
| 6 | Reads | `GetResource` resolves the stamped definition and names the cell; `ListTenants?cellId=` returns exactly the cell's tenants; an unknown `cellId` returns an empty page |
| 7 | Tenant updates | `UpdateTenant` (metadata, 200, reflected in `GetTenant`); `UpdateResource` (202) polls back to ACTIVE |
| 8 | Cell update | `UpdateCell` (202); `GetCell` polls back to ACTIVE |
| 9 | Occupied-cell guard | `DeleteCell` on a cell that still holds tenants is a 409 (ADR-014) |
| 10 | Offboard tenant #1 | `DeleteTenant` (202) polls to 404; the slot is freed (1/2); the tenant parameter is gone |
| 11 | Offboard tenants #2 and #3 | `DeleteTenant` polls to 404 for both; the tenant namespace is empty |
| 12 | Deprovision both cells | `DeleteCell` (202) polls `GetCell` to 404 for both; no cells are left; the cell SSM namespaces are empty |

Success is reported as one passing integration test.

## Runtime and cost

Expect a runtime around 25 minutes. The cost of a run is the usage of the
resources above for that time; no per-run figure is recorded.

The last green run was on 2026-10-27 in eu-west-1, covering the full cell
lifecycle: implicit cell creation, cell reuse, fill-to-capacity, second-cell
placement, the in-flight and occupied-cell guards, and complete teardown. See
the status block at the top of [`architecture.md`](./architecture.md).

## After an interruption

If execution is interrupted, inspect active stacks containing
`control-plane-integ` and parameters under `/application-plane/cells/` and
`/application-plane/tenants/` before removing test resources.

## Test-only shortcuts

| In the test | What a consumer does instead |
|---|---|
| A throwaway Cognito user pool stands in for the vendor IdP, and a pre token generation trigger adds `role: "operator"` | Configures its own vendor IdP to mint `role: "operator"` on operator tokens (ADR-018) and passes its issuer URL and audience |
| The operator is created and authenticated with Cognito admin APIs, with a password generated at run time | Signs operators in through its own IdP |
| The stamped source is an S3 bucket of the sample scripts, read by both shared CodeBuild projects through `grantRead` | Points the `cellDefinition` source at its own cell and tenant scripts |
| `maxTenants: 2`, so filling a cell is cheap | Sets `maxTenants` for its own cells |
