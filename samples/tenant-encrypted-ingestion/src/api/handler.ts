// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The tenant API (spec §5.2, ADR-0006, ADR-0011; M-2, M-3, M-5, M-6):
 * `CreateDelivery`, `GetDelivery`, `ListDeliveries` behind the token
 * authoriser, dispatched by the Smithy SSDK.
 *
 * - The tenant comes only from `requestContext.authorizer.tenantId`, which
 *   the authoriser took from the verified claim (spec §7.6). Every registry
 *   key is `TENANT#<caller>`, so another tenant's `deliveryId` is a 404.
 * - Scope is enforced here, per route: `ingestion/deliver` for
 *   `CreateDelivery`, `ingestion/read` for the reads (M-2). The authoriser's
 *   Allow is cached per token across routes, so it cannot do this.
 * - Every registry and S3 call runs under a `tenantUploadRole` session for
 *   the caller's tenant (`apiRole` can assume nothing else), whose identity
 *   policy reaches only that tenant's partition and `ingest/<tenant>/*`.
 * - `CreateDelivery` creates its row with `UpdateItem` and
 *   `attribute_not_exists(PK)` and increments `inFlight` in the same
 *   transaction, conditioned on `inFlight < maxInFlightPerTenant`: a full
 *   tenant is a 429 (N-8). The key row's status is read, not conditioned
 *   on: `keyStatus` is a protected name the role may not put in a request.
 * - The presigned PUT signs the six §7.5 headers (src/shared/presign.ts).
 *   `expiresAt = min(now + TTL, credentials.Expiration)`, and the cached
 *   session must have TTL + 60 s left (src/shared/tenant-session.ts).
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { STSClient } from '@aws-sdk/client-sts';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { convertEvent, convertVersion1Response } from '@smithy/server-apigateway';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context as LambdaContext } from 'aws-lambda';
import { ulid } from 'ulid';
import { apiError, ApiError, normaliseErrorResponse } from './errors';
import { ENV, requireEnv, requireIntEnv, SCOPES } from '../shared/constants';
import { cancellationCodes } from '../shared/errors';
import { errorName, log } from '../shared/logger';
import { presignUpload } from '../shared/presign';
import {
  deliveryRowKey,
  type DeliveryRow,
  deliveryOfSk,
  isoNow,
  type KeyRow,
  keyRowKey,
  STATUS_BUCKET,
  tenantPk,
  transactUpdate,
  UPLOAD_ROLE_ATTRIBUTES,
} from '../shared/registry';
import { dropKey, isTenantId } from '../shared/tenant-id';
import { TenantClients, type TenantCredentials, TenantSessions } from '../shared/tenant-session';
import type { DeliverySummary } from '../smithy/tenant/typescript-ssdk-codegen/src';
import { getIngestionTenantServiceServiceHandler, type IngestionTenantServiceService } from '../smithy/tenant/typescript-ssdk-codegen/src/server';

/** The SSDK context: the verified caller, never anything from the request body. */
export interface TenantContext {
  readonly tenantId: string;
  readonly sub: string;
  readonly scopes: readonly string[];
  readonly requestId: string;
}

export interface TenantApiConfig {
  readonly tableName: string;
  readonly bucketName: string;
  readonly allowedContentTypes: readonly string[];
  readonly maxObjectSizeBytes: number;
  readonly uploadUrlTtlSeconds: number;
  readonly maxInFlightPerTenant: number;
}

export interface TenantClientsPair {
  readonly ddb: DynamoDBDocumentClient;
  readonly s3: S3Client;
}

export interface TenantApiDependencies {
  readonly config: TenantApiConfig;
  /** Clients under a `tenantUploadRole` session for one tenant. */
  readonly clients: TenantClients<TenantClientsPair>;
  readonly now?: () => number;
  readonly newId?: () => string;
}

export const FILE_NAME_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const LIST_PAGE_SIZE = 50;

function requireScope(context: TenantContext, scope: string): void {
  if (!context.scopes.includes(scope)) {
    throw apiError.forbidden(`the token lacks the ${scope} scope`);
  }
}

function summary(tenantDeliveryId: string, row: DeliveryRow): DeliverySummary {
  return {
    deliveryId: tenantDeliveryId,
    fileName: row.fileName,
    contentType: row.declaredContentType,
    sizeBytes: row.declaredSizeBytes,
    status: row.status,
    reason: row.reason,
    reasonMessage: row.reasonMessage,
    landedKey: row.landedKey,
    sha256: row.sha256,
    validators: row.validators?.map((v) => ({ validator: v.validator, verdict: v.verdict, code: v.code, durationMs: v.durationMs })),
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
}

function encodeToken(key: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(key)).toString('base64url');
}

function decodeToken(token: string, tenantId: string): Record<string, unknown> {
  try {
    const key = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (key.PK === tenantPk(tenantId) && deliveryOfSk(key.SK) !== undefined && Object.keys(key).length === 2) {
      return key;
    }
  } catch {
    // fall through
  }
  throw apiError.validation('nextToken is not valid');
}

export function createTenantApi(deps: TenantApiDependencies): IngestionTenantServiceService<TenantContext> {
  const { config } = deps;
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? ulid;

  return {
    CreateDelivery: async (input, context) => {
      requireScope(context, SCOPES.deliver);
      const { fileName, contentType, sizeBytes } = input;
      if (fileName === undefined || !FILE_NAME_PATTERN.test(fileName)) {
        throw apiError.validation('fileName must match [A-Za-z0-9._-]{1,128}');
      }
      if (contentType === undefined || !config.allowedContentTypes.includes(contentType)) {
        throw apiError.validation('contentType is not accepted by this deployment');
      }
      if (sizeBytes === undefined || !Number.isInteger(sizeBytes) || sizeBytes < 1) {
        throw apiError.validation('sizeBytes must be a positive integer');
      }
      if (sizeBytes > config.maxObjectSizeBytes) {
        throw apiError.validation(`sizeBytes exceeds the limit of ${config.maxObjectSizeBytes}`);
      }

      const tenantId = context.tenantId;
      const deliveryId = newId();
      const { client, credentials } = await deps.clients.client(tenantId, deliveryId, (config.uploadUrlTtlSeconds + 60) * 1000);

      const keyRow = (await client.ddb.send(new GetCommand({ TableName: config.tableName, Key: keyRowKey(tenantId), ConsistentRead: true })))
        .Item as KeyRow | undefined;
      if (keyRow === undefined || keyRow.keyStatus !== 'ACTIVE') {
        throw apiError.tenantKeyUnavailable('the tenant has no usable key');
      }

      const at = now();
      const expiresAtMs = Math.min(at + config.uploadUrlTtlSeconds * 1000, credentials.expiration.getTime());
      const objectKey = dropKey(tenantId, deliveryId);
      const iso = isoNow(at);
      try {
        await client.ddb.send(
          new TransactWriteCommand({
            TransactItems: [
              transactUpdate(
                config.tableName,
                deliveryRowKey(tenantId, deliveryId),
                {
                  set: {
                    objectKey,
                    fileName,
                    declaredContentType: contentType,
                    declaredSizeBytes: sizeBytes,
                    status: 'AWAITING_UPLOAD',
                    statusBucket: STATUS_BUCKET.open,
                    urlExpiresAt: Math.floor(expiresAtMs / 1000),
                    createdBy: context.sub,
                    createdAt: iso,
                    updatedAt: iso,
                  },
                  condition: 'attribute_not_exists(#PK)',
                },
                UPLOAD_ROLE_ATTRIBUTES,
              ),
              transactUpdate(
                config.tableName,
                keyRowKey(tenantId),
                {
                  add: { inFlight: 1 },
                  set: { updatedAt: iso },
                  condition: 'attribute_exists(#PK) AND (attribute_not_exists(#inFlight) OR #inFlight < :max)',
                  values: { ':max': config.maxInFlightPerTenant },
                },
                UPLOAD_ROLE_ATTRIBUTES,
              ),
            ],
          }),
        );
      } catch (error) {
        const codes = cancellationCodes(error);
        if (codes?.[1] === 'ConditionalCheckFailed') {
          log.warn('delivery refused', { tenantId, operation: 'CreateDelivery', reason: 'TooManyDeliveries' });
          throw apiError.tooManyDeliveries('the tenant has the maximum number of open deliveries');
        }
        throw error;
      }

      const upload = await presignUpload(client.s3, {
        bucket: config.bucketName,
        key: objectKey,
        keyArn: keyRow.keyArn,
        contentType,
        sizeBytes,
        expiresInSeconds: Math.max(1, Math.floor((expiresAtMs - at) / 1000)),
      });
      log.info('delivery created', { tenantId, deliveryId, operation: 'CreateDelivery', sizeBytes });
      return { deliveryId, uploadUrl: upload.url, headers: upload.headers, expiresAt: new Date(expiresAtMs) };
    },

    GetDelivery: async (input, context) => {
      requireScope(context, SCOPES.read);
      const tenantId = context.tenantId;
      const deliveryId = input.deliveryId ?? '';
      const { client } = await deps.clients.client(tenantId, 'GetDelivery', 60_000);
      const row = (
        await client.ddb.send(new GetCommand({ TableName: config.tableName, Key: deliveryRowKey(tenantId, deliveryId), ConsistentRead: true }))
      ).Item as DeliveryRow | undefined;
      if (row === undefined) {
        throw apiError.notFound('delivery not found');
      }
      return { delivery: summary(deliveryId, row) };
    },

    ListDeliveries: async (input, context) => {
      requireScope(context, SCOPES.read);
      const tenantId = context.tenantId;
      const startKey = input.nextToken === undefined ? undefined : decodeToken(input.nextToken, tenantId);
      const { client } = await deps.clients.client(tenantId, 'ListDeliveries', 60_000);
      const names: Record<string, string> = { '#PK': 'PK', '#SK': 'SK' };
      const values: Record<string, unknown> = { ':pk': tenantPk(tenantId), ':prefix': 'DELIVERY#' };
      let filter: string | undefined;
      if (input.status !== undefined) {
        names['#status'] = 'status';
        values[':status'] = input.status;
        filter = '#status = :status';
      }
      const page = await client.ddb.send(
        new QueryCommand({
          TableName: config.tableName,
          KeyConditionExpression: '#PK = :pk AND begins_with(#SK, :prefix)',
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
          FilterExpression: filter,
          ScanIndexForward: false,
          Limit: LIST_PAGE_SIZE,
          ExclusiveStartKey: startKey,
        }),
      );
      const deliveries = (page.Items ?? []).map((item) => summary(deliveryOfSk(item.SK) ?? '', item as DeliveryRow));
      return {
        deliveries,
        nextToken: page.LastEvaluatedKey === undefined ? undefined : encodeToken({ PK: page.LastEvaluatedKey.PK, SK: page.LastEvaluatedKey.SK }),
      };
    },
  };
}

/** The verified caller from the authoriser context, or undefined. */
export function callerOf(event: APIGatewayProxyEvent, requestId: string): TenantContext | undefined {
  const authorizer = event.requestContext.authorizer ?? {};
  const tenantId = authorizer.tenantId;
  const sub = authorizer.sub;
  if (!isTenantId(tenantId) || typeof sub !== 'string' || sub.length === 0) {
    return undefined;
  }
  const scope = typeof authorizer.scope === 'string' ? authorizer.scope : '';
  return { tenantId, sub, scopes: scope.split(' ').filter((s) => s.length > 0), requestId };
}

export function createHandler(service: IngestionTenantServiceService<TenantContext>) {
  const serviceHandler = getIngestionTenantServiceServiceHandler<TenantContext>(service);
  return async (event: APIGatewayProxyEvent, lambdaContext?: Pick<LambdaContext, 'awsRequestId'>): Promise<APIGatewayProxyResult> => {
    const requestId = event.requestContext.requestId ?? lambdaContext?.awsRequestId ?? 'unknown';
    const context = callerOf(event, requestId);
    if (context === undefined) {
      // Unreachable behind the authoriser; refuse rather than guess a tenant.
      return normaliseErrorResponse({ statusCode: 403, headers: { 'x-amzn-errortype': 'ForbiddenError' }, body: '{"message":"no verified caller"}' }, requestId);
    }
    try {
      const response = convertVersion1Response(await serviceHandler.handle(convertEvent(event), context));
      if (response.statusCode >= 500) {
        log.error('request failed', { tenantId: context.tenantId, httpStatus: response.statusCode, requestId });
      }
      return normaliseErrorResponse(response, requestId);
    } catch (error) {
      log.error('request failed', { tenantId: context.tenantId, errorType: errorName(error), requestId });
      return normaliseErrorResponse({ statusCode: 500, body: '{}' }, requestId);
    }
  };
}

let cachedHandler: ReturnType<typeof createHandler> | undefined;

function fromEnv(): ReturnType<typeof createHandler> {
  const region = requireEnv('AWS_REGION');
  const sessions = new TenantSessions(new STSClient({}), requireEnv(ENV.tenantUploadRoleArn));
  const clients = new TenantClients<TenantClientsPair>(sessions, (credentials: TenantCredentials) => ({
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient({ region, credentials }), { marshallOptions: { removeUndefinedValues: true } }),
    // WHEN_REQUIRED: no flexible checksum in the presigned PUT, whose body the client sends.
    s3: new S3Client({ region, credentials, requestChecksumCalculation: 'WHEN_REQUIRED' }),
  }));
  return createHandler(
    createTenantApi({
      clients,
      config: {
        tableName: requireEnv(ENV.tableName),
        bucketName: requireEnv(ENV.bucketName),
        allowedContentTypes: requireEnv(ENV.allowedContentTypes).split(','),
        maxObjectSizeBytes: requireIntEnv(ENV.maxObjectSizeBytes),
        uploadUrlTtlSeconds: requireIntEnv(ENV.uploadUrlTtlSeconds),
        maxInFlightPerTenant: requireIntEnv(ENV.maxInFlightPerTenant),
      },
    }),
  );
}

export async function handler(event: APIGatewayProxyEvent, context: LambdaContext): Promise<APIGatewayProxyResult> {
  cachedHandler ??= fromEnv();
  return cachedHandler(event, context);
}

export { ApiError };
