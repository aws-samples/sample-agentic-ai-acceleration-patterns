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

import { Annotations, Aspects, Duration, Names, Stack, Token } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { AgentCoreRuntimeBackend } from './backend/agentcore-runtime.cdk';
import { AGENT_ENV } from './shared/config';
import { nameKey } from './shared/entitlements';
import { LogDrain } from './shared/log-drain';
import { DEFAULT_TOOLS_GATEWAY } from './shared/mint';
import {
  backendDelegatesToProblem,
  backendNeedsProblem,
  backendToolsProblem,
  BACKEND_NAME_PATTERN,
  DELEGATION_ROUTE,
  INGRESS_TAG_KEY,
  ROUTE,
} from './shared/registry';
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
   * (ADR-0048, spec §3.7) The agents this agent may hand a transaction to
   * through `POST /<agent>/delegations`: backend names, at most 32, no
   * duplicates, never its own. Default `[]`: the agent cannot delegate. A
   * name in this app must be an `AgentBackend` of the app; a name in another
   * stack is resolved at request time (404 when absent). Needs an ingress
   * with `agentDelegation`.
   */
  readonly delegatesTo?: string[];
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
  /** (ADR-0048) `delegatesTo`, as given. */
  readonly delegatesTo: readonly string[];

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
    // The route words are not names: /<name>/invocations and /<name>/delegations must parse (spec §3.3).
    if (props.name === ROUTE || props.name === DELEGATION_ROUTE) {
      fail('name', `must not be the route word '${props.name}'`);
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
    const delegatesTo = props.delegatesTo ?? [];
    const delegatesToProblem = backendDelegatesToProblem(props.name, delegatesTo);
    if (delegatesToProblem !== undefined) {
      fail('delegatesTo', delegatesToProblem);
    }
    const ownerIssue = ownerProblem(props.owner);
    if (ownerIssue !== undefined) {
      fail('owner', ownerIssue);
    }
    this.name = props.name;
    this.needs = [...props.needs];
    this.tools = [...tools];
    this.delegatesTo = [...delegatesTo];

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
          delegationUrl: ingress.delegationUrl,
          toolsGateways: Object.fromEntries(
            Object.entries(ingress.toolsGateways).map(([name, gw]) => [
              name,
              {
                name,
                gatewayIdentifier: gw.gatewayIdentifier,
                gatewayUrl: gw.gatewayUrl,
                gatewayRoleArn: gw.gatewayRole.roleArn,
                policyEngineId: gw.policyEngine.attrPolicyEngineId,
                contextKeyId: gw.contextKey.keyId,
              },
            ]),
          ),
        }
        : ingress;
    // ADR-0041: every tools gateway of the ingress by name; `tools` alone is the `default` one.
    const gateways = ref.toolsGateways ?? (ref.tools === undefined ? {} : { [DEFAULT_TOOLS_GATEWAY]: ref.tools });
    if (ref.ingress === 'agentcore-gateway' && ref.gatewayIdentifier === undefined) {
      fail('ingress.gatewayIdentifier', "is required with the 'agentcore-gateway' ingress");
    }
    if (!Token.isUnresolved(ref.registryPrefix) && (!ref.registryPrefix.startsWith('/') || !ref.registryPrefix.endsWith('/'))) {
      fail('ingress.registryPrefix', 'must start and end with /');
    }
    // P-4: toolsGateway: false plus a backend with tools fails synth (ADR-0034).
    if (tools.length > 0 && Object.keys(gateways).length === 0) {
      fail('tools', 'needs an ingress with a tools gateway (toolsGateway is false)');
    }
    if (ref.entitlementsTableName === undefined) {
      fail('ingress.entitlementsTableName', 'is required in v2 (the NAME# reservation, ADR-0035)');
    }
    // ADR-0048: a delegating agent needs the route; the route is the api-gateway ingress's.
    if (delegatesTo.length > 0 && ref.delegationUrl === undefined) {
      fail('delegatesTo', 'needs an ingress with agentDelegation on the api-gateway ingress (ADR-0048)');
    }
    if (delegatesTo.length > 0) {
      // Same-app names are checked once the app is assembled (spec §3.3); other stacks' names at request time.
      Aspects.of(this).add({
        visit: (node) => {
          if (node !== this) {
            return;
          }
          const names = new Set(
            node.node.root.node.findAll().filter((c): c is AgentBackend => c instanceof AgentBackend).map((b) => b.name),
          );
          const missing = delegatesTo.filter((n) => !names.has(n));
          if (missing.length > 0) {
            Annotations.of(this).addWarning(
              `AgentBackend ${props.name}: delegatesTo names ${missing.join(', ')} not found in this app; they are resolved at request time (404 when absent)`,
            );
          }
        },
      });
    }

    // The agent's environment (spec §3.3): where the tools gateways are, and the issuer.
    // ADR-0041: RI_TOOLS_GATEWAY_URLS maps each gateway name to its MCP endpoint; the agent
    // talks to the gateways its token's aud names. RI_TOOLS_GATEWAY_URL stays as the default's.
    const environment: Record<string, string> = { ...props.agent.environment };
    const urls = Object.fromEntries(
      Object.entries(gateways)
        .filter(([, gw]) => gw.gatewayUrl !== undefined)
        .map(([name, gw]) => [name, gw.gatewayUrl!]),
    );
    if (Object.keys(urls).length > 0) {
      environment[AGENT_ENV.TOOLS_GATEWAY_URLS] = Stack.of(this).toJsonString(urls);
    }
    const defaultUrl = gateways[DEFAULT_TOOLS_GATEWAY]?.gatewayUrl;
    if (defaultUrl !== undefined) {
      environment[AGENT_ENV.TOOLS_GATEWAY_URL] = defaultUrl;
    }
    if (ref.issuer !== undefined) {
      environment[AGENT_ENV.ISSUER] = ref.issuer;
    }
    // ADR-0048: where to delegate; set whenever the ingress has the route, so an agent
    // can be given delegatesTo later without a Runtime redeploy.
    if (ref.delegationUrl !== undefined) {
      environment[AGENT_ENV.DELEGATION_URL] = ref.delegationUrl;
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
      grantModelFromStack(this, ref.tenantRoleArn, props.agent.modelId);
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
      delegatesTo: this.delegatesTo as string[],
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

/**
 * The one-model statement for a backend in another stack than its ingress
 * (ADR-0018). The imported tenant role gets ONE inline policy per stack and
 * model, shared by every `AgentBackend` of that stack: each `AgentBackend`
 * adding its own copy put 308 bytes on the role per agent, and IAM caps a
 * role's inline policies at 10,240 bytes in all, so about 30 agents filled
 * it (2026-11-09, stress tier `large`, finding F-10). The holder construct
 * lives at the stack root under a name derived from the model id, so a
 * second backend of the same model in the same stack finds it.
 */
function grantModelFromStack(scope: Construct, tenantRoleArn: string, modelId: string): void {
  const stack = Stack.of(scope);
  const id = `TenantRoleModelGrant${modelId.replace(/[^A-Za-z0-9]/g, '')}`;
  if (stack.node.tryFindChild(id) !== undefined) {
    return;
  }
  const holder = new Construct(stack, id);
  const tenantRole = iam.Role.fromRoleArn(holder, 'TenantRole', tenantRoleArn, { mutable: true });
  addModelStatement(holder, tenantRole, modelId, 'OneModel');
  // An inline policy on an imported role is named by its logical id, and
  // two stacks writing one inline policy name silently overwrite each other
  // (the second deploy wins): the name carries the stack so two agents
  // stacks on one ingress each keep their own.
  const policy = tenantRole.node.tryFindChild('Policy') as iam.Policy | undefined;
  const cfnPolicy = policy?.node.defaultChild as iam.CfnPolicy | undefined;
  if (cfnPolicy !== undefined) {
    cfnPolicy.policyName = `${Names.uniqueResourceName(holder, { maxLength: 64 })}OneModel`.slice(0, 128);
  }
}
