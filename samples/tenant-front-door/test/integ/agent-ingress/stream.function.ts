// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The stand-in agent ingress's streaming proxy (spec §10 step 23,
 * ADR-0024, spike S-5): API Gateway invokes it with response streaming,
 * and it writes ten events 500 ms apart after logging what reached it.
 * Not part of the sample.
 */

import { IngressEvent, recordOf, writeStream } from './record';

interface ResponseStream {
  write(chunk: string): void;
  end(): void;
}
interface StreamingGlobal {
  readonly HttpResponseStream: { from(stream: ResponseStream, metadata: { statusCode: number; headers: Record<string, string> }): ResponseStream };
  streamifyResponse(handler: (event: IngressEvent, stream: ResponseStream) => Promise<void>): unknown;
}

/** The Lambda Node.js runtime's streaming global. */
declare const awslambda: StreamingGlobal;

const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function streamTo(event: IngressEvent, stream: ResponseStream, sleep = pause): Promise<void> {
  console.log(JSON.stringify(recordOf(event)));
  await writeStream((chunk) => stream.write(chunk), sleep);
  stream.end();
}

export const handler = typeof awslambda === 'undefined'
  ? undefined
  : awslambda.streamifyResponse(async (event, responseStream) => {
    const stream = awslambda.HttpResponseStream.from(responseStream, {
      statusCode: 200,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' },
    });
    await streamTo(event, stream);
  });
