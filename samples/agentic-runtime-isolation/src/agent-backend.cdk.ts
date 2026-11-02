// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * `AgentBackend` (ADR-0024; v2, ADR-0032, ADR-0035): one agent product
 * behind a `SharedIngress`, in the same stack or in its own. It creates the
 * AgentCore Runtime (ADR-0011), tagged `ri:ingress = <ingressId>` so the
 * ingress role's invoke grant applies; writes the Runtime's resource policy
 * naming the ingress role alone (P-1, ADR-0001); on the `agentcore-gateway`
 * ingress adds the Gateway target named after the backend (ADR-0010); adds
 * its one-model statement to the ingress's tenant role (ADR-0018); reserves
 * `NAME#<name>` in the entitlement store with an owner marker (ADR-0035);
 * and last writes its registry entry `{ runtimeArn, needs, tools, version,
 * status }`, which is what makes the route live. Creating, changing or
 * removing a backend never redeploys the ingress.
 *
 * (v2) `scopes`, `identityApi` and `scopeOwner` are removed: the backend no
 * longer registers scopes with the identity provider (ADR-0030). Its
 * `needs` and `tools` are data in its registry entry, and the grant rule
 * decides what a caller may do with it.
 */

import { Duration, Stack, Token } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { AgentCoreRuntimeBackend } from './backend/agentcore-runtime.cdk';
import { AGENT_ENV } from './shared/config';
import { nameKey } from './shared/entitlements';
import { LogDrain } from './shared/log-drain';
import { backendNeedsProblem, backendToolsProblem, BACKEND_NAME_PATTERN, INGRESS_TAG_KEY, ROUTE } from './shared/registry';
import { LONGEST_STREAM, RegistryEntryResource } from './shared/registry-entry.cdk';
import { OwnedRows, ownerProblem } from './shared/reservation.cdk';
import { addModelStatement, SharedIngress, type SharedIngressRef } from './shared-ingress.cdk';

/** The agent the backend runs. */
export interface AgentProps {
  /** Directory with the agent's `app.js` (a Node HTTP server on port 8080), uploaded as the Runtime's code. */
  readonly codePath: string;
  /** The one Bedrock model id the tenant role may invoke for this backend (P-6, ADR-0018). */
  readonly modelId: string;
  /** Environment variables for the agent process. Configuration only; never a secret. */
  readonly environment?: Record<string, string>;
}

export interface AgentBackendProps {
  /** The backend name: the route is `/<name>/invocations` and the Gateway target is `<name>`. `[a-z0-9-]{1,32}`. */
  readonly name: string;
  /**
   * The ingress this backend sits behind: the `SharedIngress` of this stack,
   * or another stack's published values from `SharedIngress.fromParameters`.
   */
  readonly ingress: SharedIngress | SharedIngressRef;
  readonly agent: AgentProps;
  /**
   * (v2, ADR-0032) The agent's own actions, `A.needs`: at least one, no
   * duplicates, each `<name>/<action>` with this backend's name, 3 to 128
   * characters of `[a-z0-9-]` and one slash. Granted whenever the agent is.
   */
  readonly needs: string[];
  /**
   * (v2, ADR-0032) The tools the agent may use, `A.tools`: each
   * `<target>/<tool>` or `<target>/*`, `[a-z0-9_-]`, at most 64, no
   * duplicates. A tool is granted only when the tenant subscribes to it and
   * the user is not cut from it (R-5). Default `[]`. A non-empty list needs
   * an ingress with a tools gateway.
   */
  readonly tools?: string[];
  /**
   * The owner marker of the `NAME#<name>` reservation (ADR-0035; was
   * `scopeOwner`). Default `<StackId>#<LogicalResourceId>`. Stacks that pass
   * the same value co-own the name and MUST be destroyed together.
   */
  readonly owner?: string;
  /** Removed in v2: renamed to `needs`. Setting it fails synth. @deprecated */
  readonly scopes?: never;
}

export class AgentBackend extends Construct {
  /** The Runtime ARN. */
  readonly runtimeArn: string;
  /** The agent's execution role (P-6). */
  readonly executionRole: iam.IRole;
  /** This backend's invocation URL. Undefined only for a `SharedIngressRef` built without `endpointUrl`. */
  readonly endpointUrl?: string;
  /** The SSM parameter name of this backend's registry entry. */
  readonly registryParameterName: string;
  /** The backend name. */
  readonly name: string;
  /** The compute, for tests and for a consumer that needs the L1. */
  readonly backend: AgentCoreRuntimeBackend;
  /** (v2) `A.needs`, as given. */
  readonly needs: readonly string[];
  /** (v2) `A.tools`, as given. */
  readonly tools: readonly string[];

  constructor(scope: Construct, id: string, props: AgentBackendProps) {
    super(scope, id);
    const fail = (prop: string, message: string): never => {
      throw new Error(`AgentBackend: ${prop} ${message}`);
    };
    if ((props as { scopes?: unknown }).scopes !== undefined) {
      fail('scopes', 'is renamed to needs in v2 (ADR-0032)');
    }
    for (const removed of ['identityApi', 'scopeOwner']) {
      if ((props as unknown as Record<string, unknown>)[removed] !== undefined) {
        fail(removed, 'is removed in v2: backends no longer register scopes with the identity provider (ADR-0030)');
      }
    }
    if (!BACKEND_NAME_PATTERN.test(props.name)) {
      fail('name', `must match ${BACKEND_NAME_PATTERN.source} (got ${props.name})`);
    }
    if (props.agent.codePath.length === 0) {
      fail('agent.codePath', 'must be a directory path');
    }
    if (props.agent.modelId.length === 0) {
      fail('agent.modelId', 'must be a Bedrock model id');
    }
    // `?? []` covers a JavaScript caller that omits the required prop: the message names it.
    const needsProblem = backendNeedsProblem(props.name, props.needs ?? []);
    if (needsProblem !== undefined) {
      fail('needs', needsProblem);
    }
    const tools = props.tools ?? [];
    const toolsProblem = backendToolsProblem(tools);
    if (toolsProblem !== undefined) {
      fail('tools', toolsProblem);
    }
    const ownerIssue = ownerProblem(props.owner);
    if (ownerIssue !== undefined) {
      fail('owner', ownerIssue);
    }
    this.name = props.name;
    this.needs = [...props.needs];
    this.tools = [...tools];

    const ingress = props.ingress;
    if (ingress instanceof SharedIngress && Stack.of(ingress) !== Stack.of(this)) {
      fail('ingress', 'a SharedIngress from another stack must be imported with SharedIngress.fromParameters(...)');
    }
    const ref: SharedIngressRef =
      ingress instanceof SharedIngress
        ? {
          registryPrefix: ingress.registryPrefix,
          endpointUrl: ingress.endpointUrl,
          ingressRoleArn: ingress.ingressRole.roleArn,
          ingressId: ingress.ingressId,
          ingress: ingress.options.ingress,
          gatewayIdentifier: ingress.gatewayIdentifier,
          tenantRoleArn: ingress.tenantRole.roleArn,
          issuer: ingress.issuer,
          entitlementsTableName: ingress.entitlementStore.tableName,
          tools:
            ingress.toolsGateway === undefined
              ? undefined
              : {
                gatewayIdentifier: ingress.toolsGateway.gatewayIdentifier,
                gatewayUrl: ingress.toolsGateway.gatewayUrl,
                gatewayRoleArn: ingress.toolsGateway.gatewayRole.roleArn,
                policyEngineId: ingress.toolsGateway.policyEngine.attrPolicyEngineId,
                contextKeyId: ingress.toolsGateway.contextKey.keyId,
              },
        }
        : ingress;
    if (ref.ingress === 'agentcore-gateway' && ref.gatewayIdentifier === undefined) {
      fail('ingress.gatewayIdentifier', "is required with the 'agentcore-gateway' ingress");
    }
    if (!Token.isUnresolved(ref.registryPrefix) && (!ref.registryPrefix.startsWith('/') || !ref.registryPrefix.endsWith('/'))) {
      fail('ingress.registryPrefix', 'must start and end with /');
    }
    // P-4: toolsGateway: false plus a backend with tools fails synth (ADR-0034).
    if (tools.length > 0 && ref.tools === undefined) {
      fail('tools', 'needs an ingress with a tools gateway (toolsGateway is false)');
    }
    if (ref.entitlementsTableName === undefined) {
      fail('ingress.entitlementsTableName', 'is required in v2 (the NAME# reservation, ADR-0035)');
    }

    // The agent's environment (spec §3.3): where the tools gateway is, and the issuer.
    const environment: Record<string, string> = { ...props.agent.environment };
    if (ref.tools?.gatewayUrl !== undefined) {
      environment[AGENT_ENV.TOOLS_GATEWAY_URL] = ref.tools.gatewayUrl;
    }
    if (ref.issuer !== undefined) {
      environment[AGENT_ENV.ISSUER] = ref.issuer;
    }

    this.backend = new AgentCoreRuntimeBackend(this, 'Runtime', {
      codePath: props.agent.codePath,
      modelId: props.agent.modelId,
      environment,
      transports: { transactionToken: true, tenantCredentials: true },
      tags: { [INGRESS_TAG_KEY]: ref.ingressId },
    });
    this.runtimeArn = this.backend.resourceArn;
    this.executionRole = this.backend.executionRole;

    const policy = this.backend.bindIngress(ref.ingressRoleArn);
    const target = ref.ingress === 'agentcore-gateway' ? this.backend.addGatewayTarget(ref.gatewayIdentifier!, props.name) : undefined;

    this.endpointUrl = ref.endpointUrl === undefined ? undefined : `${ref.endpointUrl}/${props.name}/${ROUTE}`;
    if (ingress instanceof SharedIngress) {
      ingress.grantModel(props.agent.modelId);
    } else {
      const tenantRole = iam.Role.fromRoleArn(this, 'TenantRole', ref.tenantRoleArn, { mutable: true });
      addModelStatement(this, tenantRole, props.agent.modelId, 'OneModel');
    }

    const ttl = ingress instanceof SharedIngress ? Duration.seconds(ingress.options.registryTtlSeconds) : Duration.seconds(60);
    const logDrain = ingress instanceof SharedIngress ? ingress.logDrain : new LogDrain(this, 'LogDrain');

    // ADR-0035: the name is reserved before the route exists, so an agent
    // and a tool target can never share one.
    const stack = Stack.of(this);
    const reservation = new OwnedRows(this, 'NameReservation', {
      tableName: ref.entitlementsTableName!,
      tableArn: stack.formatArn({ service: 'dynamodb', resource: 'table', resourceName: ref.entitlementsTableName }),
      rows: [{ ...nameKey(props.name), attributes: { kind: 'agent' } }],
      owner: props.owner,
      logDrain,
    });

    // The entry is written last (ADR-0024): a half-created backend is never routable.
    const entry = new RegistryEntryResource(this, 'RegistryEntry', {
      registryPrefix: ref.registryPrefix,
      backend: props.name,
      runtimeArn: this.runtimeArn,
      needs: this.needs as string[],
      tools: this.tools as string[],
      drain: ttl.plus(LONGEST_STREAM),
      logDrain,
    });
    entry.resource.node.addDependency(this.backend.runtime, policy, reservation.resource);
    if (target !== undefined) {
      entry.resource.node.addDependency(target);
    }
    this.registryParameterName = entry.parameterName;
  }
}
