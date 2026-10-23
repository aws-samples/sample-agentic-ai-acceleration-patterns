// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as fs from 'fs';
import * as path from 'path';
import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps, Tags, Validations } from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, NodejsFunctionProps } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import {
  ACCESS_TOKEN_MINUTES,
  ENV,
  ID_TOKEN_MINUTES,
  POOL_INDEX_NAME,
  REFRESH_TOKEN_DAYS,
  SAMPLE_TAG_KEY,
  SAMPLE_TAG_VALUE,
  STACK_TAG_KEY,
  TENANT_ATTRIBUTE_NAME,
  TENANT_SESSION_TAG_KEY,
  TENANT_TAG_KEY,
  tenantUsagePlanName,
  Topology,
} from './shared/constants';
import { LogDrain } from './shared/log-drain';
import { acknowledgeGranularFinding, nagFindingResource, suppressTemplateScanners } from './shared/nag';
import { IntegrationMapping, mergeOpenApi, patchIntegrations, requireApiKey } from './shared/openapi';
import { TenantDrain } from './teardown/tenant-drain-resource';

/** Stack props: the deploy-time topology (ADR-0001) plus the usual StackProps. */
export interface TenantIdentityStackProps extends StackProps {
  /** The deploy-time topology (spec P-7, ADR-0001). */
  readonly topology: Topology;
  /**
   * Publish the `/application-plane/shared/identity/*` parameters (R-6).
   * Default true. The names are fixed, so only one stack per account and
   * Region may publish them; the integration test turns it off on all but
   * one of its three stacks (ADR-0017).
   */
  readonly publishSharedParameters?: boolean;
}

/** The one API stage. Also part of the execution log group's name. */
const STAGE_NAME = 'prod';

/** The registry GSI that maps a pool to its tenant (spec §4.2). */
const GSI_BY_USER_POOL_ID = POOL_INDEX_NAME;

/**
 * The three DynamoDB actions the trigger reads the registry with (R-14):
 * get, batchGet (shared-pool-multi-tenant resolves every group's tenant in
 * one call) and the byUserPoolId query. The authoriser never batch-reads, so
 * it holds only GetItem + Query (see below), not this list.
 */
const REGISTRY_READ_ACTIONS = ['dynamodb:GetItem', 'dynamodb:BatchGetItem', 'dynamodb:Query'];

/** Per-pool cognito-idp user actions held by both the platform and tenant-user roles. */
export const TENANT_USER_ACTIONS = [
  'cognito-idp:AdminCreateUser',
  'cognito-idp:AdminGetUser',
  'cognito-idp:AdminDeleteUser',
  'cognito-idp:AdminAddUserToGroup',
  'cognito-idp:AdminRemoveUserFromGroup',
  'cognito-idp:AdminListGroupsForUser',
  'cognito-idp:ListUsers',
  'cognito-idp:ListUsersInGroup',
];

/**
 * Sign-in actions for the IssueToken/RefreshToken test aids (ADR-0006). The
 * PLATFORM role only: the tenant-user function never signs anyone in, and in
 * a shared pool these would let it set any user's password and mint their
 * tokens (P-8, M-17).
 */
export const TEST_AID_SIGN_IN_ACTIONS = ['cognito-idp:AdminSetUserPassword', 'cognito-idp:AdminInitiateAuth'];

/** Every per-pool user action the platform role holds. */
const PER_POOL_USER_ACTIONS = [...TENANT_USER_ACTIONS, ...TEST_AID_SIGN_IN_ACTIONS];

/** Group-lifecycle actions the PLATFORM role holds and the tenant-user role never does (R-8). */
const GROUP_LIFECYCLE_ACTIONS = ['cognito-idp:CreateGroup', 'cognito-idp:DeleteGroup'];

/**
 * What offboarding a tenant in a shared pool needs (ADR-0022): list the
 * tenant's users, remove or delete them, delete the two groups. The teardown
 * drain holds these and nothing else.
 */
export const DRAIN_SHARED_POOL_ACTIONS = [
  'cognito-idp:ListUsers',
  'cognito-idp:ListUsersInGroup',
  'cognito-idp:AdminListGroupsForUser',
  'cognito-idp:AdminRemoveUserFromGroup',
  'cognito-idp:AdminDeleteUser',
  'cognito-idp:DeleteGroup',
];

/**
 * Pool-lifecycle actions (pool-per-tenant platform role only). Create and
 * delete are what onboarding and offboarding call; the platform code never
 * describes a pool, so DescribeUserPool is not granted.
 */
const POOL_LIFECYCLE_ACTIONS = ['cognito-idp:CreateUserPoolClient', 'cognito-idp:DeleteUserPool'];

/**
 * A tenant id as an IAM string pattern: exactly 26 characters, the length of
 * a ULID. IAM has no regex condition, so `StringLike` with 26 `?` is the
 * tightest shape check available (ADR-0026).
 */
const TENANT_ID_PATTERN = '?'.repeat(26);

/**
 * Throttle limits by route family (N-5, N-6, N-7). `tenant` is the stage's
 * shared `/tenant/*` ceiling for all tenants together; `tenantPerKey` is each
 * tenant's own usage-plan limit (R-19, ADR-0025). The shared ceiling is five
 * times the per-tenant one, so no single tenant can fill it (T-31).
 */
const THROTTLE = {
  platform: { rateLimit: 10, burstLimit: 20 }, // N-5
  token: { rateLimit: 20, burstLimit: 40 }, // N-6
  tenant: { rateLimit: 50, burstLimit: 100 }, // N-7, shared
  tenantPerKey: { rateLimit: 10, burstLimit: 20 }, // N-7 / R-19, per tenant
} as const;

/**
 * Tenant Identity, one stack per topology (ADR-0001). One REST API
 * (SpecRestApi) built from the three merged Smithy OpenAPI documents, five
 * Lambda functions whose roles are asymmetric by design (P-8), a sixth that
 * drains the registry on stack delete (ADR-0022), the tenant
 * registry, and — for the shared-pool topologies — one user pool with the
 * pre-token-generation trigger attached. `pool-per-tenant` creates no pool
 * at deploy time; the platform function creates one per tenant at
 * onboarding (spec §7.1).
 */
export class TenantIdentityStack extends Stack {
  /** The deployed API base URL (with trailing slash). */
  readonly apiUrl: string;

  constructor(scope: Construct, id: string, props: TenantIdentityStackProps) {
    super(scope, id, props);

    const { topology } = props;
    const isPoolPerTenant = topology === 'pool-per-tenant';
    const isShared = !isPoolPerTenant;

    // --- Tenant registry (spec §4, R-3, N-2) ------------------------------
    // Single table, one item type (TENANT#<id> / META). GSI byUserPoolId
    // maps a pool to its tenant for the trigger (§4.2); the registry reads
    // tenantId off the index item, so the projection must include it.
    const table = new dynamodb.TableV2(this, 'Registry', {
      tableName: `${this.stackName}-registry`,
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      globalSecondaryIndexes: [
        {
          indexName: GSI_BY_USER_POOL_ID,
          partitionKey: { name: 'userPoolId', type: dynamodb.AttributeType.STRING },
          // The GSI item carries tenantId so getByUserPoolId reads the
          // tenant id straight off the index (spec §4.2).
          projectionType: dynamodb.ProjectionType.INCLUDE,
          nonKeyAttributes: ['tenantId'],
        },
      ],
      // N-2 (M-14): point-in-time recovery; losing the registry orphans
      // pool-per-tenant pools.
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      // Encrypted at rest with a DynamoDB-owned key (the TableV2 default):
      // the registry holds identifiers and status only, no secret.
      encryption: dynamodb.TableEncryptionV2.dynamoOwnedKey(),
      // Sample only — a real registry is retained.
      removalPolicy: RemovalPolicy.DESTROY,
    });
    suppressTemplateScanners(table, {
      checkov: [{ id: 'CKV_AWS_119', comment: 'The registry holds tenant identifiers and status only; a DynamoDB-owned key is sufficient for this sample and a customer-managed KMS key is on the hardening checklist. Accepted risk T-24 (threat model).' }],
    });

    // --- Shared pool (shared-pool, shared-pool-multi-tenant) --------------
    // pool-per-tenant creates zero pools at deploy time (R-5).
    let userPool: cognito.UserPool | undefined;
    let appClient: cognito.UserPoolClient | undefined;

    // --- Pre-token-generation trigger (R-4, ADR-0003) ---------------------
    // The hottest code path: its role holds registry reads and logging only,
    // never a cognito-idp action (R-14, M-8).
    const triggerFn = new NodejsFunction(this, 'TriggerFunction', {
      entry: path.join(__dirname, 'trigger/pre-token-generation.function.ts'),
      // Cognito waits at most 5 s for a trigger and then fails the sign-in;
      // a longer timeout would only let the function keep running (and keep
      // reading the registry) after the caller has already been refused.
      ...functionProps(this, 'TriggerFunctionLogs', Duration.seconds(5)),
      environment: {
        [ENV.topology]: topology,
        [ENV.tableName]: table.tableName,
        [ENV.poolIndexName]: GSI_BY_USER_POOL_ID,
      },
    });
    // R-14 (M-8): the three read actions, on the table AND its index, and
    // nothing else. grantReadData would add Scan + DescribeTable, widening
    // the hottest role past what §8 needs.
    triggerFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: REGISTRY_READ_ACTIONS,
        resources: [table.tableArn, `${table.tableArn}/index/${GSI_BY_USER_POOL_ID}`],
      }),
    );
    acknowledgeLambdaBasicExecutionRole(triggerFn);

    // --- Token-exchange function (R-7, ADR-0009) --------------------------
    // Logging only: GetTokensFromRefreshToken is authorised by the refresh
    // token, not IAM. No cognito-idp, no dynamodb action (M-8).
    const tokenFn = new NodejsFunction(this, 'TokenFunction', {
      entry: path.join(__dirname, 'token-exchange/token-exchange.function.ts'),
      ...functionProps(this, 'TokenFunctionLogs'),
    });
    acknowledgeLambdaBasicExecutionRole(tokenFn);

    // --- Tenant authoriser (R-9, ADR-0007) --------------------------------
    // Reads the registry to verify tenant status; reads nothing else.
    const authorizerFn = new NodejsFunction(this, 'AuthorizerFunction', {
      entry: path.join(__dirname, 'tenant-api/tenant-authorizer.function.ts'),
      ...functionProps(this, 'AuthorizerFunctionLogs'),
      environment: {
        [ENV.tableName]: table.tableName,
        [ENV.poolIndexName]: GSI_BY_USER_POOL_ID,
      },
    });
    // R-9: registry.get (GetItem) and registry.getByUserPoolId (Query on the
    // index) are the authoriser's only reads; it never batch-reads.
    authorizerFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:GetItem', 'dynamodb:Query'],
        resources: [table.tableArn, `${table.tableArn}/index/${GSI_BY_USER_POOL_ID}`],
      }),
    );
    acknowledgeLambdaBasicExecutionRole(authorizerFn);

    // --- Platform function (R-2) ------------------------------------------
    const platformFn = new NodejsFunction(this, 'PlatformFunction', {
      entry: path.join(__dirname, 'platform/platform.function.ts'),
      // Below API Gateway's fixed 29 s integration timeout: a slow
      // onboarding (CreateUserPool + client + groups) must fail in the
      // function, where it is logged and the caller sees the error, not as a
      // gateway 504 with the function still running behind it.
      ...functionProps(this, 'PlatformFunctionLogs', Duration.seconds(28)),
      environment: {
        [ENV.topology]: topology,
        [ENV.tableName]: table.tableName,
        [ENV.poolIndexName]: GSI_BY_USER_POOL_ID,
        // ADR-0025: looked up by name; the plan's id would be a cycle.
        [ENV.tenantUsagePlanName]: tenantUsagePlanName(this.stackName),
      },
    });
    // Registry read/write (M-14: only the platform function writes it).
    platformFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'dynamodb:GetItem',
          'dynamodb:PutItem',
          'dynamodb:UpdateItem',
          'dynamodb:DeleteItem',
          'dynamodb:Query',
          'dynamodb:Scan',
          'dynamodb:BatchGetItem',
        ],
        resources: [table.tableArn, `${table.tableArn}/index/${GSI_BY_USER_POOL_ID}`],
      }),
    );
    // cdk-nag keeps ONE reason per finding id per construct (the first
    // acknowledgment wins when it writes the template metadata), so the
    // pool-per-tenant platform role, which has two '*' resources (X-Ray and
    // CreateUserPool), documents both in a single reason here.
    acknowledgeLambdaBasicExecutionRole(platformFn, {
      wildcardResourceReason: isPoolPerTenant
        ? 'Two actions take no resource ARN. (1) Active X-Ray tracing grants xray:PutTraceSegments/PutTelemetryRecords, which the X-Ray API only accepts on \'*\'. (2) N-3 / threat-model M-7 (T-7): cognito-idp:CreateUserPool has no resource ARN, so it is granted on * and constrained by a RequestTag condition (only the sample, stack and tenant tags, only those keys). Per-pool actions are scoped to userpool/* with ResourceTag conditions on the sample tag and the stack tag because pools are created at runtime in pool-per-tenant.'
        : undefined,
    });

    // --- Tenant-user function (R-8) ---------------------------------------
    const tenantUsersFn = new NodejsFunction(this, 'TenantUsersFunction', {
      entry: path.join(__dirname, 'tenant-api/tenant-users.function.ts'),
      ...functionProps(this, 'TenantUsersFunctionLogs'),
      environment: {
        [ENV.topology]: topology,
        [ENV.tableName]: table.tableName,
        [ENV.poolIndexName]: GSI_BY_USER_POOL_ID,
      },
    });
    // Registry reads only (R-8).
    tenantUsersFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:GetItem', 'dynamodb:Query'],
        resources: [table.tableArn, `${table.tableArn}/index/${GSI_BY_USER_POOL_ID}`],
      }),
    );
    acknowledgeLambdaBasicExecutionRole(tenantUsersFn);

    // --- Teardown drain (ADR-0022) ----------------------------------------
    // On stack delete, offboards every tenant still in the registry before
    // the table (and the shared pool) go, so `cdk destroy` leaves no
    // runtime-created pool, group, or user behind. Same env as the platform
    // function; a subset of its permissions (delete-side only).
    const drainFn = new NodejsFunction(this, 'TenantDrainFunction', {
      entry: path.join(__dirname, 'teardown/tenant-drain.function.ts'),
      ...functionProps(this, 'TenantDrainFunctionLogs', Duration.minutes(14)),
      environment: {
        [ENV.topology]: topology,
        [ENV.tableName]: table.tableName,
        [ENV.poolIndexName]: GSI_BY_USER_POOL_ID,
      },
    });
    drainFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:GetItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'dynamodb:Query', 'dynamodb:Scan'],
        resources: [table.tableArn, `${table.tableArn}/index/${GSI_BY_USER_POOL_ID}`],
      }),
    );
    acknowledgeLambdaBasicExecutionRole(drainFn, {
      noDeadLetterQueueReason:
        'Invoked asynchronously by CloudFormation as a custom resource. The drain is idempotent (it re-reads the registry and skips what is already gone), so Lambda\'s built-in async retry is the recovery path; a dead-letter queue would hold an event nobody replays. Accepted risk T-24 (threat model).',
    });
    const tenantDrain = new TenantDrain(this, 'TenantDrain', { handler: drainFn });
    tenantDrain.dependsOn(table);

    if (isShared) {
      // shared-pool*: exactly one pool, created by the stack (R-5). Its
      // custom attribute names the tenant only in `shared-pool` (§7.2);
      // `shared-pool-multi-tenant` uses groups, no custom attribute (§7.3).
      const customAttributes =
        topology === 'shared-pool'
          ? {
            // §7.2, P-3: immutable, not writable by the app client. A ULID
            // is 26 chars.
            [TENANT_ATTRIBUTE_NAME]: new cognito.StringAttribute({ minLen: 26, maxLen: 26, mutable: false }),
          }
          : undefined;

      userPool = new cognito.UserPool(this, 'UserPool', {
        userPoolName: `${this.stackName}-pool`,
        // R-4: Essentials feature plan — access-token customisation is not
        // available on Lite.
        featurePlan: cognito.FeaturePlan.ESSENTIALS,
        // E-mail is the username (R-5, §7.2).
        signInAliases: { email: true },
        // R-5: admin-create only, no self sign-up.
        selfSignUpEnabled: false,
        autoVerify: { email: true },
        // E-mail is the identity the sample manages, so it is immutable: no
        // user (and no admin) can rewrite it after creation (T-27, R-17).
        // This is the pool-level guard; the app client's write list cannot
        // do it, because Cognito reads an empty WriteAttributes as "every
        // standard attribute" (integration-verified 2026-10-22).
        standardAttributes: { email: { required: true, mutable: false } },
        customAttributes,
        // Account recovery is admin-only: the sample never sends mail (admin
        // create + AdminSetUserPassword), and EMAIL_ONLY would let anyone
        // trigger a ForgotPassword e-mail to a user (T-27).
        accountRecovery: cognito.AccountRecovery.NONE,
        // N-8 (P-4): deletion protection OFF so teardown is total.
        deletionProtection: false,
        removalPolicy: RemovalPolicy.DESTROY,
      });
      // N-8 (M-3): tag every pool the sample creates.
      Tags.of(userPool).add(SAMPLE_TAG_KEY, SAMPLE_TAG_VALUE);
      Tags.of(userPool).add(STACK_TAG_KEY, this.stackName);

      // R-4: attach the trigger with the V2 event (access-token
      // customisation). Grants cognito-idp.amazonaws.com invoke on the
      // function automatically for this pool.
      userPool.addTrigger(
        cognito.UserPoolOperation.PRE_TOKEN_GENERATION_CONFIG,
        triggerFn,
        cognito.LambdaVersion.V2_0,
      );

      // App client (R-5, N-1, §7.2). No secret, admin-password + refresh
      // auth only, 5-minute access/id tokens, 1-day refresh, no OAuth/hosted
      // UI. readAttributes email only; custom:tenantId is neither readable
      // nor writable (P-3). No writeAttributes: Cognito treats an empty list
      // as "all standard attributes", so the guard against a user rewriting
      // their e-mail (T-27, R-17) is the pool's immutable `email` above, not
      // this list. The other standard attributes stay writable; the sample
      // reads none of them.
      const clientReadWrite = {
        readAttributes: new cognito.ClientAttributes().withStandardAttributes({ email: true }),
      };

      appClient = userPool.addClient('AppClient', {
        userPoolClientName: `${this.stackName}-client`,
        generateSecret: false,
        authFlows: { adminUserPassword: true },
        accessTokenValidity: Duration.minutes(ACCESS_TOKEN_MINUTES),
        idTokenValidity: Duration.minutes(ID_TOKEN_MINUTES),
        refreshTokenValidity: Duration.days(REFRESH_TOKEN_DAYS),
        enableTokenRevocation: true,
        preventUserExistenceErrors: true,
        disableOAuth: true,
        ...clientReadWrite,
      });

      // The shared-pool functions need the pool and app client (ENV). The
      // trigger is excluded: it reads the tenant from the event/registry, not
      // from env, and wiring the pool id into it would create a circular
      // dependency (the pool references the trigger as its V2 trigger).
      for (const fn of [platformFn, tenantUsersFn, tokenFn, authorizerFn, drainFn]) {
        fn.addEnvironment(ENV.userPoolId, userPool.userPoolId);
        fn.addEnvironment(ENV.appClientId, appClient.userPoolClientId);
      }
      // The drain runs before the pool is deleted (ADR-0022).
      tenantDrain.dependsOn(userPool);
      tenantDrain.dependsOn(appClient);

      // Platform + tenant-user roles: per-pool cognito actions scoped to the
      // stack pool ARN (N-3). Shared pools: the pool is known at synth time.
      platformFn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: [...PER_POOL_USER_ACTIONS, ...GROUP_LIFECYCLE_ACTIONS],
          resources: [userPool.userPoolArn],
        }),
      );
      tenantUsersFn.addToRolePolicy(
        new iam.PolicyStatement({
          // R-8: NO CreateUserPool/DeleteUserPool/CreateGroup/DeleteGroup, and
          // no test-aid sign-in actions (P-8).
          actions: TENANT_USER_ACTIONS,
          resources: [userPool.userPoolArn],
        }),
      );
      // The drain offboards tenants: delete-side user and group actions only.
      drainFn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: DRAIN_SHARED_POOL_ACTIONS,
          resources: [userPool.userPoolArn],
        }),
      );

      suppressUserPoolFindings(userPool);
    } else {
      // pool-per-tenant: the platform function creates pools at onboarding.
      // It must know the trigger to attach to each new pool (ENV, §7.1).
      platformFn.addEnvironment(ENV.triggerFunctionArn, triggerFn.functionArn);
      // ENV.stackName is set for every topology below (API key tag, ADR-0025).

      // Both tags, so a role reaches only pools this stack created (N-3):
      // another stack in the account tags its pools with its own name.
      const requestTags = {
        [`aws:RequestTag/${SAMPLE_TAG_KEY}`]: SAMPLE_TAG_VALUE,
        [`aws:RequestTag/${STACK_TAG_KEY}`]: this.stackName,
      };
      const resourceTags = {
        [`aws:ResourceTag/${SAMPLE_TAG_KEY}`]: SAMPLE_TAG_VALUE,
        [`aws:ResourceTag/${STACK_TAG_KEY}`]: this.stackName,
      };

      // ADR-0026: every new pool also carries its tenant's id. Required (a
      // StringLike on a missing key fails) and shaped like a ULID.
      const tenantRequestTag = { [`aws:RequestTag/${TENANT_TAG_KEY}`]: TENANT_ID_PATTERN };
      const poolTagKeys = [SAMPLE_TAG_KEY, STACK_TAG_KEY, TENANT_TAG_KEY];

      // N-3 (M-7): CreateUserPool has no resource ARN, so it is granted on
      // '*' but constrained by a tag condition — only the sample tag, this
      // stack's tag and a tenant tag may be set at create (and only those
      // three keys). Documented accepted account-wide action in the threat
      // model (T-7).
      platformFn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['cognito-idp:CreateUserPool'],
          resources: ['*'],
          conditions: {
            'StringEquals': requestTags,
            'StringLike': tenantRequestTag,
            'ForAllValues:StringEquals': { 'aws:TagKeys': poolTagKeys },
          },
        }),
      );
      // CreateUserPool with UserPoolTags is also authorised as TagResource on
      // userpool/* (integ-verified: AccessDenied without it). Same tag
      // condition as CreateUserPool, plus StringEqualsIfExists on the sample
      // and stack resource tags: a pool that already carries them must carry
      // THIS stack's values, so the role cannot tag another stack's pool into
      // its own ResourceTag rights. A Null ('no tag yet') condition is NOT
      // usable here: integ 2026-10-22 showed CreateUserPool's implicit
      // TagResource fails it (AccessDenied), so IfExists is what works for the
      // pool being created. Residual: a pool in this account that carries
      // neither tag could still be tagged in; accepted with T-7 (threat model).
      platformFn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['cognito-idp:TagResource'],
          resources: [`arn:${this.partition}:cognito-idp:${this.region}:${this.account}:userpool/*`],
          conditions: {
            'StringEquals': requestTags,
            'StringLike': tenantRequestTag,
            'ForAllValues:StringEquals': { 'aws:TagKeys': poolTagKeys },
            // A pool that is already tagged must be this stack's own.
            'StringEqualsIfExists': resourceTags,
          },
        }),
      );
      // Per-pool + pool-lifecycle actions on any pool the sample created,
      // scoped by the resource tag condition (N-3).
      platformFn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: [...PER_POOL_USER_ACTIONS, ...GROUP_LIFECYCLE_ACTIONS, ...POOL_LIFECYCLE_ACTIONS],
          resources: [`arn:${this.partition}:cognito-idp:${this.region}:${this.account}:userpool/*`],
          conditions: {
            StringEquals: resourceTags,
          },
        }),
      );
      // ADR-0026: the tenant-user function holds no Cognito action itself. It
      // assumes TenantScopedRole once per tenant, tagging the session with
      // the authoriser's tenant id; that role reaches only the pool whose
      // tenant tag equals the session tag. IAM then enforces the T-18 tenant
      // boundary; the R-12 code check stays as defence in depth.
      const tenantScopedRole = new iam.Role(this, 'TenantScopedRole', {
        description: 'Tenant-user Cognito actions on the one pool whose tenant tag matches the session tag (ADR-0026)',
        assumedBy: new iam.ArnPrincipal(tenantUsersFn.role!.roleArn)
          .withConditions({
            // A session must carry exactly one tag, TenantId, shaped like a
            // ULID; nothing else may be tagged and nothing is transitive.
            'StringLike': { [`aws:RequestTag/${TENANT_SESSION_TAG_KEY}`]: TENANT_ID_PATTERN },
            'ForAllValues:StringEquals': { 'aws:TagKeys': [TENANT_SESSION_TAG_KEY] },
          })
          .withSessionTags(),
      });
      tenantScopedRole.addToPolicy(
        new iam.PolicyStatement({
          // R-8: user actions only, no pool/group lifecycle, no sign-in (P-8).
          actions: TENANT_USER_ACTIONS,
          resources: [`arn:${this.partition}:cognito-idp:${this.region}:${this.account}:userpool/*`],
          conditions: {
            StringEquals: {
              ...resourceTags,
              [`aws:ResourceTag/${TENANT_TAG_KEY}`]: `\${aws:PrincipalTag/${TENANT_SESSION_TAG_KEY}}`,
            },
          },
        }),
      );
      tenantUsersFn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['sts:AssumeRole', 'sts:TagSession'],
          resources: [tenantScopedRole.roleArn],
        }),
      );
      tenantUsersFn.addEnvironment(ENV.tenantScopedRoleArn, tenantScopedRole.roleArn);
      new CfnOutput(this, 'TenantScopedRoleArn', { value: tenantScopedRole.roleArn });
      // The drain deletes each tenant's pool: DeleteUserPool on this stack's
      // pools only (ADR-0022).
      drainFn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['cognito-idp:DeleteUserPool'],
          resources: [`arn:${this.partition}:cognito-idp:${this.region}:${this.account}:userpool/*`],
          conditions: {
            StringEquals: resourceTags,
          },
        }),
      );

      // §7.1: the shared trigger must be invokable by any pool the platform
      // function creates in this account. Cognito is the principal; scope to
      // this account.
      triggerFn.addPermission('CognitoInvoke', {
        principal: new iam.ServicePrincipal('cognito-idp.amazonaws.com'),
        sourceAccount: this.account,
      });

      // The wildcard-resource statements above are inherent to N-3
      // (CreateUserPool has no ARN; pools are created at runtime). Document
      // each as an acknowledged cdk-nag IAM5 finding with the threat-model
      // reference. The userpool/* ARN carries the ${AWS::Partition} token, so
      // the finding id is built with nagFindingResource (resolve + flatten).
      // The platform role's Resource::* finding (X-Ray + CreateUserPool) is
      // acknowledged once, above, in acknowledgeLambdaBasicExecutionRole.
      const userpoolWildcardArn = nagFindingResource(
        this,
        `arn:${this.partition}:cognito-idp:${this.region}:${this.account}:userpool/*`,
      );
      acknowledgeGranularFinding(
        tenantScopedRole,
        `AwsSolutions-IAM5[Resource::${userpoolWildcardArn}]`,
        'N-3 / ADR-0026 / threat-model M-17, M-28: per-tenant pools are created at runtime, so the tenant-user actions are scoped to userpool/* with ResourceTag conditions on the sample tag, the stack tag, and the tenant tag equal to the session\'s TenantId tag: a session reaches exactly one tenant\'s pool. No pool or group lifecycle action is present (R-8).',
      );
      acknowledgeGranularFinding(
        platformFn,
        `AwsSolutions-IAM5[Resource::${userpoolWildcardArn}]`,
        'N-3 / threat-model M-7: per-pool and pool-lifecycle actions are scoped to userpool/* with ResourceTag conditions on the sample tag and the stack tag because pools are created at runtime in pool-per-tenant.',
      );
      acknowledgeGranularFinding(
        drainFn,
        `AwsSolutions-IAM5[Resource::${userpoolWildcardArn}]`,
        'N-3 / ADR-0022: the teardown drain deletes this stack\'s runtime-created pools, so DeleteUserPool is scoped to userpool/* with ResourceTag conditions on the sample tag and the stack tag.',
      );
    }

    // IAM5 on the registry index wildcard (table/index/<name>) is this
    // table's own index namespace — explicit scoping, not over-breadth.
    for (const fn of [triggerFn, authorizerFn, platformFn, tenantUsersFn, drainFn]) {
      acknowledgeGranularFinding(
        fn,
        `AwsSolutions-IAM5[Resource::${nagFindingResource(this, `${table.tableArn}/index/${GSI_BY_USER_POOL_ID}`)}]`,
        'Registry read scoped to this table and its byUserPoolId index only; the index ARN is this table\'s own namespace, not a cross-resource wildcard (R-14, threat-model M-8).',
      );
    }

    // --- API Gateway REST API from the merged, patched OpenAPI (R-1) ------
    // One API: /platform (IAM, ADR-0005), /oauth2/token (no authoriser,
    // ADR-0011), /tenant (custom authoriser, ADR-0007). Never hand-written:
    // generated by `smithy build`, merged and patched at synth time.
    const definition = buildApiDefinition(this, {
      platformFnArn: platformFn.functionArn,
      tenantFnArn: tenantUsersFn.functionArn,
      tokenFnArn: tokenFn.functionArn,
      authorizerFnArn: authorizerFn.functionArn,
      partition: this.partition,
      region: this.region,
    });

    const apiAccessLogs = new logs.LogGroup(this, 'ApiAccessLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY, // sample only
    });

    const api = new apigateway.SpecRestApi(this, 'Api', {
      restApiName: `${this.stackName}-api`,
      apiDefinition: apigateway.ApiDefinition.fromInline(definition),
      // Do not create the account-wide API Gateway CloudWatch role. It is one
      // setting per account and Region: CDK retains the role on destroy, and
      // the setting keeps pointing at it. The account must already have one
      // (README prerequisites, ADR-0019).
      cloudWatchRole: false,
      // Resource policy (spec §3.2): the account root may invoke /platform/*
      // (IAM-authorised, so the actual caller is a granted principal); the
      // token and tenant routes allow any principal because they
      // authenticate with tokens, not IAM.
      policy: new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            principals: [new iam.AccountRootPrincipal()],
            actions: ['execute-api:Invoke'],
            resources: [`execute-api:/${STAGE_NAME}/*/platform/*`],
          }),
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            principals: [new iam.AnyPrincipal()],
            actions: ['execute-api:Invoke'],
            resources: [`execute-api:/${STAGE_NAME}/POST/oauth2/token`, `execute-api:/${STAGE_NAME}/*/tenant/*`],
          }),
        ],
      }),
      deployOptions: {
        stageName: STAGE_NAME,
        // Who called and how (AwsSolutions-APIG1). The custom format adds the
        // caller identity: the SigV4 user ARN on /platform and the
        // authoriser principalId (the verified sub) on /tenant — every
        // request is attributable (N-4, M-10).
        accessLogDestination: new apigateway.LogGroupLogDestination(apiAccessLogs),
        accessLogFormat: apigateway.AccessLogFormat.custom(
          JSON.stringify({
            requestId: apigateway.AccessLogField.contextRequestId(),
            ip: apigateway.AccessLogField.contextIdentitySourceIp(),
            requestTime: apigateway.AccessLogField.contextRequestTime(),
            httpMethod: apigateway.AccessLogField.contextHttpMethod(),
            resourcePath: apigateway.AccessLogField.contextResourcePath(),
            status: apigateway.AccessLogField.contextStatus(),
            protocol: apigateway.AccessLogField.contextProtocol(),
            responseLength: apigateway.AccessLogField.contextResponseLength(),
            // SigV4 caller identity on /platform/*.
            callerArn: apigateway.AccessLogField.contextIdentityUserArn(),
            // The verified tenant admin sub on /tenant/* (present on Deny too).
            principalId: apigateway.AccessLogField.contextAuthorizerPrincipalId(),
            // The caller's tenant on /tenant/* (the authoriser returns
            // context.tenantId on Allow). The per-tenant dimension every
            // Contributor Insights rule below keys on.
            tenantId: apigateway.AccessLogField.contextAuthorizer('tenantId'),
          }),
        ),
        loggingLevel: apigateway.MethodLoggingLevel.INFO, // APIG6
        tracingEnabled: true,
        // Stage-wide default throttle; per-route families override below.
        throttlingRateLimit: THROTTLE.platform.rateLimit,
        throttlingBurstLimit: THROTTLE.platform.burstLimit,
        // Per-method throttling (N-5, N-6, N-7). Keyed by concrete
        // {resource_path}/{http_method}; API Gateway MethodSettings do not
        // prefix-wildcard, so each operation gets an explicit entry from the
        // merged document, classified by its path prefix.
        methodOptions: methodThrottleOptions(definition),
      },
    });
    this.apiUrl = api.url;

    // --- Per-tenant throttling on /tenant/* (ADR-0025) ---------------------
    // One usage plan per stack, on the stage; one API key per tenant, created
    // by CreateTenant. Usage-plan limits apply per key, so each tenant gets
    // THROTTLE.tenantPerKey on its own. Only /tenant/* methods require a key,
    // so the plan changes nothing on /platform/* or /oauth2/token. The
    // stage's per-method /tenant limits (THROTTLE.tenant, N-7) still apply on
    // top, to all tenants together, and sit above the per-key limit (T-31).
    const tenantUsagePlan = new apigateway.UsagePlan(this, 'TenantUsagePlan', {
      name: tenantUsagePlanName(this.stackName),
      description: 'Per-tenant throttle for /tenant/* (ADR-0025); one API key per tenant',
      throttle: { rateLimit: THROTTLE.tenantPerKey.rateLimit, burstLimit: THROTTLE.tenantPerKey.burstLimit },
      apiStages: [{ api, stage: api.deploymentStage }],
    });
    // The drain deletes every tenant's key before the plan goes (ADR-0022).
    tenantDrain.dependsOn(tenantUsagePlan);

    // API Gateway control-plane ARNs for the keys (ADR-0025). CreateApiKey is
    // POST on /apikeys; DeleteApiKey is DELETE on /apikeys/<id>, and key ids
    // are generated, so it is /apikeys/*. Every key is created carrying the
    // stack tag, and the delete is allowed only on keys with this stack's
    // tag, so neither role can delete another workload's key (T-7).
    const apiKeysArn = `arn:${this.partition}:apigateway:${this.region}::/apikeys`;
    const apiKeyArn = `${apiKeysArn}/*`;
    platformFn.addEnvironment(ENV.stackName, this.stackName);
    platformFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['apigateway:POST'],
        resources: [apiKeysArn],
        conditions: {
          'StringEquals': { [`aws:RequestTag/${STACK_TAG_KEY}`]: this.stackName },
          'ForAllValues:StringEquals': { 'aws:TagKeys': [STACK_TAG_KEY] },
        },
      }),
    );
    // API Gateway authorises the tags on CreateApiKey as TagResource:
    // apigateway:PUT on /tags/<url-encoded /apikeys/* ARN> (integ 2026-10-23).
    // Same tag conditions as the create. A role holding this can also tag an
    // existing untagged key in the Region with this stack's tag, and then
    // delete it: the accepted T-7 residual, as with Cognito's TagResource.
    const apiKeyTagsArn = `arn:${this.partition}:apigateway:${this.region}::/tags/arn%3A${this.partition}%3Aapigateway%3A${this.region}%3A%3A%2Fapikeys%2F*`;
    platformFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['apigateway:PUT'],
        resources: [apiKeyTagsArn],
        conditions: {
          'StringEquals': { [`aws:RequestTag/${STACK_TAG_KEY}`]: this.stackName },
          'ForAllValues:StringEquals': { 'aws:TagKeys': [STACK_TAG_KEY] },
          'StringEqualsIfExists': { [`aws:ResourceTag/${STACK_TAG_KEY}`]: this.stackName },
        },
      }),
    );
    const deleteOwnKeys = () =>
      new iam.PolicyStatement({
        actions: ['apigateway:DELETE'],
        resources: [apiKeyArn],
        conditions: { StringEquals: { [`aws:ResourceTag/${STACK_TAG_KEY}`]: this.stackName } },
      });
    platformFn.addToRolePolicy(deleteOwnKeys());
    // GetUsagePlans, to find this stack's plan by name at first use.
    platformFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['apigateway:GET'],
        resources: [`arn:${this.partition}:apigateway:${this.region}::/usageplans`],
      }),
    );
    // CreateUsagePlanKey on this plan only. A separate policy, not the role's
    // default one: the function depends on its default policy, and naming the
    // plan there would close the cycle function -> plan -> API -> function.
    new iam.Policy(platformFn, 'UsagePlanKeyPolicy', {
      roles: [platformFn.role!],
      statements: [
        new iam.PolicyStatement({
          actions: ['apigateway:POST'],
          resources: [
            `arn:${this.partition}:apigateway:${this.region}::/usageplans/${tenantUsagePlan.usagePlanId}/keys`,
          ],
        }),
      ],
    });
    // The drain deletes this stack's keys only.
    drainFn.addToRolePolicy(deleteOwnKeys());
    acknowledgeGranularFinding(
      platformFn,
      `AwsSolutions-IAM5[Resource::${nagFindingResource(this, apiKeyTagsArn)}]`,
      'ADR-0025: API Gateway authorises the tag on CreateApiKey as apigateway:PUT on the /tags ARN of /apikeys/*; the key id is not known before creation. Conditioned on the request tag tenant-identity:stack = this stack, no other tag key, and no other stack tag already on the key (threat-model T-7).',
    );
    for (const fn of [platformFn, drainFn]) {
      acknowledgeGranularFinding(
        fn,
        `AwsSolutions-IAM5[Resource::${nagFindingResource(this, apiKeyArn)}]`,
        'ADR-0025: API key ids are generated at CreateTenant, so DeleteApiKey is granted on /apikeys/* in this Region, conditioned on aws:ResourceTag/tenant-identity:stack = this stack. Keys are created with that tag (aws:RequestTag condition on CreateApiKey), so the role deletes only keys this stack created (threat-model T-7).',
      );
    }

    // --- Per-tenant observability: Contributor Insights (N-4) --------------
    // Who is driving traffic, errors and token issuance, by tenant, without a
    // metric per tenant. Four rules over the two log groups that already
    // carry tenantId. Rule names are account-wide, so each is prefixed with
    // the stack name. Cost: a fixed charge per rule-month plus a charge per
    // million matched log events (CloudWatch pricing).
    //
    // Access logs: $context.authorizer.tenantId renders as '-' when the
    // request had no authoriser context (/platform, /oauth2/token, and a
    // Deny), so the per-tenant rules exclude '-' as well as a missing field.
    const tenantPresent = [
      { Match: '$.tenantId', IsPresent: true },
      { Match: '$.tenantId', NotIn: ['-'] },
    ];
    // (a) Requests per tenant on /tenant/*.
    insightRule(this, 'TenantRequestsRule', `${this.stackName}-tenant-requests`, {
      LogGroupNames: [apiAccessLogs.logGroupName],
      Contribution: { Keys: ['$.tenantId'], Filters: tenantPresent },
    });
    // (b) Error responses per tenant and status. The access log writes
    // status as a string, so "4xx or 5xx" is a prefix match, not GreaterThan
    // (which Contributor Insights defines for numeric fields only).
    insightRule(this, 'TenantErrorsRule', `${this.stackName}-tenant-errors`, {
      LogGroupNames: [apiAccessLogs.logGroupName],
      Contribution: {
        Keys: ['$.tenantId', '$.status'],
        Filters: [...tenantPresent, { Match: '$.status', StartsWith: ['4', '5'] }],
      },
    });
    // (c) Tokens issued per tenant: the trigger's 'pre-token-generation
    // issued' line (src/trigger/pre-token-generation.ts). In
    // shared-pool-multi-tenant an un-narrowed token lists every tenant,
    // comma-joined, and counts as one contributor.
    insightRule(this, 'TenantTokensRule', `${this.stackName}-tenant-tokens`, {
      LogGroupNames: [triggerFn.logGroup.logGroupName],
      Contribution: {
        Keys: ['$.tenantId'],
        Filters: [{ Match: '$.message', In: ['pre-token-generation issued'] }],
      },
    });
    // (d) Refusals by rule: every 'pre-token-generation refused*' line
    // carries the §8 rule that fired (never the caller's input).
    insightRule(this, 'TokenRefusalsRule', `${this.stackName}-token-refusals`, {
      LogGroupNames: [triggerFn.logGroup.logGroupName],
      Contribution: {
        Keys: ['$.rule'],
        Filters: [{ Match: '$.message', StartsWith: ['pre-token-generation refused'] }],
      },
    });

    // M-4/M-9/N-5..N-7 signal: sustained 4XX is the probing / leaked-token /
    // amplification signature at the edge. Alarm only (sample scope).
    new cloudwatch.Alarm(this, 'ApiClientErrorAlarm', {
      metric: api.metricClientError({ period: Duration.minutes(5), statistic: 'Sum' }),
      threshold: 50,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription:
        'More than 50 4XX responses in 5 minutes - possible token probing, leaked credential, or exchange-route abuse (threat T-9/T-20).',
    });

    // Request validation IS enabled (Smithy @requestValidator in the OpenAPI);
    // the rule only detects standalone CfnRequestValidator resources.
    Validations.of(api).acknowledge({
      id: 'AwsSolutions-APIG2',
      reason:
        'Request validation IS enabled: the merged Smithy OpenAPI applies x-amazon-apigateway-request-validator per operation. The rule only detects standalone CfnRequestValidator resources, which SpecRestApi does not create (ADR-0016).',
    });
    Validations.of(api).acknowledge({
      id: 'AwsSolutions-APIG3',
      reason:
        'WAFv2 association is a production hardening concern (threat T-9, operational): /platform is IAM-authorised, /tenant is behind the Lambda authoriser, and all three route families are explicitly throttled (N-5/N-6/N-7).',
    });
    Validations.of(api).acknowledge({
      id: 'AwsSolutions-APIG4',
      reason:
        'POST /oauth2/token is intentionally unauthenticated at the gateway (ADR-0011, §5.4): the refresh token in the body is the credential, validated by Cognito. /platform uses AWS_IAM and /tenant the custom authoriser.',
    });
    Validations.of(api).acknowledge({
      id: 'AwsSolutions-COG4',
      reason:
        'POST /oauth2/token uses no Cognito user-pool authoriser by design (ADR-0011); /tenant uses a custom Lambda authoriser (ADR-0007) and /platform uses AWS_IAM (ADR-0005).',
    });
    suppressTemplateScanners(apiAccessLogs, {
      cfnNag: [{ id: 'W84', reason: 'Access logs carry request metadata only; default CloudWatch Logs SSE at rest is sufficient for this sample. Accepted risk T-24 (threat model).' }],
      checkov: [{ id: 'CKV_AWS_158', comment: 'Access logs carry request metadata only; default CloudWatch Logs SSE at rest is sufficient for this sample. Accepted risk T-24 (threat model).' }],
    });
    // The stage is in TenantUsagePlan (ADR-0025), so cfn_nag W64 no longer
    // applies to it.
    suppressTemplateScanners(api.deploymentStage, {
      checkov: [{ id: 'CKV_AWS_120', comment: 'Identity responses are per-caller and mutation-heavy; stage caching risks stale reads for marginal benefit. Accepted risk T-24 (threat model).' }],
    });
    if (api.latestDeployment !== undefined) {
      suppressTemplateScanners(api.latestDeployment, {
        cfnNag: [{ id: 'W68', reason: 'The stage this deployment backs is in the per-tenant usage plan (ADR-0025); cfn_nag matches a usage plan to a Deployment\'s StageName, which CDK leaves unset because the stage is a separate resource. Only /tenant/* requires a key: /platform/* is IAM-authorised and /oauth2/token has no authoriser to return one.' }],
      });
    }
    for (const fn of [platformFn, tenantUsersFn]) {
      suppressTemplateScanners(fn.role!.node.findChild('DefaultPolicy'), {
        cfnNag: [{ id: 'W76', reason: 'Least-privilege policy with granular per-resource statements (registry table + index, tag-conditioned cognito-idp); the statement-point count reflects explicit scoping, not over-breadth (P-8, N-3). Accepted risk T-24 (threat model).' }],
      });
    }

    // API Gateway must be allowed to invoke each integration + the authoriser.
    for (const [cid, fn] of [
      ['PlatformInvoke', platformFn],
      ['TokenInvoke', tokenFn],
      ['TenantUsersInvoke', tenantUsersFn],
    ] as const) {
      fn.addPermission(cid, {
        principal: new iam.ServicePrincipal('apigateway.amazonaws.com'),
        sourceArn: api.arnForExecuteApi(),
      });
    }
    authorizerFn.addPermission('ApiGatewayAuthorizerInvoke', {
      principal: new iam.ServicePrincipal('apigateway.amazonaws.com'),
      sourceArn: this.formatArn({ service: 'execute-api', resource: api.restApiId, resourceName: 'authorizers/*' }),
    });

    // --- Discovery parameters (R-6, §6.3, ADR-0017) + outputs ------------
    if (props.publishSharedParameters ?? true) {
      new ssm.StringParameter(this, 'TopologyParameter', {
        parameterName: '/application-plane/shared/identity/topology',
        stringValue: topology,
      });
      new ssm.StringParameter(this, 'ApiUrlParameter', {
        parameterName: '/application-plane/shared/identity/apiUrl',
        stringValue: api.url,
      });
      if (isShared && userPool !== undefined && appClient !== undefined) {
        new ssm.StringParameter(this, 'UserPoolIdParameter', {
          parameterName: '/application-plane/shared/identity/userPoolId',
          stringValue: userPool.userPoolId,
        });
        new ssm.StringParameter(this, 'AppClientIdParameter', {
          parameterName: '/application-plane/shared/identity/appClientId',
          stringValue: appClient.userPoolClientId,
        });
      }
    }

    // --- Teardown leaves no log group behind (ADR-0024) --------------------
    // API Gateway creates the execution log group itself on first write, so
    // it would live outside the stack. Own it here, before the stage writes.
    const executionLogs = new logs.LogGroup(this, 'ApiExecutionLogs', {
      // A literal stage name: a token would make the group depend on the stage.
      logGroupName: `API-Gateway-Execution-Logs_${api.restApiId}/${STAGE_NAME}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY, // sample only
    });
    suppressTemplateScanners(executionLogs, {
      cfnNag: [{ id: 'W84', reason: 'Execution logs carry request metadata only; default CloudWatch Logs SSE at rest is sufficient for this sample. Accepted risk T-24 (threat model).' }],
      checkov: [{ id: 'CKV_AWS_158', comment: 'Execution logs carry request metadata only; default CloudWatch Logs SSE at rest is sufficient for this sample. Accepted risk T-24 (threat model).' }],
    });
    // Late log delivery recreates a deleted log group. Delete what makes the
    // functions and the API write logs, wait, then delete the log groups
    // (ADR-0024). The writers are what invokes the functions, not the
    // functions: the stage (API Gateway invokes four functions and writes
    // both API log groups) and TenantDrain (CloudFormation invokes drainFn,
    // and in pool-per-tenant it deletes the runtime pools that invoke the
    // trigger). One drain guards every log group, so there is one wait.
    //
    // Neither the functions nor the shared pool can be writers: the
    // execution log group's name holds the API id, the API references the
    // functions, and the functions reference the pool, so either would be a
    // dependency cycle. The pool is deleted after the drain has waited; only
    // a direct Cognito sign-in in the seconds before that can still log late.
    const logDrain = new LogDrain(this, 'LogDrain');
    for (const fn of [triggerFn, tokenFn, authorizerFn, platformFn, tenantUsersFn, drainFn]) {
      logDrain.protect(fn.logGroup);
    }
    logDrain.protect(apiAccessLogs);
    logDrain.protect(executionLogs);
    logDrain.writer(api.deploymentStage);
    logDrain.writer(tenantDrain);

    new CfnOutput(this, 'ApiUrl', { value: api.url });
    new CfnOutput(this, 'Topology', { value: topology });
    new CfnOutput(this, 'RegistryTableName', { value: table.tableName });
    new CfnOutput(this, 'TenantUsagePlanId', { value: tenantUsagePlan.usagePlanId });
    if (isShared && userPool !== undefined && appClient !== undefined) {
      new CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
      new CfnOutput(this, 'AppClientId', { value: appClient.userPoolClientId });
    }
  }
}

/** Shared NodejsFunction properties: runtime, arch, tracing, bundling, log group. */
function functionProps(
  scope: Construct,
  logGroupId: string,
  timeout: Duration = Duration.seconds(10),
): Omit<NodejsFunctionProps, 'entry'> {
  return {
    handler: 'handler',
    runtime: lambda.Runtime.NODEJS_24_X,
    architecture: lambda.Architecture.ARM_64,
    memorySize: 256,
    timeout,
    tracing: lambda.Tracing.ACTIVE,
    logGroup: functionLogGroup(scope, logGroupId),
    // The logger (src/shared/logger.ts) writes one JSON object per line.
    // Lambda's JSON log format passes an already-JSON line through as is;
    // the plain-text format prefixes it with a timestamp, request id and
    // level, which the Contributor Insights JSON rules cannot parse.
    loggingFormat: lambda.LoggingFormat.JSON,
    bundling: {
      minify: true,
      sourceMap: true,
      // Bundle the SDK v3 clients we use: the Node 24 runtime ships v3, but
      // bundling pins the exact version the sample was tested against and
      // keeps the Smithy server packages (not in the runtime SDK) in the
      // artifact.
      externalModules: [],
      // The Smithy SSDKs validate with re2-wasm, which reads its wasm binary
      // from disk at cold start; esbuild does not bundle it. Without it every
      // SSDK function fails to initialise (502).
      commandHooks: {
        beforeBundling: () => [],
        beforeInstall: () => [],
        afterBundling: (inputDir: string, outputDir: string) => [
          `cp ${inputDir}/node_modules/re2-wasm/build/wasm/re2.wasm ${outputDir}/`,
        ],
      },
    },
  };
}

/**
 * Explicit Lambda log group with bounded retention (M-15-style): the
 * Lambda-service-created default group never expires and lives outside the
 * stack. One month matches the API access logs.
 */
function functionLogGroup(scope: Construct, id: string): logs.LogGroup {
  const logGroup = new logs.LogGroup(scope, id, {
    retention: logs.RetentionDays.ONE_MONTH,
    removalPolicy: RemovalPolicy.DESTROY, // sample only
  });
  suppressTemplateScanners(logGroup, {
    cfnNag: [{ id: 'W84', reason: 'Function logs carry non-sensitive request metadata; default CloudWatch Logs SSE at rest is sufficient for this sample. Accepted risk T-24 (threat model).' }],
    checkov: [{ id: 'CKV_AWS_158', comment: 'Function logs carry non-sensitive request metadata; default CloudWatch Logs SSE at rest is sufficient for this sample. Accepted risk T-24 (threat model).' }],
  });
  return logGroup;
}

/**
 * A CloudWatch Contributor Insights rule over CloudWatch Logs (schema
 * CloudWatchLogRule v1, JSON log format), enabled. `body` carries the
 * log groups and the Contribution; the schema, format and Count aggregation
 * are fixed here so every rule in the stack reads the same way.
 */
function insightRule(
  scope: Construct,
  id: string,
  ruleName: string,
  body: { LogGroupNames: string[]; Contribution: Record<string, unknown> },
): cloudwatch.CfnInsightRule {
  return new cloudwatch.CfnInsightRule(scope, id, {
    ruleName,
    ruleState: 'ENABLED',
    ruleBody: JSON.stringify({
      Schema: { Name: 'CloudWatchLogRule', Version: 1 },
      LogGroupNames: body.LogGroupNames,
      LogFormat: 'JSON',
      Contribution: body.Contribution,
      AggregateOn: 'Count',
    }),
  });
}

/** Per-function overrides for the reasons acknowledgeLambdaBasicExecutionRole records. */
interface ExecutionRoleAcknowledgements {
  /**
   * Replaces the X-Ray-only reason for `AwsSolutions-IAM5[Resource::*]`
   * when the role has a second '*' resource (cdk-nag records one reason per
   * finding id per construct, so both must be stated in one).
   */
  readonly wildcardResourceReason?: string;
  /** Replaces the synchronous-invocation reason for checkov CKV_AWS_116 (no dead-letter queue). */
  readonly noDeadLetterQueueReason?: string;
}

/** Acknowledges the IAM4 finding for the managed basic-execution role + template-scanner counterparts. */
function acknowledgeLambdaBasicExecutionRole(fn: NodejsFunction, overrides: ExecutionRoleAcknowledgements = {}): void {
  acknowledgeGranularFinding(
    fn,
    'AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]',
    'Logs-only managed policy attached by NodejsFunction; a scoped replacement adds boilerplate with marginal benefit. Accepted risk T-24 (threat model).',
  );
  // Active X-Ray tracing adds xray:PutTraceSegments / PutTelemetryRecords on
  // '*': the X-Ray API takes no resource ARN, so the wildcard is inherent to
  // the service, not over-breadth.
  acknowledgeGranularFinding(
    fn,
    'AwsSolutions-IAM5[Resource::*]',
    overrides.wildcardResourceReason ??
      'Active X-Ray tracing grants xray:PutTraceSegments/PutTelemetryRecords, which the X-Ray API only accepts on \'*\' (no resource ARN). Not over-breadth. Accepted risk T-24 (threat model).',
  );
  suppressTemplateScanners(fn, {
    cfnNag: [
      { id: 'W58', reason: 'Log permissions come from the AWSLambdaBasicExecutionRole managed policy; cfn_nag does not resolve managed policies. Accepted risk T-24 (threat model).' },
      { id: 'W89', reason: 'The function calls only AWS APIs over public endpoints; no VPC-internal resource to reach. Accepted risk T-24 (threat model).' },
      { id: 'W92', reason: 'The sample does not partition account concurrency; API Gateway stage throttling bounds the invoke rate. Accepted risk T-24 (threat model).' },
    ],
    checkov: [
      { id: 'CKV_AWS_115', comment: 'The sample does not partition account concurrency; API Gateway stage throttling bounds the invoke rate. Accepted risk T-24 (threat model).' },
      { id: 'CKV_AWS_116', comment: overrides.noDeadLetterQueueReason ?? 'Synchronous API/authorizer/trigger function - failures surface as errors; no async event source to dead-letter. Accepted risk T-24 (threat model).' },
      { id: 'CKV_AWS_117', comment: 'The function calls only AWS APIs over public endpoints; no VPC-internal resource to reach. Accepted risk T-24 (threat model).' },
      { id: 'CKV_AWS_173', comment: 'Environment variables carry non-secret configuration (table/pool/client identifiers); default encryption at rest applies. Accepted risk T-24 (threat model).' },
    ],
  });
  const ownedLogGroup = fn.node.tryFindChild('LogGroup');
  if (ownedLogGroup !== undefined) {
    suppressTemplateScanners(ownedLogGroup, {
      cfnNag: [{ id: 'W84', reason: 'Function logs carry non-sensitive request metadata; default CloudWatch Logs SSE at rest is sufficient for this sample. Accepted risk T-24 (threat model).' }],
      checkov: [{ id: 'CKV_AWS_158', comment: 'Function logs carry non-sensitive request metadata; default CloudWatch Logs SSE at rest is sufficient for this sample. Accepted risk T-24 (threat model).' }],
    });
  }
}

/**
 * cdk-nag flags a user pool for no MFA (COG2), no advanced security (COG3),
 * and a weak password policy (COG1). The sample sets a strong password
 * policy (not a suppression) and documents why MFA/ASF are out of scope:
 * every user is admin-created and signs in only for the demonstration
 * (ADR-0006); the subject is tenant identity, not sign-in hardening (§1.2).
 */
function suppressUserPoolFindings(userPool: cognito.UserPool): void {
  const cfnPool = userPool.node.defaultChild as cognito.CfnUserPool;
  // COG1: a strong password policy, set rather than suppressed.
  cfnPool.policies = {
    passwordPolicy: {
      minimumLength: 12,
      requireLowercase: true,
      requireUppercase: true,
      requireNumbers: true,
      requireSymbols: true,
      temporaryPasswordValidityDays: 1,
    },
  };
  Validations.of(userPool).acknowledge({
    id: 'AwsSolutions-COG2',
    reason:
      'MFA is out of scope: users are admin-created and sign in only for the demonstration (ADR-0006, §3.2). A real deployment enables MFA - on the hardening checklist. The sample subject is tenant identity in the token, not sign-in hardening (§1.2). Accepted risk T-23 (threat model).',
  });
  Validations.of(userPool).acknowledge({
    id: 'AwsSolutions-COG3',
    reason:
      'Advanced Security (threat protection) is a production hardening concern on the README checklist. Out of scope for the identity-topology subject (§1.2). Accepted risk T-23 (threat model).',
  });
  Validations.of(userPool).acknowledge({
    id: 'AwsSolutions-COG8',
    reason:
      'The Essentials feature plan is required (R-4): access-token customisation by the pre-token-generation trigger is unavailable on Lite, and the Plus tier\'s advanced threat protection is a production hardening concern (README checklist), out of scope for the identity-topology subject (§1.2). Accepted risk T-23 (threat model).',
  });
  suppressTemplateScanners(userPool, {
    cfnNag: [{ id: 'F78', reason: 'MFA out of scope: admin-created users, sign-in for the demonstration only (ADR-0006); real deployment enables MFA (README checklist). Accepted risk T-23 (threat model).' }],
  });
}

/**
 * Reads the three generated OpenAPI documents, merges them (R-1), and
 * patches the PLACEHOLDER integration + authoriser URIs. The spec is never
 * hand-crafted: `smithy build` generates it; only URIs are patched.
 */
function buildApiDefinition(stack: Stack, mapping: IntegrationMapping): object {
  const read = (projection: string, service: string) =>
    JSON.parse(
      fs.readFileSync(path.join(__dirname, `smithy/${projection}/openapi/${service}.openapi.json`), 'utf8'),
    );
  const docs = [
    read('platform', 'PlatformService'),
    read('tenant', 'TenantService'),
    read('token', 'TokenService'),
  ];
  // ADR-0025: /tenant/* methods require an API key, read from the
  // authoriser's usageIdentifierKey. /platform/* and /oauth2/token do not:
  // the token route has no authoriser, so nothing could name a tenant key.
  return requireApiKey(patchIntegrations(mergeOpenApi(docs), mapping), '/tenant');
}

/**
 * Builds the per-method throttle map from the merged OpenAPI definition.
 * API Gateway MethodSettings cannot prefix-wildcard, so every operation gets
 * an explicit `{resource_path}/{HTTP_METHOD}` entry with the throttle of its
 * route family (N-5 /platform, N-6 /oauth2/token, N-7 /tenant).
 */
function methodThrottleOptions(definition: object): { [path: string]: apigateway.MethodDeploymentOptions } {
  const options: { [path: string]: apigateway.MethodDeploymentOptions } = {};
  const paths = (definition as Record<string, any>).paths ?? {};
  for (const [pathKey, pathItem] of Object.entries(paths)) {
    const family = pathKey.startsWith('/platform')
      ? THROTTLE.platform
      : pathKey.startsWith('/tenant')
        ? THROTTLE.tenant
        : pathKey.startsWith('/oauth2')
          ? THROTTLE.token
          : undefined;
    if (family === undefined) {
      continue;
    }
    for (const method of Object.keys(pathItem as Record<string, unknown>)) {
      if (!['get', 'put', 'post', 'delete', 'patch'].includes(method)) {
        continue;
      }
      options[`${pathKey}/${method.toUpperCase()}`] = {
        throttlingRateLimit: family.rateLimit,
        throttlingBurstLimit: family.burstLimit,
      };
    }
  }
  return options;
}
