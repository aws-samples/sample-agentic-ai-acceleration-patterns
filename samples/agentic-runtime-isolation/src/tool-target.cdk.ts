// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * `ToolTarget` (spec C-16, §3.5, §3.6; ADR-0034, ADR-0035, ADR-0040,
 * ADR-0041): one group of tools behind one of the ingress's tools gateways
 * (`gateway`, default `default`), in the ingress's stack or its own. It
 * creates, in this order:
 *
 * 1. the owner-marked rows in the entitlement store: `NAME#<target>` (one
 *    namespace with agent names), one `TOOL#<target>` / `TOOL#<tool>`
 *    catalogue row per tool, each carrying the target's `gateway`, which the
 *    ingress resolves the token's `aud` from, and the target's count row
 *    `GATEWAY#<gateway>` / `TARGET#<target>`, against which the deploy
 *    refuses a target that takes its gateway past `maxToolsPerGateway`
 *    catalogued tools or 100 targets, whatever stack the other targets came
 *    from (src/shared/reservation.function.ts);
 * 2. the Gateway target, by kind (below);
 * 3. the target's one Cedar star permit (src/shared/cedar.ts, ADR-0041)
 *    through a custom resource that DependsOn the target, so CloudFormation
 *    deletes the policy, and waits for it to be gone, BEFORE the target
 *    (V-14), and that runs after the previous target's policy in the same
 *    stack (one at a time); every update also touches the policy (C-16);
 * 4. the registry pointer `tools/<target>` (spec §4.4), with its `gateway`.
 *
 * Same-app targets are also counted at synth, per gateway (ADR-0040,
 * ADR-0041), so the common case fails before a deploy.
 *
 * Kinds (spec §3.5):
 *
 * | Kind | Target configuration | Outbound auth (`outboundAuth`) |
 * |---|---|---|
 * | `lambda` | `mcp.lambda`, the inline tool schema | `GATEWAY_IAM_ROLE` (the default; the only one) |
 * | `openApi` | `mcp.openApiSchema` from `spec` | `oauth` (3LO, OBO, M2M), `apiKey`, or `gatewayIamRole` with a SigV4 `service` |
 * | `smithy` | `mcp.smithyModel` from `spec` | `gatewayIamRole`, or `oauth` M2M |
 * | `mcpServer` | `mcp.mcpServer` at `endpoint` | `oauth` (3LO, OBO, M2M), `apiKey`, or `gatewayIamRole` with a SigV4 `service` |
 *
 * (the AgentCore developer guide's outbound authorization matrix). For a
 * non-Lambda target the Gateway drops arguments its schema does not declare,
 * so `_ri_ctx` never reaches it (V-10): the target learns its caller only
 * from the outbound credential. Only a per-user grant (3LO or OBO) keeps the
 * isolation enforced; any other outbound auth is vendor-shared, filtered
 * isolation (ADR-0034, review §5.3), and synth says so with the warning
 * `runtime-isolation:filtered-isolation` naming the target.
 */

import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { Annotations, CustomResource, Duration, Stack, Token } from 'aws-cdk-lib';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { cedarPolicyFor } from './shared/cedar';
import { customResourceFunction } from './shared/custom-resource.cdk';
import { gatewayTargetKey, nameKey, toolKey } from './shared/entitlements';
import type { LogDrain } from './shared/log-drain';
import { DEFAULT_TOOLS_GATEWAY, TOOLS_GATEWAY_NAME_PATTERN } from './shared/mint';
import { acknowledgeGranularFinding, nagFindingResource } from './shared/nag';
import { TARGET_NAME_PATTERN, TOOL_SHORT_NAME_PATTERN, toolRegistryParameterName } from './shared/registry';
import { OwnedRows, ownerProblem } from './shared/reservation.cdk';
import { SharedIngress, type SharedIngressRef } from './shared-ingress.cdk';
import { TOOL_ENV } from './tools/context';
import { DEFAULT_MAX_TOOLS_PER_GATEWAY, grantPolicyWrites, MAX_TOOL_TARGETS, type ToolsGateway } from './tools-gateway.cdk';

/** The most tools one target may hold (spec §3.5). */
export const MAX_TOOLS_PER_TARGET = 1000;

/** The synth warning for a target whose isolation is filtered, not enforced (ADR-0034, review §5.3). */
export const FILTERED_ISOLATION_WARNING = 'runtime-isolation:filtered-isolation';

export type ToolTargetKind = 'lambda' | 'openApi' | 'smithy' | 'mcpServer';

/** One tool of a target (spec §3.3); the catalogue holds its name. */
export interface ToolDefinition {
  /** `[a-z0-9_]{1,64}`; the catalogue name is `<target>/<name>`, the Gateway's `<target>___<name>`. */
  readonly name: string;
  readonly description: string;
  /**
   * `lambda`: JSON Schema of the arguments (required); `_ri_ctx` need not be
   * declared (V-10). Other kinds read it from their spec or server and
   * ignore this.
   */
  readonly inputSchema?: Record<string, unknown>;
}

/** An OpenAPI document or Smithy model (JSON AST): inline, or an S3 object the Gateway role reads. */
export interface ToolSpec {
  readonly inlinePayload?: string;
  /** `s3://<bucket>/<key>`. */
  readonly s3Uri?: string;
  readonly bucketOwnerAccountId?: string;
}

/** OAuth grant: `3LO` (authorization code, per user), `OBO` (token exchange, per user), `M2M` (client credentials, vendor-shared). */
export type OAuthGrant = '3LO' | 'OBO' | 'M2M';

/**
 * How the Gateway authenticates to the target (exactly one key). The
 * credential providers are AgentCore Identity's; their secrets are read by
 * the Gateway role, so the secret ARN is needed for its grant.
 */
export type OutboundAuth =
  | {
    /** SigV4 with the Gateway role. `service` (and `region`) only for `openApi` and `mcpServer`, where it is required. */
    readonly gatewayIamRole: { readonly service?: string; readonly region?: string };
  }
  | {
    readonly oauth: {
      readonly providerArn: string;
      readonly secretArn: string;
      readonly scopes: string[];
      readonly grant: OAuthGrant;
      readonly defaultReturnUrl?: string;
      readonly customParameters?: Record<string, string>;
    };
  }
  | {
    readonly apiKey: {
      readonly providerArn: string;
      readonly secretArn: string;
      readonly location: 'HEADER' | 'QUERY_PARAMETER';
      /** The header or query parameter name. */
      readonly name: string;
      /** For example `Bearer`. */
      readonly prefix?: string;
    };
  };

export interface ToolTargetProps {
  /** `[a-z0-9-]{1,32}`; one namespace with agent names (ADR-0035). */
  readonly name: string;
  /** The ingress whose tools gateway this target joins (same stack), or its published values. */
  readonly ingress: SharedIngress | SharedIngressRef;
  /** (ADR-0041) The name of the ingress's tools gateway this target joins. Default `default`. */
  readonly gateway?: string;
  readonly kind: ToolTargetKind;
  /**
   * The tools, at least one, at most 1,000: what the catalogue holds and a
   * grant can name. For `openApi` with an inline document each name must be
   * an `operationId` of it; for `smithy` and `mcpServer` they are the names
   * the Gateway lists (`<target>___<name>`).
   */
  readonly tools?: ToolDefinition[];
  /** `lambda`: the function that serves every tool of the target (see src/tools/context.ts `toolHandler`). */
  readonly function?: lambda.Function;
  /** `openApi` / `smithy`: the document. */
  readonly spec?: ToolSpec;
  /** `mcpServer`: the server's https endpoint. */
  readonly endpoint?: string;
  /** Outbound auth. `lambda`: the Gateway role (default, the only choice). Required for the other kinds. */
  readonly outboundAuth?: OutboundAuth;
  /** The tool's tenant role (spec §6.1, `lambda` only): trusts this function's role, requires the `TenantId` tag, scopes data by it. */
  readonly tvm?: { readonly role: iam.IRole };
  /** An explicit owner marker for the catalogue and name rows; default `<StackId>#<LogicalResourceId>`. */
  readonly owner?: string;
  /**
   * The gateway's `maxToolsPerGateway` for the deploy-time check when the
   * ingress is in another stack. Same-stack targets read it from the
   * gateway. Default 300.
   */
  readonly maxToolsPerGateway?: number;
}

/** What `ToolTarget` needs from the ingress, resolved from either form. */
interface ToolsBinding {
  readonly gatewayName: string;
  readonly registryPrefix: string;
  readonly gatewayIdentifier: string;
  readonly gatewayArn: string;
  readonly gatewayRoleArn: string;
  /** The Gateway's physical name, for its workload identity `<physicalName>-*`; across stacks, the published identifier less its `-<suffix>`. */
  readonly gatewayPhysicalName: string;
  readonly policyEngineId: string;
  readonly policyEngineArn: string;
  readonly contextKeyId: string;
  readonly contextKeyArn: string;
  readonly entitlementsTableName: string;
  readonly entitlementsTableArn: string;
  readonly maxToolsPerGateway: number;
  /** The same-app gateway construct, when the ingress is in this stack. */
  readonly sameStack?: ToolsGateway;
  readonly logDrain?: LogDrain;
}

/** The Gateway's physical name from its identifier, `<physicalName>-<suffix>`: everything before the last `-`. */
export function gatewayPhysicalNameOf(gatewayIdentifier: string): string {
  const cut = gatewayIdentifier.lastIndexOf('-');
  if (cut <= 0 || cut === gatewayIdentifier.length - 1) {
    throw new Error(`ToolTarget: gateway identifier '${gatewayIdentifier}' is not <name>-<suffix>`);
  }
  return gatewayIdentifier.slice(0, cut);
}

/**
 * A Cedar policy name, `[A-Za-z][A-Za-z0-9_]*`, at most 48 characters: the
 * target name, then 8 hex of a hash of `owner` (the stack, construct path and
 * gateway). `CreatePolicy` names are unique within the account and Region,
 * not the engine (ConflictException, integ runs 3 and 4 2026-11-03), so two
 * stacks with a target of the same name, or a target moving to another
 * gateway (the new policy is created before the old one is deleted), need
 * different names.
 */
export function policyName(target: string, owner: string): string {
  const suffix = createHash('sha256').update(owner).digest('hex').slice(0, 8);
  return `${target.replace(/-/g, '_')}_target_${suffix}`;
}

/** Why the tool list of a target is refused, or undefined. `lambda` also needs an input schema per tool. */
export function toolDefinitionsProblem(tools: readonly ToolDefinition[] | undefined, kind: ToolTargetKind = 'lambda'): string | undefined {
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
    if (kind === 'lambda' && (tool.inputSchema === undefined || typeof tool.inputSchema !== 'object')) {
      return `tool '${tool.name}' needs an inputSchema with kind 'lambda'`;
    }
  }
  if (new Set(tools.map((t) => t.name)).size !== tools.length) {
    return 'must not repeat a tool name';
  }
  return undefined;
}

/** Which outbound auth each kind accepts (the AgentCore outbound authorization matrix). */
const ALLOWED_AUTH: Record<ToolTargetKind, readonly ('gatewayIamRole' | 'oauth' | 'apiKey')[]> = {
  lambda: ['gatewayIamRole'],
  openApi: ['oauth', 'apiKey', 'gatewayIamRole'],
  smithy: ['gatewayIamRole', 'oauth'],
  mcpServer: ['oauth', 'apiKey', 'gatewayIamRole'],
};

const GRANT_TYPE: Record<OAuthGrant, string> = { '3LO': 'AUTHORIZATION_CODE', 'OBO': 'TOKEN_EXCHANGE', 'M2M': 'CLIENT_CREDENTIALS' };

/** The one key of an `OutboundAuth`. */
export function outboundAuthKind(auth: OutboundAuth): 'gatewayIamRole' | 'oauth' | 'apiKey' {
  const keys = Object.keys(auth).filter((k) => ['gatewayIamRole', 'oauth', 'apiKey'].includes(k));
  if (keys.length !== 1) {
    throw new Error('ToolTarget: outboundAuth must name exactly one of gatewayIamRole, oauth or apiKey');
  }
  return keys[0] as 'gatewayIamRole' | 'oauth' | 'apiKey';
}

/** Whether the target's isolation is enforced per user (ADR-0034): Lambda (C-15b), or a 3LO or OBO grant. */
export function enforcesIsolation(kind: ToolTargetKind, auth: OutboundAuth | undefined): boolean {
  if (kind === 'lambda') {
    return true;
  }
  return auth !== undefined && 'oauth' in auth && (auth.oauth.grant === '3LO' || auth.oauth.grant === 'OBO');
}

/** Why `outboundAuth` is refused for `kind`, or undefined. */
export function outboundAuthProblem(kind: ToolTargetKind, auth: OutboundAuth | undefined): string | undefined {
  if (auth === undefined) {
    return kind === 'lambda' ? undefined : `is required with kind '${kind}'`;
  }
  let which: 'gatewayIamRole' | 'oauth' | 'apiKey';
  try {
    which = outboundAuthKind(auth);
  } catch (error) {
    return (error as Error).message.replace('ToolTarget: outboundAuth ', '');
  }
  if (!ALLOWED_AUTH[kind].includes(which)) {
    return `${which} is not supported with kind '${kind}' (supported: ${ALLOWED_AUTH[kind].join(', ')})`;
  }
  if ('gatewayIamRole' in auth) {
    const sigv4 = kind === 'openApi' || kind === 'mcpServer';
    if (sigv4 && (auth.gatewayIamRole.service === undefined || auth.gatewayIamRole.service.length === 0)) {
      return `gatewayIamRole.service (the SigV4 signing name) is required with kind '${kind}'`;
    }
    if (!sigv4 && (auth.gatewayIamRole.service !== undefined || auth.gatewayIamRole.region !== undefined)) {
      return `gatewayIamRole takes no service or region with kind '${kind}'`;
    }
  }
  if ('oauth' in auth) {
    if (!Object.prototype.hasOwnProperty.call(GRANT_TYPE, auth.oauth.grant)) {
      return `oauth.grant must be '3LO', 'OBO' or 'M2M' (got ${String(auth.oauth.grant)})`;
    }
    if (kind === 'smithy' && auth.oauth.grant !== 'M2M') {
      return "oauth.grant must be 'M2M' with kind 'smithy'";
    }
    if (auth.oauth.scopes.length > 100) {
      return 'oauth.scopes must hold at most 100 scopes';
    }
  }
  const provider = 'oauth' in auth ? auth.oauth : 'apiKey' in auth ? auth.apiKey : undefined;
  if (provider !== undefined) {
    if (!Token.isUnresolved(provider.providerArn) && !/^arn:[^:]+:bedrock-agentcore:[^:]*:\d{12}:token-vault\/.+/.test(provider.providerArn)) {
      return 'providerArn must be an AgentCore Identity credential provider ARN (token-vault/...)';
    }
    if (!Token.isUnresolved(provider.secretArn) && !/^arn:[^:]+:secretsmanager:/.test(provider.secretArn)) {
      return 'secretArn must be the provider\'s Secrets Manager secret ARN';
    }
  }
  if ('apiKey' in auth && !/^[A-Za-z0-9_-]{1,64}$/.test(auth.apiKey.name)) {
    return 'apiKey.name must be a header or query parameter name of at most 64 characters';
  }
  return undefined;
}

/** The `credentialProviderConfigurations` of a target (spec §3.5). */
export function credentialProviderConfigurations(
  kind: ToolTargetKind,
  auth: OutboundAuth | undefined,
): agentcore.CfnGatewayTarget.CredentialProviderConfigurationProperty[] {
  if (auth === undefined || 'gatewayIamRole' in auth) {
    const sigv4 = auth !== undefined && (kind === 'openApi' || kind === 'mcpServer');
    return [
      sigv4
        ? {
          credentialProviderType: 'GATEWAY_IAM_ROLE',
          credentialProvider: { iamCredentialProvider: { service: auth.gatewayIamRole.service!, region: auth.gatewayIamRole.region } },
        }
        : { credentialProviderType: 'GATEWAY_IAM_ROLE' },
    ];
  }
  if ('oauth' in auth) {
    return [
      {
        credentialProviderType: 'OAUTH',
        credentialProvider: {
          oauthCredentialProvider: {
            providerArn: auth.oauth.providerArn,
            scopes: auth.oauth.scopes,
            grantType: GRANT_TYPE[auth.oauth.grant],
            defaultReturnUrl: auth.oauth.defaultReturnUrl,
            customParameters: auth.oauth.customParameters,
          },
        },
      },
    ];
  }
  return [
    {
      credentialProviderType: 'API_KEY',
      credentialProvider: {
        apiKeyCredentialProvider: {
          providerArn: auth.apiKey.providerArn,
          credentialLocation: auth.apiKey.location,
          credentialParameterName: auth.apiKey.name,
          credentialPrefix: auth.apiKey.prefix,
        },
      },
    },
  ];
}

/** Why a spec is refused, or undefined: exactly one of `inlinePayload` and an `s3://` `s3Uri`. */
export function specProblem(spec: ToolSpec | undefined): string | undefined {
  if (spec === undefined) {
    return 'is required';
  }
  const inline = spec.inlinePayload !== undefined;
  const s3 = spec.s3Uri !== undefined;
  if (inline === s3) {
    return 'must set exactly one of inlinePayload and s3Uri';
  }
  if (s3 && !Token.isUnresolved(spec.s3Uri) && !/^s3:\/\/[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]\/.+/.test(spec.s3Uri!)) {
    return 's3Uri must be s3://<bucket>/<key>';
  }
  if (inline && !Token.isUnresolved(spec.inlinePayload) && spec.inlinePayload!.length === 0) {
    return 'inlinePayload must not be empty';
  }
  return undefined;
}

/** The `operationId`s of an inline OpenAPI document (JSON), or undefined when it is not JSON. */
export function openApiOperationIds(document: string): Set<string> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(document);
  } catch {
    return undefined;
  }
  const ids = new Set<string>();
  const paths = (parsed as { paths?: Record<string, Record<string, unknown>> } | null)?.paths ?? {};
  for (const item of Object.values(paths)) {
    for (const operation of Object.values(item ?? {})) {
      const id = (operation as { operationId?: unknown } | null)?.operationId;
      if (typeof id === 'string') {
        ids.add(id);
      }
    }
  }
  return ids;
}

/** The `targetConfiguration.mcp` of a target (spec §3.5). */
function mcpConfiguration(
  kind: ToolTargetKind,
  props: ToolTargetProps,
  tools: readonly ToolDefinition[],
): agentcore.CfnGatewayTarget.McpTargetConfigurationProperty {
  const schema = (spec: ToolSpec): agentcore.CfnGatewayTarget.ApiSchemaConfigurationProperty =>
    spec.inlinePayload !== undefined
      ? { inlinePayload: spec.inlinePayload }
      : { s3: { uri: spec.s3Uri, bucketOwnerAccountId: spec.bucketOwnerAccountId } };
  switch (kind) {
    case 'lambda':
      return {
        lambda: {
          lambdaArn: props.function!.functionArn,
          toolSchema: { inlinePayload: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema as never })) },
        },
      };
    case 'openApi':
      return { openApiSchema: schema(props.spec!) };
    case 'smithy':
      return { smithyModel: schema(props.spec!) };
    case 'mcpServer':
      return { mcpServer: { endpoint: props.endpoint! } };
  }
}

/** `arn:...:s3:::<bucket>/<key>` from `s3://<bucket>/<key>`. */
function s3ObjectArn(stack: Stack, uri: string): string {
  return `arn:${stack.partition}:s3:::${uri.replace(/^s3:\/\//, '')}`;
}

export class ToolTarget extends Construct {
  readonly name: string;
  readonly kind: ToolTargetKind;
  /** The Gateway target id. */
  readonly targetId: string;
  /** The tool names, as given. */
  readonly tools: readonly string[];
  /** (ADR-0041) The tools gateway this target is on. */
  readonly gateway: string;
  /** Whether the isolation is enforced per user (Lambda, 3LO, OBO) or filtered (ADR-0034). */
  readonly isolation: 'enforced' | 'filtered';
  /** The Cedar policy id (a deploy-time token). */
  readonly policyId: string;
  /** Seconds the policy took from CreatePolicy (or UpdatePolicy) to ACTIVE (a deploy-time token; integ step 23). */
  readonly policySecondsToActive: string;
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
    const kind = props.kind;
    if (!['lambda', 'openApi', 'smithy', 'mcpServer'].includes(kind)) {
      fail('kind', `must be 'lambda', 'openApi', 'smithy' or 'mcpServer' (got ${String(kind)})`);
    }
    const toolsProblem = toolDefinitionsProblem(props.tools, kind);
    if (toolsProblem !== undefined) {
      fail('tools', toolsProblem);
    }
    if (kind === 'lambda') {
      if (props.function === undefined) {
        fail('function', "is required with kind 'lambda'");
      }
    } else {
      if (props.function !== undefined) {
        fail('function', `is for kind 'lambda' only (got kind '${kind}')`);
      }
      if (props.tvm !== undefined) {
        fail('tvm', `is for kind 'lambda' only: a '${kind}' target reaches data with its own outbound credential`);
      }
    }
    if (kind === 'openApi' || kind === 'smithy') {
      const problem = specProblem(props.spec);
      if (problem !== undefined) {
        fail('spec', problem);
      }
    } else if (props.spec !== undefined) {
      fail('spec', `is for kinds 'openApi' and 'smithy' only (got kind '${kind}')`);
    }
    if (kind === 'mcpServer') {
      if (props.endpoint === undefined || (!Token.isUnresolved(props.endpoint) && !/^https:\/\/[^\s/]+(\/\S*)?$/.test(props.endpoint))) {
        fail('endpoint', "must be the MCP server's https URL with kind 'mcpServer'");
      }
    } else if (props.endpoint !== undefined) {
      fail('endpoint', `is for kind 'mcpServer' only (got kind '${kind}')`);
    }
    const authProblem = outboundAuthProblem(kind, props.outboundAuth);
    if (authProblem !== undefined) {
      fail('outboundAuth', authProblem);
    }
    const tools = props.tools!;
    if (kind === 'openApi' && props.spec?.inlinePayload !== undefined && !Token.isUnresolved(props.spec.inlinePayload)) {
      const ids = openApiOperationIds(props.spec.inlinePayload);
      const missing = ids === undefined ? [] : tools.map((t) => t.name).filter((n) => !ids.has(n));
      if (missing.length > 0) {
        fail('tools', `name ${missing.map((n) => `'${n}'`).join(', ')} is not an operationId of the inline OpenAPI document`);
      }
    }
    const owner = ownerProblem(props.owner);
    if (owner !== undefined) {
      fail('owner', owner);
    }
    const gatewayName = props.gateway ?? DEFAULT_TOOLS_GATEWAY;
    if (!TOOLS_GATEWAY_NAME_PATTERN.test(gatewayName)) {
      fail('gateway', `must match ${TOOLS_GATEWAY_NAME_PATTERN.source} (got ${gatewayName})`);
    }
    const binding = bindingOf(this, props, gatewayName, fail);
    const stack = Stack.of(this);
    this.name = props.name;
    this.kind = kind;
    this.tools = tools.map((t) => t.name);
    this.gateway = gatewayName;
    this.isolation = enforcesIsolation(kind, props.outboundAuth) ? 'enforced' : 'filtered';
    if (this.isolation === 'filtered') {
      // ADR-0034, review §5.3: no _ri_ctx reaches a non-Lambda target (V-10) and the outbound credential is not per user.
      Annotations.of(this).addWarningV2(
        FILTERED_ISOLATION_WARNING,
        `ToolTarget '${props.name}' (${kind}) has filtered isolation, not enforced: the tenant context cannot reach a ${kind} target (V-10) and its outbound auth is vendor-shared. Use an OAuth 3LO or OBO grant for per-user access, and say so in the README (ADR-0034).`,
      );
    }
    // ADR-0041: the gateway's Policy engine schema holds about 330 tools; count the same-app ones at synth.
    const overflow = binding.sameStack?.reserveTools(props.name, tools.length);
    if (overflow !== undefined) {
      fail('tools', overflow);
    }

    // 1. Owner-marked rows (ADR-0035): the name first, then the catalogue, then the gateway count row,
    // checked at deploy against every target of the gateway (ADR-0040, ADR-0041).
    const rows = new OwnedRows(this, 'Catalogue', {
      tableName: binding.entitlementsTableName,
      tableArn: binding.entitlementsTableArn,
      owner: props.owner,
      logDrain: binding.logDrain,
      rows: [
        { ...nameKey(props.name), attributes: { kind: 'target' } },
        ...tools.map((t) => ({ ...toolKey(props.name, t.name), attributes: { description: t.description, gateway: gatewayName } })),
        { ...gatewayTargetKey(gatewayName, props.name), attributes: { tools: String(tools.length) } },
      ],
      gatewayLimit: {
        Gateway: gatewayName,
        Target: props.name,
        Tools: String(tools.length),
        MaxTools: String(binding.maxToolsPerGateway),
        MaxTargets: String(MAX_TOOL_TARGETS),
      },
    });

    // The Gateway role, for the grants below.
    const gatewayRole: iam.IRole =
      binding.sameStack?.gatewayRole ?? iam.Role.fromRoleArn(this, 'GatewayRole', binding.gatewayRoleArn, { mutable: true });

    if (kind === 'lambda') {
      const fn = props.function!;
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
        gatewayRole.addToPrincipalPolicy(new iam.PolicyStatement({ actions: ['lambda:InvokeFunction'], resources: [fn.functionArn] }));
      }
    } else {
      this.grantOutbound(gatewayRole, binding, props);
    }

    // 2. The Gateway target.
    this.target = new agentcore.CfnGatewayTarget(this, 'GatewayTarget', {
      gatewayIdentifier: binding.gatewayIdentifier,
      name: props.name,
      description: `runtime-isolation tool target ${props.name} (${kind}, ${this.isolation} isolation; ADR-0034)`,
      credentialProviderConfigurations: credentialProviderConfigurations(kind, props.outboundAuth),
      targetConfiguration: { mcp: mcpConfiguration(kind, props, tools) },
    });
    this.target.node.addDependency(rows.resource);
    if (binding.sameStack === undefined) {
      // The cross-stack role's grants are a policy of this stack: in place before the target.
      this.target.node.addDependency(gatewayRole);
    }
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
      grantPolicyWrites(policyFunction, binding.policyEngineArn, binding.gatewayArn);
    }
    this.policy = new CustomResource(this, 'Policy', {
      serviceToken: policyFunction.functionArn,
      resourceType: 'Custom::RuntimeIsolationToolPolicy',
      properties: {
        PolicyEngineId: binding.policyEngineId,
        Name: policyName(props.name, `${stack.stackName}/${this.node.path}/${gatewayName}`),
        Statement: cedarPolicyFor(props.name, binding.gatewayArn),
        ValidationMode: 'FAIL_ON_ANY_FINDINGS',
        // The text names no tool, so a tool change only touches the policy through this (C-16).
        TargetVersion: createHash('sha256')
          .update(JSON.stringify({ tools, kind, endpoint: props.endpoint, spec: props.spec }))
          .digest('hex')
          .slice(0, 16),
      },
    });
    this.policy.node.addDependency(this.target);
    binding.sameStack?.registerTarget(this.policy);
    this.policyId = this.policy.getAttString('PolicyId');
    this.policySecondsToActive = this.policy.getAttString('SecondsToActive');

    // 4. The registry pointer (spec §4.4): no tool names, the catalogue holds them.
    this.registryParameterName = toolRegistryParameterName(binding.registryPrefix, props.name);
    const pointer = new ssm.StringParameter(this, 'RegistryPointer', {
      parameterName: this.registryParameterName,
      simpleName: false,
      stringValue: stack.toJsonString({ gatewayTargetId: this.targetId, gateway: gatewayName, kind, status: 'active', version: 1 }),
      description: `runtime-isolation: tool target ${props.name} (spec §4.4)`,
    });
    pointer.node.addDependency(this.policy);
  }

  /**
   * The Gateway role's grants for a non-Lambda target (AgentCore developer
   * guide, outbound authorization): the workload access token and the
   * provider's token or key and secret for OAuth and API keys, read access
   * to an S3-hosted spec.
   */
  private grantOutbound(role: iam.IRole, binding: ToolsBinding, props: ToolTargetProps): void {
    const stack = Stack.of(this);
    const auth = props.outboundAuth!;
    const provider = 'oauth' in auth ? auth.oauth : 'apiKey' in auth ? auth.apiKey : undefined;
    if (provider !== undefined) {
      const directory = stack.formatArn({ service: 'bedrock-agentcore', resource: 'workload-identity-directory', resourceName: 'default' });
      const identity = `${directory}/workload-identity/${binding.gatewayPhysicalName}-*`;
      role.addToPrincipalPolicy(
        new iam.PolicyStatement({ actions: ['bedrock-agentcore:GetWorkloadAccessToken'], resources: [directory, identity] }),
      );
      role.addToPrincipalPolicy(
        new iam.PolicyStatement({
          actions: ['oauth' in auth ? 'bedrock-agentcore:GetResourceOauth2Token' : 'bedrock-agentcore:GetResourceApiKey'],
          resources: [provider.providerArn],
        }),
      );
      role.addToPrincipalPolicy(new iam.PolicyStatement({ actions: ['secretsmanager:GetSecretValue'], resources: [provider.secretArn] }));
      if (role instanceof iam.Role) {
        acknowledgeGranularFinding(
          role,
          `AwsSolutions-IAM5[Resource::${nagFindingResource(role, identity)}]`,
          "The gateway's own workload identity, named by its name pattern: AgentCore suffixes it at create time (ADR-0034, M-58).",
        );
      }
    }
    if (props.spec?.s3Uri !== undefined) {
      role.addToPrincipalPolicy(new iam.PolicyStatement({ actions: ['s3:GetObject'], resources: [s3ObjectArn(stack, props.spec.s3Uri)] }));
    }
  }
}

function bindingOf(scope: Construct, props: ToolTargetProps, gatewayName: string, fail: (prop: string, message: string) => never): ToolsBinding {
  const ingress = props.ingress;
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
      gatewayPhysicalName: tg!.physicalName,
      policyEngineId: tg!.policyEngine.attrPolicyEngineId,
      policyEngineArn: tg!.policyEngine.attrPolicyEngineArn,
      contextKeyId: tg!.contextKey.keyId,
      contextKeyArn: tg!.contextKey.keyArn,
      entitlementsTableName: ingress.entitlementStore.tableName,
      entitlementsTableArn: ingress.entitlementStore.tableArn,
      maxToolsPerGateway: tg!.maxToolsPerGateway,
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
  const max = props.maxToolsPerGateway ?? DEFAULT_MAX_TOOLS_PER_GATEWAY;
  if (!Number.isInteger(max) || max < 1) {
    fail('maxToolsPerGateway', `must be a positive integer (got ${String(max)})`);
  }
  const stack = Stack.of(scope);
  const tableArn = stack.formatArn({ service: 'dynamodb', resource: 'table', resourceName: ingress.entitlementsTableName });
  return {
    gatewayName,
    registryPrefix: ingress.registryPrefix,
    gatewayIdentifier: tools!.gatewayIdentifier,
    // The identifier is `<physicalName>-<suffix>` (ToolsGateway), so the workload-identity
    // grant names this gateway's identities, not every gateway's in the account.
    gatewayPhysicalName: gatewayPhysicalNameOf(tools!.gatewayIdentifier),
    gatewayArn: stack.formatArn({ service: 'bedrock-agentcore', resource: 'gateway', resourceName: tools!.gatewayIdentifier }),
    gatewayRoleArn: tools!.gatewayRoleArn,
    policyEngineId: tools!.policyEngineId,
    policyEngineArn: stack.formatArn({ service: 'bedrock-agentcore', resource: 'policy-engine', resourceName: tools!.policyEngineId }),
    contextKeyId: tools!.contextKeyId,
    contextKeyArn: stack.formatArn({ service: 'kms', resource: 'key', resourceName: tools!.contextKeyId }),
    entitlementsTableName: ingress.entitlementsTableName!,
    entitlementsTableArn: tableArn,
    maxToolsPerGateway: max,
  };
}
