// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Deployment integration test app (spec §8, standard §5.2, ADR-0058). The
 * driver (test/integ/driver.ts, run by scripts/integ.sh) synthesises and
 * deploys it with the CDK CLI, runs the step table of integration-test.md
 * against it, and deletes the stack.
 *
 * One stack, named by `INTEG_PREFIX`, with:
 *
 *  - the producer's own ingress (`SharedIngress`, api-gateway, one tools
 *    gateway `default`) and one sample agent, so the `parse` step can make
 *    one call as a consumer's agent would. It publishes no parameters (it
 *    keeps its registry entries under its stack name), reuses
 *    tenant-identity's `shared-pool` issuer, and never touches it;
 *  - the test-only token mint (test/integ/mint.function.ts), granted
 *    `tokenSigner.grantSign` on the ingress's key (S-12);
 *  - `run-code`: all three backends, `sandboxIdle` 2 min, `dnsFirewall` on,
 *    `standalone` on, behind a `RunCodeToolTarget` named `run-code`;
 *  - `run-code-files`: `agentcore` only, `sessionFiles` on, `dnsFirewall`
 *    off, behind a `RunCodeToolTarget` named `run-code-files`;
 *  - two roles for the standalone step (one with the invoke grant, one
 *    without) and a bucket outside the endpoint policies for no-egress.
 *
 * Test-only changes to the instances, each listed in integration-test.md:
 * `RC_INTEG_OVERRIDES=1` on the `run-code` reaper, gateway tool and standalone functions through
 * a raw property override (test/integ/overrides.ts), and the reaper's
 * 5-minute schedule turned off so the driver is its only caller. Nothing in
 * `src/` reads a prop for either.
 */

import * as path from 'node:path';
import {
  AgentBackend, DEFAULT_REGISTRY_PREFIX, ROUTE, SharedIngress,
} from 'agentic-runtime-isolation';
import { App, CfnOutput, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { type Construct } from 'constructs';
import { type Backend, INSTANCE_BACKENDS, type Instance, RUN_TIMEOUT_SECONDS, SANDBOX_IDLE_MINUTES, stackPrefix, START_WAIT_SECONDS, TENANT, TOOL_TARGET, TOOLS_GATEWAY } from './integ/common';
import { backendOutputKey, outputKey } from './integ/ctx';
import { INTEG_MINT_ENV } from './integ/mint.function';
import { INTEG_CONTEXT_KEY, enableIntegOverrides } from './integ/overrides';
import { RunCodeToolTarget } from '../src/gateway';
import { UntrustedCodeSandboxes } from '../src/untrusted-code-sandboxes.cdk';

/** tenant-identity's published parameters, which the integration ingress trusts as its issuer (a shared fixture, never destroyed). */
export const IDENTITY_PARAMETERS = {
  userPoolId: '/application-plane/shared/identity/userPoolId',
  appClientId: '/application-plane/shared/identity/appClientId',
} as const;

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`the construct has no ${what}`);
  return value;
}

/** The one Lambda function under `scope` whose path matches; synth fails naming the candidates when there are none or several. */
export function findFunction(scope: Construct, pattern: RegExp, what: string): lambda.Function {
  const all = scope.node.findAll().filter((n): n is lambda.Function => n instanceof lambda.Function);
  const hits = all.filter((f) => pattern.test(f.node.path));
  if (hits.length !== 1) {
    throw new Error(`expected one ${what} function under ${scope.node.path} matching ${pattern} (found ${hits.length} of ${all.map((f) => f.node.path).join(', ')})`);
  }
  return hits[0];
}

function defaultModelId(region: string | undefined): string {
  const geo: Record<string, string> = { eu: 'eu', us: 'us', ap: 'apac' };
  const prefix = region === undefined ? undefined : geo[region.split('-')[0]];
  return prefix === undefined ? 'amazon.nova-lite-v1:0' : `${prefix}.amazon.nova-lite-v1:0`;
}

export interface IntegAppOptions {
  readonly prefix?: string;
  /** The bundled sample agent directory (`app.js`); the driver builds it, a unit test passes a stub. */
  readonly agentCodePath: string;
  /** Extra app context; a unit test passes `aws:cdk:bundling-stacks: []` to skip esbuild. */
  readonly context?: Record<string, unknown>;
}

export function createIntegApp(options: IntegAppOptions): App {
  const app = new App({ context: { [INTEG_CONTEXT_KEY]: true, ...options.context } });
  const prefix = options.prefix ?? stackPrefix();
  const account = process.env.CDK_DEFAULT_ACCOUNT;
  const region = process.env.CDK_DEFAULT_REGION;
  const stack = new Stack(app, prefix, { ...(account && region ? { env: { account, region } } : {}), description: 'agentic-untrusted-code-sandboxes integration test (spec 8). Test only; deleted by the driver.' });

  // The ingress the sandboxes sit behind, deployed through the producer's own constructs.
  const userPoolId = ssm.StringParameter.valueForStringParameter(stack, IDENTITY_PARAMETERS.userPoolId);
  const appClientId = ssm.StringParameter.valueForStringParameter(stack, IDENTITY_PARAMETERS.appClientId);
  const ingress = new SharedIngress(stack, 'SharedIngress', {
    identity: { discoveryUrl: `https://cognito-idp.${stack.region}.amazonaws.com/${userPoolId}/.well-known/openid-configuration`, allowedClientIds: [appClientId] },
    ingress: 'api-gateway',
    registryPrefix: `${DEFAULT_REGISTRY_PREFIX}${stack.stackName}/`,
    publish: false,
    tvm: { includeUserIdTag: false },
    defaultBackend: 'default',
    toolsGateways: { [TOOLS_GATEWAY]: {} },
  });
  const agent = new AgentBackend(stack, 'AgentBackend', {
    name: 'default',
    ingress,
    agent: { codePath: options.agentCodePath, modelId: defaultModelId(region) },
    needs: ['default/chat'],
    tools: Object.values(TOOL_TARGET).map((t) => `${t}/*`),
  });

  // TEST ONLY (spec §8, S-12): signs tokens with the ingress's own key.
  const mintLogs = new logs.LogGroup(stack, 'IntegMintLogs', { retention: logs.RetentionDays.ONE_WEEK, removalPolicy: RemovalPolicy.DESTROY });
  const mint = new NodejsFunction(stack, 'IntegMintFunction', {
    entry: path.join(__dirname, 'integ', 'mint.function.ts'),
    runtime: lambda.Runtime.NODEJS_22_X,
    timeout: Duration.seconds(10),
    logGroup: mintLogs,
    description: 'agentic-untrusted-code-sandboxes INTEGRATION TEST ONLY: mints transaction tokens (spec 8, S-12)',
    environment: {
      [INTEG_MINT_ENV.ISSUER]: ingress.issuer,
      [INTEG_MINT_ENV.KEY_ID]: ingress.tokenSigner.keyId,
      [INTEG_MINT_ENV.INGRESS_ROLE_ARN]: ingress.ingressRole.roleArn,
    },
  });
  ingress.tokenSigner.grantSign(mint);

  const common = {
    runTimeout: Duration.seconds(RUN_TIMEOUT_SECONDS),
    startWait: Duration.seconds(START_WAIT_SECONDS),
    sandboxIdle: Duration.minutes(SANDBOX_IDLE_MINUTES),
  };
  const instances: Record<Instance, UntrustedCodeSandboxes> = {
    'run-code': new UntrustedCodeSandboxes(stack, 'RunCode', {
      ...common, backends: [...INSTANCE_BACKENDS['run-code']], defaultBackend: 'microvm', standalone: true, dnsFirewall: true,
    }),
    'run-code-files': new UntrustedCodeSandboxes(stack, 'RunCodeFiles', {
      ...common, backends: [...INSTANCE_BACKENDS['run-code-files']], agentcore: { sessionFiles: true }, dnsFirewall: false,
    }),
  };
  const targets: Record<Instance, RunCodeToolTarget> = {
    'run-code': new RunCodeToolTarget(stack, 'RunCodeTarget', { sandboxes: instances['run-code'], ingress, gateway: TOOLS_GATEWAY, toolName: TOOL_TARGET['run-code'] }),
    'run-code-files': new RunCodeToolTarget(stack, 'RunCodeFilesTarget', { sandboxes: instances['run-code-files'], ingress, gateway: TOOLS_GATEWAY, toolName: TOOL_TARGET['run-code-files'] }),
  };

  const out = (id: string, value: string): CfnOutput => new CfnOutput(stack, id, { value });
  out('MintFunction', mint.functionName);
  out('ToolsGatewayUrl', required(ingress.toolsGateways[TOOLS_GATEWAY], `tools gateway ${TOOLS_GATEWAY}`).gatewayUrl);
  out('EndpointUrl', `${ingress.endpointUrl}/${ROUTE}`);
  out('EntitlementsApiUrl', ingress.entitlementsApiUrl);
  out('AgentRuntimeArn', agent.runtimeArn);

  for (const name of ['run-code', 'run-code-files'] as const) {
    const view = instances[name];
    const o = (key: string, value: string): CfnOutput => out(outputKey(name, key), value);
    o('Table', view.registryTable.tableName);
    o('TableArn', view.registryTable.tableArn);
    o('Bucket', view.inputBucket.bucketName);
    o('ToolRole', view.toolRole.roleArn);
    o('ToolTenantRole', view.toolTenantRole.roleArn);
    o('OffboardFunction', view.offboardFunction.functionName);
    const reaper = findFunction(instances[name], /reaper/i, 'reaper');
    o('ReaperFunction', reaper.functionName);
    o('ToolFunction', targets[name].function.functionName);
    for (const backend of INSTANCE_BACKENDS[name]) {
      for (const [key, value] of Object.entries(required(view.backends[backend], `backend ${backend}`).outputs())) out(backendOutputKey(name, backend, key), value);
    }
    // TEST ONLY: the reaper's own schedule is off, so a reaper run never lands in the middle of a timing step.
    const schedules = instances[name].node.findAll()
      .filter((n): n is events.CfnRule => n instanceof events.CfnRule && n.scheduleExpression !== undefined);
    for (const rule of schedules) rule.state = 'DISABLED';
    if (schedules.length !== 1) throw new Error(`expected one schedule rule under ${instances[name].node.path} (found ${schedules.length})`);
  }

  const runCode = instances['run-code'];
  out(outputKey('run-code', 'RunCodeFunction'), required(runCode.runCodeFunction, 'runCodeFunction (standalone)').functionName);
  // TEST ONLY: the two switches of threat T-88, on the run-code instance's reaper, gateway tool and standalone functions only.
  enableIntegOverrides(findFunction(instances['run-code'], /reaper/i, 'reaper'));
  enableIntegOverrides(targets['run-code'].function, { failStartTenant: TENANT.e });
  enableIntegOverrides(required(runCode.runCodeFunction, 'runCodeFunction') as lambda.Function, { failStartTenant: TENANT.e });

  // Query-log group of the firewall instance, for the dns and dns-platform steps.
  const firewall = required(instances['run-code'].dnsFirewall, 'dnsFirewall (the run-code instance turns it on)');
  out('QueryLogGroup', firewall.queryLogGroup.logGroupName);
  out('QueryLogGroupArn', firewall.queryLogGroup.logGroupArn);

  // The standalone step: a role with the invoke grant through the construct's own method, and one with none.
  const vendor = new iam.Role(stack, 'VendorRole', { assumedBy: new iam.AccountRootPrincipal(), description: 'integration test: holds the run-code invoke grant (grantInvokeRunCode)' });
  runCode.grantInvokeRunCode(vendor);
  out('VendorRoleArn', vendor.roleArn);
  const nogrant = new iam.Role(stack, 'NoGrantRole', { assumedBy: new iam.AccountRootPrincipal(), description: 'integration test: no lambda:InvokeFunction' });
  out('NoGrantRoleArn', nogrant.roleArn);

  // The no-egress presigned PUT goes to a bucket the endpoint policies do not name.
  const outside = new s3.Bucket(stack, 'Outside', { removalPolicy: RemovalPolicy.DESTROY, autoDeleteObjects: true, blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, enforceSSL: true, encryption: s3.BucketEncryption.S3_MANAGED });
  out('OutsideBucket', outside.bucketName);
  // The presigned PUT handed to the hostile code is signed by a role that may put under integ/ in that bucket and nothing else.
  const presign = new iam.Role(stack, 'PresignRole', { assumedBy: new iam.AccountRootPrincipal(), description: 'integration test: signs the no-egress presigned PUT' });
  presign.addToPolicy(new iam.PolicyStatement({ actions: ['s3:PutObject'], resources: [outside.arnForObjects('integ/*')] }));
  out('PresignRoleArn', presign.roleArn);
  return app;
}

if (require.main === module) {
  // The sample agent bundle comes from the producer's own bundler; the driver installs its dependencies first.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { bundleAgent } = require(path.join(path.dirname(require.resolve('agentic-runtime-isolation/package.json')), 'src', 'agent', 'bundle')) as { bundleAgent(): string };
  createIntegApp({ agentCodePath: bundleAgent() }).synth();
}
