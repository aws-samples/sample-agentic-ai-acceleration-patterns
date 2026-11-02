// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * `ToolTarget` (spec C-16, §3.5, §3.6; ADR-0034, ADR-0035, ADR-0040): one
 * group of tools behind the shared tools gateway, in the ingress's stack or
 * its own. It creates, in this order:
 *
 * 1. the owner-marked rows in the entitlement store: `NAME#<target>` (one
 *    namespace with agent names) and one `TOOL#<target>` / `TOOL#<tool>`
 *    catalogue row per tool (src/shared/reservation.function.ts);
 * 2. the Gateway target (`GATEWAY_IAM_ROLE` outbound for a Lambda), with the
 *    function's resource policy naming the Gateway role alone (M-61);
 * 3. the target's Cedar policy (src/shared/cedar.ts) through a custom
 *    resource that DependsOn the target, so CloudFormation deletes the
 *    policy, and waits for it to be gone, BEFORE the target (V-14), and
 *    that runs after the previous target's policy in the same stack (one at
 *    a time); every update also touches the policy (C-16);
 * 4. the registry pointer `tools/<target>` (spec §4.4).
 *
 * Kinds: `lambda` is built. `openApi`, `smithy` and `mcpServer` are typed
 * props whose bodies are TODO(v2) and fail synth today.
 */

import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { CustomResource, Duration, Stack } from 'aws-cdk-lib';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { cedarPolicyFor } from './shared/cedar';
import { customResourceFunction } from './shared/custom-resource.cdk';
import { nameKey, toolKey } from './shared/entitlements';
import type { LogDrain } from './shared/log-drain';
import { TARGET_NAME_PATTERN, TOOL_SHORT_NAME_PATTERN, toolRegistryParameterName } from './shared/registry';
import { OwnedRows, ownerProblem } from './shared/reservation.cdk';
import { SharedIngress, type SharedIngressRef } from './shared-ingress.cdk';
import { TOOL_ENV } from './tools/context';
import { grantPolicyWrites } from './tools-gateway.cdk';

/** The most tools one target may hold (spec §3.5). */
export const MAX_TOOLS_PER_TARGET = 1000;

export type ToolTargetKind = 'lambda' | 'openApi' | 'smithy' | 'mcpServer';

/** One tool of a `lambda` target (spec §3.3). */
export interface ToolDefinition {
  /** `[a-z0-9_]{1,64}`; the catalogue name is `<target>/<name>`, the Gateway's `<target>___<name>`. */
  readonly name: string;
  readonly description: string;
  /** JSON Schema of the arguments; `_ri_ctx` need not be declared (V-10). */
  readonly inputSchema: Record<string, unknown>;
}

export interface ToolTargetProps {
  /** `[a-z0-9-]{1,32}`; one namespace with agent names (ADR-0035). */
  readonly name: string;
  /** The ingress whose tools gateway this target joins (same stack), or its published values. */
  readonly ingress: SharedIngress | SharedIngressRef;
  readonly kind: ToolTargetKind;
  /** `lambda`: the tools, at least one, at most 1,000. Read from the spec for the other kinds. */
  readonly tools?: ToolDefinition[];
  /** `lambda`: the function that serves every tool of the target (see src/tools/context.ts `toolHandler`). */
  readonly function?: lambda.Function;
  /** `openApi` / `smithy`: the spec. TODO(v2). */
  readonly spec?: { readonly inlinePayload?: string; readonly s3Uri?: string };
  /** `mcpServer`: the server endpoint. TODO(v2). */
  readonly endpoint?: string;
  /** Third-party outbound auth (AgentCore Identity credential provider ARN). TODO(v2). */
  readonly outboundAuth?: { readonly credentialProviderArn: string; readonly type: 'OAUTH' | 'API_KEY' };
  /** The tool's tenant role (spec §6.1): trusts this function's role, requires the `TenantId` tag, scopes data by it. */
  readonly tvm?: { readonly role: iam.IRole };
  /** An explicit owner marker for the catalogue and name rows; default `<StackId>#<LogicalResourceId>`. */
  readonly owner?: string;
}

/** What `ToolTarget` needs from the ingress, resolved from either form. */
interface ToolsBinding {
  readonly registryPrefix: string;
  readonly gatewayIdentifier: string;
  readonly gatewayArn: string;
  readonly gatewayRoleArn: string;
  readonly policyEngineId: string;
  readonly policyEngineArn: string;
  readonly contextKeyId: string;
  readonly contextKeyArn: string;
  readonly entitlementsTableName: string;
  readonly entitlementsTableArn: string;
  readonly sameStack?: SharedIngress;
  readonly logDrain?: LogDrain;
}

/** A Cedar policy name from a target name: `[A-Za-z][A-Za-z0-9_]*`. */
export function policyName(target: string): string {
  return `${target.replace(/-/g, '_')}_target`;
}

/** Why the tool list of a `lambda` target is refused, or undefined. */
export function toolDefinitionsProblem(tools: readonly ToolDefinition[] | undefined): string | undefined {
  if (tools === undefined || tools.length === 0) {
    return 'must list at least one tool';
  }
  if (tools.length > MAX_TOOLS_PER_TARGET) {
    return `must list at most ${MAX_TOOLS_PER_TARGET} tools (got ${tools.length})`;
  }
  for (const tool of tools) {
    if (!TOOL_SHORT_NAME_PATTERN.test(tool.name)) {
      return `name '${tool.name}' must match ${TOOL_SHORT_NAME_PATTERN.source}`;
    }
  }
  if (new Set(tools.map((t) => t.name)).size !== tools.length) {
    return 'must not repeat a tool name';
  }
  return undefined;
}

export class ToolTarget extends Construct {
  readonly name: string;
  /** The Gateway target id. */
  readonly targetId: string;
  /** The tool names, as given. */
  readonly tools: readonly string[];
  /** The Cedar policy id (a deploy-time token). */
  readonly policyId: string;
  /** The SSM parameter name of the registry pointer (spec §4.4). */
  readonly registryParameterName: string;
  /** The target L1, for tests. */
  readonly target: agentcore.CfnGatewayTarget;
  /** The policy custom resource, for tests and ordering. */
  readonly policy: CustomResource;

  constructor(scope: Construct, id: string, props: ToolTargetProps) {
    super(scope, id);
    const fail = (prop: string, message: string): never => {
      throw new Error(`ToolTarget: ${prop} ${message}`);
    };
    if (!TARGET_NAME_PATTERN.test(props.name)) {
      fail('name', `must match ${TARGET_NAME_PATTERN.source} (got ${props.name})`);
    }
    if (props.kind !== 'lambda') {
      if (props.kind === 'openApi' || props.kind === 'smithy' || props.kind === 'mcpServer') {
        // TODO(v2): openApi/smithy targets from `spec`, mcpServer from `endpoint`, with `outboundAuth`.
        fail('kind', `'${props.kind}' is not built yet (TODO(v2)); use 'lambda'`);
      }
      fail('kind', `must be 'lambda', 'openApi', 'smithy' or 'mcpServer' (got ${String(props.kind)})`);
    }
    const toolsProblem = toolDefinitionsProblem(props.tools);
    if (toolsProblem !== undefined) {
      fail('tools', toolsProblem);
    }
    if (props.function === undefined) {
      fail('function', "is required with kind 'lambda'");
    }
    const owner = ownerProblem(props.owner);
    if (owner !== undefined) {
      fail('owner', owner);
    }
    const binding = bindingOf(this, props.ingress, fail);
    const tools = props.tools!;
    const fn = props.function!;
    this.name = props.name;
    this.tools = tools.map((t) => t.name);

    // 1. Owner-marked rows (ADR-0035): the name first, then the catalogue.
    const rows = new OwnedRows(this, 'Catalogue', {
      tableName: binding.entitlementsTableName,
      tableArn: binding.entitlementsTableArn,
      owner: props.owner,
      logDrain: binding.logDrain,
      rows: [
        { ...nameKey(props.name), attributes: { kind: 'target' } },
        ...tools.map((t) => ({ ...toolKey(props.name, t.name), attributes: { description: t.description } })),
      ],
    });

    // The tool function: the context key's public half and, with tvm, its tenant role (P-15).
    fn.addEnvironment(TOOL_ENV.CONTEXT_KEY_ID, binding.contextKeyId);
    fn.addToRolePolicy(new iam.PolicyStatement({ sid: 'ReadContextPublicKey', actions: ['kms:GetPublicKey'], resources: [binding.contextKeyArn] }));
    if (props.tvm !== undefined) {
      fn.addEnvironment(TOOL_ENV.TVM_ROLE_ARN, props.tvm.role.roleArn);
      fn.addToRolePolicy(
        new iam.PolicyStatement({ sid: 'AssumeToolTenantRole', actions: ['sts:AssumeRole', 'sts:TagSession'], resources: [props.tvm.role.roleArn] }),
      );
    }
    // M-61: only the Gateway role may invoke the function, and it invokes registered functions only.
    fn.addPermission('ToolsGatewayInvoke', { principal: new iam.ArnPrincipal(binding.gatewayRoleArn), action: 'lambda:InvokeFunction' });
    if (binding.sameStack?.toolsGateway !== undefined) {
      binding.sameStack.toolsGateway.allowInvoke(fn);
    } else {
      const role = iam.Role.fromRoleArn(this, 'GatewayRole', binding.gatewayRoleArn, { mutable: true });
      role.addToPrincipalPolicy(new iam.PolicyStatement({ actions: ['lambda:InvokeFunction'], resources: [fn.functionArn] }));
    }

    // 2. The Gateway target.
    this.target = new agentcore.CfnGatewayTarget(this, 'GatewayTarget', {
      gatewayIdentifier: binding.gatewayIdentifier,
      name: props.name,
      description: `runtime-isolation tool target ${props.name} (ADR-0034)`,
      credentialProviderConfigurations: [{ credentialProviderType: 'GATEWAY_IAM_ROLE' }],
      targetConfiguration: {
        mcp: {
          lambda: {
            lambdaArn: fn.functionArn,
            toolSchema: {
              inlinePayload: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema as never })),
            },
          },
        },
      },
    });
    this.target.node.addDependency(rows.resource);
    this.targetId = this.target.attrTargetId;

    // 3. The policy, after the target and deleted before it (ADR-0040).
    let policyFunction = binding.sameStack?.toolsGateway?.policyFunction;
    if (policyFunction === undefined) {
      policyFunction = customResourceFunction(
        this,
        'PolicyFunction',
        path.join(__dirname, 'tools', 'tool-policy.function.ts'),
        'runtime-isolation: the Cedar policy of one tool target (ADR-0040)',
        Duration.minutes(15),
      );
      grantPolicyWrites(policyFunction, binding.policyEngineArn);
    }
    const toolNames = tools.map((t) => t.name);
    this.policy = new CustomResource(this, 'Policy', {
      serviceToken: policyFunction.functionArn,
      resourceType: 'Custom::RuntimeIsolationToolPolicy',
      properties: {
        PolicyEngineId: binding.policyEngineId,
        Name: policyName(props.name),
        Statement: cedarPolicyFor(props.name, toolNames, binding.gatewayArn),
        ValidationMode: 'FAIL_ON_ANY_FINDINGS',
        TargetVersion: createHash('sha256').update(JSON.stringify(tools)).digest('hex').slice(0, 16),
      },
    });
    this.policy.node.addDependency(this.target);
    binding.sameStack?.toolsGateway?.registerTarget(this.policy);
    binding.sameStack?.registerToolTarget(this);
    this.policyId = this.policy.getAttString('PolicyId');

    // 4. The registry pointer (spec §4.4): no tool names, the catalogue holds them.
    this.registryParameterName = toolRegistryParameterName(binding.registryPrefix, props.name);
    const pointer = new ssm.StringParameter(this, 'RegistryPointer', {
      parameterName: this.registryParameterName,
      simpleName: false,
      stringValue: Stack.of(this).toJsonString({ gatewayTargetId: this.targetId, kind: props.kind, status: 'active', version: 1 }),
      description: `runtime-isolation: tool target ${props.name} (spec §4.4)`,
    });
    pointer.node.addDependency(this.policy);
  }
}

function bindingOf(scope: Construct, ingress: SharedIngress | SharedIngressRef, fail: (prop: string, message: string) => never): ToolsBinding {
  if (ingress instanceof SharedIngress) {
    if (Stack.of(ingress) !== Stack.of(scope)) {
      fail('ingress', 'a SharedIngress from another stack must be imported with SharedIngress.fromParameters(...)');
    }
    const tg = ingress.toolsGateway;
    if (tg === undefined) {
      fail('ingress', 'has toolsGateway: false; a ToolTarget needs a tools gateway (ADR-0034)');
    }
    return {
      registryPrefix: ingress.registryPrefix,
      gatewayIdentifier: tg!.gatewayIdentifier,
      gatewayArn: tg!.gatewayArn,
      gatewayRoleArn: tg!.gatewayRole.roleArn,
      policyEngineId: tg!.policyEngine.attrPolicyEngineId,
      policyEngineArn: tg!.policyEngine.attrPolicyEngineArn,
      contextKeyId: tg!.contextKey.keyId,
      contextKeyArn: tg!.contextKey.keyArn,
      entitlementsTableName: ingress.entitlementStore.tableName,
      entitlementsTableArn: ingress.entitlementStore.tableArn,
      sameStack: ingress,
      logDrain: ingress.logDrain,
    };
  }
  const tools = ingress.tools;
  if (tools === undefined || ingress.entitlementsTableName === undefined) {
    fail('ingress', 'must carry the tools gateway and the entitlement store (SharedIngress.fromParameters with toolsGateway on)');
  }
  const stack = Stack.of(scope);
  const tableArn = stack.formatArn({ service: 'dynamodb', resource: 'table', resourceName: ingress.entitlementsTableName });
  return {
    registryPrefix: ingress.registryPrefix,
    gatewayIdentifier: tools!.gatewayIdentifier,
    gatewayArn: stack.formatArn({ service: 'bedrock-agentcore', resource: 'gateway', resourceName: tools!.gatewayIdentifier }),
    gatewayRoleArn: tools!.gatewayRoleArn,
    policyEngineId: tools!.policyEngineId,
    policyEngineArn: stack.formatArn({ service: 'bedrock-agentcore', resource: 'policy-engine', resourceName: tools!.policyEngineId }),
    contextKeyId: tools!.contextKeyId,
    contextKeyArn: stack.formatArn({ service: 'kms', resource: 'key', resourceName: tools!.contextKeyId }),
    entitlementsTableName: ingress.entitlementsTableName!,
    entitlementsTableArn: tableArn,
  };
}

