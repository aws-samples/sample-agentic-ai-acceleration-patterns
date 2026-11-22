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
 *
 * The app must load one copy of the CDK: the aspect and the synth context register on the
 * app's own `aws-cdk-lib`. The cell scripts install only the runtime-isolation sample and
 * run this file with `NODE_PATH` set to its `node_modules`, so every import here resolves
 * there; the app refuses to run when this package's own `aws-cdk-lib` would be loaded too.
 */

import * as path from 'node:path';
import { App, Tags } from 'aws-cdk-lib';
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
applyCellRolePath(stack as never);
Tags.of(stack as never).add(CELL_TAG.key, CELL_TAG.value);
Tags.of(stack as never).add('stress:cell', cellId);
app.synth();
