// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The sweeper's Lambda entry (spec §3.1, §3.4 step 5): one function with a
 * 15-minute timeout, run by EventBridge Scheduler, that runs one of three
 * jobs, named by the invocation's `job`:
 *
 * - `remove`, every 15 minutes: the two-phase removal (`removal.ts`);
 * - `recheck`, daily and from the starter: the re-check's lister
 *   (`recheck.ts`), which starts one asynchronous `page` per 500 entries;
 * - `page`: one page of the re-check.
 *
 * A failed invocation throws, so Lambda retries it and then keeps it in
 * the function's on-failure queue.
 */

// The KeyValueStore data API signs with SigV4A. The multi-region signer
// finds the pure-JS signer only once this module has been loaded.
import '@aws-sdk/signature-v4a';
import { ACMClient } from '@aws-sdk/client-acm';
import { CloudFrontClient } from '@aws-sdk/client-cloudfront';
import { CloudFrontKeyValueStoreClient } from '@aws-sdk/client-cloudfront-keyvaluestore';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { LambdaClient } from '@aws-sdk/client-lambda';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { logLine } from './log';
import { parsePageEvent, type RecheckDeps, runLister, runPage } from './recheck';
import { type RemovalDeps, runRemoval } from './removal';
import { SWEEPER_ENV, SWEEPER_JOB } from '../shared/contracts';
import { checkChallenge, nodeDnsLookup } from '../shared/dns-challenge';

/** The Region of every registrar certificate: CloudFront takes certificates from `us-east-1` only. */
export const CERTIFICATE_REGION = 'us-east-1';

export interface SweeperDeps {
  readonly recheck: RecheckDeps;
  readonly removal: RemovalDeps;
}

export type Handler = (event: unknown) => Promise<void>;

export function createHandler(deps: SweeperDeps): Handler {
  return async (event) => {
    const job = (event as { job?: unknown } | undefined)?.job;
    if (job === SWEEPER_JOB.remove) {
      await runRemoval(deps.removal);
    } else if (job === SWEEPER_JOB.recheck) {
      await runLister(deps.recheck);
    } else if (job === SWEEPER_JOB.page) {
      await runPage(parsePageEvent(event), deps.recheck);
    } else {
      logLine('ERROR', 'unknown sweeper job');
      throw new Error('unknown sweeper job');
    }
  };
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value === '') throw new Error(`missing environment variable ${name}`);
  return value;
}

/** Builds the function's clients and settings from its environment. */
export function depsFromEnv(env: NodeJS.ProcessEnv = process.env): SweeperDeps {
  const routeTableArn = requireEnv(env, SWEEPER_ENV.routeTableArn);
  const distributionId = requireEnv(env, SWEEPER_ENV.distributionId);
  const kvs = new CloudFrontKeyValueStoreClient({});
  const lookup = nodeDnsLookup();
  return {
    recheck: {
      kvs,
      // A page makes each read and each table call once (§3.4 step 5).
      kvsOnce: new CloudFrontKeyValueStoreClient({ maxAttempts: 1 }),
      ddb: DynamoDBDocumentClient.from(new DynamoDBClient({ maxAttempts: 1 })),
      lambda: new LambdaClient({}),
      routeTableArn,
      distributionId,
      tableName: requireEnv(env, SWEEPER_ENV.tableName),
      functionName: requireEnv(env, 'AWS_LAMBDA_FUNCTION_NAME'),
      now: () => Date.now(),
      challenge: (domain, token) => checkChallenge(domain, token, { lookup }),
    },
    removal: {
      // CloudFront's control API is global and signed for us-east-1.
      cloudFront: new CloudFrontClient({ region: 'us-east-1' }),
      acm: new ACMClient({ region: CERTIFICATE_REGION }),
      kvs,
      routeTableArn,
      distributionId,
      pooledTenantId: requireEnv(env, SWEEPER_ENV.pooledTenantId),
    },
  };
}

let handlerOnce: Handler | undefined;

export const handler: Handler = async (event) => {
  handlerOnce ??= createHandler(depsFromEnv());
  return handlerOnce(event);
};
