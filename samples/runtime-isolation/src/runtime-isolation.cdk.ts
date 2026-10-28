// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * `IsolatedRuntime` (spec §3, standard §4.5): a backend that trusts exactly
 * one ingress, which maps the validated caller to an isolated compute unit.
 * Since ADR-0024 it is the one-backend wrapper over `SharedIngress` and
 * `AgentBackend`: the ingress serves `POST /{backend}/invocations` with the
 * one backend also at the bare `/invocations` (`defaultBackend`), so the URL
 * and the published values a single-agent deployer relies on do not change.
 * The ingress is a deploy-time choice (ADR-0003): an API Gateway REST API
 * with response streaming, or an AgentCore Gateway with a Runtime target.
 * Session mapping, scope checks and delegation are optional modules, off by
 * default (P-4).
 *
 * The token vending machine is always on (ADR-0018): every model call is
 * signed by a tenant role carrying the verified `TenantId`, so AWS attributes
 * model cost to the IAM principal per tenant (CUR 2.0). `tvm` stays an
 * optional prop, but only to let the deployer supply a role that also reaches
 * tenant data; unset, the construct creates `TenantModelRole`, which may
 * invoke only the one model. The agent holds no shared model permission: the
 * execution role has no `bedrock:Invoke*` (ADR-0008 amended by ADR-0018).
 *
 * The construct creates none of its data dependencies: the issuer, the agent
 * code and, with `tvm`, a data-bearing tenant role are props. It applies no
 * cdk-nag aspect and no App settings; it carries its own acknowledgments with
 * reasons. A deployer with several agents uses `SharedIngress` and
 * `AgentBackend` directly.
 */

import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import type * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { AgentBackend, type AgentProps } from './agent-backend.cdk';
import { BACKEND_NAME_PATTERN, ROUTE } from './shared/registry';
import { type ResolvedOptions, SharedIngress, type SharedIngressProps } from './shared-ingress.cdk';

export { AUTHORIZER_CACHE_TTL, INTEGRATION_TIMEOUT, resolveOptions, STAGE_NAME } from './shared-ingress.cdk';
export type {
  DelegationProps,
  IdentityProps,
  ResolvedOptions,
  SessionProps,
  StageThrottleProps,
  TenantLimitsProps,
  TvmProps,
} from './shared-ingress.cdk';
export type { AgentProps } from './agent-backend.cdk';
/** The one route under every backend name on both ingresses (spec §5). */
export { ROUTE } from './shared/registry';

/** The default backend name, and so the Gateway target name; part of `endpointUrl` on the `agentcore-gateway` ingress. */
export const GATEWAY_TARGET_NAME = 'agent';

export interface IsolatedRuntimeProps extends Omit<SharedIngressProps, 'defaultBackend'> {
  readonly agent: AgentProps;
  /**
   * The one backend's name (ADR-0024): its route is `/<name>/invocations`
   * beside the bare `/invocations`, its registry entry
   * `${registryPrefix}backends/<name>`, and on the Gateway ingress its
   * target. `[a-z0-9-]{1,32}`. Default `'agent'`.
   */
  readonly backendName?: string;
}

export class IsolatedRuntime extends Construct {
  /** The ingress invocation URL (spec §5): the bare `/invocations` on `api-gateway`, `/<backendName>/invocations` on the Gateway. */
  readonly endpointUrl: string;
  /** The backend's resource ARN (for `agentcore-runtime`, the Runtime ARN). */
  readonly runtimeArn: string;
  /** The one principal the backend trusts (P-1): the integration Lambda's role, or the Gateway's role. */
  readonly ingressRole: iam.IRole;
  /** The agent's execution role (P-6). */
  readonly executionRole: iam.IRole;
  /** The role that validates the token and assumes the tenant role: the integration Lambda or the interceptor. */
  readonly tvmCallerRole: iam.IRole;
  /** The tenant role every model call is signed by (ADR-0018): the deployer's role, or the construct's default `TenantModelRole`. */
  readonly tenantRole: iam.IRole;
  /** The resolved options, for consumers and tests. */
  readonly options: ResolvedOptions;
  /** The per-tenant usage counters (ADR-0020); undefined when `tenantLimits` is `false`. */
  readonly limitsTable?: dynamodb.TableV2;
  /** The ingress (ADR-0024); add further backends to it with `AgentBackend`. */
  readonly ingress: SharedIngress;
  /** The one backend (ADR-0024). */
  readonly backend: AgentBackend;

  constructor(scope: Construct, id: string, props: IsolatedRuntimeProps) {
    super(scope, id);
    const backendName = props.backendName ?? GATEWAY_TARGET_NAME;
    if (!BACKEND_NAME_PATTERN.test(backendName)) {
      throw new Error(`IsolatedRuntime: backendName must match ${BACKEND_NAME_PATTERN.source} (got ${backendName})`);
    }
    const { agent, backendName: _name, ...ingressProps } = props;

    this.ingress = new SharedIngress(this, 'Ingress', { ...ingressProps, defaultBackend: backendName });
    this.backend = new AgentBackend(this, 'Backend', { name: backendName, ingress: this.ingress, agent });

    this.options = this.ingress.options;
    this.ingressRole = this.ingress.ingressRole;
    this.tvmCallerRole = this.ingress.tvmCallerRole;
    this.tenantRole = this.ingress.tenantRole;
    this.limitsTable = this.ingress.limitsTable;
    this.runtimeArn = this.backend.runtimeArn;
    this.executionRole = this.backend.executionRole;
    // Today's URLs (ADR-0024 keeps them): the Gateway has no bare route, its
    // target name is the path; API Gateway keeps `/invocations` for the
    // default backend.
    this.endpointUrl = this.options.ingress === 'api-gateway' ? `${this.ingress.endpointUrl}/${ROUTE}` : this.ingress.urlFor(backendName);
  }
}
