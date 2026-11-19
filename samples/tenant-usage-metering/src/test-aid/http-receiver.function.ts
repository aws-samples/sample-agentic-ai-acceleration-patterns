// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * TEST ONLY: a stand-in billing API for the integration test's `HTTP` sink
 * (demo stack, `integHttpReceiver=true`). It sits behind a Lambda function
 * URL with `AuthType AWS_IAM`, and only the dispatcher's role is granted
 * invoke, so Lambda refuses an unsigned or unauthorised call before this
 * code runs:
 *
 * - only `POST` is accepted;
 * - it stores nothing and logs only the idempotency key and the mapped
 *   billing account, which are synthetic test values.
 */

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

const reply = (statusCode: number): FunctionUrlResult => ({ statusCode, headers: { 'content-type': 'application/json' }, body: '{}' });

export const handler = async (event: FunctionUrlEvent): Promise<FunctionUrlResult> => {
  if (event.requestContext?.http?.method !== 'POST') {
    return reply(405);
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
