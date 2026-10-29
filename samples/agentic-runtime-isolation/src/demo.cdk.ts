// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The demo stack (spec C-4, §6.4; standard §4.5): a thin wiring of a
 * `SharedIngress` (with a `default` backend owning `default/chat`) and one
 * `AgentBackend` to the sample's dependencies, plus a second backend
 * (`billing`, owning `billing/read` and `billing/invoke`; ADR-0024,
 * ADR-0025) behind the same ingress on request. It reads tenant-identity's
 * published parameters for the issuer (ADR-0004) and for the scope
 * registration's API (ADR-0025), chooses the ingress and the optional
 * modules from CDK context,
 * and publishes the Runtime ARNs as this sample's parameters (the ingress
 * publishes its own, src/shared-ingress.cdk.ts). The TVM is always on (ADR-0018):
 * the `tvm` context flag now means "demo tenant data". When true, the demo
 * adds a tenant-partitioned table and its own data-bearing TenantRole and
 * passes it (ADR-0016 lazy trust ARN); when false, the demo passes no role
 * and the construct's default model-only TenantModelRole is used, so model
 * cost is still attributed per tenant. Only this file and the integration
 * test name tenant-identity; the construct does not.
 */

import { Aws, CfnOutput, CfnRule, Duration, Fn, Lazy, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { AgentBackend, type AgentProps } from './agent-backend.cdk';
import { AGENT_ENV } from './shared/config';
import { COST_METRIC_NAMES, type IngressKind, METRIC_NAMES, METRICS_NAMESPACE } from './shared/metrics';
import { ROUTE } from './shared/registry';
import type { IdentityApiProps } from './shared/scope-registration.cdk';
import type { SessionScope } from './shared/session';
import { TENANT_TAG_KEY, USER_TAG_KEY } from './shared/tvm';
import { DEFAULT_REGISTRY_PREFIX, GATEWAY_TARGET_NAME, SharedIngress, type SharedIngressProps } from './shared-ingress.cdk';

/**
 * tenant-identity's published parameters this stack consumes for the issuer
 * (ARCHITECTURE.md §5.1, ADR-0004). The scope registration reads two more,
 * `apiUrl` and `platformInvokePolicyArn` (`IDENTITY_API_PARAMETERS`, ADR-0025).
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
 * The scopes the demo's backends own (ADR-0025), named after the backend.
 * The default backend owns one; billing owns two, so the agent behind it can
 * tell a read-only token from one that may invoke. A tenant is entitled to a
 * scope by `CreateTenant.scopes` (tenant-identity ADR-0035) and a user by the
 * tenant admin (ADR-0036); the integration test gives tenant A all three and
 * tenant B `default/chat` only.
 */
export const DEFAULT_SCOPES = [`${GATEWAY_TARGET_NAME}/chat`] as const;
export const BILLING_SCOPES = [`${BILLING_BACKEND}/read`, `${BILLING_BACKEND}/invoke`] as const;

/** The build-time placeholders (standard §4.3). A CloudFormation rule refuses to deploy a stack that carries them. */
export const PLACEHOLDER = {
  userPoolId: 'PLACEHOLDER-NOT-A-USER-POOL',
  appClientId: 'PLACEHOLDER-NOT-A-CLIENT-ID',
  apiUrl: 'https://placeholder-not-an-api.example.com/',
  platformInvokePolicyArn: 'arn:aws:iam::111122223333:policy/PLACEHOLDER-NOT-A-POLICY',
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
  readonly forwardUserToken: boolean;
  readonly requireNarrowedToken: boolean;
  readonly allowedScopes?: string[];
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
   * Add the `billing` backend behind the same ingress (ADR-0024), owning `BILLING_SCOPES`
   * (ADR-0025). Default off: the one-backend form. The demo deploy and the integration
   * stacks turn it on.
   */
  readonly billingBackend?: boolean;
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
    forwardUserToken: flag(read, 'forwardUserToken'),
    requireNarrowedToken: flag(read, 'requireNarrowedToken'),
    allowedScopes: list(read, 'allowedScopes'),
    tvm: flag(read, 'tvm'),
    includeUserIdTag: flag(read, 'includeUserIdTag'),
    modelId,
    identityParameterPlaceholders: flag(read, 'identityParameterPlaceholders'),
    perTenantMetrics: flag(read, 'perTenantMetrics'),
    requestsPerMinute: integer(read, 'requestsPerMinute'),
    outputTokensPerMinute: integer(read, 'outputTokensPerMinute'),
    publishParameters: read('publishParameters') === undefined ? true : flag(read, 'publishParameters'),
    billingBackend: read('billingBackend') === undefined ? undefined : flag(read, 'billingBackend'),
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
  /** The cost dashboard's name (account-wide). Default `RuntimeIsolation-<ingress>`; the integration test passes its stack name so several stacks of one ingress coexist. */
  readonly dashboardName?: string;
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

  constructor(scope: Construct, id: string, props: RuntimeIsolationDemoStackProps) {
    super(scope, id, props);
    const ctx = props.context;

    // The issuer (ADR-0004): tenant-identity's shared pool, read from its
    // published parameters at deploy time; the scope registration reads the
    // identity API's URL and invoke policy the same way (ADR-0025). The build
    // synthesises with placeholders no account can resolve, and the rule
    // below makes sure a placeholder template is refused by CloudFormation.
    let userPoolId: string;
    let appClientId: string;
    let identityApi: IdentityApiProps | undefined;
    if (ctx.identityParameterPlaceholders) {
      userPoolId = PLACEHOLDER.userPoolId;
      appClientId = PLACEHOLDER.appClientId;
      identityApi = { apiUrl: PLACEHOLDER.apiUrl, platformInvokePolicyArn: PLACEHOLDER.platformInvokePolicyArn };
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
    this.ingress = new SharedIngress(this, 'SharedIngress', {
      identity: { discoveryUrl, allowedClientIds: [appClientId] },
      ingress: ctx.ingress,
      registryPrefix: this.registryPrefix,
      session: ctx.sessionScope === undefined ? undefined : { scope: ctx.sessionScope },
      requiredScopes: ctx.requiredScopes,
      delegation: {
        forwardUserToken: ctx.forwardUserToken,
        requireNarrowedToken: ctx.requireNarrowedToken,
        allowedScopes: ctx.allowedScopes,
      },
      tvm,
      perTenantMetrics: ctx.perTenantMetrics ?? false,
      tenantLimits:
        ctx.requestsPerMinute === undefined && ctx.outputTokensPerMinute === undefined
          ? undefined
          : { requestsPerMinute: ctx.requestsPerMinute, outputTokensPerMinute: ctx.outputTokensPerMinute },
      defaultBackend: GATEWAY_TARGET_NAME,
    });
    this.agentBackend = new AgentBackend(this, 'AgentBackend', {
      name: GATEWAY_TARGET_NAME,
      ingress: this.ingress,
      agent,
      scopes: [...DEFAULT_SCOPES],
      identityApi,
    });
    callerRoleArn = this.ingress.tvmCallerRole.roleArn;

    // A second backend behind the same ingress (ADR-0024): the same agent
    // code and model, its own Runtime, registry entry and scopes (ADR-0025).
    // A token carrying `default/chat` alone reaches `/default/invocations`
    // and gets 403 on `/billing/invocations`; one carrying `billing/read` or
    // `billing/invoke` reaches billing.
    if (wantsBillingBackend(ctx)) {
      this.billing = new AgentBackend(this, 'BillingBackend', {
        name: BILLING_BACKEND,
        ingress: this.ingress,
        agent,
        scopes: [...BILLING_SCOPES],
        identityApi,
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
    // publishes endpointUrl, ingress, ingressRoleArn, ingressId and
    // tenantRoleArn under its prefix (ADR-0024); the demo adds the Runtime
    // ARNs. The default prefix is account-wide, so one stack per account and
    // Region publishes there.
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
  }
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
