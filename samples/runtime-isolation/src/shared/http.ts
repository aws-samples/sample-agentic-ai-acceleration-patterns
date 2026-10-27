// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * One HTTPS socket pool for the ingress process (ADR-0023). Every SDK client
 * the ingress builds (STS, DynamoDB, AgentCore) shares the agent below, so a
 * connection opened at init is the one the first request reuses, and a
 * connection one request opened is the one the next request reuses.
 *
 * `preconnect` opens the TLS connection to a service endpoint during Lambda
 * init, where the CPU is boosted and the time is not on any request's
 * clock, with an unsigned, empty `POST /` that needs no permission and
 * touches no resource (STS answers 302, DynamoDB 400, AgentCore 404, each
 * on a kept-alive socket; STS closes the socket after a HEAD, measured
 * 2026-10-27). The response is discarded; only the socket matters. A
 * failure is ignored: the first request then opens its own connection, as
 * it did before.
 */

import { Agent as HttpsAgent, request } from 'node:https';
import { NodeHttpHandler, type NodeHttpHandlerOptions } from '@smithy/node-http-handler';

/** The shared keep-alive agent. `maxSockets` bounds one Lambda environment's open connections. */
export const httpsAgent = new HttpsAgent({ keepAlive: true, maxSockets: 50 });

/** A request handler on the shared agent, with optional timeouts (ADR-0023: the limiter's are short). */
export function sharedHandler(options: Pick<NodeHttpHandlerOptions, 'connectionTimeout' | 'requestTimeout'> = {}): NodeHttpHandler {
  return new NodeHttpHandler({ httpsAgent, ...options });
}

/** The regional endpoint host of a service in this Region, or undefined when the Region is unknown. */
export function endpointHost(service: 'sts' | 'dynamodb' | 'bedrock-agentcore', region = process.env.AWS_REGION): string | undefined {
  return region === undefined || region.length === 0 ? undefined : `${service}.${region}.amazonaws.com`;
}

/** Opens one connection to each host and leaves it in the pool. Returns when every attempt has ended, success or not. */
export function preconnect(hosts: ReadonlyArray<string | undefined>, timeoutMs = 2000): Promise<void> {
  const attempts = hosts
    .filter((h): h is string => h !== undefined)
    .map(
      (host) =>
        new Promise<void>((resolve) => {
          const req = request({ agent: httpsAgent, host, method: 'POST', path: '/', headers: { 'Content-Length': '0' }, timeout: timeoutMs }, (res) => {
            res.resume();
            res.on('end', resolve);
            res.on('error', () => resolve());
          });
          req.on('timeout', () => req.destroy());
          req.on('error', () => resolve());
          req.end();
        }),
    );
  return Promise.all(attempts).then(() => undefined);
}
