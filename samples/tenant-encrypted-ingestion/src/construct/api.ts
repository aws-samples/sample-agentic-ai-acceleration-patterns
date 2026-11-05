// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The ingestion API (spec §5, ADR-0011; M-1, M-4, M-5).
 *
 * - `/tenant/*`: the TOKEN authoriser on every method, result cache 300 s
 *   (the revocation lag); with `tenantThrottle`, `apiKeySource: AUTHORIZER`,
 *   `apiKeyRequired: true` on every `/tenant/*` method and a usage plan on
 *   the stage. The handler enforces scope per route.
 * - `/platform/*`: `AWS_IAM` only. The authoriser is not attached there.
 *   `POST .../key` goes to the key factory (`keyFactoryRole`), the other
 *   platform methods to the platform function (`platformRole`).
 * - Access logs carry the verified `tenantId` (P-9); data tracing stays off
 *   (it would log the `Authorization` header).
 */

import { Duration, Names, RemovalPolicy, Validations } from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';

export const STAGE_NAME = 'v1';
export const AUTHORISER_CACHE_TTL = Duration.seconds(300);

export interface ApiProps {
  readonly authoriserFn: lambda.IFunction;
  readonly tenantFn: lambda.IFunction;
  readonly keyFactoryFn: lambda.IFunction;
  readonly platformFn: lambda.IFunction;
  readonly tenantThrottle?: { readonly rateLimit: number; readonly burstLimit: number };
  readonly usagePlanName: string;
  readonly logRetention: logs.RetentionDays;
}

export interface IngestionApi {
  readonly api: apigateway.RestApi;
  readonly accessLogs: logs.LogGroup;
  readonly usagePlan?: apigateway.UsagePlan;
}

/** A unique, deterministic name for the usage plan, found by name at run time (see roles.ts). */
export function usagePlanName(scope: Construct): string {
  return `${Names.uniqueResourceName(scope, { maxLength: 48, separator: '-' })}-tenants`;
}

export function createApi(scope: Construct, props: ApiProps): IngestionApi {
  const throttled = props.tenantThrottle !== undefined;
  const accessLogs = new logs.LogGroup(scope, 'ApiAccessLogs', { retention: props.logRetention, removalPolicy: RemovalPolicy.DESTROY });
  const api = new apigateway.RestApi(scope, 'Api', {
    restApiName: `${Names.uniqueResourceName(scope, { maxLength: 48, separator: '-' })}-ingestion`,
    description: 'tenant-encrypted-ingestion: /platform (IAM) and /tenant (token authoriser) (spec §5)',
    // The account-level API Gateway CloudWatch role is one setting per
    // account and Region, retained on destroy; the README names it as a prerequisite.
    cloudWatchRole: false,
    endpointTypes: [apigateway.EndpointType.REGIONAL],
    apiKeySourceType: throttled ? apigateway.ApiKeySourceType.AUTHORIZER : undefined,
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
          tenantId: apigateway.AccessLogField.contextAuthorizer('tenantId'),
          caller: apigateway.AccessLogField.contextIdentityUserArn(),
          latency: apigateway.AccessLogField.contextResponseLatency(),
        }),
      ),
      dataTraceEnabled: false,
      throttlingRateLimit: 100,
      throttlingBurstLimit: 200,
    },
  });

  const authorizer = new apigateway.TokenAuthorizer(scope, 'TokenAuthoriser', {
    handler: props.authoriserFn,
    identitySource: apigateway.IdentitySource.header('Authorization'),
    resultsCacheTtl: AUTHORISER_CACHE_TTL,
  });
  const tenantMethod: apigateway.MethodOptions = {
    authorizationType: apigateway.AuthorizationType.CUSTOM,
    authorizer,
    apiKeyRequired: throttled,
  };
  const iamMethod: apigateway.MethodOptions = { authorizationType: apigateway.AuthorizationType.IAM };

  const tenantIntegration = new apigateway.LambdaIntegration(props.tenantFn);
  const deliveries = api.root.addResource('tenant').addResource('deliveries');
  deliveries.addMethod('POST', tenantIntegration, tenantMethod);
  deliveries.addMethod('GET', tenantIntegration, tenantMethod);
  deliveries.addResource('{deliveryId}').addMethod('GET', tenantIntegration, tenantMethod);

  const key = api.root.addResource('platform').addResource('tenants').addResource('{tenantId}').addResource('key');
  const platformIntegration = new apigateway.LambdaIntegration(props.platformFn);
  key.addMethod('POST', new apigateway.LambdaIntegration(props.keyFactoryFn), iamMethod);
  key.addMethod('GET', platformIntegration, iamMethod);
  key.addMethod('DELETE', platformIntegration, iamMethod);
  key.addResource('rotate').addMethod('POST', platformIntegration, iamMethod);

  let usagePlan: apigateway.UsagePlan | undefined;
  if (props.tenantThrottle !== undefined) {
    usagePlan = api.addUsagePlan('TenantUsagePlan', {
      name: props.usagePlanName,
      description: 'tenant-encrypted-ingestion: one API key per tenant, value computed from the verified claim (N-8, M-5)',
      throttle: { rateLimit: props.tenantThrottle.rateLimit, burstLimit: props.tenantThrottle.burstLimit },
      apiStages: [{ api, stage: api.deploymentStage }],
    });
  }

  Validations.of(api).acknowledge({
    id: 'AwsSolutions-APIG2',
    reason: 'Request validation is the Smithy SSDK in each handler (model/ patterns, ranges, required members), so a request validator in API Gateway would duplicate it (M-3, standard §4.2).',
  });
  Validations.of(api).acknowledge({
    id: 'AwsSolutions-APIG3',
    reason: 'WAFv2 association is production hardening (README checklist): /tenant is behind the token authoriser and per-tenant limits, /platform behind IAM (M-1, M-4, M-5).',
  });
  Validations.of(api).acknowledge({
    id: 'AwsSolutions-APIG4',
    reason: '/tenant methods use the custom token authoriser and /platform methods AWS_IAM (M-1, M-4); cdk-nag reads the CUSTOM type without a Cognito pool as unauthorised.',
  });
  Validations.of(api).acknowledge({
    id: 'AwsSolutions-COG4',
    reason: 'The custom token authoriser accepts any OIDC issuer meeting the token contract, not only a Cognito pool (ADR-0011, M-1).',
  });
  Validations.of(api).acknowledge({
    id: 'AwsSolutions-APIG6',
    reason: 'Execution logging needs the account-level API Gateway CloudWatch role, an account setting the sample does not own; access logs with tenantId are on (M-27, M-28).',
  });
  return { api, accessLogs, usagePlan };
}
