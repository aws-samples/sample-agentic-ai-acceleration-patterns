// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The REST API (spec §3.1, §3.2, §5): every method `AWS_IAM`.
 *
 * - Resource policy: `POST /usage-events` admits any account's principal
 *   whose `aws:PrincipalArn` matches `<fleet>-ue-*`; every other route admits
 *   only the principals listed for it (src/api/routes.ts). Each allow has a
 *   matching explicit deny, so an identity-policy allow in the metering
 *   account does not open a route either.
 * - Throttling: a stage limit, a method limit on `POST /usage-events` below
 *   it, and a method limit on the admin routes, so an ingest flood cannot
 *   take the headroom of the control plane's `PRE` hooks.
 * - Access logs carry the caller ARN, the request id and the route, kept
 *   for `rawRetentionDays` (spec §3.5, Audit). Data tracing stays off.
 */

import { RemovalPolicy, Validations } from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';
import { ADMIN_ROUTES, type CallerClass, INGEST_ROUTE, policyPath, type Route } from '../api/routes';

export const STAGE_NAME = 'v1';

/** Requests per second (spec §3.2). */
export const THROTTLE = {
  stage: { rate: 1000, burst: 2000 },
  ingest: { rate: 600, burst: 1200 },
  admin: { rate: 50, burst: 100 },
};

export interface ApiProps {
  readonly name: string;
  readonly ingestFn: lambda.IFunction;
  readonly adminFn: lambda.IFunction;
  readonly emitterRolePattern: string;
  readonly callers: Record<CallerClass, ReadonlyArray<string>>;
  readonly logRetentionDays: number;
}

export interface MeteringApi {
  readonly api: apigateway.RestApi;
  readonly accessLogs: logs.LogGroup;
}

/** The nearest CloudWatch Logs retention at or above `days`. */
export function retentionAtLeast(days: number): logs.RetentionDays {
  const values = Object.values(logs.RetentionDays)
    .filter((value): value is number => typeof value === 'number' && value > 0)
    .sort((a, b) => a - b);
  return (values.find((value) => value >= days) ?? logs.RetentionDays.INFINITE) as logs.RetentionDays;
}

function routeResource(route: Route): string {
  return `execute-api:/*/${policyPath(route)}`;
}

function routePolicy(props: ApiProps): iam.PolicyDocument {
  const statements: iam.PolicyStatement[] = [
    new iam.PolicyStatement({
      sid: 'AllowRegisteredEmitterShapedRoles',
      principals: [new iam.AnyPrincipal()],
      actions: ['execute-api:Invoke'],
      resources: [routeResource(INGEST_ROUTE)],
      conditions: { ArnLike: { 'aws:PrincipalArn': props.emitterRolePattern } },
    }),
    new iam.PolicyStatement({
      sid: 'DenyIngestToOtherPrincipals',
      effect: iam.Effect.DENY,
      principals: [new iam.AnyPrincipal()],
      actions: ['execute-api:Invoke'],
      resources: [routeResource(INGEST_ROUTE)],
      conditions: { ArnNotLike: { 'aws:PrincipalArn': props.emitterRolePattern } },
    }),
  ];
  // One allow and one deny per distinct caller set.
  const groups = new Map<string, Route[]>();
  for (const route of ADMIN_ROUTES) {
    const key = [...route.callers].sort().join(',');
    groups.set(key, [...(groups.get(key) ?? []), route]);
  }
  for (const [key, routes] of groups) {
    const principals = key.split(',').flatMap((cls) => props.callers[cls as CallerClass]);
    const resources = routes.map(routeResource);
    const sid = key
      .replace(/[^a-z]/g, ' ')
      .split(' ')
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join('');
    if (principals.length > 0) {
      statements.push(
        new iam.PolicyStatement({
          sid: `Allow${sid}Routes`,
          principals: [new iam.AnyPrincipal()],
          actions: ['execute-api:Invoke'],
          resources,
          conditions: { ArnEquals: { 'aws:PrincipalArn': principals } },
        }),
        new iam.PolicyStatement({
          sid: `Deny${sid}RoutesToOthers`,
          effect: iam.Effect.DENY,
          principals: [new iam.AnyPrincipal()],
          actions: ['execute-api:Invoke'],
          resources,
          conditions: { ArnNotEquals: { 'aws:PrincipalArn': principals } },
        }),
      );
    } else {
      statements.push(
        new iam.PolicyStatement({
          sid: `Deny${sid}Routes`,
          effect: iam.Effect.DENY,
          principals: [new iam.AnyPrincipal()],
          actions: ['execute-api:Invoke'],
          resources,
        }),
      );
    }
  }
  return new iam.PolicyDocument({ statements });
}

export function createApi(scope: Construct, props: ApiProps): MeteringApi {
  const accessLogs = new logs.LogGroup(scope, 'ApiAccessLogs', {
    retention: retentionAtLeast(props.logRetentionDays),
    removalPolicy: RemovalPolicy.DESTROY, // sample only
  });
  const ingestPath = `${INGEST_ROUTE.path}/${INGEST_ROUTE.method}`;
  const api = new apigateway.RestApi(scope, 'Api', {
    restApiName: props.name,
    description: 'tenant-usage-metering: ingest door and admin API, IAM-authorised (spec §5)',
    cloudWatchRole: false,
    endpointTypes: [apigateway.EndpointType.REGIONAL],
    policy: routePolicy(props),
    deployOptions: {
      stageName: STAGE_NAME,
      accessLogDestination: new apigateway.LogGroupLogDestination(accessLogs),
      accessLogFormat: apigateway.AccessLogFormat.custom(
        JSON.stringify({
          requestId: apigateway.AccessLogField.contextRequestId(),
          requestTime: apigateway.AccessLogField.contextRequestTime(),
          httpMethod: apigateway.AccessLogField.contextHttpMethod(),
          resourcePath: apigateway.AccessLogField.contextResourcePath(),
          status: apigateway.AccessLogField.contextStatus(),
          caller: apigateway.AccessLogField.contextIdentityUserArn(),
          latency: apigateway.AccessLogField.contextResponseLatency(),
        }),
      ),
      dataTraceEnabled: false,
      throttlingRateLimit: THROTTLE.stage.rate,
      throttlingBurstLimit: THROTTLE.stage.burst,
      methodOptions: {
        '/*/*': { throttlingRateLimit: THROTTLE.admin.rate, throttlingBurstLimit: THROTTLE.admin.burst },
        [ingestPath]: { throttlingRateLimit: THROTTLE.ingest.rate, throttlingBurstLimit: THROTTLE.ingest.burst },
      },
    },
  });

  const iamMethod: apigateway.MethodOptions = { authorizationType: apigateway.AuthorizationType.IAM };
  const resources = new Map<string, apigateway.IResource>([['', api.root]]);
  const resourceFor = (path: string): apigateway.IResource => {
    let current: apigateway.IResource = api.root;
    let walked = '';
    for (const part of path.split('/').filter((segment) => segment.length > 0)) {
      walked += `/${part}`;
      const found = resources.get(walked);
      current = found ?? current.addResource(part);
      resources.set(walked, current);
    }
    return current;
  };
  resourceFor(INGEST_ROUTE.path).addMethod(
    INGEST_ROUTE.method,
    new apigateway.LambdaIntegration(props.ingestFn, { allowTestInvoke: false }),
    iamMethod,
  );
  // One permission for the whole API: a permission per method (29, and as
  // many test permissions) overflows the function's 20 KB resource policy
  // (test account, 2026-11-18). The function checks the route itself (src/api/handler.ts).
  const admin = new apigateway.LambdaIntegration(props.adminFn, { allowTestInvoke: false, scopePermissionToMethod: false });
  for (const route of ADMIN_ROUTES) {
    resourceFor(route.path).addMethod(route.method, admin, iamMethod);
  }

  Validations.of(api).acknowledge({
    id: 'AwsSolutions-APIG2',
    reason:
      'Request validation is the Smithy SSDK in each function (model patterns, ranges, required members); the ingest function checks each event alone (spec §4.8).',
  });
  Validations.of(api).acknowledge({
    id: 'AwsSolutions-APIG3',
    reason:
      'WAFv2 is production hardening (README checklist): every method is AWS_IAM behind a resource policy with explicit denies, and the routes have method throttles (spec §3.2).',
  });
  Validations.of(api).acknowledge({
    id: 'AwsSolutions-APIG6',
    reason:
      'Execution logging needs the account-level API Gateway CloudWatch role, an account setting the sample does not own; access logs with the caller ARN are on (spec §3.5).',
  });
  Validations.of(api).acknowledge({
    id: 'AwsSolutions-COG4',
    reason: 'Every method is AWS_IAM: emitters, the control plane hook and operators sign with SigV4 (spec §3.2); there is no user pool.',
  });
  return { api, accessLogs };
}
