// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The demo stack (spec C-4, §6.4; standard §4.5): a thin wiring of
 * `IsolatedRuntime` to the sample's dependencies. It reads tenant-identity's
 * published parameters for the issuer (ADR-0004), chooses the ingress and the
 * optional modules from CDK context, and publishes the construct's read-only
 * properties as this sample's parameters. The TVM is always on (ADR-0018):
 * the `tvm` context flag now means "demo tenant data". When true, the demo
 * adds a tenant-partitioned table and its own data-bearing TenantRole and
 * passes it (ADR-0016 lazy trust ARN); when false, the demo passes no role
 * and the construct's default model-only TenantModelRole is used, so model
 * cost is still attributed per tenant. Only this file and the integration
 * test name tenant-identity; the construct does not.
 */

import { CfnOutput, CfnRule, Duration, Fn, Lazy, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { IsolatedRuntime, IsolatedRuntimeProps } from './runtime-isolation.cdk';
import { AGENT_ENV } from './shared/config';
import { COST_METRIC_NAMES, type IngressKind, METRIC_NAMES, METRICS_NAMESPACE } from './shared/metrics';
import type { SessionScope } from './shared/session';
import { TENANT_TAG_KEY, USER_TAG_KEY } from './shared/tvm';

/** tenant-identity's published parameters this sample consumes (ARCHITECTURE.md §5.1, ADR-0004). */
export const IDENTITY_PARAMETERS = {
  userPoolId: '/application-plane/shared/identity/userPoolId',
  appClientId: '/application-plane/shared/identity/appClientId',
} as const;

/** This sample's published parameters (spec §6.4, ARCHITECTURE.md §5.1). */
export const AGENT_RUNTIME_PARAMETERS = {
  endpointUrl: '/application-plane/shared/agent-runtime/endpointUrl',
  runtimeArn: '/application-plane/shared/agent-runtime/runtimeArn',
  ingress: '/application-plane/shared/agent-runtime/ingress',
} as const;

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
  readonly forwardUserToken: boolean;
  readonly requireNarrowedToken: boolean;
  readonly allowedScopes?: string[];
  readonly tvm: boolean;
  readonly includeUserIdTag: boolean;
  readonly modelId: string;
  /** Build-only: synthesise with placeholders instead of tenant-identity's parameters. */
  readonly identityParameterPlaceholders: boolean;
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
  };
}

export interface RuntimeIsolationDemoStackProps extends StackProps {
  readonly context: DemoContext;
  /** Directory with the bundled agent (`app.js`); see src/agent/bundle.ts. */
  readonly agentCodePath: string;
  /** Publish the `/application-plane/shared/agent-runtime/*` parameters. Default true; the integration test turns it off on all but one stack. */
  readonly publishParameters?: boolean;
  /** The cost dashboard's name (account-wide). Default `RuntimeIsolation-<ingress>`; the integration test passes its stack name so several stacks of one ingress coexist. */
  readonly dashboardName?: string;
}

export class RuntimeIsolationDemoStack extends Stack {
  readonly runtime: IsolatedRuntime;
  readonly table?: dynamodb.TableV2;
  readonly tenantRole?: iam.Role;
  /** The per-tenant cost dashboard, `RuntimeIsolation-<ingress>` (P-10). */
  readonly dashboard: cloudwatch.Dashboard;

  constructor(scope: Construct, id: string, props: RuntimeIsolationDemoStackProps) {
    super(scope, id, props);
    const ctx = props.context;

    // The issuer (ADR-0004): tenant-identity's shared pool, read from its
    // published parameters at deploy time. The build synthesises with
    // placeholders no account can resolve, and the rule below makes sure a
    // placeholder template is refused by CloudFormation.
    let userPoolId: string;
    let appClientId: string;
    if (ctx.identityParameterPlaceholders) {
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

    // The TVM is always on (ADR-0018). `ctx.tvm` means "demo tenant data":
    // true adds a tenant-partitioned table and the construct's tvmCallerRole
    // may assume a data-bearing role the demo owns (ADR-0016 lazy trust ARN);
    // false passes no role, so the construct creates its default model-only
    // role and model cost is still attributed per tenant.
    let tvm: IsolatedRuntimeProps['tvm'] = { includeUserIdTag: ctx.includeUserIdTag };
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

    this.runtime = new IsolatedRuntime(this, 'IsolatedRuntime', {
      identity: { discoveryUrl, allowedClientIds: [appClientId] },
      agent: { codePath: props.agentCodePath, modelId: ctx.modelId, environment: agentEnvironment },
      ingress: ctx.ingress,
      session: ctx.sessionScope === undefined ? undefined : { scope: ctx.sessionScope },
      requiredScopes: ctx.requiredScopes,
      delegation: {
        forwardUserToken: ctx.forwardUserToken,
        requireNarrowedToken: ctx.requireNarrowedToken,
        allowedScopes: ctx.allowedScopes,
      },
      tvm,
    });
    callerRoleArn = this.runtime.tvmCallerRole.roleArn;

    // P-9 on the api-gateway ingress: top tenants by request and by error,
    // from the access log's tenantId field. P-10 (ADR-0017): top tenants by
    // backend seconds and by output tokens, from the ingress Lambda's EMF
    // records (the same log group the metrics come from). The
    // agentcore-gateway ingress has no access log of its own and its
    // interceptor sees only the request side (no backend or model figures),
    // so it gets none of these.
    if (ctx.ingress === 'api-gateway') {
      const accessLogs = this.runtime.node.findChild('ApiAccessLogs') as logs.LogGroup;
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
      const ingressLogs = this.runtime.node.findChild('IngressLogs') as logs.LogGroup;
      insightRule(this, 'TopTenantsByBackendSeconds', `${this.stackName}-top-tenants-backend-seconds`, {
        LogGroupNames: [ingressLogs.logGroupName],
        Contribution: {
          Keys: ['$.TenantId'],
          ValueOf: `$.${METRIC_NAMES.BackendInvokeSeconds}`,
          Filters: [{ Match: `$.${METRIC_NAMES.BackendInvokeSeconds}`, IsPresent: true }],
        },
        AggregateOn: 'Sum',
      });
      insightRule(this, 'TopTenantsByOutputTokens', `${this.stackName}-top-tenants-output-tokens`, {
        LogGroupNames: [ingressLogs.logGroupName],
        Contribution: {
          Keys: ['$.TenantId'],
          ValueOf: `$.${METRIC_NAMES.ModelOutputTokens}`,
          Filters: [{ Match: `$.${METRIC_NAMES.ModelOutputTokens}`, IsPresent: true }],
        },
        AggregateOn: 'Sum',
      });
    }

    // The per-tenant cost dashboard (P-10, ADR-0017): one widget per cost
    // metric, one line per tenant, found by a SEARCH over the TenantId
    // dimension so a new tenant appears without a template change.
    this.dashboard = costDashboard(this, ctx.ingress, props.dashboardName ?? dashboardName(ctx.ingress));

    // The published interface (spec §6.4, standard §1.1).
    if (props.publishParameters ?? true) {
      new ssm.StringParameter(this, 'EndpointUrlParameter', {
        parameterName: AGENT_RUNTIME_PARAMETERS.endpointUrl,
        stringValue: this.runtime.endpointUrl,
        description: 'runtime-isolation: the ingress invocation URL (POST, bearer token)',
      });
      new ssm.StringParameter(this, 'RuntimeArnParameter', {
        parameterName: AGENT_RUNTIME_PARAMETERS.runtimeArn,
        stringValue: this.runtime.runtimeArn,
        description: 'runtime-isolation: the AgentCore Runtime ARN',
      });
      new ssm.StringParameter(this, 'IngressParameter', {
        parameterName: AGENT_RUNTIME_PARAMETERS.ingress,
        stringValue: ctx.ingress,
        description: 'runtime-isolation: the deployed ingress (api-gateway or agentcore-gateway)',
      });
    }

    new CfnOutput(this, 'EndpointUrl', { value: this.runtime.endpointUrl });
    new CfnOutput(this, 'RuntimeArn', { value: this.runtime.runtimeArn });
    new CfnOutput(this, 'Ingress', { value: ctx.ingress });
    new CfnOutput(this, 'IngressRoleArn', { value: this.runtime.ingressRole.roleArn });
    new CfnOutput(this, 'TvmCallerRoleArn', { value: this.runtime.tvmCallerRole.roleArn });
    // The TVM is always on (ADR-0018): the tenant role every model call is
    // signed by is always present, the deployer's role or the default one.
    new CfnOutput(this, 'TenantRoleArn', { value: this.runtime.tenantRole.roleArn });
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
