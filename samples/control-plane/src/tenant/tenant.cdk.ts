// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as fs from 'fs';
import * as path from 'path';
import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps, Validations } from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { ProvisioningWorkflow } from './tenant.sfn';
import { stackIdentity, validateTenantBuildManagedPolicyArns } from './validation';
import { CellAccountRoles } from '../cell-account/cell-account.cdk';
import { apiRoleName, DEFAULT_FLEET_NAME, provisioningRoleArn, validateFleetName } from '../shared/fleet';
import { nagFindingResource, acknowledgeGranularFinding, suppressTemplateScanners } from '../shared/nag';

export interface TenantStackProps extends StackProps {
  /** Vendor IdP OIDC issuer URL - validated by the Lambda Authorizer. */
  readonly vendorIdpIssuerUrl: string;
  /** Vendor IdP audience expected in control plane JWTs. */
  readonly vendorIdpAudience: string;
  /**
   * DEMO ONLY: application ids for which this stack publishes
   * `/application-plane/applications/<id>/shared/base-domain` in its own
   * account, so the sample cell script has a shared resource to read
   * (ADR-010, ADR-034). A real deployment's application plane publishes its
   * own. Default: none.
   */
  readonly demoApplicationIds?: string[];
  /**
   * Names the five physical roles of the fleet (spec §3.3, ADR-025/028):
   * the pair every account installs, `<fleetName>-cell-provisioning` and
   * `<fleetName>-tenant-provisioning`; the control plane's build roles,
   * `<fleetName>-cell-build` and `<fleetName>-tenant-build`; and its API
   * role, `<fleetName>-api`. `[a-z0-9-]{1,32}`; default `control-plane`.
   * Two control planes in one account need different fleet names, and the
   * names must be free in every account the fleet will register (T31).
   */
  readonly fleetName?: string;
  /**
   * Optional deployment input (ADR-022, narrowed by ADR-025): customer-managed
   * IAM policy ARNs attached to the tenant provisioning role this stack
   * installs in its OWN account, in addition to its SSM namespace grants
   * (spec §6.2). Lets a tenant script call an application-plane API with a
   * policy the application plane publishes (producer-owned least privilege)
   * while the control plane learns only an ARN list - never what the policy
   * is for (P-3). Every entry must be a managed-policy ARN in this stack's
   * partition and account; synth fails otherwise. Other accounts attach
   * their own through the `CellAccountStack`. Default: none.
   */
  readonly tenantBuildManagedPolicyArns?: string[];
}

/** GSI-1: cell, account and application listing, per-cell deployment lookup (spec §4.7). */
export const GSI1_NAME = 'GSI1';
/** GSI-2: unfiltered tenant and deployment listing, per-account cell lookup (§4.7). */
export const GSI2_NAME = 'GSI2';
/** GSI-3: per-application cell and deployment lookup (§4.7). */
export const GSI3_NAME = 'GSI3';

// Re-exported so existing imports of the input validators keep working.
export {
  StackIdentity,
  stackIdentity,
  validateTenantBuildManagedPolicyArns,
} from './validation';

/**
 * The cell-based control plane - one stack: API Gateway (generated from the
 * Smithy OpenAPI output), Lambda Authorizer (vendor IdP), API handler, the
 * single table (GSI-1/2/3), and the provisioning workflow
 * (architecture.md §3).
 */
export class TenantStack extends Stack {
  /** The provisioning workflow (exposed so tests can grant script-source access). */
  readonly provisioning: ProvisioningWorkflow;
  /**
   * The account role pair installed in this stack's own account (spec R-25,
   * ADR-025): the home account is reached exactly like any other, so it needs
   * the same `<fleet>-cell-provisioning` / `<fleet>-tenant-provisioning` roles.
   */
  readonly homeAccountRoles: CellAccountRoles;
  /** The validated fleet name. */
  readonly fleetName: string;
  /** The deployed API base URL (with trailing slash). */
  readonly apiUrl: string;

  constructor(scope: Construct, id: string, props: TenantStackProps) {
    super(scope, id, props);

    this.fleetName = validateFleetName(props.fleetName ?? DEFAULT_FLEET_NAME);
    // Fail synth on a policy ARN outside this partition/account (ADR-022).
    const identity = stackIdentity(this);
    validateTenantBuildManagedPolicyArns(props.tenantBuildManagedPolicyArns, identity);

    // --- Control plane table (applications + accounts + cells + tenants +
    // deployments, single table, spec §4) ---
    // PK=APPLICATION#<id>|ACCOUNT#<id>|CELL#<id>|TENANT#<id>, SK=META; a
    // tenant's deployments share its partition under SK=DEPLOYMENT#<appId>.
    // GSI-1 (static APPLICATION, ACCOUNT and CELL partitions, CELL#<id> for a
    // cell's deployments), GSI-2 (static TENANT and DEPLOYMENT partitions,
    // ACCOUNT#<id> for an account's cells) and GSI-3 (APPLICATION#<id> for an
    // application's cells and deployments) serve the listing patterns and
    // the two placement scans (§4.7); all project ALL attributes - the
    // candidate scan needs status/tenantCount/maxTenants, and the listings
    // return full summaries. The GSIs are eventually consistent and never
    // authoritative - the four counters on the base records are the
    // occupancy guards (P-5, P-6).
    const table = new dynamodb.TableV2(this, 'TenantTable', {
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      globalSecondaryIndexes: [
        {
          indexName: GSI1_NAME,
          partitionKey: { name: 'GSI1PK', type: dynamodb.AttributeType.STRING },
          sortKey: { name: 'GSI1SK', type: dynamodb.AttributeType.STRING },
          projectionType: dynamodb.ProjectionType.ALL,
        },
        {
          indexName: GSI2_NAME,
          partitionKey: { name: 'GSI2PK', type: dynamodb.AttributeType.STRING },
          sortKey: { name: 'GSI2SK', type: dynamodb.AttributeType.STRING },
          projectionType: dynamodb.ProjectionType.ALL,
        },
        {
          indexName: GSI3_NAME,
          partitionKey: { name: 'GSI3PK', type: dynamodb.AttributeType.STRING },
          sortKey: { name: 'GSI3SK', type: dynamodb.AttributeType.STRING },
          projectionType: dynamodb.ProjectionType.ALL,
        },
      ],
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      // Garbage-collects CreateDeployment idempotency records (ADR-017). TTL
      // deletion is lazy, so tokens are honoured for AT LEAST 24h — replay
      // handling never reads expiresAt.
      timeToLiveAttribute: 'expiresAt',
      // Sample only - a production control plane retains its tenant registry.
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // --- Provisioning workflow (Step Functions + two shared CodeBuild
    //     projects with distinct service roles, §3/§7) ---------------------
    // The workflow grants itself least-privilege table access internally.
    const workflow = new ProvisioningWorkflow(this, 'Provisioning', {
      table,
      fleetName: this.fleetName,
    });
    this.provisioning = workflow;

    // --- The home account's role pair (R-25, ADR-025) ----------------------
    // The control plane's own account is just another registered account:
    // the pair it installs here is what the CellAccountStack installs in
    // every other account, trusting the build roles above by ARN. The
    // deployer registers this account with PutAccount like any other.
    this.homeAccountRoles = new CellAccountRoles(this, 'HomeAccountRoles', {
      controlPlaneAccountId: this.account,
      fleetName: this.fleetName,
      tenantBuildManagedPolicyArns: props.tenantBuildManagedPolicyArns,
      identity,
    });
    // Same-stack ordering only: the trust is by account + aws:PrincipalArn
    // condition, so IAM does not need the build roles to exist first.
    this.homeAccountRoles.node.addDependency(workflow.cellBuildRole, workflow.tenantBuildRole);
    // (The API role is created below; the trust is by name, so no ordering is needed.)

    // --- Lambda Authorizer (the ingress layer) ----------------------------
    const authorizerFn = new NodejsFunction(this, 'AuthorizerFunction', {
      entry: path.join(__dirname, '../shared/authorizer.function.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      bundling: {
        externalModules: [], // bundle everything - see ApiFunction note
      },
      // M15 (T13): explicit log group with bounded retention — the
      // Lambda-service-created default group never expires.
      logGroup: functionLogGroup(this, 'AuthorizerFunctionLogs'),
      environment: {
        VENDOR_IDP_ISSUER_URL: props.vendorIdpIssuerUrl,
        VENDOR_IDP_AUDIENCE: props.vendorIdpAudience,
        // M13 (T2/T20): the role allowlist the authorizer enforces on the
        // JWT `role` claim. 'operator' is also the code's default when
        // unset — wiring it here makes the enforcement configuration
        // visible at the deployment surface.
        ALLOWED_ROLES: 'operator',
      },
    });
    acknowledgeLambdaBasicExecutionRole(authorizerFn);

    // --- API handler (pass-through to the Smithy service handler) ---------
    // The role has the physical name `<fleet>-api` (ADR-028): every account
    // role pair trusts it by ARN for the PutAccount handshake probe.
    const apiRole = new iam.Role(this, 'ApiFunctionRole', {
      roleName: apiRoleName(this.fleetName),
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: `${this.fleetName} control plane API: table access, workflow start, and the PutAccount handshake probe into registered accounts (ADR-027)`,
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
    });
    suppressTemplateScanners(apiRole, {
      cfnNag: [{ id: 'W28', reason: 'The physical name is the cross-account contract: every account role pair trusts this role by ARN for the registration probe (ADR-027/028).' }],
    });
    const apiFn = new NodejsFunction(this, 'ApiFunction', {
      entry: path.join(__dirname, 'tenant.function.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      role: apiRole,
      // M15 (T13) — see AuthorizerFunction.
      logGroup: functionLogGroup(this, 'ApiFunctionLogs'),
      bundling: {
        // Bundle everything. The default externalModules treats @smithy/* as
        // provided by the Lambda runtime, but the runtime SDK does NOT ship
        // the Smithy *server* packages (@smithy/server-apigateway,
        // @smithy/server-common) - relying on externals 502s at cold start.
        externalModules: [],
        // The SSDK's generated validators use re2-wasm, which loads its wasm
        // binary from disk at runtime - esbuild does not bundle it.
        commandHooks: {
          beforeBundling: () => [],
          beforeInstall: () => [],
          afterBundling: (inputDir: string, outputDir: string) => [
            `cp ${inputDir}/node_modules/re2-wasm/build/wasm/re2.wasm ${outputDir}/`,
          ],
        },
      },
      environment: {
        TABLE_NAME: table.tableName,
        GSI1_NAME: GSI1_NAME,
        GSI2_NAME: GSI2_NAME,
        GSI3_NAME: GSI3_NAME,
        STATE_MACHINE_ARN: workflow.stateMachine.stateMachineArn,
        CELL_PROJECT_NAME: workflow.cellProject.projectName,
        TENANT_PROJECT_NAME: workflow.tenantProject.projectName,
        // ADR-025: the service derives each cell's provisioning role ARNs
        // from the fleet name and the account id (resolved input, R-20).
        FLEET_NAME: this.fleetName,
      },
    });
    table.grantReadWriteData(apiFn);
    workflow.stateMachine.grantStartExecution(apiFn);
    // ADR-027 (M20): PutAccount probes both halves of the pair in the account
    // being registered. The resource is the role NAME in any account (N-8) -
    // the same bound the build roles carry; the target trust policy is the
    // gate. The probe makes no call under the assumed credentials.
    const probeTargets = (['cell', 'tenant'] as const).map((kind) =>
      provisioningRoleArn(this.partition, '*', this.fleetName, kind));
    apiFn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'ProbeAccountHandshake',
        actions: ['sts:AssumeRole'],
        resources: probeTargets,
      }),
    );
    for (const target of probeTargets) {
      acknowledgeGranularFinding(
        apiRole,
        `AwsSolutions-IAM5[Resource::${nagFindingResource(this, target)}]`,
        'PutAccount verifies the account handshake by assuming the provisioning role pair (ADR-027); accounts are registered at run time, so the resource is the role name in any account (spec N-8) and the target trust policy is the gate (M20).',
      );
    }
    acknowledgeLambdaBasicExecutionRole(apiFn);
    // The explicit role is not a child of the function, so the findings on
    // its policies are acknowledged on the role itself.
    acknowledgeGranularFinding(
      apiRole,
      'AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]',
      'Logs-only managed policy; a scoped customer-managed replacement adds boilerplate with marginal benefit.',
    );
    acknowledgeGranularFinding(
      apiRole,
      `AwsSolutions-IAM5[Resource::${nagFindingResource(this, `${table.tableArn}/index/*`)}]`,
      'grantReadWriteData grants Query on the table\'s own GSIs - the wildcard is scoped to this table\'s index namespace, not across resources.',
    );

    // --- API Gateway from the Smithy-generated OpenAPI spec ---------------
    // Never hand-crafted: the spec is generated by `smithy build`; only the
    // PLACEHOLDER URIs (authorizer + integrations) are patched at synth time.
    const apiAccessLogs = new logs.LogGroup(this, 'ApiAccessLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY, // sample only
    });
    const api = new apigateway.SpecRestApi(this, 'Api', {
      apiDefinition: apigateway.ApiDefinition.fromInline(
        patchOpenApiSpec(this, authorizerFn.functionArn, apiFn.functionArn),
      ),
      deployOptions: {
        stageName: 'prod',
        // Who called the API and how (AwsSolutions-APIG1). M12 (T9): the
        // custom JSON format adds the authorizer principalId — the verified
        // JWT `sub` — so every logged request, INCLUDING denied ones, is
        // attributable to an operator. jsonWithStandardFields() omits it.
        accessLogDestination: new apigateway.LogGroupLogDestination(apiAccessLogs),
        accessLogFormat: apigateway.AccessLogFormat.custom(JSON.stringify({
          requestId: apigateway.AccessLogField.contextRequestId(),
          ip: apigateway.AccessLogField.contextIdentitySourceIp(),
          requestTime: apigateway.AccessLogField.contextRequestTime(),
          httpMethod: apigateway.AccessLogField.contextHttpMethod(),
          resourcePath: apigateway.AccessLogField.contextResourcePath(),
          status: apigateway.AccessLogField.contextStatus(),
          protocol: apigateway.AccessLogField.contextProtocol(),
          responseLength: apigateway.AccessLogField.contextResponseLength(),
          // The operator identity: the authorizer's principalId (JWT sub),
          // present on Allow AND Deny — the audit chain's first link.
          operatorId: apigateway.AccessLogField.contextAuthorizerPrincipalId(),
        })),
        // Execution logging for every method (AwsSolutions-APIG6).
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
        // X-Ray tracing (CKV_AWS_73) - completes the trace path that the
        // provisioning state machine already participates in.
        tracingEnabled: true,
        // Explicit stage throttling: CreateDeployment/UpdateDeployment start
        // CodeBuild builds, so a leaked token is a cost-amplification
        // vector. Modest sample-appropriate limits; tune for real fleets.
        throttlingRateLimit: 20,
        throttlingBurstLimit: 40,
      },
    });
    this.apiUrl = api.url;

    // M17 (T16): sustained client errors are the probing / leaked-token /
    // amplification-attempt signature at the API edge. Alarm only (no
    // actions) — sample scope surfaces the signal.
    new cloudwatch.Alarm(this, 'ApiClientErrorAlarm', {
      metric: api.metricClientError({
        period: Duration.minutes(5),
        statistic: 'Sum',
      }),
      threshold: 50,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription:
        'More than 50 4XX responses in 5 minutes - possible token probing or amplification attempt (threat T16, mitigation M17).',
    });
    acknowledgeGranularFinding(
      api,
      'AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AmazonAPIGatewayPushToCloudWatchLogs]',
      'The canonical AWS policy for API Gateway\'s account-level CloudWatch logging role - required for stage execution logging (APIG6).',
    );
    Validations.of(api).acknowledge({
      id: 'AwsSolutions-APIG2',
      reason: 'Request validation IS enabled: the Smithy model applies @requestValidator("full"), embedded in the OpenAPI definition. The rule only detects standalone CfnRequestValidator resources, which SpecRestApi does not create.',
    });
    Validations.of(api).acknowledge({
      id: 'AwsSolutions-APIG3',
      reason: 'WAFv2 association is a production deployment concern outside this sample\'s scope - the stage is protected by the Lambda Authorizer and explicit throttling limits.',
    });
    suppressTemplateScanners(apiAccessLogs, {
      cfnNag: [{ id: 'W84', reason: 'Access logs carry request metadata only; default CloudWatch Logs SSE encryption at rest is sufficient for this sample.' }],
      checkov: [{ id: 'CKV_AWS_158', comment: 'Access logs carry request metadata only; default CloudWatch Logs SSE encryption at rest is sufficient for this sample.' }],
    });
    suppressTemplateScanners(api.deploymentStage, {
      cfnNag: [{ id: 'W64', reason: 'The API is not usage-plan/API-key based: callers authenticate with vendor-IdP JWTs via the Lambda Authorizer, and explicit stage throttling bounds request rates.' }],
      checkov: [{ id: 'CKV_AWS_120', comment: 'Control-plane responses are per-caller and mutation-heavy; stage caching risks stale reads for marginal benefit.' }],
    });
    if (api.latestDeployment !== undefined) {
      suppressTemplateScanners(api.latestDeployment, {
        cfnNag: [{ id: 'W68', reason: 'The API is not usage-plan/API-key based: callers authenticate with vendor-IdP JWTs via the Lambda Authorizer, and explicit stage throttling bounds request rates.' }],
      });
    }
    // Least-privilege policies with granular per-namespace statements push
    // the SPCM metric past cfn_nag's threshold - explicit scoping, not
    // over-breadth.
    suppressTemplateScanners(apiFn.role!.node.findChild('DefaultPolicy'), {
      cfnNag: [{ id: 'W76', reason: 'Least-privilege policy with granular per-resource statements (table, GSIs, state machine, idempotency); the statement-point count reflects explicit scoping, not over-breadth.' }],
    });

    // API Gateway must be allowed to invoke both functions.
    apiFn.addPermission('ApiGatewayInvoke', {
      principal: new iam.ServicePrincipal('apigateway.amazonaws.com'),
      sourceArn: api.arnForExecuteApi(),
    });
    authorizerFn.addPermission('ApiGatewayAuthorizerInvoke', {
      principal: new iam.ServicePrincipal('apigateway.amazonaws.com'),
      sourceArn: Stack.of(this).formatArn({
        service: 'execute-api',
        resource: api.restApiId,
        resourceName: 'authorizers/*',
      }),
    });

    // --- Discovery + outputs ----------------------------------------------
    new ssm.StringParameter(this, 'ApiUrlParameter', {
      parameterName: '/control-plane/tenant-api-url',
      stringValue: api.url,
    });

    // DEMO ONLY: stands in for application-plane shared infrastructure in
    // the home account, one namespace per application (ADR-010, ADR-034). In
    // a real deployment the application plane publishes its own shared
    // resource identifiers - the control plane is not involved. Every other
    // account gets its own from the CellAccountStack.
    for (const applicationId of props.demoApplicationIds ?? []) {
      new ssm.StringParameter(this, `DemoSharedBaseDomain-${applicationId}`, {
        parameterName: `/application-plane/applications/${applicationId}/shared/base-domain`,
        stringValue: `${applicationId}.cells.example.com`,
      });
    }

    new CfnOutput(this, 'ApiUrl', { value: api.url });
    new CfnOutput(this, 'StateMachineArn', { value: workflow.stateMachine.stateMachineArn });
    new CfnOutput(this, 'FleetName', { value: this.fleetName });
    new CfnOutput(this, 'ControlPlaneAccountId', {
      value: this.account,
      description: 'Pass as controlPlaneAccountId when installing the account role pair in another account (spec §6.4)',
    });
  }
}

/**
 * Acknowledges the AwsSolutions-IAM4 finding for the AWSLambdaBasicExecutionRole
 * managed policy that NodejsFunction attaches to every function's service role.
 */
function acknowledgeLambdaBasicExecutionRole(fn: NodejsFunction): void {
  acknowledgeGranularFinding(
    fn,
    'AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]',
    'Logs-only managed policy attached by NodejsFunction; a scoped customer-managed replacement adds boilerplate with marginal benefit.',
  );
  // Template-scanner (cfn_nag/checkov) counterparts of the deliberate
  // deviations above - annotated on the resources so scans of the
  // synthesized templates (e.g. the committed integ snapshot) see the
  // same documented decisions.
  suppressTemplateScanners(fn, {
    cfnNag: [
      { id: 'W58', reason: 'Log permissions come from the AWSLambdaBasicExecutionRole managed policy on the function role; cfn_nag does not resolve managed policies.' },
      { id: 'W89', reason: 'The function calls only AWS APIs over public endpoints; there are no VPC-internal resources to reach. VPC placement adds cost and complexity without a security benefit here.' },
      { id: 'W92', reason: 'The sample does not partition account concurrency; API Gateway stage throttling bounds the invoke rate.' },
    ],
    checkov: [
      { id: 'CKV_AWS_115', comment: 'The sample does not partition account concurrency; API Gateway stage throttling bounds the invoke rate.' },
      { id: 'CKV_AWS_116', comment: 'Synchronous API/authorizer function - failures surface to the caller as HTTP errors; there is no async event source to dead-letter.' },
      { id: 'CKV_AWS_117', comment: 'The function calls only AWS APIs over public endpoints; there are no VPC-internal resources to reach.' },
      { id: 'CKV_AWS_173', comment: 'Environment variables carry non-secret configuration (table/project names, ARNs, public IdP values); default encryption at rest applies.' },
    ],
  });
  // Newer feature flags give the function an owned LogGroup child; older
  // apps rely on the Lambda-service-created group (no CFN resource).
  // (fn.logGroup returns an imported wrapper, so target the child directly.)
  const ownedLogGroup = fn.node.tryFindChild('LogGroup');
  if (ownedLogGroup !== undefined) {
    suppressTemplateScanners(ownedLogGroup, {
      cfnNag: [{ id: 'W84', reason: 'Function logs carry non-sensitive request metadata; default CloudWatch Logs SSE encryption at rest is sufficient for this sample.' }],
      checkov: [{ id: 'CKV_AWS_158', comment: 'Function logs carry non-sensitive request metadata; default CloudWatch Logs SSE encryption at rest is sufficient for this sample.' }],
    });
  }
}

/**
 * An explicit Lambda function log group with bounded retention (M15,
 * threat T13): the Lambda-service-created default group never expires and
 * exists outside the stack. One month matches the other control plane log
 * groups (API access logs, workflow logs, build logs).
 */
function functionLogGroup(scope: Construct, id: string): logs.LogGroup {
  const logGroup = new logs.LogGroup(scope, id, {
    retention: logs.RetentionDays.ONE_MONTH,
    removalPolicy: RemovalPolicy.DESTROY, // sample only
  });
  suppressTemplateScanners(logGroup, {
    cfnNag: [{ id: 'W84', reason: 'Function logs carry non-sensitive request metadata; default CloudWatch Logs SSE encryption at rest is sufficient for this sample.' }],
    checkov: [{ id: 'CKV_AWS_158', comment: 'Function logs carry non-sensitive request metadata; default CloudWatch Logs SSE encryption at rest is sufficient for this sample.' }],
  });
  return logGroup;
}

/**
 * Loads the generated OpenAPI spec and patches the two PLACEHOLDER kinds:
 * - the token authorizer's `authorizerUri` → the authorizer Lambda
 * - every operation's `x-amazon-apigateway-integration.uri` → the API Lambda
 */
function patchOpenApiSpec(stack: Stack, authorizerFnArn: string, apiFnArn: string): object {
  const specPath = path.join(
    __dirname,
    '../smithy/source/openapi/TenantService.openapi.json',
  );
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));

  const invocationUri = (fnArn: string) =>
    `arn:${stack.partition}:apigateway:${stack.region}:lambda:path/2015-03-31/functions/${fnArn}/invocations`;

  for (const scheme of Object.values(spec.components?.securitySchemes ?? {}) as any[]) {
    if (scheme['x-amazon-apigateway-authorizer']?.authorizerUri === 'PLACEHOLDER') {
      scheme['x-amazon-apigateway-authorizer'].authorizerUri = invocationUri(authorizerFnArn);
    }
  }
  for (const pathItem of Object.values(spec.paths ?? {}) as any[]) {
    for (const operation of Object.values(pathItem) as any[]) {
      const integration = operation['x-amazon-apigateway-integration'];
      if (integration?.uri === 'PLACEHOLDER') {
        integration.uri = invocationUri(apiFnArn);
      }
    }
  }
  return spec;
}
