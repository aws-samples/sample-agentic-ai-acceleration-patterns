// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * `AgentBackend` (ADR-0024): one backend behind a `SharedIngress`, in the
 * same stack or in its own. It creates the AgentCore Runtime (ADR-0011),
 * tagged `ri:ingress = <ingressId>` so the ingress role's invoke grant
 * applies; writes the Runtime's resource policy naming the ingress role
 * alone (P-1, ADR-0001); on the `agentcore-gateway` ingress adds the Gateway
 * target named after the backend (ADR-0010); adds its one-model statement to
 * the ingress's tenant role (ADR-0018); and last writes its registry entry,
 * which is what makes the route live. Creating, changing or removing a
 * backend never redeploys the ingress.
 */

import { Duration, Token } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { AgentCoreRuntimeBackend } from './backend/agentcore-runtime.cdk';
import { INGRESS_TAG_KEY, BACKEND_NAME_PATTERN, ROUTE } from './shared/registry';
import { LONGEST_STREAM, RegistryEntryResource } from './shared/registry-entry.cdk';
import { addModelStatement, SharedIngress, type SharedIngressRef } from './shared-ingress.cdk';

/** The agent the backend runs. */
export interface AgentProps {
  /** Directory with the agent's `app.js` (a Node HTTP server on port 8080), uploaded as the Runtime's code. */
  readonly codePath: string;
  /** The one Bedrock model id the tenant role may invoke for this backend (P-6, ADR-0018). */
  readonly modelId: string;
  /**
   * Environment variables for the agent process (the demo passes its table
   * name). Configuration only; never a secret.
   */
  readonly environment?: Record<string, string>;
}

export interface AgentBackendProps {
  /** The backend name: the route is `/<name>/invocations` and the Gateway target is `<name>`. `[a-z0-9-]{1,32}`. */
  readonly name: string;
  /** The ingress this backend sits behind: the construct in this stack, or another stack's published values. */
  readonly ingress: SharedIngress | SharedIngressRef;
  readonly agent: AgentProps;
  /** Scopes a token must carry for this backend, on top of the ingress-wide floor (ADR-0005, ADR-0024). Unset: none. */
  readonly requiredScopes?: string[];
}

export class AgentBackend extends Construct {
  /** The Runtime ARN. */
  readonly runtimeArn: string;
  /** The agent's execution role (P-6). */
  readonly executionRole: iam.IRole;
  /** This backend's invocation URL: `${ingress.endpointUrl}/<name>/invocations`. Undefined only for a `SharedIngressRef` built without `endpointUrl`. */
  readonly endpointUrl?: string;
  /** The SSM parameter name of this backend's registry entry. */
  readonly registryParameterName: string;
  /** The backend name. */
  readonly name: string;
  /** The compute, for tests and for a consumer that needs the L1. */
  readonly backend: AgentCoreRuntimeBackend;

  constructor(scope: Construct, id: string, props: AgentBackendProps) {
    super(scope, id);
    const fail = (prop: string, message: string): never => {
      throw new Error(`AgentBackend: ${prop} ${message}`);
    };
    if (!BACKEND_NAME_PATTERN.test(props.name)) {
      fail('name', `must match ${BACKEND_NAME_PATTERN.source} (got ${props.name})`);
    }
    if (props.agent.codePath.length === 0) {
      fail('agent.codePath', 'must be a directory path');
    }
    if (props.agent.modelId.length === 0) {
      fail('agent.modelId', 'must be a Bedrock model id');
    }
    const requiredScopes = props.requiredScopes ?? [];
    if (requiredScopes.some((s) => s.trim().length === 0 || /\s/.test(s))) {
      fail('requiredScopes', 'must be a list of scope strings without whitespace');
    }
    this.name = props.name;

    const ingress = props.ingress;
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
          forwardUserToken: ingress.options.forwardUserToken,
        }
        : ingress;
    if (ref.ingress === 'agentcore-gateway' && ref.gatewayIdentifier === undefined) {
      fail('ingress.gatewayIdentifier', "is required with the 'agentcore-gateway' ingress");
    }
    if (!Token.isUnresolved(ref.registryPrefix) && (!ref.registryPrefix.startsWith('/') || !ref.registryPrefix.endsWith('/'))) {
      fail('ingress.registryPrefix', 'must start and end with /');
    }

    // The Runtime, tagged for the ingress role's grant (ADR-0024). The tag
    // is given at creation so the service copies it to the DEFAULT endpoint.
    this.backend = new AgentCoreRuntimeBackend(this, 'Runtime', {
      codePath: props.agent.codePath,
      modelId: props.agent.modelId,
      environment: props.agent.environment,
      transports: { forwardUserToken: ref.forwardUserToken ?? false, tenantCredentials: true },
      tags: { [INGRESS_TAG_KEY]: ref.ingressId },
    });
    this.runtimeArn = this.backend.resourceArn;
    this.executionRole = this.backend.executionRole;

    // P-1: the resource policy names the ingress role alone (ADR-0001).
    const policy = this.backend.bindIngress(ref.ingressRoleArn);

    // ADR-0010: on the Gateway ingress the route is a target named after the backend.
    const target = ref.ingress === 'agentcore-gateway' ? this.backend.addGatewayTarget(ref.gatewayIdentifier!, props.name) : undefined;

    // ADR-0018: every model call is signed by the tenant role, so it must
    // allow this backend's one model. Same-stack: the ingress adds it once
    // per model id. Other stack: the role is imported by ARN (mutable), so
    // the statement lands in a policy of this stack attached by role name.
    this.endpointUrl = ref.endpointUrl === undefined ? undefined : `${ref.endpointUrl}/${props.name}/${ROUTE}`;
    if (ingress instanceof SharedIngress) {
      ingress.grantModel(props.agent.modelId);
    } else {
      const tenantRole = iam.Role.fromRoleArn(this, 'TenantRole', ref.tenantRoleArn, { mutable: true });
      addModelStatement(this, tenantRole, props.agent.modelId, 'OneModel');
    }

    // The entry is written last (ADR-0024): a half-created backend is never
    // routable, and `status` gates traffic from the first write.
    const ttl = ingress instanceof SharedIngress ? Duration.seconds(ingress.options.registryTtlSeconds) : Duration.seconds(60);
    const entry = new RegistryEntryResource(this, 'RegistryEntry', {
      registryPrefix: ref.registryPrefix,
      backend: props.name,
      runtimeArn: this.runtimeArn,
      requiredScopes,
      drain: ttl.plus(LONGEST_STREAM),
    });
    entry.resource.node.addDependency(this.backend.runtime, policy);
    if (target !== undefined) {
      entry.resource.node.addDependency(target);
    }
    this.registryParameterName = entry.parameterName;
  }
}
