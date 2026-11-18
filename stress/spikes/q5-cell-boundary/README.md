<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# Spike Q-5: one runtime-isolation cell under the cell permissions boundary

Question ([spec](../../../docs/stress-test.spec.md) §10, Q-5): does every
`agentic-runtime-isolation` stack deploy through a scoped cell bootstrap,
with the cell permissions boundary on every role, and which actions does the
execution policy need?

Run 2026-11-18, `eu-central-1`, a non-production test account. The cell was
the demo stack `RuntimeIsolation-api-gateway` with `tvm=true` and
`publishParameters=false` (195 resources: one ingress, one agent, two tools
gateways, two tool targets).

## Files

| File | What it is |
|---|---|
| `cell-policies.yaml` | the cell execution policy and the cell permissions boundary |
| `app.js` | a CDK app: `CellBootstrapPolicies-spike` (the two policies) and `CellDenyProbe-spike` (one role without the boundary) |

## Steps

Run from a folder with no `cdk.json` for the bootstrap, and with `NODE_PATH`
set to a sample's `node_modules` for `app.js`.

1. `cdk deploy CellBootstrapPolicies-spike --app "node app.js"` (default bootstrap).
2. `cdk bootstrap aws://<account>/eu-central-1 --qualifier cell --toolkit-stack-name CDKToolkit-cell --cloudformation-execution-policies arn:aws:iam::<account>:policy/cell-execution-policy --custom-permissions-boundary cell-permissions-boundary`.
3. `cdk deploy CellDenyProbe-spike --app "node app.js" --toolkit-stack-name CDKToolkit-cell --context @aws-cdk/core:bootstrapQualifier=cell`: must fail.
4. Synthesise the cell with the qualifier and the boundary as **object** context, then deploy the assembly:
   `CDK_OUTDIR=<out> CDK_CONTEXT_JSON='{"ingress":"api-gateway","tvm":"true","publishParameters":"false","@aws-cdk/core:bootstrapQualifier":"cell","@aws-cdk/core:permissionsBoundary":{"name":"cell-permissions-boundary"}}' npx ts-node -P tsconfig.json --prefer-ts-exts src/main.ts`, then
   `cdk deploy RuntimeIsolation-api-gateway --app <out> --toolkit-stack-name CDKToolkit-cell`.
5. `cdk destroy` both stacks.

## Results

| Step | Result | Time |
|---|---|---|
| Policies stack | created | 30 s |
| Cell bootstrap | created; its execution role carries the boundary | 53 s |
| Deny probe | refused: `iam:CreateRole ... with an explicit deny in a permissions boundary` | 22 s, destroy 7 s |
| Cell deploy | `CREATE_COMPLETE`; 27 of 27 roles carry the boundary, custom-resource and log-drain roles included; all 8 custom resources ran | 402 s |
| Cell destroy | first attempt `DELETE_FAILED` on the three DynamoDB global tables (below); after the fix, clean | 528 s failed, then 8 s |

## Findings

| Id | Finding | Consequence |
|---|---|---|
| Q5-1 | `--context @aws-cdk/core:permissionsBoundary={"name":...}` on the CLI arrives as a string; the CDK reads `context.name`, so no role got the boundary and the first deploy failed on 66 `iam:CreateRole` denials | the cell script passes the boundary as object context (`cdk.json`, `cdk.context.json` or `CDK_CONTEXT_JSON`), never as a CLI `--context` |
| Q5-2 | Every role in the cell carries the boundary when the context is an object | the boundary pattern holds for the whole sample, no construct change needed |
| Q5-3 | `AWS::DynamoDB::GlobalTable` calls `application-autoscaling:DeregisterScalableTarget` on delete; the create did not need it | `application-autoscaling` is in the execution policy and the boundary |
| Q5-4 | The deny probe proves an execution role bounded this way cannot create an unbounded role, even one asking for `AdministratorAccess` | the scope holds |
| Q5-5 | No traffic ran: the bounded roles on the request path (authoriser, TVM `sts:AssumeRole`, the tenant role's model call, the Runtime's execution role) are unproven | run the sample's integration test under the boundary |

## Left in the account

`CDKToolkit-cell` and `CellBootstrapPolicies-spike` stay, for the next cell
spike. To remove them: `aws s3` empty the `cdk-cell-assets-*` bucket, then
delete `CDKToolkit-cell`, then `cdk destroy CellBootstrapPolicies-spike`.
