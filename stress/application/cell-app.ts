// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The stress application's cell app (spec §3.1, §3.3 step 2; §8, decision 7): one
 * runtime-isolation cell, the sample's demo stack with the `api-gateway` ingress and the
 * TVM, synthesised for the cell bootstrap: every role on `/cell/` (`CellRolePath`), the
 * `cell` qualifier and the workload boundary (`cellSynthContext`). The cell scripts in
 * `scripts/cell/` run it in CodeBuild, from the source at the pinned commit.
 *
 * Environment: `CELL_ID` (from the control plane), `CELL_POLICY_SUFFIX` (optional, as for
 * the owner stacks), `CDK_DEFAULT_ACCOUNT` and `CDK_DEFAULT_REGION` (from the CDK CLI).
 * With `DISTRIBUTION_ARN` set (platform mode) the stack also holds the tenant front door's
 * cell API origin, `DemoCellApi`, and its `FrontDoorApiDomain` output; it then needs
 * `APPLICATION_ID`, `IDENTITY_USER_POOL_ID` and `IDENTITY_APP_CLIENT_ID` (the stress
 * identity the cell account's base stack names). Empty or unset is slice mode.
 *
 * The app must load one copy of the CDK: the aspect and the synth context register on the
 * app's own `aws-cdk-lib`. The cell scripts install only the runtime-isolation sample and
 * run this file with `NODE_PATH` set to its `node_modules`, so every import here resolves
 * there; the app refuses to run when this package's own `aws-cdk-lib` would be loaded too.
 */

import * as path from 'node:path';
import { App, CfnOutput, Tags } from 'aws-cdk-lib';
import { applyCellRolePath, cellSynthContext } from './cell-path';
import { cellPolicyNames } from './cell-policies';
import { CELL_TAG, cellAppContext, cellStackName } from './cell-stack';

const sample = path.resolve(__dirname, '..', '..', 'samples', 'agentic-runtime-isolation');
const ours = require.resolve('aws-cdk-lib');
const theirs = require.resolve('aws-cdk-lib', { paths: [sample] });
if (ours !== theirs) {
  throw new Error('cell-app.ts must load the runtime-isolation sample\'s aws-cdk-lib only: run it with NODE_PATH set to that sample\'s node_modules, without stress/node_modules');
}
/* eslint-disable @typescript-eslint/no-require-imports */
const { RuntimeIsolationDemoStack, parseDemoContext } = require(path.join(sample, 'src', 'demo.cdk')) as {
  RuntimeIsolationDemoStack: new (scope: unknown, id: string, props: Record<string, unknown>) => unknown;
  parseDemoContext: (read: (key: string) => unknown, region?: string) => Record<string, unknown>;
};
const { bundleAgent } = require(path.join(sample, 'src', 'agent', 'bundle')) as { bundleAgent: () => string };
/* eslint-enable @typescript-eslint/no-require-imports */

const need = (name: string): string => {
  const v = process.env[name];
  if (v === undefined || v === '') throw new Error(`${name} is not set`);
  return v;
};

const cellId = need('CELL_ID');
const stackName = cellStackName(cellId);
const app = new App({ context: { ...cellAppContext(stackName), ...cellSynthContext(cellPolicyNames(process.env.CELL_POLICY_SUFFIX ?? '')) } });
const region = need('CDK_DEFAULT_REGION');
const context = parseDemoContext((key) => app.node.tryGetContext(key), region);
const stack = new RuntimeIsolationDemoStack(app, stackName, {
  context,
  agentCodePath: bundleAgent(),
  dashboardName: stackName,
  owner: stackName,
  description: `Stress application cell ${cellId} (platform stress test, spec §3.3)`,
  env: { account: need('CDK_DEFAULT_ACCOUNT'), region },
});

// The cell API origin of the tenant front door (spec §3.3 step 2). `DISTRIBUTION_ARN` empty or
// unset is slice mode: no cell API, no output, the cell as before.
const distributionArn = process.env.DISTRIBUTION_ARN ?? '';
if (distributionArn !== '') {
  const frontDoorDir = path.resolve(__dirname, '..', '..', 'samples', 'tenant-front-door');
  const demoCellDir = path.resolve(frontDoorDir, 'src', 'demo-cell');
  // The same one-copy rule as above, for the module the cell API loads (it must not find a
  // tenant-front-door `node_modules` of its own).
  if (require.resolve('aws-cdk-lib', { paths: [demoCellDir] }) !== ours) {
    throw new Error('the demo cell API must load the runtime-isolation sample\'s aws-cdk-lib only');
  }
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { DemoCellApi } = require(path.join(demoCellDir, 'demo-cell-api.cdk')) as {
    DemoCellApi: new (scope: unknown, id: string, props: Record<string, unknown>) => { apiDomain: string };
  };
  /* eslint-enable @typescript-eslint/no-require-imports */
  // The ids come from the cell account's identity parameters; they build the issuer URL, so
  // only their own character sets pass.
  const userPoolId = need('IDENTITY_USER_POOL_ID');
  const appClientId = need('IDENTITY_APP_CLIENT_ID');
  if (!/^[a-z0-9-]+_[A-Za-z0-9]+$/.test(userPoolId)) throw new Error('IDENTITY_USER_POOL_ID is not a user pool id');
  if (!/^[A-Za-z0-9]+$/.test(appClientId)) throw new Error('IDENTITY_APP_CLIENT_ID is not an app client id');
  const issuer = `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`;
  // NodejsFunction takes its project root from the nearest package lock file above the working
  // directory, and the entry must sit under it: the cell API's entry is in tenant-front-door,
  // so the working directory is that sample's for the construct (its lock file is in the
  // repository). The bundle's imports resolve through NODE_PATH, in the runtime-isolation sample.
  // The bundler runs `npx --no-install esbuild` in that directory: it needs a `node_modules`
  // with esbuild, which scripts/lib.sh `link_front_door_modules` links to the runtime-isolation
  // sample's (the one install of a cell build).
  const workingDirectory = process.cwd();
  process.chdir(frontDoorDir);
  let cellApi: { apiDomain: string };
  try {
    cellApi = new DemoCellApi(stack, 'DemoCellApi', {
      issuer: { issuer, jwksUrl: `${issuer}/.well-known/jwks.json`, clientIds: [appClientId] },
      applicationId: need('APPLICATION_ID'),
      cellId,
      distributionArn,
    });
  } finally {
    process.chdir(workingDirectory);
  }
  new CfnOutput(stack as never, 'FrontDoorApiDomain', { value: cellApi.apiDomain });
}

applyCellRolePath(stack as never);
Tags.of(stack as never).add(CELL_TAG.key, CELL_TAG.value);
Tags.of(stack as never).add('stress:cell', cellId);
app.synth();
