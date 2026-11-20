// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Sink operations (spec §4.4). A sink is configuration: a change takes
 * effect at the next dispatch (spec §6.2 item 5).
 *
 * - `HTTP`: an HTTPS URL with no credentials in it and no IP-literal or
 *   `localhost` host, and an optional field mapping. `auth: SECRET` (the
 *   default) takes a secret under `<fleet>/metering/sinks/`; `AWS_IAM`
 *   takes none and is signed with the dispatcher's role, so its host must
 *   be a Lambda function URL or an API Gateway endpoint (src/shared/sink-auth.ts).
 * - `S3_EXPORT`: a key prefix in the sample's export bucket; no secret, no
 *   mapping (the line is the record).
 */

import { DeleteCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { type AdminContext, type AdminDeps, nowOf, toDate } from './deps';
import { apiError } from './errors';
import { DEFAULT_PAGE_SIZE, decodeToken, encodeToken } from './pagination';
import { getItem } from '../shared/db';
import type { MappingSource, SinkItem } from '../shared/items';
import { keys, LIST_BY_TYPE_INDEX } from '../shared/keys';
import { isConditionFailure } from '../shared/retry';
import { iamSinkTarget, secretNameInFleet, sinkSecretPrefix } from '../shared/sink-auth';
import { iso } from '../shared/time';
import type { MappingSource as ModelMappingSource, SinkAuth, SinkSummary, SinkType } from '../smithy/metering/typescript-ssdk-codegen/src';

/** Record fields a mapping may read (spec §4.7, §4.8). */
export const RECORD_FIELDS: ReadonlySet<string> = new Set([
  'recordId',
  'revision',
  'kind',
  'tenantId',
  'applicationId',
  'meterId',
  'meterVersion',
  'unit',
  'hour',
  'seq',
  'quantity',
  'total',
  'eventCount',
  'billingAccount',
]);

/** Meter fields a mapping may read (spec §4.1). */
export const METER_FIELDS: ReadonlySet<string> = new Set(['meterId', 'version', 'unit', 'rule']);

const S3_PREFIX = /^[A-Za-z0-9!_.*'()-]+(\/[A-Za-z0-9!_.*'()-]+)*\/?$/;
const IP_LITERAL = /^(\d{1,3}(\.\d{1,3}){3}|\[[0-9a-fA-F:.]+\])$/;

export function sinkOut(item: SinkItem): SinkSummary {
  return {
    sinkId: item.sinkId,
    type: item.type,
    enabled: item.enabled,
    endpoint: item.endpoint,
    auth: item.type === 'HTTP' ? (item.auth ?? 'SECRET') : undefined,
    secretName: item.secretName,
    mapping: item.mapping as Record<string, ModelMappingSource> | undefined,
    meters: item.meters,
    createdBy: item.createdBy,
    createdAt: toDate(item.createdAt),
  };
}

function mappingIn(mapping: Record<string, ModelMappingSource> | undefined): Record<string, MappingSource> | undefined {
  if (mapping === undefined) {
    return undefined;
  }
  const out: Record<string, MappingSource> = {};
  for (const [target, source] of Object.entries(mapping)) {
    if (source.recordField !== undefined) {
      if (!RECORD_FIELDS.has(source.recordField)) {
        throw apiError.validation(`mapping ${target}: unknown record field`);
      }
      out[target] = { recordField: source.recordField };
    } else if (source.meterField !== undefined) {
      if (!METER_FIELDS.has(source.meterField)) {
        throw apiError.validation(`mapping ${target}: unknown meter field`);
      }
      out[target] = { meterField: source.meterField };
    } else if (source.constant !== undefined) {
      out[target] = { constant: source.constant };
    } else {
      throw apiError.validation(`mapping ${target}: unknown source`);
    }
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

/** Validates a whole sink as it will be stored, and normalises it. */
export function validateSink(sink: SinkItem, fleetName: string): SinkItem {
  if (sink.type === 'HTTP') {
    let url: URL;
    try {
      url = new URL(sink.endpoint);
    } catch {
      throw apiError.validation('endpoint is not a URL');
    }
    if (
      url.protocol !== 'https:' ||
      url.username !== '' ||
      url.password !== '' ||
      url.hostname === 'localhost' ||
      IP_LITERAL.test(url.hostname)
    ) {
      throw apiError.validation('endpoint must be an https URL with a DNS host name and no credentials');
    }
    if (sink.auth === 'AWS_IAM') {
      if (sink.secretName !== undefined) {
        throw apiError.validation('an AWS_IAM sink takes no secretName');
      }
      if (iamSinkTarget(sink.endpoint) === undefined) {
        throw apiError.validation('an AWS_IAM sink endpoint must be a Lambda function URL or an API Gateway execute-api host');
      }
      return sink;
    }
    if (sink.secretName === undefined || !secretNameInFleet(fleetName, sink.secretName)) {
      throw apiError.validation(`secretName must be under ${sinkSecretPrefix(fleetName)}`);
    }
    return sink;
  }
  if (sink.secretName !== undefined || sink.mapping !== undefined || sink.auth !== undefined) {
    throw apiError.validation('an S3_EXPORT sink takes no auth, no secretName and no mapping');
  }
  if (
    sink.endpoint.length > 512 ||
    !S3_PREFIX.test(sink.endpoint) ||
    sink.endpoint.split('/').some((part) => part === '.' || part === '..')
  ) {
    throw apiError.validation('endpoint must be a key prefix such as exports/billing/');
  }
  return { ...sink, endpoint: sink.endpoint.endsWith('/') ? sink.endpoint : `${sink.endpoint}/` };
}

const meterList = (meters: string[] | undefined): string[] | undefined =>
  meters === undefined || meters.length === 0 ? undefined : [...new Set(meters)].sort();

export async function createSink(
  deps: AdminDeps,
  ctx: AdminContext,
  input: {
    sinkId: string;
    type: SinkType;
    enabled: boolean;
    endpoint: string;
    auth?: SinkAuth;
    secretName?: string;
    mapping?: Record<string, ModelMappingSource>;
    meters?: string[];
  },
): Promise<SinkItem> {
  if (input.auth !== undefined && input.auth !== 'SECRET' && input.auth !== 'AWS_IAM') {
    throw apiError.validation('auth must be SECRET or AWS_IAM');
  }
  const item = validateSink(
    {
      ...keys.sink(input.sinkId),
      SK: 'META',
      sinkId: input.sinkId,
      type: input.type as SinkItem['type'],
      enabled: input.enabled,
      endpoint: input.endpoint,
      auth: input.auth as SinkItem['auth'],
      secretName: input.secretName,
      mapping: mappingIn(input.mapping),
      meters: meterList(input.meters),
      createdBy: ctx.caller.roleArn,
      createdAt: iso(nowOf(deps)),
    },
    deps.config.fleetName,
  );
  try {
    await deps.db.send(
      new PutCommand({
        TableName: deps.config.tableName,
        Item: { ...item, version: 1, listType: 'SINK', listSort: item.sinkId },
        ConditionExpression: 'attribute_not_exists(PK)',
      }),
    );
  } catch (error) {
    if (isConditionFailure(error)) {
      throw apiError.conflict('ALREADY_EXISTS', 'a sink with this id exists');
    }
    throw error;
  }
  return item;
}

export async function getSink(deps: AdminDeps, sinkId: string): Promise<SinkItem> {
  const item = await getItem<SinkItem>(deps.db, deps.config.tableName, keys.sink(sinkId), true);
  if (item === undefined) {
    throw apiError.notFound('no such sink');
  }
  return item;
}

export async function updateSink(
  deps: AdminDeps,
  input: {
    sinkId: string;
    enabled?: boolean;
    endpoint?: string;
    secretName?: string;
    mapping?: Record<string, ModelMappingSource>;
    meters?: string[];
  },
): Promise<SinkItem> {
  const stored = await getSink(deps, input.sinkId);
  const item = validateSink(
    {
      ...stored,
      enabled: input.enabled ?? stored.enabled,
      endpoint: input.endpoint ?? stored.endpoint,
      secretName: input.secretName ?? stored.secretName,
      mapping: input.mapping === undefined ? stored.mapping : mappingIn(input.mapping),
      meters: input.meters === undefined ? stored.meters : meterList(input.meters),
    },
    deps.config.fleetName,
  );
  try {
    await deps.db.send(
      new PutCommand({
        TableName: deps.config.tableName,
        Item: { ...item, version: (stored.version ?? 0) + 1, listType: 'SINK', listSort: item.sinkId },
        // The stored item is the one validated against: any write in between moves its version.
        ConditionExpression: stored.version === undefined ? 'attribute_exists(PK) AND attribute_not_exists(version)' : 'version = :v',
        ...(stored.version === undefined ? {} : { ExpressionAttributeValues: { ':v': stored.version } }),
      }),
    );
  } catch (error) {
    if (isConditionFailure(error)) {
      throw apiError.conflict('CONCURRENT_WRITE', 'the sink changed; read it and retry');
    }
    throw error;
  }
  return item;
}

export async function deleteSink(deps: AdminDeps, sinkId: string): Promise<void> {
  try {
    await deps.db.send(
      new DeleteCommand({ TableName: deps.config.tableName, Key: keys.sink(sinkId), ConditionExpression: 'attribute_exists(PK)' }),
    );
  } catch (error) {
    if (isConditionFailure(error)) {
      throw apiError.notFound('no such sink');
    }
    throw error;
  }
}

export async function listSinks(
  deps: AdminDeps,
  nextToken: string | undefined,
  maxResults: number | undefined,
): Promise<{ sinks: SinkItem[]; nextToken?: string }> {
  const query = 'ListSinks';
  const page = await deps.db.send(
    new QueryCommand({
      TableName: deps.config.tableName,
      IndexName: LIST_BY_TYPE_INDEX,
      KeyConditionExpression: 'listType = :t',
      ExpressionAttributeValues: { ':t': 'SINK' },
      Limit: maxResults ?? DEFAULT_PAGE_SIZE,
      ExclusiveStartKey: decodeToken(query, nextToken),
    }),
  );
  return {
    sinks: (page.Items ?? []) as SinkItem[],
    nextToken: encodeToken(query, page.LastEvaluatedKey as Record<string, string> | undefined),
  };
}
