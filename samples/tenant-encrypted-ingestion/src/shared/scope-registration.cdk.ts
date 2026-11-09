// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * `ScopeRegistration`, copied from agentic-runtime-isolation (its ADR-0025),
 * not imported (ADR-0015). ADR numbers below are this sample's unless they
 * name tenant-identity; T- and M- numbers are this sample's threat model.
 * Here it registers `ingestion/deliver` and `ingestion/read` (spec §3.2,
 * §6.4). It is a custom resource that puts a backend's
 * scopes in tenant-identity's scope catalogue when the backend deploys and
 * removes them when it is deleted. The handler (`scope-registration.function.ts`)
 * calls `PUT` and `DELETE /platform/scopes/{scope}` on the identity API with
 * SigV4. The API URL and the managed policy the function's role carries
 * (tenant-identity ADR-0030) are props: this copy reads no parameter itself,
 * so the construct that uses it stays producer-agnostic (ADR-0019, standard
 * §1.1); the demo stack reads tenant-identity's published parameters and
 * passes them in. The registry entry of the backend depends on this
 * resource, so a route is never live for a scope the issuer does not know. Each scope's description
 * is an owner marker (the handler's default, or the `owner` prop) that a
 * second registration of the same name is checked against.
 *
 * The policy grants `PUT|GET|DELETE /platform/scopes*` and the tenant routes
 * (`POST /platform/tenants`, `GET|PATCH|DELETE /platform/tenants/{id}`,
 * `POST /platform/tenants/{id}/users`), and, for tenant-identity's
 * control-plane mount (its ADR-0033), `kms:Encrypt` and `kms:GenerateDataKey`
 * on its admin-password key under `kms:ViaService = ssm.<region>.amazonaws.com`.
 * That KMS grant is inert here: the function calls no SSM API, holds no
 * `ssm:PutParameter`, and the condition only lets SSM use the key on the
 * role's behalf. The role carries an inline Deny on `execute-api:Invoke` for
 * every `/platform/tenants*` route, so what it can reach is the catalogue
 * alone; that is still wider than this one backend's names: whoever can run
 * code as this function's role can register or remove any scope (T-38,
 * mitigated by M-34). The handler also refuses an `ApiUrl` whose host is not
 * `<api>.execute-api.<AWS_REGION>.amazonaws.com`, so the role's signature is
 * never sent to a host of a direct invoker's choosing. The function runs the
 * handler in this file's sibling and nothing else, and its role holds this
 * policy, the Deny and logs only.
 */

import * as path from 'node:path';
import { CustomResource, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { LogDrain } from './log-drain';
import { acknowledgeGranularFinding } from './nag';
import { backendScopesProblem } from './scopes';

/**
 * The execute-api ARN pattern of every `/platform/tenants*` route on any API
 * in this account and Region (`<api>/<stage>/<method>/platform/tenants` and
 * everything under it): the part of `PlatformInvokePolicy` the registration
 * role is denied (T-38, M-34).
 */
export function platformTenantRoutesArn(scope: Construct): string {
  return Stack.of(scope).formatArn({ service: 'execute-api', resource: '*', resourceName: '*/*/platform/tenants*' });
}

/**
 * Where the scope-catalogue API is (ADR-0019). Both values are required; the
 * demo stack reads them from tenant-identity's published parameters, and a
 * build that must synthesise without an account passes placeholders (the
 * demo stack's `identityParameterPlaceholders`).
 */
export interface IdentityApiProps {
  /** Base URL of the API that serves `PUT|GET|DELETE /platform/scopes/{scope}`. */
  readonly apiUrl: string;
  /** The managed policy that may call `/platform/scopes*` on it. */
  readonly platformInvokePolicyArn: string;
}

export interface ScopeRegistrationProps {
  /** The backend name; every scope is `<backend>/<action>`. */
  readonly backend: string;
  /** The scopes to register: at least one, no duplicates, each owned by `backend`. */
  readonly scopes: string[];
  readonly identityApi: IdentityApiProps;
  /**
   * The owner marker written as each scope's description and compared on
   * Create, Update and Delete. Unset: the handler uses
   * `<StackId>#<LogicalResourceId>`, which is unique to this resource.
   * Resources that pass the same value co-own the names (`AgentBackend.scopeOwner`).
   */
  readonly owner?: string;
  /**
   * The log drain (ADR-0015) that holds back this function's log group until
   * the custom resource is gone and its last lines have landed.
   */
  readonly logDrain?: LogDrain;
}

export class ScopeRegistration extends Construct {
  /** The custom resource, for dependencies: the registry entry is written after it. */
  readonly resource: CustomResource;
  /** The handler's log group, for a drain added after construction. */
  readonly logGroup: logs.ILogGroup;
  /** The function's role: the published `PlatformInvokePolicy`, an inline Deny on every `/platform/tenants*` route, and logs. */
  readonly role: iam.IRole;
  /** The scopes registered. */
  readonly scopes: readonly string[];

  constructor(scope: Construct, id: string, props: ScopeRegistrationProps) {
    super(scope, id);
    const problem = backendScopesProblem(props.backend, props.scopes);
    if (problem !== undefined) {
      throw new Error(`ScopeRegistration: scopes ${problem}`);
    }
    this.scopes = [...props.scopes];

    const { apiUrl, platformInvokePolicyArn: policyArn } = props.identityApi;

    // Explicit, deletable log group (ADR-0015). The handler writes nothing on
    // success and Lambda's own START/END/REPORT lines are below WARN.
    const logGroup = new logs.LogGroup(this, 'Logs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY, // sample only
    });
    this.logGroup = logGroup;
    const fn = new NodejsFunction(this, 'Function', {
      entry: path.join(__dirname, 'scope-registration.function.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      // Two signed calls per scope (GET, then PUT or DELETE), each a few
      // hundred milliseconds, bounded at 10 s per attempt with one retry; the
      // handler answers FAILED 2 s before this deadline rather than let
      // Lambda kill it unanswered.
      timeout: Duration.seconds(60),
      logGroup,
      loggingFormat: lambda.LoggingFormat.JSON,
      systemLogLevelV2: lambda.SystemLogLevel.WARN,
      applicationLogLevelV2: lambda.ApplicationLogLevel.ERROR,
      description: `tenant-encrypted-ingestion: registers ${props.backend}/* scopes with tenant-identity; removes them on delete (spec §3.2)`,
      bundling: { minify: true, sourceMap: false, externalModules: [] },
    });
    this.role = fn.role!;
    // The published PlatformInvokePolicy (tenant-identity ADR-0030): the
    // only way into `/platform/*`. Wider than one backend's names; T-38.
    fn.role!.addManagedPolicy(iam.ManagedPolicy.fromManagedPolicyArn(this, 'PlatformInvokePolicy', policyArn));
    // The policy also grants the tenant routes (`POST /platform/tenants`,
    // `GET|PATCH|DELETE /platform/tenants/*`, `POST /platform/tenants/*/users`),
    // which this function never calls and which reach tenant data (CreateUser
    // returns a temporary password). An explicit Deny on that route family
    // wins over the managed Allow, so the role keeps `/platform/scopes*`
    // alone (M-34; tenant-identity's T-34 expects each holder to do this).
    fn.role!.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'DenyPlatformTenantRoutes',
        effect: iam.Effect.DENY,
        actions: ['execute-api:Invoke'],
        resources: [platformTenantRoutesArn(this)],
      }),
    );
    acknowledgeGranularFinding(
      fn,
      'AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]',
      'AWSLambdaBasicExecutionRole is the logs-only managed policy NodejsFunction attaches; a scoped replacement adds boilerplate for no change in access (M-31, ADR-0015).',
    );

    this.resource = new CustomResource(this, 'Resource', {
      serviceToken: fn.functionArn,
      resourceType: 'Custom::IngestionScopeRegistration',
      properties: {
        ApiUrl: apiUrl,
        Backend: props.backend,
        Scopes: this.scopes,
        // Omitted when unset: the handler then derives the marker from the event.
        ...(props.owner === undefined ? {} : { Owner: props.owner }),
      },
    });
    // The policy must be attached before the first call, and detached only after the last.
    this.resource.node.addDependency(fn.role!);

    // ADR-0015: the custom resource (whose Delete invokes the function) goes
    // before the drain waits, and the log group only after.
    if (props.logDrain !== undefined) {
      props.logDrain.writer(this.resource);
      props.logDrain.protect(logGroup);
    }
  }
}
