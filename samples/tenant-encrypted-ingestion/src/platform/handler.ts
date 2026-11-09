// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The platform API's two Lambda entry points (spec §5.1, M-4), one Smithy
 * service behind both:
 *
 * - `factoryHandler` runs under `keyFactoryRole` and serves
 *   `POST /platform/tenants/{tenantId}/key` (`CreateTenantKey`) only.
 * - `platformHandler` runs under `platformRole` and serves `GetTenantKey`,
 *   `RotateTenantKey` and `DeleteTenantKey`.
 *
 * API Gateway routes each method to its function (src/construct/api.ts),
 * and each function refuses the operations that belong to the other, so a
 * misrouted request cannot run key creation under `platformRole` or the
 * reverse. `/platform/*` is IAM-authorised; the caller ARN is not needed.
 */

import { APIGatewayClient } from '@aws-sdk/client-api-gateway';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { KMSClient } from '@aws-sdk/client-kms';
import { S3Client } from '@aws-sdk/client-s3';
import { STSClient } from '@aws-sdk/client-sts';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { convertEvent, convertVersion1Response } from '@smithy/server-apigateway';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context as LambdaContext } from 'aws-lambda';
import { arnParts, type PlatformConfig, type PlatformDependencies, type TenantPlatformClients } from './common';
import { createTenantKey } from './create-tenant-key';
import { deleteTenantKey } from './delete-tenant-key';
import { getTenantKey } from './get-tenant-key';
import { rotateTenantKey } from './rotate-tenant-key';
import { apiError, ApiError, normaliseErrorResponse } from '../api/errors';
import { boolEnv, ENV, requireEnv, requireIntEnv } from '../shared/constants';
import { errorName, log } from '../shared/logger';
import { TenantClients, type TenantCredentials, TenantSessions } from '../shared/tenant-session';
import { getIngestionPlatformServiceServiceHandler, type IngestionPlatformServiceService } from '../smithy/platform/typescript-ssdk-codegen/src/server';

export type PlatformRole = 'keyFactory' | 'platform';

export interface PlatformContext {
  readonly requestId: string;
}

function wrongFunction(): never {
  throw apiError.internal('operation routed to the wrong function');
}

/**
 * Runs an operation; an error that is not a modelled `ApiError` becomes the
 * SSDK's 500 with no cause in the response, so it is logged here first.
 * Only its type reaches the log: the logger drops `errorMessage`, which is
 * not in `LOG_FIELD_ALLOWLIST`, so no request body, key value or message
 * text is written (ADR-0025). The 2026-11-06 integration run hit API
 * Gateway control-plane throttling and the log showed only the 500.
 */
async function guarded<T>(operation: string, tenantId: string | undefined, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof ApiError)) {
      log.error('platform operation failed', { operation, tenantId, errorType: errorName(error), errorMessage: error instanceof Error ? error.message : String(error) });
    }
    throw error;
  }
}

export function createPlatformService(role: PlatformRole, deps: PlatformDependencies): IngestionPlatformServiceService<PlatformContext> {
  return {
    CreateTenantKey: async (input) =>
      guarded('CreateTenantKey', input.tenantId, async () => {
        if (role !== 'keyFactory') {
          wrongFunction();
        }
        return { key: await createTenantKey(deps, { tenantId: input.tenantId!, tier: input.tier as 'vendor-key' | 'tenant-key', keyArn: input.keyArn }) };
      }),
    GetTenantKey: async (input) =>
      guarded('GetTenantKey', input.tenantId, async () => {
        if (role !== 'platform') {
          wrongFunction();
        }
        return { key: await getTenantKey(deps, input.tenantId!) };
      }),
    RotateTenantKey: async (input) =>
      guarded('RotateTenantKey', input.tenantId, async () => {
        if (role !== 'platform') {
          wrongFunction();
        }
        return rotateTenantKey(deps, input.tenantId!);
      }),
    DeleteTenantKey: async (input) =>
      guarded('DeleteTenantKey', input.tenantId, async () => {
        if (role !== 'platform') {
          wrongFunction();
        }
        return deleteTenantKey(deps, input.tenantId!);
      }),
  };
}

export function createHandler(service: IngestionPlatformServiceService<PlatformContext>) {
  const serviceHandler = getIngestionPlatformServiceServiceHandler<PlatformContext>(service);
  return async (event: APIGatewayProxyEvent, lambdaContext?: Pick<LambdaContext, 'awsRequestId'>): Promise<APIGatewayProxyResult> => {
    const requestId = event.requestContext?.requestId ?? lambdaContext?.awsRequestId ?? 'unknown';
    const tenantId = typeof event.pathParameters?.tenantId === 'string' ? event.pathParameters.tenantId : undefined;
    try {
      const response = convertVersion1Response(await serviceHandler.handle(convertEvent(event), { requestId }));
      if (response.statusCode >= 500) {
        log.error('platform request failed', { tenantId, httpStatus: response.statusCode, requestId });
      }
      return normaliseErrorResponse(response, requestId);
    } catch (error) {
      log.error('platform request failed', { tenantId, errorType: errorName(error), requestId });
      return normaliseErrorResponse({ statusCode: 500, body: '{}' }, requestId);
    }
  };
}

export function platformConfigFromEnv(): PlatformConfig {
  const platformRoleArn = requireEnv(ENV.platformRoleArn);
  const { partition, account } = arnParts(platformRoleArn);
  const consumers = process.env[ENV.consumerRoleArns] ?? '';
  return {
    tableName: requireEnv(ENV.tableName),
    bucketName: requireEnv(ENV.bucketName),
    partition,
    account,
    region: requireEnv('AWS_REGION'),
    tenantRoleArns: {
      upload: requireEnv(ENV.tenantUploadRoleArn),
      process: requireEnv(ENV.tenantProcessRoleArn),
      platform: requireEnv(ENV.tenantPlatformRoleArn),
    },
    consumerRoleArns: consumers.split(',').filter((s) => s.length > 0),
    platformRoleArn,
    keyFactoryRoleArn: requireEnv(ENV.keyFactoryRoleArn),
    allowTenantKeys: boolEnv(ENV.allowTenantKeys),
    keyRotation: boolEnv(ENV.keyRotation),
    keyDeletionWindowDays: requireIntEnv(ENV.keyDeletionWindowDays),
    tenantThrottle: boolEnv(ENV.tenantThrottle),
    usagePlanName: process.env[ENV.usagePlanName],
    stackId: requireEnv(ENV.stackId),
  };
}

export function platformDependenciesFromEnv(): PlatformDependencies {
  const config = platformConfigFromEnv();
  const region = config.region;
  const sessions = new TenantSessions(new STSClient({}), config.tenantRoleArns.platform);
  return {
    config,
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } }),
    kms: new KMSClient({}),
    apiGateway: config.tenantThrottle ? new APIGatewayClient({}) : undefined,
    tenant: new TenantClients<TenantPlatformClients>(sessions, (credentials: TenantCredentials) => ({
      s3: new S3Client({ region, credentials }),
      kms: new KMSClient({ region, credentials }),
    })),
  };
}

let factory: ReturnType<typeof createHandler> | undefined;
let platform: ReturnType<typeof createHandler> | undefined;

export async function factoryHandler(event: APIGatewayProxyEvent, context: LambdaContext): Promise<APIGatewayProxyResult> {
  factory ??= createHandler(createPlatformService('keyFactory', platformDependenciesFromEnv()));
  return factory(event, context);
}

export async function platformHandler(event: APIGatewayProxyEvent, context: LambdaContext): Promise<APIGatewayProxyResult> {
  platform ??= createHandler(createPlatformService('platform', platformDependenciesFromEnv()));
  return platform(event, context);
}
