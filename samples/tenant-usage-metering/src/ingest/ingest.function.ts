// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Lambda entry of `POST /usage-events` (spec §3.1). Order matters: the body
 * is measured in bytes before it is parsed (413), the caller is admitted
 * before the SSDK reads the body (403), and only then does the SSDK
 * deserialise and validate the batch.
 */

import { EventBridgeV2Client } from '@aws-sdk/client-eventbridgev2';
import { FirehoseClient } from '@aws-sdk/client-firehose';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { convertEvent, convertVersion1Response } from '@smithy/server-apigateway';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { type AdmittedEmitter, Ingest, MAX_BODY_BYTES } from './ingest';
import { busPublisher, directPublisher } from './publish';
import { bodyBytes, errorResponse } from '../api/http';
import { documentClient } from '../shared/db';
import { ENV, requireEnv, requireIntEnv } from '../shared/env';
import { errorName, log } from '../shared/logger';
import { Metrics } from '../shared/metrics';
import { getPutUsageEventsHandler } from '../smithy/metering/typescript-ssdk-codegen/src/server/operations/PutUsageEvents';

interface IngestContext {
  readonly admitted: AdmittedEmitter;
  readonly requestId: string;
  readonly metrics: Metrics;
}

export function createIngestHandler(ingest: Ingest) {
  const operation = getPutUsageEventsHandler<IngestContext>(async (input, ctx) => {
    const outcomes = await ingest.putEvents(ctx.admitted, input.events ?? [], ctx.requestId, ctx.metrics);
    return {
      results: outcomes.map((outcome, index) => {
        const event = (input.events ?? [])[index] as { eventId?: unknown } | null;
        const eventId = event !== null && typeof event === 'object' && typeof event.eventId === 'string' && event.eventId.length <= 64 ? event.eventId : undefined;
        return { eventId, result: outcome.result, ...(outcome.result === 'REFUSED' ? { reason: outcome.reason } : {}) };
      }),
    };
  });

  return async (event: APIGatewayProxyEvent, context?: Pick<Context, 'awsRequestId'>): Promise<APIGatewayProxyResult> => {
    const requestId = event.requestContext?.requestId ?? context?.awsRequestId ?? 'unknown';
    const metrics = new Metrics();
    try {
      if (bodyBytes(event.body, event.isBase64Encoded) > MAX_BODY_BYTES) {
        return errorResponse(413, 'PayloadTooLargeException', 'request body is over 1,048,576 bytes of UTF-8');
      }
      const admitted = await ingest.admit(event.requestContext?.identity?.userArn ?? undefined, metrics);
      if (admitted === undefined) {
        return errorResponse(403, 'AccessDeniedException', 'caller is not a registered emitter');
      }
      const response = convertVersion1Response(await operation.handle(convertEvent(event), { admitted, requestId, metrics }));
      if (response.statusCode >= 500) {
        log.error('ingest request failed', { requestId, httpStatus: response.statusCode });
      }
      return response;
    } catch (error) {
      log.error('ingest request failed', { requestId, errorType: errorName(error) });
      return errorResponse(500, 'InternalServerError', 'internal error');
    } finally {
      metrics.flush();
    }
  };
}

function fromEnv(): Ingest {
  const db = documentClient();
  const s3 = new S3Client({});
  const rawBucket = requireEnv(ENV.rawBucket);
  const publish =
    requireEnv(ENV.ingestPath) === 'DIRECT'
      ? directPublisher(new FirehoseClient({}), requireEnv(ENV.firehoseStreamName))
      : busPublisher(new EventBridgeV2Client({}), requireEnv(ENV.ingestBusArn));
  return new Ingest({
    db,
    publish,
    writeErrorObject: async (key, body) => {
      await s3.send(new PutObjectCommand({ Bucket: rawBucket, Key: key, Body: body, ContentType: 'application/json' }));
    },
    config: {
      fleetName: requireEnv(ENV.fleetName),
      tableName: requireEnv(ENV.tableName),
      recountWindowHours: requireIntEnv(ENV.recountWindowHours),
      maxEventsPerEmitterPerMinute: requireIntEnv(ENV.maxEventsPerEmitterPerMinute),
      maxRefusedPerEmitterPerHour: requireIntEnv(ENV.maxRefusedPerEmitterPerHour),
    },
  });
}

let cached: ReturnType<typeof createIngestHandler> | undefined;

export const handler = (event: APIGatewayProxyEvent, context: Context): Promise<APIGatewayProxyResult> => {
  cached ??= createIngestHandler(fromEnv());
  return cached(event, context);
};
