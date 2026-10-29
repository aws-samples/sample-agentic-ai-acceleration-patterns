// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * `AgentBackend` (ADR-0024): one backend behind a `SharedIngress`, in the
 * same stack or in its own. It creates the AgentCore Runtime (ADR-0011),
 * tagged `ri:ingress = <ingressId>` so the ingress role's invoke grant
 * applies; writes the Runtime's resource policy naming the ingress role
 * alone (P-1, ADR-0001); on the `agentcore-gateway` ingress adds the Gateway
 * target named after the backend (ADR-0010); adds its one-model statement to
 * the ingress's tenant role (ADR-0018); registers its own scopes with the
 * identity provider (ADR-0025), under its own owner marker unless
 * `scopeOwner` names a shared one; and last writes its registry entry, which is
 * what makes the route live. Creating, changing or removing a backend never
 * redeploys the ingress, and never redeploys the identity provider.
 */

import { Duration, Stack, Token } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { AgentCoreRuntimeBackend } from './backend/agentcore-runtime.cdk';
import { LogDrain } from './shared/log-drain';
import { INGRESS_TAG_KEY, BACKEND_NAME_PATTERN, backendScopesProblem, ROUTE } from './shared/registry';
import { LONGEST_STREAM, RegistryEntryResource } from './shared/registry-entry.cdk';
import { type IdentityApiProps, ScopeRegistration } from './shared/scope-registration.cdk';
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
  /**
   * The ingress this backend sits behind: the `SharedIngress` of this stack,
   * or another stack's published values from `SharedIngress.fromParameters`.
   * A `SharedIngress` instance from another stack is refused: it would pull
   * that stack's role, drain and Gateway in as cross-stack references, which
   * is what the registry exists to avoid (ADR-0024).
   */
  readonly ingress: SharedIngress | SharedIngressRef;
  readonly agent: AgentProps;
  /**
   * The scopes this backend owns (ADR-0025): at least one, no duplicates,
   * each `<name>/<action>` where `<name>` is this backend's name (so two
   * backends cannot share a scope), 3 to 128 characters of `[a-z0-9-]` and
   * one slash. Registered with tenant-identity at deploy, removed at delete.
   * A token reaches this backend when it carries ANY ONE of them (OR), after
   * the ingress-wide `requiredScopes` floor (AND, ADR-0005). The agent sees
   * the token's scopes itself (ADR-0007) and separates, say, `billing/read`
   * from `billing/invoke`.
   */
  readonly scopes: string[];
  /**
   * Where tenant-identity's platform API is, for the scope registration.
   * Unset: read from its published parameters at deploy time. Set only by a
   * build that must synthesise without an account (placeholders).
   */
  readonly identityApi?: IdentityApiProps;
  /**
   * The owner marker the scope registration writes into the catalogue as
   * each scope's description (ADR-0025). Default: this stack's id and the
   * registration's logical id, so a second stack that registers the same
   * names fails its deploy instead of taking them over. Stacks that pass the
   * same value co-own the names: each one's Create and Update passes the
   * owner check, and they MUST be destroyed together, because the first one
   * destroyed removes the scopes from the catalogue and the others' tokens
   * are refused from then on. Non-empty, at most 200 characters, no `#`
   * (the separator of the default marker).
   */
  readonly scopeOwner?: string;
}

/** The longest `scopeOwner`; PutScope's description holds 256 and the default marker is longer than any sensible explicit one. */
export const SCOPE_OWNER_MAX_LENGTH = 200;

/** Why `scopeOwner` is refused, or undefined when it is acceptable (or unset). */
export function scopeOwnerProblem(owner: string | undefined): string | undefined {
  if (owner === undefined) {
    return undefined;
  }
  if (typeof owner !== 'string' || owner.length === 0) {
    return 'must be a non-empty string';
  }
  if (owner.length > SCOPE_OWNER_MAX_LENGTH) {
    return `must be at most ${SCOPE_OWNER_MAX_LENGTH} characters (got ${owner.length})`;
  }
  if (owner.includes('#')) {
    return "must not contain '#' (the separator of the default <StackId>#<LogicalResourceId> marker)";
  }
  return undefined;
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
  /** The scopes this backend owns, as given (ADR-0025). */
  readonly scopes: readonly string[];
  /** The scope registration with the identity provider (ADR-0025). */
  readonly scopeRegistration: ScopeRegistration;

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
    // `?? []` covers a JavaScript caller that omits the required prop: the message names it.
    const scopesProblem = backendScopesProblem(props.name, props.scopes ?? []);
    if (scopesProblem !== undefined) {
      fail('scopes', scopesProblem);
    }
    const ownerProblem = scopeOwnerProblem(props.scopeOwner);
    if (ownerProblem !== undefined) {
      fail('scopeOwner', ownerProblem);
    }
    this.name = props.name;
    this.scopes = [...props.scopes];

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

    // The scopes go to the identity provider before the route exists
    // (ADR-0025), so a token is never checked against a scope the issuer
    // does not know. The handlers' log groups sit behind a log drain
    // (ADR-0019): the ingress's own in the same stack, this backend's own
    // otherwise.
    const ttl = ingress instanceof SharedIngress ? Duration.seconds(ingress.options.registryTtlSeconds) : Duration.seconds(60);
    const logDrain = ingress instanceof SharedIngress ? ingress.logDrain : new LogDrain(this, 'LogDrain');
    this.scopeRegistration = new ScopeRegistration(this, 'Scopes', {
      backend: props.name,
      scopes: this.scopes as string[],
      identityApi: props.identityApi,
      owner: props.scopeOwner,
      logDrain,
    });

    // The entry is written last (ADR-0024): a half-created backend is never
    // routable, and `status` gates traffic from the first write.
    const entry = new RegistryEntryResource(this, 'RegistryEntry', {
      registryPrefix: ref.registryPrefix,
      backend: props.name,
      runtimeArn: this.runtimeArn,
      scopes: this.scopes as string[],
      drain: ttl.plus(LONGEST_STREAM),
      logDrain,
    });
    entry.resource.node.addDependency(this.backend.runtime, policy, this.scopeRegistration.resource);
    if (target !== undefined) {
      entry.resource.node.addDependency(target);
    }
    this.registryParameterName = entry.parameterName;
  }
}
