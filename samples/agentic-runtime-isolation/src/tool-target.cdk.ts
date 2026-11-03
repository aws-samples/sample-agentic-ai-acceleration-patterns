// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * `ToolTarget` (spec C-16, §3.5, §3.6; ADR-0034, ADR-0035, ADR-0040,
 * ADR-0041): one group of tools behind one of the ingress's tools gateways
 * (`gateway`, default `default`), in the ingress's stack or its own. It
 * creates, in this order:
 *
 * 1. the owner-marked rows in the entitlement store: `NAME#<target>` (one
 *    namespace with agent names) and one `TOOL#<target>` / `TOOL#<tool>`
 *    catalogue row per tool, each carrying the target's `gateway`, which the
 *    ingress resolves the token's `aud` from (src/shared/reservation.function.ts);
 * 2. the Gateway target (`GATEWAY_IAM_ROLE` outbound for a Lambda), with the
 *    function's resource policy naming the Gateway role alone (M-61);
 * 3. the target's one Cedar star permit (src/shared/cedar.ts, ADR-0041)
 *    through a custom
 *    resource that DependsOn the target, so CloudFormation deletes the
 *    policy, and waits for it to be gone, BEFORE the target (V-14), and
 *    that runs after the previous target's policy in the same stack (one at
 *    a time); every update also touches the policy (C-16);
 * 4. the registry pointer `tools/<target>` (spec §4.4), with its `gateway`.
 *
 * Same-app targets are counted per gateway: synth fails when their
 * catalogued tools would exceed the gateway's `maxToolsPerGateway`
 * (ADR-0041) or their number the 100-target quota (ADR-0040).
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
import { DEFAULT_TOOLS_GATEWAY, TOOLS_GATEWAY_NAME_PATTERN } from './shared/mint';
import { TARGET_NAME_PATTERN, TOOL_SHORT_NAME_PATTERN, toolRegistryParameterName } from './shared/registry';
import { OwnedRows, ownerProblem } from './shared/reservation.cdk';
import { SharedIngress, type SharedIngressRef } from './shared-ingress.cdk';
import { TOOL_ENV } from './tools/context';
import { grantPolicyWrites, type ToolsGateway } from './tools-gateway.cdk';

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
  /** (ADR-0041) The name of the ingress's tools gateway this target joins. Default `default`. */
  readonly gateway?: string;
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
  readonly gatewayName: string;
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
  /** The same-app gateway construct, when the ingress is in this stack. */
  readonly sameStack?: ToolsGateway;
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
  /** (ADR-0041) The tools gateway this target is on. */
  readonly gateway: string;
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
    const gatewayName = props.gateway ?? DEFAULT_TOOLS_GATEWAY;
    if (!TOOLS_GATEWAY_NAME_PATTERN.test(gatewayName)) {
      fail('gateway', `must match ${TOOLS_GATEWAY_NAME_PATTERN.source} (got ${gatewayName})`);
    }
    const binding = bindingOf(this, props.ingress, gatewayName, fail);
    const tools = props.tools!;
    const fn = props.function!;
    this.name = props.name;
    this.tools = tools.map((t) => t.name);
    this.gateway = gatewayName;
    // ADR-0041: the gateway's Policy engine schema holds about 330 tools; count the same-app ones.
    // TODO(v2): a ToolTarget in another stack is not counted; enforce it at deploy from the catalogue rows.
    const overflow = binding.sameStack?.reserveTools(props.name, tools.length);
    if (overflow !== undefined) {
      fail('tools', overflow);
    }

    // 1. Owner-marked rows (ADR-0035): the name first, then the catalogue.
    const rows = new OwnedRows(this, 'Catalogue', {
      tableName: binding.entitlementsTableName,
      tableArn: binding.entitlementsTableArn,
      owner: props.owner,
      logDrain: binding.logDrain,
      rows: [
        { ...nameKey(props.name), attributes: { kind: 'target' } },
        ...tools.map((t) => ({ ...toolKey(props.name, t.name), attributes: { description: t.description, gateway: gatewayName } })),
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
    if (binding.sameStack !== undefined) {
      binding.sameStack.allowInvoke(fn);
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

    // 3. The one star permit, after the target and deleted before it (ADR-0040, ADR-0041).
    let policyFunction = binding.sameStack?.policyFunction;
    if (policyFunction === undefined) {
      policyFunction = customResourceFunction(
        this,
        'PolicyFunction',
        path.join(__dirname, 'tools', 'tool-policy.function.ts'),
        'runtime-isolation: the Cedar star permit of one tool target (ADR-0040, ADR-0041)',
        Duration.minutes(15),
      );
      grantPolicyWrites(policyFunction, binding.policyEngineArn);
    }
    this.policy = new CustomResource(this, 'Policy', {
      serviceToken: policyFunction.functionArn,
      resourceType: 'Custom::RuntimeIsolationToolPolicy',
      properties: {
        PolicyEngineId: binding.policyEngineId,
        Name: policyName(props.name),
        Statement: cedarPolicyFor(props.name, binding.gatewayArn),
        ValidationMode: 'FAIL_ON_ANY_FINDINGS',
        // The text names no tool, so a tool change only touches the policy through this (C-16).
        TargetVersion: createHash('sha256').update(JSON.stringify(tools)).digest('hex').slice(0, 16),
      },
    });
    this.policy.node.addDependency(this.target);
    binding.sameStack?.registerTarget(this.policy);
    this.policyId = this.policy.getAttString('PolicyId');

    // 4. The registry pointer (spec §4.4): no tool names, the catalogue holds them.
    this.registryParameterName = toolRegistryParameterName(binding.registryPrefix, props.name);
    const pointer = new ssm.StringParameter(this, 'RegistryPointer', {
      parameterName: this.registryParameterName,
      simpleName: false,
      stringValue: Stack.of(this).toJsonString({ gatewayTargetId: this.targetId, gateway: gatewayName, kind: props.kind, status: 'active', version: 1 }),
      description: `runtime-isolation: tool target ${props.name} (spec §4.4)`,
    });
    pointer.node.addDependency(this.policy);
  }
}

function bindingOf(
  scope: Construct,
  ingress: SharedIngress | SharedIngressRef,
  gatewayName: string,
  fail: (prop: string, message: string) => never,
): ToolsBinding {
  if (ingress instanceof SharedIngress) {
    if (Stack.of(ingress) !== Stack.of(scope)) {
      fail('ingress', 'a SharedIngress from another stack must be imported with SharedIngress.fromParameters(...)');
    }
    const names = Object.keys(ingress.toolsGateways);
    if (names.length === 0) {
      fail('ingress', 'has toolsGateway: false; a ToolTarget needs a tools gateway (ADR-0034)');
    }
    const tg = ingress.toolsGatewayNamed(gatewayName);
    if (tg === undefined) {
      fail('gateway', `'${gatewayName}' is not a tools gateway of the ingress (it has ${names.map((n) => `'${n}'`).join(', ')}; ADR-0041)`);
    }
    return {
      gatewayName,
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
      sameStack: tg!,
      logDrain: ingress.logDrain,
    };
  }
  const known = ingress.toolsGateways ?? (ingress.tools === undefined ? {} : { [DEFAULT_TOOLS_GATEWAY]: ingress.tools });
  if (Object.keys(known).length === 0 || ingress.entitlementsTableName === undefined) {
    fail('ingress', 'must carry the tools gateway and the entitlement store (SharedIngress.fromParameters with toolsGateway on)');
  }
  const tools = Object.prototype.hasOwnProperty.call(known, gatewayName) ? known[gatewayName] : undefined;
  if (tools === undefined) {
    fail('gateway', `'${gatewayName}' is not a tools gateway of the ingress reference (it has ${Object.keys(known).map((n) => `'${n}'`).join(', ')}; ADR-0041)`);
  }
  const stack = Stack.of(scope);
  const tableArn = stack.formatArn({ service: 'dynamodb', resource: 'table', resourceName: ingress.entitlementsTableName });
  return {
    gatewayName,
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

