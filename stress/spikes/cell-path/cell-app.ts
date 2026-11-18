// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
//
// Spike Q-6: the runtime-isolation demo stack as one cell, with every IAM
// role on the /cell/ path. The same app as samples/agentic-runtime-isolation/
// src/main.ts plus one aspect. Run from that sample's folder:
//   CDK_OUTDIR=<out> CDK_CONTEXT_JSON='{...}' TS_NODE_TRANSPILE_ONLY=1 \
//     npx ts-node ../../stress/spikes/cell-path/cell-app.ts
import { App, Aspects, CfnResource, type IAspect } from 'aws-cdk-lib';
import type { IConstruct } from 'constructs';
import { bundleAgent } from '../../../samples/agentic-runtime-isolation/src/agent/bundle';
import { parseDemoContext, RuntimeIsolationDemoStack } from '../../../samples/agentic-runtime-isolation/src/demo.cdk';

/** Every AWS::IAM::Role on /cell/, CfnRole or raw CfnResource alike (spec §8, decision 7). */
class CellPath implements IAspect {
  visit(node: IConstruct): void {
    if (CfnResource.isCfnResource(node) && node.cfnResourceType === 'AWS::IAM::Role') {
      node.addPropertyOverride('Path', '/cell/');
    }
  }
}

const app = new App();
const context = parseDemoContext((key) => app.node.tryGetContext(key), process.env.CDK_DEFAULT_REGION);
const stack = new RuntimeIsolationDemoStack(app, `RuntimeIsolation-${context.ingress}`, {
  context,
  agentCodePath: bundleAgent(),
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
Aspects.of(stack).add(new CellPath());
app.synth();
