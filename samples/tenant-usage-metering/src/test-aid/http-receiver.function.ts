// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * TEST ONLY: a stand-in billing API for the integration test's `HTTP` sink
 * (demo stack, `integHttpReceiver=true`). It sits behind a Lambda function
 * URL, so it is reachable from the internet while the test stack exists:
 *
 * - only `POST` is accepted;
 * - the `Authorization: Bearer <secret>` the dispatcher sends must equal the
 *   sink's secret, compared in constant time; anything else is a 401;
 * - it stores nothing and logs only the record id, the idempotency key and
 *   the mapped billing account, which are synthetic test values.
 */

import { timingSafeEqual } from 'node:crypto';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

interface FunctionUrlEvent {
  readonly requestContext?: { readonly http?: { readonly method?: string } };
  readonly headers?: Record<string, string | undefined>;
  readonly body?: string;
  readonly isBase64Encoded?: boolean;
}

interface FunctionUrlResult {
  readonly statusCode: number;
  readonly headers: Record<string, string>;
  readonly body: string;
}

const secrets = new SecretsManagerClient({});
let expected: Buffer | undefined;

async function expectedHeader(): Promise<Buffer> {
  if (expected === undefined) {
    const name = process.env.RECEIVER_SECRET_NAME;
    if (name === undefined) {
      throw new Error('RECEIVER_SECRET_NAME is not set');
    }
    const out = await secrets.send(new GetSecretValueCommand({ SecretId: name }));
    expected = Buffer.from(`Bearer ${out.SecretString ?? ''}`);
  }
  return expected;
}

const reply = (statusCode: number): FunctionUrlResult => ({ statusCode, headers: { 'content-type': 'application/json' }, body: '{}' });

/** True when the presented header equals the expected one, in constant time. */
export function sameCredential(presented: string | undefined, wanted: Buffer): boolean {
  const given = Buffer.from(presented ?? '');
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

export const handler = async (event: FunctionUrlEvent): Promise<FunctionUrlResult> => {
  if (event.requestContext?.http?.method !== 'POST') {
    return reply(405);
  }
  if (!sameCredential(event.headers?.authorization, await expectedHeader())) {
    return reply(401);
  }
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(event.isBase64Encoded === true ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : (event.body ?? '{}'));
  } catch {
    return reply(400);
  }
  const key = event.headers?.['idempotency-key'];
  process.stdout.write(
    `${JSON.stringify({ message: 'usage received', idempotencyKey: typeof key === 'string' ? key.slice(0, 64) : undefined, account: typeof body.account === 'string' ? body.account.slice(0, 128) : undefined })}\n`,
  );
  return reply(200);
};
