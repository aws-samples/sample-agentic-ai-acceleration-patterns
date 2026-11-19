// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The route table's stack-owned keys (spec §4.1): `app`, the SPA's public
 * issuer settings, and in `host` mode `signin`, the sign-in HMAC keys
 * (ADR-0016). On each Create and Update it:
 *
 * - writes `app` as the stack built it;
 * - in `host` mode, generates a 32-byte key for each id in `SigninIds` the
 *   store does not hold yet, keeps the others, drops any id not listed and
 *   sets `cur` to `SigninCurrent` (the §4.1 rotation rules);
 * - in `single` mode, removes a `signin` key a former `host` mode left.
 *
 * Both keys go in one `UpdateKeys` call under the store's ETag, retried on
 * a conflict, because the registrar writes the same store (M-15). The keys
 * are made here from a cryptographic source and never leave the function:
 * not in the template, the response or a log (M-20). On Delete it does
 * nothing: the store goes with the stack.
 */

import { randomBytes } from 'node:crypto';
import {
  CloudFrontKeyValueStoreClient,
  ConflictException,
  DescribeKeyValueStoreCommand,
  GetKeyCommand,
  ResourceNotFoundException,
  UpdateKeysCommand,
} from '@aws-sdk/client-cloudfront-keyvaluestore';
// The KeyValueStore data plane signs with SigV4A; importing the pure-JS
// signer registers it with the SDK's multi-Region signer.
import '@aws-sdk/signature-v4a';
import { CustomResourceEventBase, CustomResourceOutcome, respond } from './cfn-response';
import { decodeSigninEntry, encodeEntry, KEY_APP, KEY_SIGNIN, signinEntry, SigninEntry } from '../shared/route-table';

export const PHYSICAL_RESOURCE_ID = 'route-table-keys';

/** Attempts of the ETag cycle before the resource fails (the registrar's bound, §3.4 step 5). */
export const MAX_ATTEMPTS = 5;

/** The custom resource's properties. CloudFormation passes every value as a string. */
export interface RouteTableKeysProperties {
  readonly KeyValueStoreArn: string;
  /** The encoded `app` value. */
  readonly App: string;
  /** `host` mode only. */
  readonly SigninIds?: readonly string[];
  readonly SigninCurrent?: string;
}

export interface RouteTableKeysEvent extends CustomResourceEventBase {
  readonly RequestType: 'Create' | 'Update' | 'Delete';
  readonly PhysicalResourceId?: string;
  readonly ResourceProperties: RouteTableKeysProperties & { readonly ServiceToken?: string };
}

export interface Deps {
  readonly client: Pick<CloudFrontKeyValueStoreClient, 'send'>;
  /** 32 random bytes per call. */
  readonly newKey: () => string;
  readonly sleep: (ms: number) => Promise<void>;
}

/**
 * The `signin` value after this update: keeps each listed key the store
 * holds, makes the missing ones, drops the rest (§4.1).
 */
export function nextSigninEntry(existing: SigninEntry | undefined, ids: readonly string[], current: string, newKey: () => string): SigninEntry {
  const k: Record<string, string> = {};
  for (const id of ids) {
    k[id] = existing?.k[id] ?? newKey();
  }
  return signinEntry({ cur: current, k });
}

export async function handleEvent(event: RouteTableKeysEvent, deps: Deps): Promise<CustomResourceOutcome> {
  const physicalResourceId = event.PhysicalResourceId ?? PHYSICAL_RESOURCE_ID;
  if (event.RequestType === 'Delete') {
    return { status: 'SUCCESS', physicalResourceId };
  }
  const p = event.ResourceProperties;
  const hostMode = p.SigninIds !== undefined;
  if (hostMode && (p.SigninCurrent === undefined || !p.SigninIds.includes(p.SigninCurrent))) {
    return { status: 'FAILED', physicalResourceId, reason: 'SigninCurrent must be one of SigninIds' };
  }

  for (let attempt = 1; ; attempt++) {
    try {
      const { ETag } = await deps.client.send(new DescribeKeyValueStoreCommand({ KvsARN: p.KeyValueStoreArn }));
      const stored = await getSignin(deps, p.KeyValueStoreArn);
      const puts = [{ Key: KEY_APP, Value: p.App }];
      const deletes: { Key: string }[] = [];
      if (hostMode) {
        const next = nextSigninEntry(stored, p.SigninIds!, p.SigninCurrent!, deps.newKey);
        puts.push({ Key: KEY_SIGNIN, Value: encodeEntry(next) });
      } else if (stored !== undefined) {
        deletes.push({ Key: KEY_SIGNIN });
      }
      await deps.client.send(new UpdateKeysCommand({
        KvsARN: p.KeyValueStoreArn,
        IfMatch: ETag,
        Puts: puts,
        Deletes: deletes.length > 0 ? deletes : undefined,
      }));
      return { status: 'SUCCESS', physicalResourceId };
    } catch (error) {
      if (error instanceof ConflictException && attempt < MAX_ATTEMPTS) {
        await deps.sleep(50 + Math.floor(Math.random() * 450));
        continue;
      }
      // The error's name only: a message could quote a value.
      return { status: 'FAILED', physicalResourceId, reason: `route table write failed: ${errorName(error)}` };
    }
  }
}

/** The stored `signin` entry, or undefined when absent. An unreadable one is replaced by fresh keys. */
async function getSignin(deps: Deps, kvsArn: string): Promise<SigninEntry | undefined> {
  let value: string | undefined;
  try {
    value = (await deps.client.send(new GetKeyCommand({ KvsARN: kvsArn, Key: KEY_SIGNIN }))).Value;
  } catch (error) {
    if (error instanceof ResourceNotFoundException) return undefined;
    throw error;
  }
  if (value === undefined) return undefined;
  try {
    return decodeSigninEntry(value);
  } catch {
    console.warn(JSON.stringify({ message: 'stored signin entry is unreadable; new keys are generated' }));
    return undefined;
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

/** Time the answer needs before the function's own timeout. */
export const ANSWER_MARGIN_MS = 5_000;

/**
 * `handleEvent`, or FAILED with `Timeout` once `ms` pass: an answer that
 * never goes out leaves the stack waiting an hour.
 */
export async function answerWithin(work: Promise<CustomResourceOutcome>, ms: number, physicalResourceId: string): Promise<CustomResourceOutcome> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<CustomResourceOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ status: 'FAILED', physicalResourceId, reason: 'Timeout' }), ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

const deps: Deps = {
  // Each call gives up after 10 s, so the retries fit the function's timeout.
  client: new CloudFrontKeyValueStoreClient({ requestHandler: { requestTimeout: 10_000 } }),
  newKey: () => randomBytes(32).toString('base64'),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

export const handler = async (event: RouteTableKeysEvent, context: { getRemainingTimeInMillis(): number }): Promise<void> => {
  const physicalResourceId = event.PhysicalResourceId ?? PHYSICAL_RESOURCE_ID;
  let outcome: CustomResourceOutcome;
  try {
    outcome = await answerWithin(handleEvent(event, deps), context.getRemainingTimeInMillis() - ANSWER_MARGIN_MS, physicalResourceId);
  } catch (error) {
    outcome = { status: 'FAILED', physicalResourceId, reason: errorName(error) };
  }
  await respond(event, outcome);
};
