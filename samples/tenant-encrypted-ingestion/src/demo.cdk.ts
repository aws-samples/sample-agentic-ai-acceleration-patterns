// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The demo stack (spec §6.3, §6.4; standard §4.5): a thin wiring of one
 * `TenantEncryptedIngestion` to the sample's dependencies.
 *
 * - The issuer is tenant-identity's `shared-pool`, read from its published
 *   parameters under `identityParams` (default
 *   `/application-plane/shared/identity/`) at deploy time; so is where the
 *   scopes are registered. The build synthesises with placeholders no
 *   account can resolve, and a CloudFormation rule refuses to deploy them.
 * - Two validators: `pdf-pages` (examples/validator-pdf-pages, limit 3) and
 *   `test-switch` (src/validators/test-switch.function.ts), whose mode is an
 *   SSM parameter the integration test writes (spec §10).
 * - It publishes the construct's read-only properties under
 *   `/application-plane/shared/ingestion/` (ARCHITECTURE.md §5.1): written
 *   by CloudFormation only (M-30).
 *
 * Only this file and the integration test name tenant-identity; the
 * construct does not.
 */

import * as path from 'node:path';
import { CfnOutput, CfnRule, Duration, Fn, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import type { IdentityApiProps } from './shared/scope-registration.cdk';
import { TenantEncryptedIngestion, type TenantEncryptedIngestionProps } from './tenant-encrypted-ingestion.cdk';
import { LambdaValidator } from './validators/lambda-validator';
import { TEST_SWITCH_PARAMETER_ENV } from './validators/test-switch.function';

/** This sample's published parameters (spec §6.3, ARCHITECTURE.md §5.1). */
export const INGESTION_PARAMETER_PREFIX = '/application-plane/shared/ingestion/';
export const INGESTION_PARAMETERS = {
  apiUrl: `${INGESTION_PARAMETER_PREFIX}apiUrl`,
  bucketName: `${INGESTION_PARAMETER_PREFIX}bucketName`,
  tenantRoleArns: `${INGESTION_PARAMETER_PREFIX}tenantRoleArns`,
  consumerRoleArns: `${INGESTION_PARAMETER_PREFIX}consumerRoleArns`,
  eventBusArn: `${INGESTION_PARAMETER_PREFIX}eventBusArn`,
  accessLogBucketName: `${INGESTION_PARAMETER_PREFIX}accessLogBucketName`,
} as const;

/** The value `consumerRoleArns` takes when there are none (an SSM value cannot be empty). */
export const NO_CONSUMER_ROLES = 'none';

export const DEFAULT_IDENTITY_PARAMS = '/application-plane/shared/identity/';

/** The build-time placeholders (standard §4.3). A CloudFormation rule refuses to deploy a stack that carries them. */
export const PLACEHOLDER = {
  userPoolId: 'PLACEHOLDER-NOT-A-USER-POOL',
  appClientId: 'PLACEHOLDER-NOT-A-CLIENT-ID',
  apiUrl: 'https://placeholder-not-an-api.example.com/',
  platformInvokePolicyArn: 'arn:aws:iam::111122223333:policy/PLACEHOLDER-NOT-A-POLICY',
} as const;

export interface DemoContext {
  readonly identityParameterPlaceholders: boolean;
  /** Prefix of tenant-identity's published parameters; ends with `/`. */
  readonly identityParams: string;
  readonly consumerRoleArns: string[];
  readonly allowTenantKeys: boolean;
  /** The spec §10 test profile (short timings, small limits, tenantThrottle). */
  readonly integProfile: boolean;
  readonly accessLogReaderRoleArn?: string;
  /** The queue's one other sender (spec §7.7); the integration test's redrive role. */
  readonly redriveOperatorRoleArn?: string;
  /** Per-prop overrides of the timings and limits, from context (spec §3.3); applied over the test profile. */
  readonly profile: DemoProfileOverrides;
}

/** The props a deployer (or scripts/integ.sh) may set from context. The construct validates the ranges. */
export const PROFILE_CONTEXT_KEYS = ['maxReceiveCount', 'visibilityTimeoutFactor', 'abandonGraceSeconds', 'uploadUrlTtlSeconds', 'maxInFlightPerTenant'] as const;
export type DemoProfileOverrides = Partial<Record<(typeof PROFILE_CONTEXT_KEYS)[number], number>>;

export type ContextReader = (key: string) => unknown;

const ROLE_ARN = /^arn:aws[a-z-]*:iam::\d{12}:role\/[\w+=,.@/-]+$/;

function bool(read: ContextReader, key: string): boolean {
  const value = read(key);
  if (value === undefined) {
    return false;
  }
  if (value === true || value === 'true') {
    return true;
  }
  if (value === false || value === 'false') {
    return false;
  }
  throw new Error(`context ${key} must be true or false`);
}

/** Reads and validates the demo's context; fails fast naming the key (spec §3.3). */
export function parseDemoContext(read: ContextReader): DemoContext {
  const identityParams = read('identityParams') ?? DEFAULT_IDENTITY_PARAMS;
  if (typeof identityParams !== 'string' || !/^\/[A-Za-z0-9/_.-]+\/$/.test(identityParams)) {
    throw new Error('context identityParams must be an SSM path prefix ending in /');
  }
  const consumerRaw = read('consumerRoleArns') ?? '';
  if (typeof consumerRaw !== 'string') {
    throw new Error('context consumerRoleArns must be a comma-separated list of role ARNs');
  }
  const consumerRoleArns = consumerRaw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  for (const arn of consumerRoleArns) {
    if (!ROLE_ARN.test(arn)) {
      throw new Error('context consumerRoleArns: every entry must be an IAM role ARN');
    }
  }
  const reader = read('accessLogReaderRoleArn');
  if (reader !== undefined && (typeof reader !== 'string' || !ROLE_ARN.test(reader))) {
    throw new Error('context accessLogReaderRoleArn must be an IAM role ARN');
  }
  const redrive = read('redriveOperatorRoleArn');
  if (redrive !== undefined && (typeof redrive !== 'string' || !ROLE_ARN.test(redrive))) {
    throw new Error('context redriveOperatorRoleArn must be an IAM role ARN');
  }
  const profile: Record<string, number> = {};
  for (const key of PROFILE_CONTEXT_KEYS) {
    const raw = read(key);
    if (raw === undefined) {
      continue;
    }
    const value = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isInteger(value)) {
      throw new Error(`context ${key} must be an integer`);
    }
    profile[key] = value;
  }
  return {
    identityParameterPlaceholders: bool(read, 'identityParameterPlaceholders'),
    identityParams,
    consumerRoleArns,
    allowTenantKeys: bool(read, 'allowTenantKeys'),
    integProfile: bool(read, 'integProfile'),
    accessLogReaderRoleArn: reader as string | undefined,
    redriveOperatorRoleArn: redrive as string | undefined,
    profile: profile as DemoProfileOverrides,
  };
}

/** The spec §10 test profile. */
export const INTEG_PROFILE: Partial<TenantEncryptedIngestionProps> = {
  maxReceiveCount: 1,
  visibilityTimeoutFactor: 2,
  abandonGraceSeconds: 60,
  uploadUrlTtlSeconds: 60,
  maxInFlightPerTenant: 5,
  tenantThrottle: { rateLimit: 10, burstLimit: 20 },
};

export interface DemoStackProps extends StackProps {
  readonly context: DemoContext;
}

export class TenantEncryptedIngestionDemoStack extends Stack {
  readonly ingestion: TenantEncryptedIngestion;
  readonly testSwitchParameter: ssm.StringParameter;

  constructor(scope: Construct, id: string, props: DemoStackProps) {
    super(scope, id, props);
    const ctx = props.context;

    let userPoolId: string;
    let appClientId: string;
    let identityApi: IdentityApiProps;
    if (ctx.identityParameterPlaceholders) {
      userPoolId = PLACEHOLDER.userPoolId;
      appClientId = PLACEHOLDER.appClientId;
      identityApi = { apiUrl: PLACEHOLDER.apiUrl, platformInvokePolicyArn: PLACEHOLDER.platformInvokePolicyArn };
      new CfnRule(this, 'RefusePlaceholderDeployment', {
        assertions: [
          {
            assert: Fn.conditionEquals('build-placeholder', 'deployable'),
            assertDescription:
              'This template was synthesised with --context identityParameterPlaceholders=true (build only). Synthesise without it so the stack reads tenant-identity\'s published parameters.',
          },
        ],
      });
    } else {
      const read = (name: string) => ssm.StringParameter.valueForStringParameter(this, `${ctx.identityParams}${name}`);
      userPoolId = read('userPoolId');
      appClientId = read('appClientId');
      identityApi = { apiUrl: read('apiUrl'), platformInvokePolicyArn: read('platformInvokePolicyArn') };
    }
    const discoveryUrl = `https://cognito-idp.${this.region}.amazonaws.com/${userPoolId}/.well-known/openid-configuration`;

    // Validators (spec §3.5, §10). Each function's role: logs only.
    const pdfPages = this.validatorFunction('PdfPagesValidator', path.join(__dirname, '..', 'examples', 'validator-pdf-pages', 'handler.ts'), {
      timeout: Duration.seconds(30),
      environment: { PDF_PAGE_LIMIT: '3' },
      description: 'tenant-encrypted-ingestion example validator: PDF page limit (spec §3.5)',
    });
    this.testSwitchParameter = new ssm.StringParameter(this, 'TestSwitchMode', {
      description: 'tenant-encrypted-ingestion test-switch validator mode: accept | throw | pause | sleep (spec §10)',
      stringValue: 'accept',
    });
    const testSwitch = this.validatorFunction('TestSwitchValidator', path.join(__dirname, 'validators', 'test-switch.function.ts'), {
      // The function may run 5 minutes; it declares 60 s to the chain. T is then
      // 60 + 30 + 60 + 60 = 210 s, so `sleep` (until its own 300 s timeout)
      // outlasts the processor (spec §10 step 7c), and `pause:<n>` up to
      // about 140 s stays inside T (step 8).
      timeout: Duration.minutes(5),
      environment: { [TEST_SWITCH_PARAMETER_ENV]: this.testSwitchParameter.parameterName },
      description: 'tenant-encrypted-ingestion test-switch validator: behaviour from an SSM parameter (spec §10)',
    });
    this.testSwitchParameter.grantRead(testSwitch);

    const consumerRoles = ctx.consumerRoleArns.map((arn, i) => iam.Role.fromRoleArn(this, `ConsumerRole${i}`, arn, { mutable: false }));
    this.ingestion = new TenantEncryptedIngestion(this, 'Ingestion', {
      identity: { discoveryUrl, allowedClientIds: [appClientId] },
      identityApi,
      allowTenantKeys: ctx.allowTenantKeys,
      consumerRoles,
      validators: [
        new LambdaValidator(pdfPages, { name: 'pdf-pages', timeout: Duration.seconds(30) }),
        new LambdaValidator(testSwitch, { name: 'test-switch', timeout: Duration.seconds(60) }),
      ],
      accessLogReaderRole:
        ctx.accessLogReaderRoleArn === undefined ? undefined : iam.Role.fromRoleArn(this, 'AccessLogReader', ctx.accessLogReaderRoleArn, { mutable: false }),
      redriveOperatorRole:
        ctx.redriveOperatorRoleArn === undefined ? undefined : iam.Role.fromRoleArn(this, 'RedriveOperator', ctx.redriveOperatorRoleArn, { mutable: false }),
      ...(ctx.integProfile ? INTEG_PROFILE : {}),
      ...ctx.profile,
    });

    // Published parameters (spec §6.3), written by CloudFormation only (M-30).
    const ing = this.ingestion;
    const publish = (parameterId: string, name: string, value: string, description: string) =>
      new ssm.StringParameter(this, parameterId, { parameterName: name, stringValue: value, description });
    publish('ApiUrlParameter', INGESTION_PARAMETERS.apiUrl, ing.apiUrl, 'tenant-encrypted-ingestion API base URL');
    publish('BucketNameParameter', INGESTION_PARAMETERS.bucketName, ing.bucket.bucketName, 'tenant-encrypted-ingestion bucket');
    publish(
      'TenantRoleArnsParameter',
      INGESTION_PARAMETERS.tenantRoleArns,
      Fn.join(',', [ing.tenantRoles.upload.roleArn, ing.tenantRoles.process.roleArn, ing.tenantRoles.platform.roleArn]),
      'tenant-encrypted-ingestion tenant roles: upload,process,platform (a tenant-key key policy trusts these)',
    );
    publish(
      'ConsumerRoleArnsParameter',
      INGESTION_PARAMETERS.consumerRoleArns,
      ing.consumerRoleArns.length === 0 ? NO_CONSUMER_ROLES : ing.consumerRoleArns.join(','),
      `tenant-encrypted-ingestion consumer roles, comma-separated, or '${NO_CONSUMER_ROLES}'`,
    );
    publish('EventBusArnParameter', INGESTION_PARAMETERS.eventBusArn, ing.eventBus.eventBusArn, 'tenant-encrypted-ingestion Delivery* event bus');
    publish('AccessLogBucketNameParameter', INGESTION_PARAMETERS.accessLogBucketName, ing.accessLogBucket.bucketName, 'tenant-encrypted-ingestion access-log bucket');

    new CfnOutput(this, 'ApiUrl', { value: ing.apiUrl });
    new CfnOutput(this, 'BucketName', { value: ing.bucket.bucketName });
    new CfnOutput(this, 'TestSwitchParameterName', { value: this.testSwitchParameter.parameterName });
    // The construct's read-only properties the integration test drives (spec §3.4).
    new CfnOutput(this, 'SweepFunctionName', { value: ing.sweepFunction.functionName });
    new CfnOutput(this, 'ProcessorFunctionName', { value: ing.processorFunction.functionName });
    new CfnOutput(this, 'DeadLetterQueueUrl', { value: ing.deadLetterQueue.queueUrl });
    new CfnOutput(this, 'DeadLetterQueueArn', { value: ing.deadLetterQueue.queueArn });
    new CfnOutput(this, 'QueueUrl', { value: ing.queue.queueUrl });
    new CfnOutput(this, 'QueueArn', { value: ing.queue.queueArn });
    new CfnOutput(this, 'PipelineTiming', { value: JSON.stringify(ing.pipelineTiming) });
    new CfnOutput(this, 'LogGroupNames', {
      value: this.toJsonString(Object.fromEntries(Object.entries(ing.logGroups).map(([k, g]) => [k, g.logGroupName]))),
    });
    new CfnOutput(this, 'ContributorInsightRuleNames', { value: ing.contributorInsightRuleNames.join(',') });
    new CfnOutput(this, 'AccessLogBucketName', { value: ing.accessLogBucket.bucketName });
    new CfnOutput(this, 'KeyBindingChangedAlarmName', { value: ing.alarms.bindingChanged.alarmName });
    new CfnOutput(this, 'RegistryTableName', { value: ing.registryTable.tableName });
    new CfnOutput(this, 'EventBusName', { value: ing.eventBus.eventBusName });
    new CfnOutput(this, 'TenantRoleArns', {
      value: Fn.join(',', [ing.tenantRoles.upload.roleArn, ing.tenantRoles.process.roleArn, ing.tenantRoles.platform.roleArn]),
    });
  }

  private validatorFunction(
    id: string,
    entry: string,
    options: { timeout: Duration; environment: Record<string, string>; description: string },
  ): NodejsFunction {
    const logGroup = new logs.LogGroup(this, `${id}Logs`, { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY });
    const role = new iam.Role(this, `${id}Role`, {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'tenant-encrypted-ingestion validator: logs only; it reads the document through the presigned URL (M-20)',
    });
    logGroup.grantWrite(role);
    return new NodejsFunction(this, id, {
      entry,
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: options.timeout,
      role,
      logGroup,
      loggingFormat: lambda.LoggingFormat.JSON,
      environment: options.environment,
      description: options.description,
      bundling: { minify: true, sourceMap: false, externalModules: [] },
    });
  }
}
