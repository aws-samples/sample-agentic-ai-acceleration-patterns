// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The integration test's CDK app (spec §10), built by `test/integ.single.ts`
 * and `test/integ.host.ts` and driven by `scripts/integ.sh` (ADR-0028).
 *
 * Accounts: the edge account (the driver's credentials, the hosted zone)
 * holds the front door, cell B, the vendor IdP, the stand-in agent ingress
 * and the test roles; the control plane's account holds the control plane
 * (deployed by the driver through the control-plane sample's own app),
 * cell A, the hook and application source and the `RouteHookAccess` stack.
 *
 * | Stack | Account | Holds |
 * |---|---|---|
 * | `<prefix>-support` | edge | vendor IdP (operator and registrar reader clients, the reader secret), the edge operator role, the stranger role (step 12), the edge pair's probe policy |
 * | `<prefix>-cp-setup` | control plane | the source zip (route hook, probe hook, demo application scripts) in a versioned bucket, the home pair's probe policy, the driver's read-and-parameter role |
 * | `<prefix>-agent-ingress` | edge | the stand-in agent ingress (ADR-0024) |
 * | `<prefix>-edge`, `-main`, `-edge-logging` | edge | the front door under test |
 * | `<prefix>-route-hook-access` | control plane | the front door's `RouteHookAccess` (ADR-0027) |
 * | `<prefix>-cell-a`, `-cell-b` | control plane, edge | one demo cell API each, which the cell scripts name as `frontDoorApiDomain` |
 * | `<prefix>-test-role` | edge | the test role (spec §6.1) |
 *
 * A stack is added only once its inputs are known, so each deploy phase of
 * the driver synthesises what it can deploy. Every role trusts the driver's
 * principal alone. Not part of the sample: `src/main.ts` deploys none of it.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { App, ArnFormat, CfnOutput, Duration, Fn, RemovalPolicy, Stack, StackProps, Validations } from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { AwsSolutionsChecks } from 'cdk-nag';
import { Construct } from 'constructs';
import { identityIssuer, IntegInputs, integNames, IntegNames, parseIntegInputs, TestRoleInputs } from './inputs';
import { DemoCellApi } from '../../src/demo-cell/demo-cell-api.cdk';
import { registrarCertificateRequestStatements, Sweeper } from '../../src/edge/dedicated-domains.cdk';
import { MainStack, REGISTRAR_STAGE } from '../../src/edge/main.cdk';
import { acknowledge, BASIC_EXECUTION_ROLE_FINDING, nagFindingResource } from '../../src/edge/nag';
import { EDGE_REGION, TenantFrontDoor } from '../../src/edge/tenant-front-door.cdk';
import { Addressing, CHALLENGE_RECORD_PREFIX, paramHook, TAG_DISTRIBUTION_ID } from '../../src/shared/contracts';

const SAMPLE_ROOT = path.join(__dirname, '..', '..');

/** The parameter a cell stack publishes and the demo application's cell scripts read (test/integ/app/cell). */
export const CELL_API_PARAMETER = (applicationId: string) => `/application-plane/applications/${applicationId}/shared/front-door-cell-api`;

/** The vendor IdP's resource server and scope for the registrar's reader token (spec §6.1, control-plane R-38). */
export const VENDOR_READ_SCOPE = 'control-plane/read';
/** The `role` values the vendor IdP's trigger mints (control-plane ADR-018, ADR-042). */
export const OPERATOR_ROLE = 'operator';
export const READER_ROLE = 'control-plane:reader';
/** The vendor IdP user the driver signs in as the operator. */
export const OPERATOR_USER = 'integ-operator';

const TEST_REASON = 'Integration test fixture (spec §10, ADR-0028): deployed for one run and destroyed by scripts/integ.sh; not part of the sample.';

/** Builds the stacks the inputs allow; applies the AWS Solutions checks, as `src/main.ts` does. */
export function buildIntegApp(app: App, addressing: Addressing): void {
  Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true, writeSuppressionsToCloudFormation: true }));
  const inputs = parseIntegInputs(app.node.tryGetContext('integ'));
  const names = integNames(inputs.runId);
  const edgeEnv = { account: inputs.edgeAccount, region: inputs.region };
  const cpEnv = { account: inputs.controlPlaneAccount, region: inputs.region };

  new SupportStack(app, names.stacks.support, { env: edgeEnv, inputs, names });
  new ControlPlaneSetupStack(app, names.stacks.controlPlaneSetup, { env: cpEnv, inputs, names });
  new AgentIngressStack(app, names.stacks.agentIngress, { env: edgeEnv, inputs });

  if (inputs.controlPlaneApiUrl !== undefined && inputs.agentIngressUrl !== undefined && inputs.vendorIdp !== undefined) {
    const frontDoor = new TenantFrontDoor(app, 'FrontDoor', {
      stackNamePrefix: names.prefix,
      appDomain: inputs.appDomain,
      hostedZone: { zoneId: inputs.hostedZoneId, zoneName: inputs.zoneName },
      addressing,
      applicationId: names.applicationId,
      controlPlane: {
        apiUrl: inputs.controlPlaneApiUrl,
        accountId: inputs.controlPlaneAccount,
        region: inputs.region,
        // Literal values from the support stack's outputs: the front door checks them at synth (§3.6).
        vendorIdp: inputs.vendorIdp,
      },
      fleet: names.fleet,
      edgeOperatorRoleArn: roleArn(inputs.edgeAccount, names.roles.edgeOperator),
      issuer: issuerInput(inputs),
      agentIngress: inputs.agentIngressUrl,
      dedicatedDomains: inputs.dedicatedDomains ?? true,
      tenantRequestsPer5Min: inputs.tenantRequestsPer5Min,
      ipRequestsPer5Min: inputs.ipRequestsPer5Min,
      registrarUrl: inputs.registrarUrl,
      spaSource: inputs.spaSource,
    });
    addFrontDoorOutputs(frontDoor);
  }

  if (inputs.distributionArn !== undefined) {
    // In host mode the edge limits each host, so the cells' origin limit is off (§3.6).
    const originLimit = addressing === 'host' ? 0 : inputs.tenantRequestsPer5Min;
    new CellStack(app, names.stacks.cellA, { env: cpEnv, inputs, names, cellLabel: 'cell-a', originLimit });
    new CellStack(app, names.stacks.cellB, { env: edgeEnv, inputs, names, cellLabel: 'cell-b', originLimit });
  }

  if (inputs.testRole !== undefined) {
    new TestRoleStack(app, names.stacks.testRole, { env: edgeEnv, inputs, names, resources: inputs.testRole });
  }
}

/** Acknowledges each cdk-nag finding by its granular id (cdk-nag v3 matches the id, not the rule). */
function ackFindings(scope: Construct, reason: string, ...ids: string[]): void {
  for (const id of ids) acknowledge(scope, id, `${reason} ${TEST_REASON}`);
}

function roleArn(account: string, name: string): string {
  return `arn:aws:iam::${account}:role/${name}`;
}

/** The driver's principal, and nothing else, may assume a test role. */
function driverTrust(inputs: IntegInputs): iam.IPrincipal {
  return new iam.PrincipalWithConditions(new iam.AccountPrincipal(inputs.edgeAccount), {
    ArnEquals: { 'aws:PrincipalArn': inputs.driverPrincipalArn },
  });
}

/** The front door's `issuer` input: a Cognito domain when given, else reserved endpoints, since no browser step runs here (spec §10). */
function issuerInput(inputs: IntegInputs) {
  const scopes = 'openid';
  if (inputs.issuerDomain !== undefined) {
    return { clientId: inputs.identity.appClientId, scopes, cognitoDomain: inputs.issuerDomain };
  }
  return {
    clientId: inputs.identity.appClientId,
    scopes,
    authorizeEndpoint: 'https://issuer.example.com/oauth2/authorize',
    tokenEndpoint: 'https://issuer.example.com/oauth2/token',
    logoutEndpoint: 'https://issuer.example.com/logout',
  };
}

/** Registrar routes in the edge account and the control plane's Region, on any API (its id is not known when the role is made). */
function registrarRoutes(inputs: IntegInputs, ...routes: string[]): string[] {
  return routes.map((route) => `arn:aws:execute-api:${inputs.region}:${inputs.edgeAccount}:*/${REGISTRAR_STAGE}/${route}`);
}

function acknowledgeRegistrarRoutes(scope: Construct, inputs: IntegInputs, routes: string[], who: string): void {
  for (const route of registrarRoutes(inputs, ...routes)) {
    acknowledge(scope, `AwsSolutions-IAM5[Resource::${route}]`,
      `${who}: the registrar's API id is made when the front door's main stack deploys, after this policy; the stage and the routes are fixed. ${TEST_REASON}`);
  }
}

/**
 * Outputs the test needs from the stacks under test. They name resources
 * the test-only shortcuts of spec §10 reach (the route table, the router,
 * the sweeper, the log groups); none is exported, so a stack update the
 * test makes (step 14 removes the sweeper) is never blocked by a reader.
 */
function addFrontDoorOutputs(frontDoor: TenantFrontDoor): void {
  const main: MainStack = frontDoor.mainStack;
  const out = (id: string, value: string) => new CfnOutput(main, `Integ${id}`, { value });
  out('DistributionId', frontDoor.distributionId);
  out('RouteTableArn', frontDoor.routeTableArn);
  out('RoutingEndpoint', frontDoor.routingEndpoint);
  out('RouterFunctionArn', (main.node.findChild('Router') as cloudfront.Function).functionArn);
  const registrar = main.node.findChild('Registrar');
  const registrarFn = registrar.node.findChild('Function') as NodejsFunction;
  out('RegistrarLogGroupArn', registrarFn.logGroup.logGroupArn);
  out('RegistrarLogGroupName', registrarFn.logGroup.logGroupName);
  const access = registrar.node.findChild('AccessLogs') as logs.LogGroup;
  out('RegistrarAccessLogGroupArn', access.logGroupArn);
  out('RegistrarAccessLogGroupName', access.logGroupName);
  const sweeper = main.node.tryFindChild('Sweeper') as Sweeper | undefined;
  if (sweeper !== undefined) {
    out('SweeperFunctionArn', sweeper.function.functionArn);
    out('SweeperFunctionName', sweeper.function.functionName);
    out('SweeperTableArn', sweeper.table.tableArn);
    out('SweeperTableName', sweeper.table.tableName);
    out('SweeperLogGroupArn', sweeper.function.logGroup.logGroupArn);
    out('SweeperLogGroupName', sweeper.function.logGroup.logGroupName);
  }
  const logging = frontDoor.edgeLoggingStack;
  new CfnOutput(logging, 'IntegEdgeLogGroupName', { value: logging.logGroupName });
  new CfnOutput(logging, 'IntegEdgeLogGroupArn', {
    value: logging.formatArn({ service: 'logs', resource: 'log-group', resourceName: `${logging.logGroupName}:*`, arnFormat: ArnFormat.COLON_RESOURCE_NAME }),
  });
  if (frontDoor.routeHookAccessStack !== undefined) {
    const access2 = frontDoor.routeHookAccessStack.access;
    new CfnOutput(frontDoor.routeHookAccessStack, 'IntegHookPolicyArn', { value: access2.policy.managedPolicyArn });
    new CfnOutput(frontDoor.routeHookAccessStack, 'IntegHookParameterName', { value: access2.parameterName });
  }
}

// ---------------------------------------------------------------------------
// Support (edge account)
// ---------------------------------------------------------------------------

interface IntegStackProps extends StackProps {
  readonly inputs: IntegInputs;
  readonly names: IntegNames;
}

/**
 * The vendor IdP, the edge operator role and the stranger role. The vendor
 * IdP is a throwaway Cognito pool whose pre-token-generation trigger adds
 * the `role` claim, as the control-plane sample's own test does: `operator`
 * on the operator user's ID token, `control-plane:reader` on the registrar
 * client's client-credentials token (spec §6.1, spike S-9).
 */
export class SupportStack extends Stack {
  public readonly vendorIdp: { tokenUrl: string; clientId: string; clientSecretArn: string };

  constructor(scope: Construct, id: string, props: IntegStackProps) {
    super(scope, id, { ...props, description: 'tenant-front-door integ: vendor IdP, edge operator, stranger and pair probe roles (spec §10)' });
    const { inputs, names } = props;
    ackFindings(this, 'The role claim trigger and the CDK custom resource that reads the client secret write logs only.', BASIC_EXECUTION_ROLE_FINDING);
    ackFindings(this, 'Node.js 24, the sample\'s pinned runtime, and the runtime CDK pins for its custom resource.', 'AwsSolutions-L1');

    const pool = new cognito.UserPool(this, 'VendorIdp', {
      selfSignUpEnabled: false,
      featurePlan: cognito.FeaturePlan.ESSENTIALS,
      passwordPolicy: { minLength: 16, requireDigits: true, requireLowercase: true, requireUppercase: true, requireSymbols: true },
      removalPolicy: RemovalPolicy.DESTROY, // test fixture
    });
    acknowledge(pool, 'AwsSolutions-COG2', `One driver-made operator user with a random password, signed in by admin auth for one run. ${TEST_REASON}`);
    acknowledge(pool, 'AwsSolutions-COG3', `Threat protection needs the Plus plan; the pool has one machine client and one driver-made user. ${TEST_REASON}`);
    acknowledge(pool, 'AwsSolutions-COG8', `The Essentials plan is what the V3 pre-token trigger needs (spec §6.1); the pool lives for one run. ${TEST_REASON}`);
    const trigger = new lambda.Function(this, 'RoleClaim', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      timeout: Duration.seconds(5),
      logGroup: new logs.LogGroup(this, 'RoleClaimLogs', { retention: logs.RetentionDays.ONE_WEEK, removalPolicy: RemovalPolicy.DESTROY }),
      code: lambda.Code.fromInline(`
        exports.handler = async (event) => {
          if (event.triggerSource === 'TokenGeneration_ClientCredentials') {
            event.response = { claimsAndScopeOverrideDetails: { accessTokenGeneration: { claimsToAddOrOverride: { role: '${READER_ROLE}' } } } };
            return event;
          }
          const role = event.userName === '${OPERATOR_USER}' ? '${OPERATOR_ROLE}' : 'integ-none';
          event.response = { claimsAndScopeOverrideDetails: { idTokenGeneration: { claimsToAddOrOverride: { role } } } };
          return event;
        };
      `),
    });
    pool.addTrigger(cognito.UserPoolOperation.PRE_TOKEN_GENERATION_CONFIG, trigger, cognito.LambdaVersion.V3_0);
    const operatorClient = pool.addClient('Operator', {
      authFlows: { adminUserPassword: true },
      generateSecret: false,
      idTokenValidity: Duration.hours(1),
      accessTokenValidity: Duration.hours(1),
    });
    const readScope = new cognito.ResourceServerScope({ scopeName: 'read', scopeDescription: 'Read cells, tenants and deployments' });
    const server = pool.addResourceServer('ControlPlane', { identifier: VENDOR_READ_SCOPE.split('/')[0], scopes: [readScope] });
    // A prefix CloudFormation makes unique: the stack id's UUID.
    const domain = pool.addDomain('Domain', {
      cognitoDomain: { domainPrefix: Fn.join('', ['tfdi-', Fn.select(2, Fn.split('/', this.stackId))]) },
    });
    const reader = pool.addClient('Registrar', {
      generateSecret: true,
      authFlows: {},
      oAuth: { flows: { clientCredentials: true }, scopes: [cognito.OAuthScope.resourceServer(server, readScope)] },
    });
    const readerSecret = new secretsmanager.Secret(this, 'ReaderSecret', {
      description: 'tenant-front-door integ: the registrar reader client secret',
      secretStringValue: reader.userPoolClientSecret,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    acknowledge(readerSecret, 'AwsSolutions-SMG4', `A Cognito client secret Cognito cannot rotate in place; the secret lives for one run. ${TEST_REASON}`);
    this.vendorIdp = { tokenUrl: `${domain.baseUrl()}/oauth2/token`, clientId: reader.userPoolClientId, clientSecretArn: readerSecret.secretArn };

    // The edge operator (spec §3.6), passed as edgeOperatorRoleArn: the registrar's resource policy is the gate.
    const operatorRoutes = ['PUT/cells/*', 'PUT/tenants/*', 'DELETE/cells/*', 'DELETE/tenants/*', 'DELETE/hosts/*'];
    const operator = new iam.Role(this, 'EdgeOperator', {
      roleName: names.roles.edgeOperator,
      assumedBy: driverTrust(inputs),
      description: 'tenant-front-door integ: the edge operator role the front door names (spec §3.6)',
    });
    operator.addToPolicy(new iam.PolicyStatement({ actions: ['execute-api:Invoke'], resources: registrarRoutes(inputs, ...operatorRoutes) }));
    acknowledgeRegistrarRoutes(operator, inputs, operatorRoutes, 'The edge operator');

    // Step 12: an edge-account principal that is neither a pair role nor the operator, with Invoke in its identity policy.
    const strangerRoutes = ['PUT/tenants/*'];
    const stranger = new iam.Role(this, 'Stranger', {
      roleName: names.roles.stranger,
      assumedBy: driverTrust(inputs),
      description: 'tenant-front-door integ: an edge-account principal the registrar must refuse (spec §10 step 12)',
    });
    stranger.addToPolicy(new iam.PolicyStatement({ actions: ['execute-api:Invoke'], resources: registrarRoutes(inputs, ...strangerRoutes) }));
    acknowledgeRegistrarRoutes(stranger, inputs, strangerRoutes, 'The stranger');

    // Steps 11 and 12: the edge account's pair roles hold Invoke, so their 403 is the registrar's explicit Deny.
    const probeRoutes = ['PUT/tenants/*', 'DELETE/tenants/*', 'DELETE/cells/*'];
    const probe = new iam.ManagedPolicy(this, 'PairProbe', {
      managedPolicyName: names.pairProbePolicy,
      description: 'tenant-front-door integ: lets the account role pair call the registrar, so the registrar\'s Deny is what refuses it (spec §10 steps 11, 12)',
      statements: [new iam.PolicyStatement({ actions: ['execute-api:Invoke'], resources: registrarRoutes(inputs, ...probeRoutes) })],
    });
    acknowledgeRegistrarRoutes(probe, inputs, probeRoutes, 'The pair probe');

    new CfnOutput(this, 'UserPoolId', { value: pool.userPoolId });
    new CfnOutput(this, 'IssuerUrl', { value: pool.userPoolProviderUrl });
    new CfnOutput(this, 'OperatorClientId', { value: operatorClient.userPoolClientId });
    new CfnOutput(this, 'ReaderClientId', { value: reader.userPoolClientId });
    new CfnOutput(this, 'ReaderSecretArn', { value: readerSecret.secretArn });
    new CfnOutput(this, 'TokenUrl', { value: this.vendorIdp.tokenUrl });
    new CfnOutput(this, 'EdgeOperatorRoleArn', { value: operator.roleArn });
    new CfnOutput(this, 'StrangerRoleArn', { value: stranger.roleArn });
    new CfnOutput(this, 'PairProbePolicyArn', { value: probe.managedPolicyArn });
  }
}

// ---------------------------------------------------------------------------
// Control plane setup (control plane's account)
// ---------------------------------------------------------------------------

/**
 * Copies the hook and application scripts into a directory laid out like
 * the repository, so the zip's root is the repository's root and
 * `register-hooks.sh`'s script path holds (spec §5.2). The directory is
 * named after its content, so an unchanged tree gives the same asset.
 */
export function stageSource(): string {
  const files: string[] = [];
  const walk = (rel: string) => {
    const abs = path.join(SAMPLE_ROOT, rel);
    for (const entry of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = path.join(rel, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.name.endsWith('.sh')) files.push(child);
    }
  };
  walk('hooks');
  walk(path.join('test', 'integ', 'app'));
  walk(path.join('test', 'integ', 'hooks'));
  const hash = createHash('sha256');
  for (const f of files) hash.update(f).update('\0').update(fs.readFileSync(path.join(SAMPLE_ROOT, f)));
  const dir = path.join(os.tmpdir(), `tfd-integ-source-${hash.digest('hex').slice(0, 16)}`);
  for (const f of files) {
    const target = path.join(dir, 'samples', 'tenant-front-door', f);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(SAMPLE_ROOT, f), target);
    fs.chmodSync(target, 0o755);
  }
  return dir;
}

/**
 * The control plane's script and hook source: one zip in a versioned
 * bucket, so `register-hooks.sh` pins the hooks to an object version as it
 * pins a git source to a commit (§5.2). The bucket policy lets the
 * control plane's two build roles and its global hook role read it,
 * because the control-plane sample's app takes no source grant input.
 */
export class ControlPlaneSetupStack extends Stack {
  constructor(scope: Construct, id: string, props: IntegStackProps) {
    super(scope, id, { ...props, description: 'tenant-front-door integ: control plane source, pair probe policy and driver access (spec §10)' });
    const { inputs, names } = props;
    ackFindings(this, 'CDK custom resource roles (bucket deployment, auto-delete) write logs only.', BASIC_EXECUTION_ROLE_FINDING);
    ackFindings(this, 'CDK pins the custom resource runtimes.', 'AwsSolutions-L1');

    const bucket = new s3.Bucket(this, 'Source', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    acknowledge(bucket, 'AwsSolutions-S1', `A one-zip source bucket written once by the deployment; CloudTrail records its reads. ${TEST_REASON}`);
    const readers = (['cell-build', 'tenant-build', 'global-hook'] as const).map((kind) => roleArn(inputs.controlPlaneAccount, `${names.fleet}-${kind}`));
    bucket.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'ControlPlaneBuildsRead',
      principals: [new iam.AnyPrincipal()],
      actions: ['s3:GetObject', 's3:GetObjectVersion', 's3:GetBucketLocation', 's3:GetBucketAcl', 's3:ListBucket'],
      resources: [bucket.bucketArn, bucket.arnForObjects('*')],
      conditions: { ArnEquals: { 'aws:PrincipalArn': readers }, StringEquals: { 'aws:PrincipalAccount': inputs.controlPlaneAccount } },
    }));
    const deployment = new s3deploy.BucketDeployment(this, 'SourceZip', {
      destinationBucket: bucket,
      sources: [s3deploy.Source.asset(stageSource())],
      extract: false,
      prune: false,
      memoryLimit: 512,
    });
    ackFindings(this, 'CDK\'s bucket deployment copies the asset from the bootstrap bucket into this bucket.',
      ...['s3:GetObject*', 's3:GetBucket*', 's3:List*', 's3:DeleteObject*', 's3:Abort*'].map((a) => `AwsSolutions-IAM5[Action::${a}]`),
      `AwsSolutions-IAM5[Resource::${nagFindingResource(this, bucket.bucketArn)}/*]`,
      `AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:s3:::cdk-hnb659fds-assets-${inputs.controlPlaneAccount}-${inputs.region}/*]`);

    // Steps 11 and 12: the home pair's roles hold Invoke on the edge account's registrar.
    const probeRoutes = ['PUT/tenants/*', 'DELETE/tenants/*', 'DELETE/cells/*'];
    const probe = new iam.ManagedPolicy(this, 'PairProbe', {
      managedPolicyName: names.pairProbePolicy,
      description: 'tenant-front-door integ: lets the home account role pair call the registrar, so the registrar\'s policy is what refuses it (spec §10 step 12)',
      statements: [new iam.PolicyStatement({ actions: ['execute-api:Invoke'], resources: registrarRoutes(inputs, ...probeRoutes) })],
    });
    acknowledgeRegistrarRoutes(probe, inputs, probeRoutes, 'The pair probe');

    // The driver's reads in this account, and its writes to the front door hook parameter (steps 22, 24).
    const access = new iam.Role(this, 'DriverAccess', {
      roleName: names.roles.controlPlaneAccess,
      assumedBy: driverTrust(inputs),
      description: 'tenant-front-door integ: the driver\'s reads in the control plane\'s account and its hook parameter writes (spec §10)',
    });
    const parameter = (name: string) => this.formatArn({ service: 'ssm', resource: 'parameter', resourceName: name.replace(/^\//, '') });
    access.addToPolicy(new iam.PolicyStatement({
      sid: 'HookParameter',
      actions: ['ssm:GetParameter', 'ssm:PutParameter', 'ssm:DeleteParameter'],
      resources: [parameter(paramHook(names.applicationId))],
    }));
    access.addToPolicy(new iam.PolicyStatement({
      sid: 'ReadApplicationPlane',
      actions: ['ssm:GetParameter', 'ssm:GetParametersByPath'],
      resources: [parameter('application-plane'), parameter('application-plane/*')],
    }));
    access.addToPolicy(new iam.PolicyStatement({
      sid: 'ReadRunStacks',
      actions: ['cloudformation:DescribeStacks'],
      resources: [
        this.formatArn({ service: 'cloudformation', resource: 'stack', resourceName: `${names.prefix}-*` }),
        this.formatArn({ service: 'cloudformation', resource: 'stack', resourceName: `${names.fleet}-*` }),
      ],
    }));
    access.addToPolicy(new iam.PolicyStatement({ sid: 'SourceVersion', actions: ['s3:ListBucketVersions'], resources: [bucket.bucketArn] }));
    access.addToPolicy(new iam.PolicyStatement({
      sid: 'ReadCellLogs',
      actions: ['logs:FilterLogEvents'],
      resources: [this.formatArn({ service: 'logs', resource: 'log-group', resourceName: `${names.stacks.cellA}-*`, arnFormat: ArnFormat.COLON_RESOURCE_NAME })],
    }));
    access.addToPolicy(new iam.PolicyStatement({
      sid: 'Leftovers',
      actions: ['iam:GetRole', 'iam:GetPolicy'],
      resources: [
        this.formatArn({ service: 'iam', region: '', resource: 'role', resourceName: `${names.fleet}-*` }),
        this.formatArn({ service: 'iam', region: '', resource: 'policy', resourceName: `tenant-front-door-route-hook-${names.applicationId}` }),
        this.formatArn({ service: 'iam', region: '', resource: 'policy', resourceName: names.pairProbePolicy }),
      ],
    }));
    access.addToPolicy(new iam.PolicyStatement({ sid: 'LeftoverLogGroups', actions: ['logs:DescribeLogGroups'], resources: ['*'] }));
    // Step 22: the control plane's count of the skipped delete hook (control-plane R-46); GetMetricData takes no resource.
    access.addToPolicy(new iam.PolicyStatement({ sid: 'HookSkippedCount', actions: ['cloudwatch:GetMetricData'], resources: ['*'] }));
    const cp = inputs.controlPlaneAccount;
    ackFindings(access, 'Reads of this run\'s parameters, stacks, log groups and roles by name prefix; logs:DescribeLogGroups and cloudwatch:GetMetricData take no resource.',
      'AwsSolutions-IAM5[Resource::*]',
      `AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:ssm:${inputs.region}:${cp}:parameter/application-plane/*]`,
      `AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:cloudformation:${inputs.region}:${cp}:stack/${names.prefix}-*]`,
      `AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:cloudformation:${inputs.region}:${cp}:stack/${names.fleet}-*]`,
      `AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:logs:${inputs.region}:${cp}:log-group:${names.stacks.cellA}-*]`,
      `AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:iam::${cp}:role/${names.fleet}-*]`);

    new CfnOutput(this, 'SourceBucket', { value: bucket.bucketName });
    new CfnOutput(this, 'SourceKey', { value: Fn.select(0, deployment.objectKeys) });
    new CfnOutput(this, 'PairProbePolicyArn', { value: probe.managedPolicyArn });
    new CfnOutput(this, 'DriverAccessRoleArn', { value: access.roleArn });
  }
}

// ---------------------------------------------------------------------------
// The stand-in agent ingress (edge account)
// ---------------------------------------------------------------------------

/**
 * Spike S-5's stand-in (ADR-0024): a REST API whose REQUEST authoriser
 * verifies the tenant token, and a Lambda proxy with response streaming
 * that records the path and headers it receives. `POST
 * /{backend}/invocations` only, as the real ingress serves (spec §6.3).
 */
export class AgentIngressStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps & { inputs: IntegInputs }) {
    super(scope, id, { ...props, description: 'tenant-front-door integ: stand-in agent ingress (ADR-0024)' });
    const { inputs } = props;
    const fn = (name: string, entry: string, environment: Record<string, string>, timeout: Duration) => {
      const logGroup = new logs.LogGroup(this, `${name}Logs`, { retention: logs.RetentionDays.ONE_WEEK, removalPolicy: RemovalPolicy.DESTROY });
      const f = new NodejsFunction(this, name, {
        entry: path.join(__dirname, 'agent-ingress', entry),
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_24_X,
        architecture: lambda.Architecture.ARM_64,
        timeout,
        environment,
        logGroup,
        bundling: { minify: true, sourceMap: false, externalModules: [] },
      });
      acknowledge(f, BASIC_EXECUTION_ROLE_FINDING, `Logs-only managed policy. ${TEST_REASON}`);
      acknowledge(f, 'AwsSolutions-L1', `Node.js 24, the sample's pinned runtime. ${TEST_REASON}`);
      return { f, logGroup };
    };
    const issuer = identityIssuer(inputs);
    const auth = fn('Authorizer', 'authorizer.function.ts', { ISSUER: issuer, CLIENT_IDS: inputs.identity.appClientId }, Duration.seconds(5));
    const stream = fn('Stream', 'stream.function.ts', {}, Duration.seconds(30));

    const accessLogs = new logs.LogGroup(this, 'AccessLogs', { retention: logs.RetentionDays.ONE_WEEK, removalPolicy: RemovalPolicy.DESTROY });
    const api = new apigateway.RestApi(this, 'Api', {
      description: 'tenant-front-door integ: stand-in agent ingress (ADR-0024)',
      endpointTypes: [apigateway.EndpointType.REGIONAL],
      // The account's API Gateway logging role is a prerequisite of the front door too (spec §6.1).
      cloudWatchRole: false,
      deployOptions: {
        stageName: 'prod',
        accessLogDestination: new apigateway.LogGroupLogDestination(accessLogs),
        accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields(),
      },
    });
    const authorizer = new apigateway.RequestAuthorizer(this, 'TokenCheck', {
      handler: auth.f,
      identitySources: [apigateway.IdentitySource.header('Authorization')],
      resultsCacheTtl: Duration.seconds(0),
    });
    api.root.addResource('{backend}').addResource('invocations').addMethod('POST',
      new apigateway.LambdaIntegration(stream.f, { responseTransferMode: apigateway.ResponseTransferMode.STREAM, timeout: Duration.seconds(29) }),
      { authorizer, authorizationType: apigateway.AuthorizationType.CUSTOM });
    acknowledge(api, 'AwsSolutions-APIG2', `The stand-in reads no body; it records the path and headers (ADR-0024). ${TEST_REASON}`);
    acknowledge(api, 'AwsSolutions-APIG3', `Reached only through the front door's distribution, whose web ACL applies (spec §6.2 limits). ${TEST_REASON}`);
    acknowledge(api, 'AwsSolutions-APIG6', `Access logs are on; execution logs would record headers. ${TEST_REASON}`);
    acknowledge(api, 'AwsSolutions-COG4', `The REQUEST authoriser verifies tenant-identity tokens, as the real ingress does (ADR-0024). ${TEST_REASON}`);

    new CfnOutput(this, 'Url', { value: api.url });
    new CfnOutput(this, 'StreamLogGroupName', { value: stream.logGroup.logGroupName });
    new CfnOutput(this, 'StreamLogGroupArn', { value: stream.logGroup.logGroupArn });
  }
}

// ---------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------

/**
 * One demo cell API (spec §6.1) in the account a cell of the demo
 * application runs in, granted to the distribution. It publishes its
 * function URL host, which the demo application's cell scripts write as
 * `frontDoorApiDomain` (§5.2): the cell's origin is deployed by the test
 * ahead of the cell, and the scripts only name it (spec §10 test-only
 * shortcuts).
 */
export class CellStack extends Stack {
  constructor(scope: Construct, id: string, props: IntegStackProps & { cellLabel: string; originLimit?: number }) {
    super(scope, id, { ...props, description: `tenant-front-door integ: demo cell API (${props.cellLabel})` });
    const { inputs, names } = props;
    const cell = new DemoCellApi(this, 'CellApi', {
      issuer: { issuer: identityIssuer(inputs), jwksUrl: `${identityIssuer(inputs)}/.well-known/jwks.json`, clientIds: [inputs.identity.appClientId] },
      applicationId: names.applicationId,
      cellId: props.cellLabel,
      distributionArn: inputs.distributionArn,
      tenantRequestsPer5Min: props.originLimit,
      logRetention: logs.RetentionDays.ONE_WEEK,
    });
    new ssm.StringParameter(this, 'ApiDomainParameter', {
      parameterName: CELL_API_PARAMETER(names.applicationId),
      stringValue: cell.apiDomain,
      description: 'tenant-front-door integ: the demo cell API host the cell scripts name as frontDoorApiDomain',
    });
    new CfnOutput(this, 'ApiDomain', { value: cell.apiDomain });
    new CfnOutput(this, 'FunctionUrl', { value: cell.functionUrl.url });
    new CfnOutput(this, 'LogGroupName', { value: cell.logGroup.logGroupName });
    new CfnOutput(this, 'LogGroupArn', { value: cell.logGroup.logGroupArn });
  }
}

// ---------------------------------------------------------------------------
// The test role (edge account)
// ---------------------------------------------------------------------------

/**
 * The test role of spec §6.1 and §10: the step 2 fixture writes, the
 * router's `TestFunction`, step 14's TXT records, sweeper table items,
 * hand runs, log reads and certificate probe, and the log reads of steps 5,
 * 15 and 23. Every resource is this run's; the registrar's certificate
 * statements come from the registrar's own code.
 */
export class TestRoleStack extends Stack {
  constructor(scope: Construct, id: string, props: IntegStackProps & { resources: TestRoleInputs }) {
    super(scope, id, { ...props, description: 'tenant-front-door integ: the test role (spec §6.1, §10)' });
    const { inputs, names, resources: r } = props;
    const role = new iam.Role(this, 'Test', {
      roleName: names.roles.test,
      assumedBy: driverTrust(inputs),
      description: 'tenant-front-door integ: the test role (spec §6.1); made for one run and removed after',
    });
    const allow = (sid: string, actions: string[], resources: string[], conditions?: Record<string, Record<string, unknown>>) =>
      role.addToPolicy(new iam.PolicyStatement({ sid, actions, resources, conditions }));

    allow('RouteTableFixture', [
      'cloudfront-keyvaluestore:DescribeKeyValueStore', 'cloudfront-keyvaluestore:GetKey',
      'cloudfront-keyvaluestore:PutKey', 'cloudfront-keyvaluestore:DeleteKey',
    ], [r.routeTableArn]);
    allow('RouterTest', ['cloudfront:DescribeFunction', 'cloudfront:TestFunction'], [r.routerFunctionArn]);
    const logGroups = [
      r.registrarLogGroupArn, r.registrarAccessLogGroupArn, r.edgeLogGroupArn, r.agentIngressLogGroupArn, r.cellLogGroupArn,
      ...(r.sweeperLogGroupArn === undefined ? [] : [r.sweeperLogGroupArn]),
    ];
    allow('ReadLogs', ['logs:FilterLogEvents'], logGroups);
    // The three-miss count: GetMetricData takes no resource (spec §10 step 14).
    allow('ReadMetrics', ['cloudwatch:GetMetricData'], ['*']);
    if (r.sweeperFunctionArn !== undefined && r.sweeperTableArn !== undefined) {
      allow('SweeperHandRun', ['lambda:InvokeFunction'], [r.sweeperFunctionArn]);
      allow('SweeperItems', ['dynamodb:GetItem', 'dynamodb:PutItem'], [r.sweeperTableArn]);
    }
    // Step 14's TXT records, at the challenge name only.
    const challenge = `${CHALLENGE_RECORD_PREFIX}${inputs.dedicatedDomain}`;
    allow('ChallengeRecords', ['route53:ChangeResourceRecordSets'], [`arn:aws:route53:::hostedzone/${inputs.hostedZoneId}`], {
      'ForAllValues:StringEquals': {
        'route53:ChangeResourceRecordSetsNormalizedRecordNames': [challenge],
        'route53:ChangeResourceRecordSetsRecordTypes': ['TXT'],
      },
    });
    allow('ChallengeChange', ['route53:GetChange'], ['arn:aws:route53:::change/*']);
    // Step 14's repeat-request probe: the registrar's own statements, plus a delete of its own certificates and the reads of the leftover check.
    for (const s of registrarCertificateRequestStatements(this, r.distributionId)) role.addToPolicy(s);
    const certificates = this.formatArn({ service: 'acm', region: EDGE_REGION, resource: 'certificate', resourceName: '*' });
    allow('CertificateDelete', ['acm:DeleteCertificate'], [certificates], { StringEquals: { [`aws:ResourceTag/${TAG_DISTRIBUTION_ID}`]: r.distributionId } });
    allow('CertificateRead', ['acm:DescribeCertificate', 'acm:ListTagsForCertificate'], [certificates]);
    allow('CertificateList', ['acm:ListCertificates'], ['*'], { StringEquals: { 'aws:RequestedRegion': EDGE_REGION } });
    ackFindings(role, 'cloudwatch:GetMetricData, acm:RequestCertificate and acm:ListCertificates take no resource; certificates and Route 53 '
      + 'changes have ids made at run time, held by tag and record-name conditions; each log read covers one group\'s streams.',
    'AwsSolutions-IAM5[Resource::*]',
    'AwsSolutions-IAM5[Resource::arn:aws:route53:::change/*]',
    `AwsSolutions-IAM5[Resource::${nagFindingResource(this, certificates)}]`,
    ...logGroups.filter((arn) => arn.endsWith('*')).map((arn) => `AwsSolutions-IAM5[Resource::${arn}]`));
    new CfnOutput(this, 'TestRoleArn', { value: role.roleArn });
  }
}
