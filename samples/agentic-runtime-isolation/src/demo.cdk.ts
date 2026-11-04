// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The demo stack (spec C-4, §6.4; standard §4.5): a thin wiring of a
 * `SharedIngress` (with a `default` agent that needs `default/chat` and may
 * use `crm/*`) and one `AgentBackend` to the sample's dependencies, plus a
 * second agent (`billing`, needs `billing/read` and `billing/invoke`, may use
 * `invoices/*`; ADR-0024, ADR-0032) behind the same ingress on request, and
 * (v2) two `ToolTarget`s, `crm` and `invoices`, behind two tools gateways (`default` and `finance`, ADR-0041). It
 * reads tenant-identity's published parameters for the issuer (ADR-0004),
 * chooses the ingress and the optional modules from CDK context,
 * and publishes the Runtime ARNs as this sample's parameters (the ingress
 * publishes its own, src/shared-ingress.cdk.ts). The TVM is always on (ADR-0018):
 * the `tvm` context flag now means "demo tenant data". When true, the demo
 * adds a tenant-partitioned table and its own data-bearing TenantRole and
 * passes it (ADR-0016 lazy trust ARN); when false, the demo passes no role
 * and the construct's default model-only TenantModelRole is used, so model
 * cost is still attributed per tenant. Only this file and the integration
 * test name tenant-identity; the construct does not.
 */

import * as path from 'node:path';
import { Aws, CfnOutput, CfnRule, Duration, Fn, Lazy, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { AgentBackend, type AgentProps } from './agent-backend.cdk';
import { AGENT_ENV } from './shared/config';
import { acknowledgeLambdaFindings, functionProps } from './shared/function.cdk';
import { COST_METRIC_NAMES, type IngressKind, METRIC_NAMES, METRICS_NAMESPACE } from './shared/metrics';
import { ROUTE } from './shared/registry';
import type { SessionScope } from './shared/session';
import { TENANT_TAG_KEY, USER_TAG_KEY } from './shared/tvm';
import { DEFAULT_REGISTRY_PREFIX, GATEWAY_TARGET_NAME, SharedIngress, type SharedIngressProps } from './shared-ingress.cdk';
import { type ToolDefinition, ToolTarget } from './tool-target.cdk';
import { CRM_TOOLS } from './tools/demo/crm.function';
import { DEMO_TOOL_ENV } from './tools/demo/data';
import { INVOICES_TOOLS } from './tools/demo/invoices.function';
import { gatewayIdPart } from './tools-gateway.cdk';

/**
 * tenant-identity's published parameters this stack consumes for the issuer
 * (ARCHITECTURE.md §5.1, ADR-0004). (v2, ADR-0030) The stack no longer reads
 * tenant-identity's API: backends register no scopes there.
 */
export const IDENTITY_PARAMETERS = {
  userPoolId: '/application-plane/shared/identity/userPoolId',
  appClientId: '/application-plane/shared/identity/appClientId',
} as const;

/**
 * This sample's published parameters (spec §6.4, ARCHITECTURE.md §5.1).
 * `SharedIngress` publishes `endpointUrl`, `ingress`, `ingressRoleArn`,
 * `ingressId` and `tenantRoleArn` under the same prefix itself (ADR-0024);
 * the demo keeps `runtimeArn` for the default backend (back-compat) and adds
 * the billing backend's ARN.
 */
export const AGENT_RUNTIME_PARAMETERS = {
  runtimeArn: `${DEFAULT_REGISTRY_PREFIX}runtimeArn`,
  billingRuntimeArn: `${DEFAULT_REGISTRY_PREFIX}backends-info/billing/runtimeArn`,
} as const;

/** The second backend's name (ADR-0024): the integ's step 9 calls `/billing/invocations`. */
export const BILLING_BACKEND = 'billing';
/**
 * The demo's agent products (v2, ADR-0032): each agent's own `needs`, named
 * after the backend, and the `tools` it may use. Which of them a tenant and
 * a user actually get is the entitlement store's (subscriptions, plans,
 * cuts), written by the integration driver, not this stack.
 */
export const DEFAULT_NEEDS = [`${GATEWAY_TARGET_NAME}/chat`] as const;
export const DEFAULT_TOOLS = ['crm/*'] as const;
export const BILLING_NEEDS = [`${BILLING_BACKEND}/read`, `${BILLING_BACKEND}/invoke`] as const;
export const BILLING_TOOLS = ['invoices/*'] as const;
/** (ADR-0041) The demo's tools gateways: `crm` on `default`, `invoices` on `finance`. */
export const DEMO_TOOLS_GATEWAYS = { crm: 'default', invoices: 'finance' } as const;

/** The build-time placeholders (standard §4.3). A CloudFormation rule refuses to deploy a stack that carries them. */
export const PLACEHOLDER = {
  userPoolId: 'PLACEHOLDER-NOT-A-USER-POOL',
  appClientId: 'PLACEHOLDER-NOT-A-CLIENT-ID',
} as const;

/** Base model id for the demo: the one model the agent calls and the tenant role allows (P-6, ADR-0018). */
export const DEFAULT_MODEL_ID = 'amazon.nova-lite-v1:0';

/**
 * The demo's default model for a Region. Amazon Nova Lite is served on demand
 * only through a cross-Region inference profile in most Regions (the base id
 * is a ValidationException there, first integ run 2026-10-27), so the default
 * is the geography's profile; an unknown or unresolved Region gets the base id.
 */
export function defaultModelId(region: string | undefined): string {
  const geo: Record<string, string> = { eu: 'eu', us: 'us', ap: 'apac' };
  const prefix = region === undefined ? undefined : geo[region.split('-')[0]];
  return prefix === undefined ? DEFAULT_MODEL_ID : `${prefix}.${DEFAULT_MODEL_ID}`;
}

/** The demo table's partition key and the per-tenant key prefix the tenant role's ABAC condition pins. */
export const TABLE_PARTITION_KEY = 'PK';
export const TENANT_KEY_PREFIX = 'TENANT#';

/** What `--context` may set (README, Deploy). */
export interface DemoContext {
  readonly ingress: IngressKind;
  readonly sessionScope?: SessionScope;
  readonly requiredScopes?: string[];
  /** (v2, ADR-0038) Accept identity tokens that carry `tenants`. Default false. */
  readonly multiTenant?: boolean;
  readonly tvm: boolean;
  readonly includeUserIdTag: boolean;
  readonly modelId: string;
  /** Build-only: synthesise with placeholders instead of tenant-identity's parameters. */
  readonly identityParameterPlaceholders: boolean;
  /** Per-tenant EMF metrics and the cost dashboard (ADR-0021). Default false: they cost per tenant. */
  readonly perTenantMetrics?: boolean;
  /** Requests per tenant per minute (ADR-0020); unset uses the construct default (60), 0 turns it off. */
  readonly requestsPerMinute?: number;
  /** Output tokens per tenant per minute (ADR-0020, api-gateway only). */
  readonly outputTokensPerMinute?: number;
  /**
   * Publish under `/application-plane/shared/agent-runtime/` (spec §6.4). Default true.
   * The prefix is account-wide, so only one stack per account and Region may use it: a second
   * ingress deployed beside the first must set `publishParameters=false`, which moves its
   * registry and its published parameters under `/application-plane/shared/agent-runtime/<stackName>/`
   * and skips the demo's own `runtimeArn` parameters (ADR-0024).
   */
  readonly publishParameters: boolean;
  /**
   * Add the `billing` backend behind the same ingress (ADR-0024), needing `BILLING_NEEDS`
   * (ADR-0032). Default off: the one-backend form. The demo deploy and the integration
   * stacks turn it on.
   */
  readonly billingBackend?: boolean;
  /**
   * The owner marker of the backends' and tool targets' name reservations
   * (`AgentBackend.owner`, `ToolTarget.owner`, ADR-0035). Each stack has its own
   * entitlement store, so the default per-stack marker is right unless stacks
   * share an ingress.
   */
  readonly owner?: string;
  /** (v2) `transactionToken.keyGeneration` (spec §6.2.3); default 1. Bumping it rotates the signing key. */
  readonly keyGeneration?: number;
}

type ContextReader = (key: string) => unknown;

function flag(read: ContextReader, key: string): boolean {
  const value = read(key);
  if (value === undefined || value === false || value === 'false') {
    return false;
  }
  if (value === true || value === 'true') {
    return true;
  }
  throw new Error(`Context '${key}' must be true or false (got ${String(value)})`);
}

function integer(read: ContextReader, key: string): number | undefined {
  const value = read(key);
  if (value === undefined || value === '') {
    return undefined;
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`Context '${key}' must be a non-negative integer (got ${String(value)})`);
  }
  return n;
}

function text(read: ContextReader, key: string): string | undefined {
  const value = read(key);
  if (value === undefined || value === '') {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error(`Context '${key}' must be a string`);
  }
  return value;
}

function list(read: ContextReader, key: string): string[] | undefined {
  const value = read(key);
  if (value === undefined || value === '') {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error(`Context '${key}' must be a comma-separated string`);
  }
  return value.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Parses and validates the demo's context; fails fast naming the key (standard §4.3). `region` picks the default model. */
export function parseDemoContext(read: ContextReader, region?: string): DemoContext {
  const ingress = read('ingress');
  if (ingress !== 'api-gateway' && ingress !== 'agentcore-gateway') {
    throw new Error(
      "Context 'ingress' is required: pass --context ingress=api-gateway or --context ingress=agentcore-gateway (ADR-0003)",
    );
  }
  const session = read('session');
  let sessionScope: SessionScope | undefined;
  if (session !== undefined && session !== 'off' && session !== '') {
    if (session !== 'user' && session !== 'tenant') {
      throw new Error(`Context 'session' must be user, tenant or off (got ${String(session)}) (ADR-0013)`);
    }
    sessionScope = session;
  }
  const modelId = read('modelId') ?? defaultModelId(region);
  if (typeof modelId !== 'string' || modelId.length === 0) {
    throw new Error("Context 'modelId' must be a Bedrock model id");
  }
  return {
    ingress,
    sessionScope,
    requiredScopes: list(read, 'requiredScopes'),
    multiTenant: flag(read, 'multiTenant'),
    tvm: flag(read, 'tvm'),
    includeUserIdTag: flag(read, 'includeUserIdTag'),
    modelId,
    identityParameterPlaceholders: flag(read, 'identityParameterPlaceholders'),
    perTenantMetrics: flag(read, 'perTenantMetrics'),
    requestsPerMinute: integer(read, 'requestsPerMinute'),
    outputTokensPerMinute: integer(read, 'outputTokensPerMinute'),
    publishParameters: read('publishParameters') === undefined ? true : flag(read, 'publishParameters'),
    billingBackend: read('billingBackend') === undefined ? undefined : flag(read, 'billingBackend'),
    owner: text(read, 'owner'),
    keyGeneration: integer(read, 'keyGeneration'),
  };
}

/** Whether the demo adds the billing backend: the explicit flag, else off. */
export function wantsBillingBackend(ctx: DemoContext): boolean {
  return ctx.billingBackend ?? false;
}

export interface RuntimeIsolationDemoStackProps extends StackProps {
  readonly context: DemoContext;
  /** Directory with the bundled agent (`app.js`); see src/agent/bundle.ts. */
  readonly agentCodePath: string;
  /** Publish under `/application-plane/shared/agent-runtime/`. Overrides `context.publishParameters`; the integration test turns it off on all but one stack, which then use a stack-scoped prefix. */
  readonly publishParameters?: boolean;
  /**
   * Write the ingress's published interface (spec §6.4) at all. Default true. The integration
   * test sets it on one stack only: six stacks writing 20-odd parameters each at once exceed
   * Parameter Store's 3 writes per second per account and fail to delete (ADR-0042).
   */
  readonly publishInterface?: boolean;
  /** The cost dashboard's name (account-wide). Default `RuntimeIsolation-<ingress>`; the integration test passes its stack name so several stacks of one ingress coexist. */
  readonly dashboardName?: string;
  /** The owner marker of the name reservations. Overrides `context.owner`; see `DemoContext.owner`. */
  readonly owner?: string;
  /**
   * The issuer's user pool and app client, instead of tenant-identity's
   * published parameters. The integration test passes a second
   * tenant-identity deployment's (`shared-pool-multi-tenant`) here.
   */
  readonly identity?: { readonly userPoolId: string; readonly appClientId: string };
  /**
   * TEST ONLY (integration stacks): the demo tools' test mode, a read of
   * another tenant's item with the same credentials on request (integ step
   * 20). Never set in the demo app.
   */
  readonly toolTestMode?: boolean;
}

export class RuntimeIsolationDemoStack extends Stack {
  /** The shared ingress (ADR-0024). */
  readonly ingress: SharedIngress;
  /** The default backend `agent`, served at the bare `/invocations` URL (ADR-0024). */
  readonly agentBackend: AgentBackend;
  /** The second backend behind the same ingress (ADR-0024); undefined unless `wantsBillingBackend`. */
  readonly billing?: AgentBackend;
  /** The registry prefix this stack's ingress and backends use (ADR-0024). */
  readonly registryPrefix: string;
  readonly table?: dynamodb.TableV2;
  readonly tenantRole?: iam.Role;
  /** The per-tenant cost dashboard, `RuntimeIsolation-<ingress>` (P-10); only with `perTenantMetrics` (ADR-0021). */
  readonly dashboard?: cloudwatch.Dashboard;
  /** (v2) The demo tool targets. */
  readonly crm: ToolTarget;
  readonly invoices: ToolTarget;
  /** (v2) The demo tool functions and, with demo tenant data, their tenant roles (P-15). */
  readonly crmFunction: NodejsFunction;
  readonly invoicesFunction: NodejsFunction;
  readonly toolTenantRoles: iam.Role[] = [];

  constructor(scope: Construct, id: string, props: RuntimeIsolationDemoStackProps) {
    super(scope, id, props);
    const ctx = props.context;

    // The issuer (ADR-0004): tenant-identity's shared pool, read from its
    // published parameters at deploy time. The build synthesises with placeholders no account can resolve, and the rule
    // below makes sure a placeholder template is refused by CloudFormation.
    let userPoolId: string;
    let appClientId: string;
    if (props.identity !== undefined) {
      userPoolId = props.identity.userPoolId;
      appClientId = props.identity.appClientId;
    } else if (ctx.identityParameterPlaceholders) {
      userPoolId = PLACEHOLDER.userPoolId;
      appClientId = PLACEHOLDER.appClientId;
      new CfnRule(this, 'RefusePlaceholderDeployment', {
        assertions: [
          {
            assert: Fn.conditionEquals('build-placeholder', 'deployable'),
            assertDescription:
              'This template was synthesised with --context identityParameterPlaceholders=true (build only). Synthesise without it so the stack reads /application-plane/shared/identity/* from tenant-identity.',
          },
        ],
      });
    } else {
      userPoolId = ssm.StringParameter.valueForStringParameter(this, IDENTITY_PARAMETERS.userPoolId);
      appClientId = ssm.StringParameter.valueForStringParameter(this, IDENTITY_PARAMETERS.appClientId);
    }
    const discoveryUrl = `https://cognito-idp.${this.region}.amazonaws.com/${userPoolId}/.well-known/openid-configuration`;

    // The registry prefix (ADR-0024) is also where the ingress publishes, and
    // it is one per account and Region; a stack that does not publish takes
    // a prefix of its own under it, so its registry entries and parameters
    // never collide with the publishing stack's.
    const publish = props.publishParameters ?? ctx.publishParameters;
    this.registryPrefix = publish ? DEFAULT_REGISTRY_PREFIX : `${DEFAULT_REGISTRY_PREFIX}${Aws.STACK_NAME}/`;

    // The TVM is always on (ADR-0018). `ctx.tvm` means "demo tenant data":
    // true adds a tenant-partitioned table and the construct's tvmCallerRole
    // may assume a data-bearing role the demo owns (ADR-0016 lazy trust ARN);
    // false passes no role, so the construct creates its default model-only
    // role and model cost is still attributed per tenant.
    let tvm: SharedIngressProps['tvm'] = { includeUserIdTag: ctx.includeUserIdTag };
    let agentEnvironment: Record<string, string> | undefined;
    let callerRoleArn: string | undefined;
    if (ctx.tvm) {
      this.table = new dynamodb.TableV2(this, 'DemoTable', {
        partitionKey: { name: TABLE_PARTITION_KEY, type: dynamodb.AttributeType.STRING },
        removalPolicy: RemovalPolicy.DESTROY, // sample only
        pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      });
      const tagKeys = ctx.includeUserIdTag ? [TENANT_TAG_KEY, USER_TAG_KEY] : [TENANT_TAG_KEY];
      // Resolved at synth so the trust policy names exactly the construct's caller role (ADR-0016).
      const caller = new iam.ArnPrincipal(Lazy.string({ produce: () => callerRoleArn! }));
      this.tenantRole = new iam.Role(this, 'TenantRole', {
        description: 'Tenant role (spec §6.1): assumable only by tvmCallerRole with a TenantId session tag; ABAC on the demo table (the construct adds the model statement, ADR-0018)',
        // Trust (spec §6.1): tvmCallerRole only, a non-empty TenantId request
        // tag, and exactly the tag keys the deployment expects. TagSession
        // comes from withSessionTags().
        assumedBy: caller
          .withConditions({
            'StringLike': { [`aws:RequestTag/${TENANT_TAG_KEY}`]: '?*' },
            'ForAllValues:StringEquals': { 'aws:TagKeys': tagKeys },
          })
          .withSessionTags(),
        maxSessionDuration: Duration.hours(1),
      });
      // ABAC (P-8): the tenant's own partition only, decided by IAM from the
      // session tag, whatever the agent asks for. The one-model statement is
      // added by the construct (ADR-0018), not here.
      this.tenantRole.addToPolicy(
        new iam.PolicyStatement({
          sid: 'OwnTenantPartitionOnly',
          actions: ['dynamodb:GetItem', 'dynamodb:Query'],
          resources: [this.table.tableArn],
          conditions: {
            'ForAllValues:StringEquals': {
              'dynamodb:LeadingKeys': [`${TENANT_KEY_PREFIX}\${aws:PrincipalTag/${TENANT_TAG_KEY}}`],
            },
          },
        }),
      );
      tvm = { role: this.tenantRole, includeUserIdTag: ctx.includeUserIdTag };
      agentEnvironment = { [AGENT_ENV.TABLE_NAME]: this.table.tableName };
    }

    const agent: AgentProps = { codePath: props.agentCodePath, modelId: ctx.modelId, environment: agentEnvironment };
    // One marker for every reservation of this stack (ADR-0035); unset, each resource is its own owner.
    const owner = props.owner ?? ctx.owner;
    this.ingress = new SharedIngress(this, 'SharedIngress', {
      identity: { discoveryUrl, allowedClientIds: [appClientId], multiTenant: ctx.multiTenant ?? false },
      ingress: ctx.ingress,
      registryPrefix: this.registryPrefix,
      publish: props.publishInterface ?? true,
      session: ctx.sessionScope === undefined ? undefined : { scope: ctx.sessionScope },
      requiredScopes: ctx.requiredScopes,
      tvm,
      perTenantMetrics: ctx.perTenantMetrics ?? false,
      tenantLimits:
        ctx.requestsPerMinute === undefined && ctx.outputTokensPerMinute === undefined
          ? undefined
          : { requestsPerMinute: ctx.requestsPerMinute, outputTokensPerMinute: ctx.outputTokensPerMinute },
      defaultBackend: GATEWAY_TARGET_NAME,
      transactionToken: ctx.keyGeneration === undefined ? undefined : { keyGeneration: ctx.keyGeneration },
      // ADR-0041: two tools gateways, each with its own Policy engine. `finance` trims
      // tools/list to the exact tools in scope (its RESPONSE interceptor).
      toolsGateways: { [DEMO_TOOLS_GATEWAYS.crm]: {}, [DEMO_TOOLS_GATEWAYS.invoices]: { responseFilter: true } },
    });
    this.agentBackend = new AgentBackend(this, 'AgentBackend', {
      name: GATEWAY_TARGET_NAME,
      ingress: this.ingress,
      agent,
      needs: [...DEFAULT_NEEDS],
      tools: [...DEFAULT_TOOLS],
      owner,
    });
    callerRoleArn = this.ingress.tvmCallerRole.roleArn;

    // v2: the demo tool targets behind the tools gateways (ADR-0034, ADR-0041).
    // With demo tenant data each tool reads and writes the calling tenant's
    // item through its own TVM: a tool tenant role it may assume with the
    // TenantId tag from the signed context, limited to that tenant's
    // partition (P-15); without it, synthetic answers (src/tools/demo).
    const crm = demoToolTarget(this, 'CrmTools', this.ingress, 'crm', 'crm.function.ts', [...CRM_TOOLS], owner, DEMO_TOOLS_GATEWAYS.crm, {
      table: this.table,
      actions: ['dynamodb:GetItem', 'dynamodb:UpdateItem'],
      testMode: props.toolTestMode === true,
    });
    const invoices = demoToolTarget(this, 'InvoicesTools', this.ingress, 'invoices', 'invoices.function.ts', [...INVOICES_TOOLS], owner, DEMO_TOOLS_GATEWAYS.invoices, {
      table: this.table,
      actions: ['dynamodb:GetItem'],
      testMode: props.toolTestMode === true,
    });
    this.crm = crm.target;
    this.invoices = invoices.target;
    this.crmFunction = crm.fn;
    this.invoicesFunction = invoices.fn;
    for (const role of [crm.role, invoices.role]) {
      if (role !== undefined) {
        this.toolTenantRoles.push(role);
      }
    }

    // A second backend behind the same ingress (ADR-0024): the same agent
    // code and model, its own Runtime, registry entry, needs and tools
    // (ADR-0032). Which tenants may use it is the entitlement store's.
    if (wantsBillingBackend(ctx)) {
      this.billing = new AgentBackend(this, 'BillingBackend', {
        name: BILLING_BACKEND,
        ingress: this.ingress,
        agent,
        needs: [...BILLING_NEEDS],
        tools: [...BILLING_TOOLS],
        owner,
      });
    }

    // P-9 on the api-gateway ingress: top tenants by request and by error,
    // from the access log's tenantId field. P-10 (ADR-0017): top tenants by
    // backend seconds and by output tokens, from the ingress Lambda's
    // 'request served' log line, which carries the figures whether or not
    // per-tenant metrics are on (ADR-0021). Contributor Insights is billed
    // per rule and per log event matched, not per tenant. The
    // agentcore-gateway ingress has no access log of its own and its
    // interceptor sees only the request side (no backend or model figures),
    // so it gets none of these.
    if (ctx.ingress === 'api-gateway') {
      const accessLogs = this.ingress.node.findChild('ApiAccessLogs') as logs.LogGroup;
      insightRule(this, 'TopTenantsByRequest', `${this.stackName}-top-tenants-requests`, {
        LogGroupNames: [accessLogs.logGroupName],
        Contribution: { Keys: ['$.tenantId'], Filters: [{ Match: '$.tenantId', IsPresent: true }] },
      });
      insightRule(this, 'TopTenantsByError', `${this.stackName}-top-tenants-errors`, {
        LogGroupNames: [accessLogs.logGroupName],
        Contribution: {
          Keys: ['$.tenantId'],
          Filters: [
            { Match: '$.tenantId', IsPresent: true },
            { Match: '$.status', GreaterThan: 399 },
          ],
        },
      });
      // The 'request served' line names the backend (ADR-0024), so the cost
      // rules key on tenant and backend: one tenant's seconds and tokens per
      // agent, which the access log cannot give.
      const ingressLogs = this.ingress.node.findChild('IngressLogs') as logs.LogGroup;
      insightRule(this, 'TopTenantsByBackendSeconds', `${this.stackName}-top-tenants-backend-seconds`, {
        LogGroupNames: [ingressLogs.logGroupName],
        Contribution: {
          Keys: ['$.tenantId', '$.backend'],
          ValueOf: '$.backendInvokeSeconds',
          Filters: [
            { Match: '$.message', In: ['request served'] },
            { Match: '$.backendInvokeSeconds', IsPresent: true },
          ],
        },
        AggregateOn: 'Sum',
      });
      insightRule(this, 'TopTenantsByOutputTokens', `${this.stackName}-top-tenants-output-tokens`, {
        LogGroupNames: [ingressLogs.logGroupName],
        Contribution: {
          Keys: ['$.tenantId', '$.backend'],
          ValueOf: '$.usageOutput',
          Filters: [
            { Match: '$.message', In: ['request served'] },
            { Match: '$.usageOutput', IsPresent: true },
          ],
        },
        AggregateOn: 'Sum',
      });
    }

    // The per-tenant cost dashboard (P-10, ADR-0017): one widget per cost
    // metric, one line per tenant, found by a SEARCH over the TenantId
    // dimension so a new tenant appears without a template change. Only
    // with per-tenant metrics on (ADR-0021): without them there is nothing
    // to chart, and the insight rules above cover top tenants.
    if (ctx.perTenantMetrics === true) {
      this.dashboard = costDashboard(this, ctx.ingress, props.dashboardName ?? dashboardName(ctx.ingress));
    }

    // The published interface (spec §6.4, standard §1.1). The ingress
    // publishes endpointUrl, baseUrl, ingress, ingressRoleArn, ingressId,
    // tenantRoleArn and, on agentcore-gateway, gatewayIdentifier under its
    // prefix (ADR-0024); the demo adds the Runtime ARNs. The default prefix
    // is account-wide, so one stack per account and Region publishes there.
    if (publish) {
      new ssm.StringParameter(this, 'RuntimeArnParameter', {
        parameterName: AGENT_RUNTIME_PARAMETERS.runtimeArn,
        stringValue: this.agentBackend.runtimeArn,
        description: 'runtime-isolation: the default backend\'s AgentCore Runtime ARN',
      });
      if (this.billing !== undefined) {
        new ssm.StringParameter(this, 'BillingRuntimeArnParameter', {
          parameterName: AGENT_RUNTIME_PARAMETERS.billingRuntimeArn,
          stringValue: this.billing.runtimeArn,
          description: 'runtime-isolation: the billing backend\'s AgentCore Runtime ARN (ADR-0024)',
        });
      }
    }

    const endpointUrl = ctx.ingress === 'api-gateway' ? `${this.ingress.endpointUrl}/${ROUTE}` : this.ingress.urlFor(GATEWAY_TARGET_NAME);
    new CfnOutput(this, 'EndpointUrl', { value: endpointUrl });
    new CfnOutput(this, 'RuntimeArn', { value: this.agentBackend.runtimeArn });
    new CfnOutput(this, 'RegistryPrefix', { value: this.registryPrefix });
    if (this.billing !== undefined) {
      new CfnOutput(this, 'BillingEndpointUrl', { value: this.billing.endpointUrl! });
      new CfnOutput(this, 'BillingRuntimeArn', { value: this.billing.runtimeArn });
    }
    new CfnOutput(this, 'Ingress', { value: ctx.ingress });
    new CfnOutput(this, 'IngressRoleArn', { value: this.ingress.ingressRole.roleArn });
    new CfnOutput(this, 'TvmCallerRoleArn', { value: this.ingress.tvmCallerRole.roleArn });
    // The TVM is always on (ADR-0018): the tenant role every model call is
    // signed by is always present, the deployer's role or the default one.
    new CfnOutput(this, 'TenantRoleArn', { value: this.ingress.tenantRole.roleArn });
    if (this.table !== undefined) {
      new CfnOutput(this, 'DemoTableName', { value: this.table.tableName });
    }
    // (v2) What the integration driver and scripts/demo.sh reach directly.
    new CfnOutput(this, 'Issuer', { value: this.ingress.issuer });
    new CfnOutput(this, 'EntitlementsApiUrl', { value: this.ingress.entitlementsApiUrl });
    new CfnOutput(this, 'EntitlementsTableName', { value: this.ingress.entitlementStore.tableName });
    for (const [name, gateway] of Object.entries(this.ingress.toolsGateways)) {
      const part = gatewayIdPart(name);
      new CfnOutput(this, `ToolsGatewayUrl${part}`, { value: gateway.gatewayUrl });
      new CfnOutput(this, `PolicyEngineId${part}`, { value: gateway.policyEngine.attrPolicyEngineId });
    }
    const filter = this.ingress.toolsGatewayNamed(DEMO_TOOLS_GATEWAYS.invoices)?.responseFilter;
    if (filter !== undefined) {
      new CfnOutput(this, 'ResponseFilterFunctionName', { value: filter.functionName });
    }
    new CfnOutput(this, 'CrmFunctionName', { value: this.crmFunction.functionName });
    new CfnOutput(this, 'InvoicesFunctionName', { value: this.invoicesFunction.functionName });
    new CfnOutput(this, 'CrmPolicySecondsToActive', { value: this.crm.policySecondsToActive });
    new CfnOutput(this, 'InvoicesPolicySecondsToActive', { value: this.invoices.policySecondsToActive });
    if (this.toolTenantRoles.length > 0) {
      new CfnOutput(this, 'CrmToolTenantRoleArn', { value: this.toolTenantRoles[0].roleArn });
    }
  }
}

/** The demo tools' tenant data access (P-15): the table, what the tool may do there, and the test mode. */
interface DemoToolData {
  readonly table?: dynamodb.TableV2;
  readonly actions: string[];
  readonly testMode: boolean;
}

/**
 * One demo tool target: a Lambda from src/tools/demo and its `ToolTarget`
 * (spec C-4). With a demo table, the tool's own tenant role (spec §6.1,
 * P-15): assumable only by this function's role with exactly a non-empty
 * `TenantId` session tag, and allowing `data.actions` only on the item of
 * that tenant (`dynamodb:LeadingKeys` = `TENANT#${aws:PrincipalTag/TenantId}`).
 */
function demoToolTarget(
  scope: Construct,
  id: string,
  ingress: SharedIngress,
  name: string,
  file: string,
  tools: ToolDefinition[],
  owner: string | undefined,
  gateway: string,
  data: DemoToolData,
): { target: ToolTarget; fn: NodejsFunction; role?: iam.Role } {
  const fn = new NodejsFunction(scope, `${id}Function`, {
    ...functionProps(scope, `${id}Logs`, Duration.seconds(10)),
    entry: path.join(__dirname, 'tools', 'demo', file),
    description: `runtime-isolation demo tool target ${name}: the calling tenant's data through the tool's TVM (P-15)`,
  });
  acknowledgeLambdaFindings(fn);
  let role: iam.Role | undefined;
  if (data.table !== undefined) {
    role = new iam.Role(scope, `${id}TenantRole`, {
      description: `Tool tenant role of ${name} (spec §6.1, P-15): assumable only by the tool function with a TenantId session tag; that tenant's demo item only`,
      assumedBy: new iam.ArnPrincipal(fn.role!.roleArn)
        .withConditions({
          'StringLike': { [`aws:RequestTag/${TENANT_TAG_KEY}`]: '?*' },
          'ForAllValues:StringEquals': { 'aws:TagKeys': [TENANT_TAG_KEY] },
        })
        .withSessionTags(),
      maxSessionDuration: Duration.hours(1),
    });
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'OwnTenantItemOnly',
        actions: data.actions,
        resources: [data.table.tableArn],
        conditions: { 'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': [`${TENANT_KEY_PREFIX}\${aws:PrincipalTag/${TENANT_TAG_KEY}}`] } },
      }),
    );
    fn.addEnvironment(DEMO_TOOL_ENV.TABLE_NAME, data.table.tableName);
  }
  if (data.testMode) {
    fn.addEnvironment(DEMO_TOOL_ENV.TEST_MODE, 'true');
  }
  const target = new ToolTarget(scope, id, { name, ingress, gateway, kind: 'lambda', function: fn, tools, owner, tvm: role === undefined ? undefined : { role } });
  return { target, fn, role };
}

/** A Contributor Insights rule over a JSON CloudWatch Logs group, enabled; counts by default, sums `ValueOf` with `AggregateOn: 'Sum'`. */
function insightRule(
  scope: Construct,
  id: string,
  ruleName: string,
  body: { LogGroupNames: string[]; Contribution: Record<string, unknown>; AggregateOn?: 'Count' | 'Sum' },
): cloudwatch.CfnInsightRule {
  return new cloudwatch.CfnInsightRule(scope, id, {
    ruleName,
    ruleState: 'ENABLED',
    ruleBody: Stack.of(scope).toJsonString({
      Schema: { Name: 'CloudWatchLogRule', Version: 1 },
      LogGroupNames: body.LogGroupNames,
      LogFormat: 'JSON',
      Contribution: body.Contribution,
      AggregateOn: body.AggregateOn ?? 'Count',
    }),
  });
}

/** The dashboard name for an ingress; one dashboard per deployed ingress. */
export function dashboardName(ingress: IngressKind): string {
  return `RuntimeIsolation-${ingress}`;
}

/** The SEARCH expression that finds one cost metric for every tenant on one ingress (Sum over the period). */
export function tenantSearchExpression(metricName: string, ingress: IngressKind): string {
  return `SEARCH('{${METRICS_NAMESPACE},TenantId,Ingress} MetricName="${metricName}" Ingress="${ingress}"', 'Sum', 300)`;
}

/** Which of the six cost metrics an ingress can meter (the interceptor sees only the request side). */
export function meteredCostMetrics(ingress: IngressKind): readonly string[] {
  return ingress === 'api-gateway' ? COST_METRIC_NAMES : [METRIC_NAMES.Requests, METRIC_NAMES.IngressDurationMs];
}

/**
 * The per-tenant cost dashboard (P-10, ADR-0017). Each widget is one cost
 * metric with one line per tenant. On the agentcore-gateway ingress the
 * backend and model widgets are replaced by a note, since that ingress
 * cannot meter them (gateway-interceptor.function.ts).
 */
function costDashboard(scope: Construct, ingress: IngressKind, title: string): cloudwatch.Dashboard {
  const dashboard = new cloudwatch.Dashboard(scope, 'CostDashboard', {
    dashboardName: title,
    defaultInterval: Duration.hours(3),
  });
  dashboard.addWidgets(
    new cloudwatch.TextWidget({
      width: 24,
      height: 2,
      markdown: [
        `## Per-tenant cost drivers, ingress \`${ingress}\` (P-10, ADR-0017)`,
        'Each line is one tenant (the `TenantId` dimension of the `RuntimeIsolation` EMF records). Cost per tenant = sum over metrics of (metric x unit price) plus an equal share of the unattributable remainder; see the README.',
      ].join('\n'),
    }),
  );
  const widgets = meteredCostMetrics(ingress).map(
    (name) =>
      new cloudwatch.GraphWidget({
        title: `${name} by tenant`,
        width: 8,
        height: 6,
        left: [new cloudwatch.MathExpression({ expression: tenantSearchExpression(name, ingress), label: name, period: Duration.minutes(5) })],
        leftYAxis: { min: 0 },
        statistic: 'Sum',
      }),
  );
  dashboard.addWidgets(...widgets);
  if (ingress === 'agentcore-gateway') {
    dashboard.addWidgets(
      new cloudwatch.TextWidget({
        width: 24,
        height: 3,
        markdown: [
          '### Not metered on this ingress',
          `\`${METRIC_NAMES.BackendInvokeSeconds}\`, \`${METRIC_NAMES.ModelInputTokens}\`, \`${METRIC_NAMES.ModelOutputTokens}\` and \`${METRIC_NAMES.StreamedBytes}\`: a REQUEST interceptor returns before the Runtime is invoked and never sees the response, so backend seconds and tokens cannot be attributed at this ingress (ADR-0009 comparison input).`,
        ].join('\n'),
      }),
    );
  }
  return dashboard;
}
