// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * `RunCodeToolTarget` (spec §3.3, §6.3, ADR-0017, ADR-0055): puts the core
 * construct behind the tools gateway of `agentic-runtime-isolation`. It is a
 * Lambda `ToolTarget` of that sample with one tool, `run_code`. It
 *
 * 1. deploys one function whose entry wraps the core's `runCode` in the
 *    producer's `toolHandler` (src/gateway/run-code-tool.function.ts), which
 *    takes the tenant from the signed context only;
 * 2. registers it as a Lambda target, which grants it `kms:GetPublicKey` on
 *    the context key; the core's `runCode` vends the `TenantId`-tagged tool
 *    tenant role itself;
 * 3. hands the function to `sandboxes.bindRunCode`, which gives it the tool
 *    subnets, security group, timeout, environment and an owned log group;
 *    as the function runs as the core's tool role, the trust and the actions
 *    that role holds already apply.
 *
 * It is the one construct that names the producer; the core never imports
 * this directory (test/import-graph.test.ts, the lint rule).
 */

import { ToolTarget, type SharedIngress, type SharedIngressRef, type ToolTargetProps } from 'agentic-runtime-isolation';
import { Duration } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';
import { HANDLERS, handlerEntry } from '../handler-entry';
import { GATEWAY_BUDGET_CAP_SECONDS } from '../props';
import type { UntrustedCodeSandboxes } from '../untrusted-code-sandboxes.cdk';
import { DEFAULT_TARGET_NAME, runCodeToolDefinition } from './tool-schema';

export interface RunCodeToolTargetProps {
  /** The core construct (required). Its tool budget must be at most 90 s. */
  readonly sandboxes: UntrustedCodeSandboxes;
  /** The ingress whose tools gateway the target joins: the same-app construct, or its published values. */
  readonly ingress: SharedIngress | SharedIngressRef;
  /** The name of the ingress's tools gateway. @default 'default' */
  readonly gateway?: string;
  /** The target name, `[a-z0-9-]{1,32}`; the tool is `<toolName>/run_code` in grants. @default 'run-code' */
  readonly toolName?: string;
}

/** The one function a target needs, built before the target because `ToolTarget` takes it as a prop. */
function gatewayFunction(scope: Construct, id: string, props: RunCodeToolTargetProps): NodejsFunction {
  const budget = props.sandboxes.config.toolBudget.toSeconds();
  if (budget > GATEWAY_BUDGET_CAP_SECONDS) {
    // Through the ingress the agent's whole turn shares a fixed 120 s (spike S-11): a longer tool leaves it no time.
    throw new Error(
      `RunCodeToolTarget: the tool budget (5 s + startWait + runTimeout + 10 s) is ${budget} s, above the ${GATEWAY_BUDGET_CAP_SECONDS} s cap of the gateway entry; lower startWait or runTimeout`,
    );
  }
  // Under its own holder node, `<id>Handler`, the one extra id the target reserves in the deployer's scope; the
  // function cannot be a child of the target because `ToolTarget` takes it as a prop.
  return new NodejsFunction(new Construct(scope, `${id}Handler`), 'Function', {
    entry: handlerEntry(HANDLERS.gatewayRunCode),
    runtime: lambda.Runtime.NODEJS_24_X,
    architecture: lambda.Architecture.ARM_64,
    role: props.sandboxes.toolRole,
    timeout: Duration.seconds(budget),
    memorySize: 512,
    // The producer's logger and `toolHandler` write one JSON object per line; the JSON format keeps its fields
    // (`tenantId`, `txn`) queryable (spec §3.8). The log group and the VPC settings come from `bindRunCode` (ADR-0055).
    loggingFormat: lambda.LoggingFormat.JSON,
    // As the core's own functions: no START, END or REPORT lines in a group the log rules read.
    systemLogLevelV2: lambda.SystemLogLevel.WARN,
    applicationLogLevelV2: lambda.ApplicationLogLevel.INFO,
    bundling: {
      minify: true,
      sourceMap: false,
      // Bundle the SDK clients, as the producer does, so the artifact pins the versions the sample was tested with.
      externalModules: [],
    },
    description: 'run_code on the tools gateway: the core run logic behind the producer toolHandler (spec 3.3)',
  });
}

export class RunCodeToolTarget extends ToolTarget {
  /** The gateway entry's function, after `bindRunCode`. */
  public readonly function: NodejsFunction;

  public constructor(scope: Construct, id: string, props: RunCodeToolTargetProps) {
    const fn = gatewayFunction(scope, id, props);
    const target: ToolTargetProps = {
      name: props.toolName ?? DEFAULT_TARGET_NAME,
      ingress: props.ingress,
      gateway: props.gateway,
      kind: 'lambda',
      function: fn,
      tools: [runCodeToolDefinition(props.sandboxes.config.backends, props.sandboxes.config.defaultBackend)],
    };
    super(scope, id, target);
    this.function = fn;
    props.sandboxes.bindRunCode(fn);
  }
}
