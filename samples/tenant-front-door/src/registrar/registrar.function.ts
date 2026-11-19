// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { CloudFrontKeyValueStoreClient } from '@aws-sdk/client-cloudfront-keyvaluestore';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { convertEvent, convertVersion1Response } from '@smithy/server-apigateway';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { classifyCaller } from './caller';
import { loadConfig } from './config';
import { ControlPlaneReader } from './control-plane';
import { DedicatedDomainsNotBuilt } from './dedicated-domains';
import { logLine } from './log';
import { type RegistrarContext, type RegistrarDeps, RegistrarService } from './registrar';
import { KvsRouteStore } from './route-store';
import { getRegistrarServiceServiceHandler } from '../smithy/source/typescript-ssdk-codegen/src';

/**
 * The route registrar's Lambda entry (spec §3.4, §5.1), behind an API
 * Gateway REST API with `AWS_IAM` and a resource policy that admits the
 * control plane's global hook role and the edge operator role (ADR-0017).
 * It refuses any other caller itself, normalises header names for the
 * SSDK, dispatches to the generated service handler, and writes every
 * error body as `{message, reason?}`.
 */

export type Handler = (event: APIGatewayProxyEvent) => Promise<APIGatewayProxyResult>;


/** REST keeps the client's header casing; the SSDK reads modelled headers by lower-case name. */
function lowerCaseHeaders(event: APIGatewayProxyEvent): APIGatewayProxyEvent {
  const headers: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(event.headers ?? {})) headers[k.toLowerCase()] = v;
  const multiValueHeaders: Record<string, string[] | undefined> = {};
  for (const [k, v] of Object.entries(event.multiValueHeaders ?? {})) {
    const key = k.toLowerCase();
    multiValueHeaders[key] = [...(multiValueHeaders[key] ?? []), ...(v ?? [])];
  }
  return { ...event, headers, multiValueHeaders };
}

const DEFAULT_MESSAGES: Readonly<Record<number, string>> = {
  400: 'the request is malformed',
  403: 'the caller is not admitted',
  404: 'no such operation',
  500: 'internal error',
};

/**
 * Every error body the function writes is `{message, reason?}` (§5.1). The
 * SSDK's own answers (a `ValidationException` with its `fieldList`, an
 * empty `InternalFailure`, an unknown route) are cut to that shape, with a
 * fixed message where they carry none.
 */
function errorBody(statusCode: number, body: string): string {
  let parsed: Record<string, unknown> = {};
  try {
    const x: unknown = JSON.parse(body);
    if (typeof x === 'object' && x !== null && !Array.isArray(x)) parsed = x as Record<string, unknown>;
  } catch {
    // Not JSON: the fixed message stands in.
  }
  const message = typeof parsed.message === 'string' && parsed.message !== ''
    ? parsed.message
    : DEFAULT_MESSAGES[statusCode] ?? (statusCode >= 500 ? 'internal error' : 'the request is refused');
  return JSON.stringify(typeof parsed.reason === 'string' ? { message, reason: parsed.reason } : { message });
}

function forbidden(): APIGatewayProxyResult {
  return {
    statusCode: 403,
    multiValueHeaders: { 'content-type': ['application/json'], 'x-amzn-errortype': ['ForbiddenError'] },
    body: JSON.stringify({ message: 'the caller is not admitted' }),
  };
}

export function createHandler(deps: RegistrarDeps): Handler {
  const serviceHandler = getRegistrarServiceServiceHandler<RegistrarContext>(new RegistrarService(deps));
  return async (event) => {
    const operation = `${event.httpMethod} ${event.resource ?? event.path}`;
    // §3.4 step 1: the role from the signed request context, never the body.
    const role = classifyCaller(event.requestContext?.identity, deps.config);
    if (role === undefined) {
      logLine('WARN', 'registrar call refused', { operation, outcome: 403 });
      return forbidden();
    }
    const context: RegistrarContext = { role };
    let result: APIGatewayProxyResult;
    try {
      result = convertVersion1Response(await serviceHandler.handle(convertEvent(lowerCaseHeaders(event)), context));
    } catch (error) {
      logLine('ERROR', 'registrar call failed', { role, operation, key: context.key, error: error instanceof Error ? error.name : typeof error });
      result = { statusCode: 500, multiValueHeaders: { 'content-type': ['application/json'] }, body: '{}' };
    }
    if (result.statusCode >= 400) result = { ...result, body: errorBody(result.statusCode, result.body) };
    // §3.4 step 6: role, key and outcome, never the body.
    logLine(result.statusCode >= 500 ? 'ERROR' : 'INFO', 'registrar call', { role, operation, key: context.key, outcome: result.statusCode });
    return result;
  };
}

let cached: Handler | undefined;

/** Built once per environment, on the first call, so a test can import the module without the environment. */
function coldStart(): Handler {
  const config = loadConfig(process.env);
  return createHandler({
    config,
    controlPlane: new ControlPlaneReader({
      baseUrl: config.controlPlaneUrl,
      tokenUrl: config.vendorIdpTokenUrl,
      clientId: config.vendorIdpClientId,
      secretArn: config.vendorIdpSecretArn,
      secrets: new SecretsManagerClient({}),
    }),
    store: new KvsRouteStore({ client: new CloudFrontKeyValueStoreClient({}), arn: config.routeTableArn }),
    domains: new DedicatedDomainsNotBuilt(),
  });
}

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  cached ??= coldStart();
  return cached(event);
}
