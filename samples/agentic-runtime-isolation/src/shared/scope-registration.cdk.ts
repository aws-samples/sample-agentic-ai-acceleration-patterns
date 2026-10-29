// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * `ScopeRegistration` (ADR-0025): a custom resource that puts a backend's
 * scopes in tenant-identity's scope catalogue when the backend deploys and
 * removes them when it is deleted. The handler (`scope-registration.function.ts`)
 * calls `PUT` and `DELETE /platform/scopes/{scope}` on the identity API with
 * SigV4; the API URL comes from tenant-identity's published parameter
 * `/application-plane/shared/identity/apiUrl` and the function's role carries
 * the managed policy published at
 * `/application-plane/shared/identity/platformInvokePolicyArn`
 * (tenant-identity ADR-0030), read at deploy time the way the demo stack
 * reads the pool id (`AWS::SSM::Parameter::Value` template parameters). The
 * registry entry of the backend depends on this resource, so a route is
 * never live for a scope the issuer does not know.
 *
 * The policy grants `PUT|DELETE /platform/scopes/*`, `GET /platform/scopes`
 * and `PATCH /platform/tenants/*`, which is wider than this one backend's
 * names: whoever can run code as this function's role can register or
 * remove any scope and change any tenant's entitlement (threat model T-41).
 * The function runs the handler in this file's sibling and nothing else, and
 * its role holds this policy and logs only.
 */

import * as path from 'node:path';
import { CustomResource, Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { LogDrain } from './log-drain';
import { acknowledgeGranularFinding } from './nag';
import { backendScopesProblem } from './registry';

/** tenant-identity's published parameters the registration consumes (ARCHITECTURE.md §5.1, tenant-identity ADR-0017, ADR-0030). */
export const IDENTITY_API_PARAMETERS = {
  apiUrl: '/application-plane/shared/identity/apiUrl',
  platformInvokePolicyArn: '/application-plane/shared/identity/platformInvokePolicyArn',
} as const;

/**
 * Where the identity API is. Unset, both values are read from the published
 * parameters at deploy time. A build that must synthesise without an account
 * passes placeholders (the demo stack's `identityParameterPlaceholders`).
 */
export interface IdentityApiProps {
  /** tenant-identity's API base URL. Default: the `apiUrl` parameter. */
  readonly apiUrl?: string;
  /** The managed policy that may call `/platform/*`. Default: the `platformInvokePolicyArn` parameter. */
  readonly platformInvokePolicyArn?: string;
}

export interface ScopeRegistrationProps {
  /** The backend name; every scope is `<backend>/<action>`. */
  readonly backend: string;
  /** The scopes to register: at least one, no duplicates, each owned by `backend`. */
  readonly scopes: string[];
  readonly identityApi?: IdentityApiProps;
  /**
   * The log drain (ADR-0019) that holds back this function's log group until
   * the custom resource is gone and its last lines have landed.
   */
  readonly logDrain?: LogDrain;
}

export class ScopeRegistration extends Construct {
  /** The custom resource, for dependencies: the registry entry is written after it. */
  readonly resource: CustomResource;
  /** The handler's log group, for a drain added after construction. */
  readonly logGroup: logs.ILogGroup;
  /** The function's role: the published `PlatformInvokePolicy` plus logs. */
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

    // Deploy-time reads of tenant-identity's published values (ADR-0004
    // mechanism). `valueForStringParameter` is one template parameter per
    // name per stack, so several backends in one stack share the two reads.
    const apiUrl = props.identityApi?.apiUrl ?? ssm.StringParameter.valueForStringParameter(this, IDENTITY_API_PARAMETERS.apiUrl);
    const policyArn =
      props.identityApi?.platformInvokePolicyArn ??
      ssm.StringParameter.valueForStringParameter(this, IDENTITY_API_PARAMETERS.platformInvokePolicyArn);

    // Explicit, deletable log group (ADR-0019). The handler writes nothing on
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
      // One signed call per scope, each a few hundred milliseconds.
      timeout: Duration.seconds(60),
      logGroup,
      loggingFormat: lambda.LoggingFormat.JSON,
      systemLogLevelV2: lambda.SystemLogLevel.WARN,
      applicationLogLevelV2: lambda.ApplicationLogLevel.ERROR,
      description: `runtime-isolation: registers backend ${props.backend}'s scopes with tenant-identity; removes them on delete (ADR-0025)`,
      bundling: { minify: true, sourceMap: false, externalModules: [] },
    });
    this.role = fn.role!;
    // The published PlatformInvokePolicy (tenant-identity ADR-0030): the
    // only way into `/platform/*`. Wider than one backend's names; T-41.
    fn.role!.addManagedPolicy(iam.ManagedPolicy.fromManagedPolicyArn(this, 'PlatformInvokePolicy', policyArn));
    acknowledgeGranularFinding(
      fn,
      'AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]',
      'AWSLambdaBasicExecutionRole is the logs-only managed policy NodejsFunction attaches; a scoped replacement adds boilerplate for no change in access (ADR-0014).',
    );

    this.resource = new CustomResource(this, 'Resource', {
      serviceToken: fn.functionArn,
      resourceType: 'Custom::RuntimeIsolationScopeRegistration',
      properties: {
        ApiUrl: apiUrl,
        Backend: props.backend,
        Scopes: this.scopes,
      },
    });
    // The policy must be attached before the first call, and detached only after the last.
    this.resource.node.addDependency(fn.role!);

    // ADR-0019: the custom resource (whose Delete invokes the function) goes
    // before the drain waits, and the log group only after.
    if (props.logDrain !== undefined) {
      props.logDrain.writer(this.resource);
      props.logDrain.protect(logGroup);
    }
  }
}
