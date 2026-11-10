// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The demo stack (standard §4.5: a thin wiring of the construct). It supplies
 * an issuer, instantiates `TenantMemoryIsolation`, and publishes the
 * construct's identifiers as one JSON parameter under the sample's
 * `ARCHITECTURE.md` namespace (spec §6.3).
 *
 * The issuer is a synthetic Cognito user pool (ADR-0013) whose access tokens
 * carry the repository token contract: `tenant_id` from an immutable
 * attribute the vendor sets, and Cognito's own `sub`, `client_id`, and
 * `token_use`. Give `issuerDiscoveryUrl` and `issuerClientIds` to trust an
 * existing issuer instead, such as tenant-identity's shared pool; the
 * construct is the same either way.
 */

import * as path from 'node:path';
import { Duration, RemovalPolicy, Stack, type StackProps, Validations } from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import { acknowledgeResourceWildcard } from './nag';
import { type MemoryIssuer, TenantMemoryIsolation } from './tenant-memory-isolation';

/** The published parameter (spec §6.3, ARCHITECTURE.md §5.1). */
export const PUBLISHED_PARAMETER = '/application-plane/shared/memory/gateway';
export const PUBLISHED_VERSION = 1;

/** What the published parameter holds. */
export interface PublishedMemoryGateway {
  readonly version: number;
  readonly gatewayUrl: string;
  readonly targetName: string;
  readonly gatewayArn: string;
  readonly memoryId: string;
  readonly memoryArn: string;
  readonly policyEngineArn: string;
  readonly gatewayRoleArn: string;
  readonly tenantClaim: string;
  readonly sessionClaim: string;
  readonly applicationLogGroup: string;
  /** Present only with the bundled demo issuer. */
  readonly demoIssuer?: { readonly userPoolId: string; readonly appClientId: string };
}

/** Deployment inputs from `--context` (spec §6.2). */
export interface DemoContext {
  readonly issuer?: MemoryIssuer;
}

/** Reads and validates the context; throws a message naming the bad key. */
export function parseDemoContext(get: (key: string) => unknown): DemoContext {
  const url = get('issuerDiscoveryUrl');
  const clients = get('issuerClientIds');
  if (url === undefined && clients === undefined) {
    return {};
  }
  if (typeof url !== 'string' || typeof clients !== 'string') {
    throw new Error('Context: give both issuerDiscoveryUrl and issuerClientIds (comma-separated), or neither for the bundled demo issuer');
  }
  const allowedClients = clients.split(',').map((c) => c.trim()).filter((c) => c.length > 0);
  if (allowedClients.length === 0 || allowedClients.some((c) => !/^[A-Za-z0-9_-]{1,128}$/.test(c))) {
    throw new Error('Context: issuerClientIds must be a comma-separated list of client ids');
  }
  return { issuer: { discoveryUrl: url, allowedClients } };
}

export interface TenantMemoryIsolationDemoStackProps extends StackProps {
  readonly context: DemoContext;
}

export class TenantMemoryIsolationDemoStack extends Stack {
  readonly memory: TenantMemoryIsolation;
  readonly userPool?: cognito.UserPool;
  readonly appClient?: cognito.UserPoolClient;

  constructor(scope: Construct, id: string, props: TenantMemoryIsolationDemoStackProps) {
    super(scope, id, props);

    let issuer = props.context.issuer;
    if (issuer === undefined) {
      const demo = this.demoIssuer();
      this.userPool = demo.pool;
      this.appClient = demo.client;
      issuer = {
        discoveryUrl: `https://cognito-idp.${this.region}.${this.urlSuffix}/${demo.pool.userPoolId}/.well-known/openid-configuration`,
        allowedClients: [demo.client.userPoolClientId],
      };
    }

    this.memory = new TenantMemoryIsolation(this, 'TenantMemory', { issuer });

    const published: PublishedMemoryGateway = {
      version: PUBLISHED_VERSION,
      gatewayUrl: this.memory.gatewayUrl,
      targetName: this.memory.targetName,
      gatewayArn: this.memory.gatewayArn,
      memoryId: this.memory.memoryId,
      memoryArn: this.memory.memoryArn,
      policyEngineArn: this.memory.policyEngineArn,
      gatewayRoleArn: this.memory.gatewayRole.roleArn,
      tenantClaim: this.memory.claims.tenant,
      sessionClaim: this.memory.claims.session,
      applicationLogGroup: this.memory.applicationLogs.logGroupName,
      demoIssuer:
        this.userPool && this.appClient ? { userPoolId: this.userPool.userPoolId, appClientId: this.appClient.userPoolClientId } : undefined,
    };
    new ssm.StringParameter(this, 'PublishedGateway', {
      parameterName: PUBLISHED_PARAMETER,
      description: 'tenant-memory-isolation published interface (spec §6.3)',
      stringValue: this.toJsonString(published),
    });
  }

  /** The synthetic issuer (ADR-0013): vendor-created users, tenant in an immutable attribute. */
  private demoIssuer(): { pool: cognito.UserPool; client: cognito.UserPoolClient } {
    const logGroup = new logs.LogGroup(this, 'PreTokenLogs', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    // No logs:CreateLogGroup, so a late invocation cannot recreate the group after teardown.
    const role = new iam.Role(this, 'PreTokenRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Demo issuer pre-token trigger: writes its own log group only',
      inlinePolicies: {
        Logs: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({ actions: ['logs:CreateLogStream', 'logs:PutLogEvents'], resources: [`${logGroup.logGroupArn}:*`] }),
          ],
        }),
      },
    });
    acknowledgeResourceWildcard(
      role,
      `${logGroup.logGroupArn}:*`,
      'The log streams of the function\'s own log group; Lambda names each stream at run time, and the logs carry no secrets (M-9).',
    );
    const preToken = new NodejsFunction(this, 'PreTokenFunction', {
      entry: path.join(__dirname, 'issuer', 'pre-token.function.ts'),
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(5),
      role,
      logGroup,
      description: 'tenant-memory-isolation demo issuer: tenant_id claim from the immutable custom:tenantId attribute (ADR-0009)',
    });

    const pool = new cognito.UserPool(this, 'DemoIssuer', {
      featurePlan: cognito.FeaturePlan.ESSENTIALS,
      selfSignUpEnabled: false,
      signInAliases: { username: true },
      customAttributes: { tenantId: new cognito.StringAttribute({ mutable: false, minLen: 1, maxLen: 64 }) },
      passwordPolicy: { minLength: 16, requireDigits: true, requireLowercase: true, requireUppercase: true, requireSymbols: true },
      accountRecovery: cognito.AccountRecovery.NONE,
      deletionProtection: false,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    pool.addTrigger(cognito.UserPoolOperation.PRE_TOKEN_GENERATION_CONFIG, preToken, cognito.LambdaVersion.V2_0);
    const client = pool.addClient('DemoAgents', {
      generateSecret: false,
      // No hosted sign-in or redirect flows: the vendor's agents use admin auth only.
      disableOAuth: true,
      authFlows: { adminUserPassword: true },
      accessTokenValidity: Duration.minutes(5),
      idTokenValidity: Duration.minutes(5),
      refreshTokenValidity: Duration.minutes(60),
      enableTokenRevocation: true,
      preventUserExistenceErrors: true,
      // No app client may write any attribute, so a user cannot change its tenant.
      writeAttributes: new cognito.ClientAttributes(),
    });

    Validations.of(pool).acknowledge({
      id: 'AwsSolutions-COG2',
      reason: 'Synthetic demo issuer: the vendor creates every user and signs in with admin auth; a production issuer brings its own MFA (ADR-0013, production hardening).',
    });
    Validations.of(pool).acknowledge({
      id: 'AwsSolutions-COG8',
      reason: 'Synthetic demo issuer: the Essentials tier is the one that supports access-token customisation; Plus-tier threat protection belongs to the production issuer (ADR-0013, production hardening).',
    });
    Validations.of(pool).acknowledge({
      id: 'AwsSolutions-COG3',
      reason: 'Synthetic demo issuer with no self sign-up or hosted sign-in; threat protection belongs to the production issuer (ADR-0013, production hardening).',
    });
    return { pool, client };
  }
}
