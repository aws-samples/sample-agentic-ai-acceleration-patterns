// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The `agentcore-runtime` backend, runtime side (spec §3.4, ADR-0011,
 * ADR-0012, ADR-0024). It owns every AgentCore-specific detail on the request
 * path: the `InvokeAgentRuntime` call on the Runtime the request resolved,
 * `runtimeSessionId` as the unit-id transport, and the two allowlisted custom
 * headers that carry the forwarded user token and the vended credentials
 * (base64 JSON). The echo agent uses the same constants to read them back.
 */

import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore';
import type { BackendResponse, HeaderTransportBackend, InvokeBackend, ValidatedRequest } from './backend';
import { endpointHost, preconnect, sharedHandler } from '../shared/http';
import type { VendedCredentials } from '../shared/tvm';

/** Request headers on the ingress-to-Runtime hop (ADR-0006, ADR-0012). */
export const RUNTIME_HEADERS = {
  /** The unit id; written by the Gateway interceptor, read by the agent. */
  SESSION_ID: 'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id',
  /** The forwarded user token (P-5). On the Runtime allowlist only with `delegation.forwardUserToken`. */
  USER_TOKEN: 'X-Amzn-Bedrock-AgentCore-Runtime-Custom-User-Token',
  /** The vended tenant credentials (P-8). On the Runtime allowlist only with `tvm`. */
  TENANT_CREDENTIALS: 'X-Amzn-Bedrock-AgentCore-Runtime-Custom-Tenant-Credentials',
} as const;

/** The credential header value: base64 of the JSON credential object. */
export function encodeCredentials(credentials: VendedCredentials): string {
  return Buffer.from(JSON.stringify(credentials), 'utf8').toString('base64');
}

/** The inverse, for the agent. Throws on malformed input. */
export function decodeCredentials(header: string): VendedCredentials {
  const parsed = JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as Partial<VendedCredentials>;
  if (!parsed.accessKeyId || !parsed.secretAccessKey || !parsed.sessionToken || !parsed.expiration) {
    throw new Error('credential header is incomplete');
  }
  return {
    accessKeyId: parsed.accessKeyId,
    secretAccessKey: parsed.secretAccessKey,
    sessionToken: parsed.sessionToken,
    expiration: parsed.expiration,
  };
}

/** The custom headers for a request: only those the options put on the request. */
export function customHeaders(request: ValidatedRequest): Record<string, string> {
  const headers: Record<string, string> = {};
  if (request.userToken !== undefined) {
    headers[RUNTIME_HEADERS.USER_TOKEN] = request.userToken;
  }
  if (request.credentials !== undefined) {
    headers[RUNTIME_HEADERS.TENANT_CREDENTIALS] = encodeCredentials(request.credentials);
  }
  return headers;
}

/** The payload the Runtime receives: the prompt and nothing else from the request. */
export function runtimePayload(request: ValidatedRequest): Uint8Array {
  return Buffer.from(JSON.stringify({ prompt: request.prompt }), 'utf8');
}

export class AgentCoreRuntimeBackend implements InvokeBackend, HeaderTransportBackend {
  private client?: BedrockAgentCoreClient;

  /**
   * The Runtime to invoke is `request.runtimeArn`, resolved per request from
   * the registry (ADR-0024), so one instance serves every backend behind the
   * ingress and no ARN lives in the environment.
   *
   * @param client an injected client (tests); otherwise built by `warm()` at
   * init or, for an interceptor that only writes headers, never
   */
  constructor(client?: BedrockAgentCoreClient) {
    this.client = client;
  }

  /** Builds the client and opens the connection to the Runtime endpoint ahead of the first invoke (ADR-0023); call it at init. */
  warm(): Promise<void> {
    this.client ??= new BedrockAgentCoreClient({ requestHandler: sharedHandler() });
    return preconnect([endpointHost('bedrock-agentcore')]);
  }

  /** Headers for the Gateway path: unit id plus the custom headers (ADR-0002). */
  transportHeaders(request: ValidatedRequest): Record<string, string> {
    return { [RUNTIME_HEADERS.SESSION_ID]: request.unitId, ...customHeaders(request) };
  }

  /** The direct path: `InvokeAgentRuntime` with SigV4 on the request's Runtime, the unit id as `runtimeSessionId`. */
  async invoke(request: ValidatedRequest): Promise<BackendResponse> {
    // `runtimeArn` is typed and registry-validated; an empty string would be a pipeline defect, not a request fault.
    if (request.runtimeArn.length === 0) {
      throw new Error('AgentCoreRuntimeBackend: no runtime ARN to invoke');
    }
    const command = new InvokeAgentRuntimeCommand({
      agentRuntimeArn: request.runtimeArn,
      runtimeSessionId: request.unitId,
      contentType: 'application/json',
      accept: 'text/event-stream, application/json',
      payload: runtimePayload(request),
    });
    const headers = customHeaders(request);
    if (Object.keys(headers).length > 0) {
      // The SDK has no parameter for custom headers; add them at the build
      // step so SigV4 signs them with the rest (spike V-6).
      command.middlewareStack.add(
        (next) => async (args) => {
          const req = args.request as { headers: Record<string, string> };
          Object.assign(req.headers, headers);
          return next(args);
        },
        { step: 'build', name: 'runtimeCustomHeaders' },
      );
    }
    this.client ??= new BedrockAgentCoreClient({ requestHandler: sharedHandler() });
    const output = await this.client.send(command);
    const body = output.response;
    if (body === undefined) {
      throw new Error('InvokeAgentRuntime returned no response body');
    }
    return {
      contentType: output.contentType ?? 'application/json',
      body: body as AsyncIterable<Uint8Array>,
    };
  }
}
