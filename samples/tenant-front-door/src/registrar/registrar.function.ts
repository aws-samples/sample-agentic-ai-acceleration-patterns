// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { ACMClient } from '@aws-sdk/client-acm';
import { CloudFrontClient } from '@aws-sdk/client-cloudfront';
import { CloudFrontKeyValueStoreClient } from '@aws-sdk/client-cloudfront-keyvaluestore';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { convertEvent, convertVersion1Response } from '@smithy/server-apigateway';
import { ServiceException } from '@smithy/server-common';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { classifyCaller } from './caller';
import { loadConfig, type RegistrarConfig } from './config';
import { ControlPlaneReader } from './control-plane';
import { AwsDedicatedDomains, CERTIFICATE_REGION, type DedicatedDomains, DedicatedDomainsOff } from './dedicated-domains';
import { logLine } from './log';
import { type RegistrarContext, type RegistrarDeps, RegistrarService } from './registrar';
import { KvsRouteStore } from './route-store';
import { nodeDnsLookup } from '../shared/dns-challenge';
import {
  getRegistrarServiceServiceHandler,
  type RegistrarServiceService,
  type RegistrarServiceServiceOperations,
} from '../smithy/source/typescript-ssdk-codegen/src';

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
  const serviceHandler = getRegistrarServiceServiceHandler<RegistrarContext>(recordingErrors(new RegistrarService(deps)));
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
    logLine(result.statusCode >= 500 ? 'ERROR' : 'INFO', 'registrar call', {
      role,
      operation,
      key: context.key,
      outcome: result.statusCode,
      error: context.error,
    });
    return result;
  };
}

let cached: Handler | undefined;

/**
 * Each SDK call is bounded: 2 s to connect, 3 s for the answer (an error,
 * not only a warning), two tries. That bounds a hung call, not the whole
 * request: a call with its token fetch and five store attempts can still
 * run past API Gateway's 29 s and get a 504 while the function goes on.
 * Every operation is repeat-safe, so the caller repeats it (spec §3.4).
 */
export const SDK_CLIENT = {
  maxAttempts: 2,
  requestHandler: new NodeHttpHandler({ connectionTimeout: 2_000, requestTimeout: 3_000, throwOnRequestTimeout: true }),
} as const;

const OPERATIONS = ['PutCellRoute', 'DeleteCellRoute', 'PutTenantRoute', 'DeleteTenantRoute', 'UpdateTenantRouteStatus', 'DeleteHostRoute'] as const;

// Fails to compile when the model gains an operation this list lacks.
const EVERY_OPERATION: [Exclude<RegistrarServiceServiceOperations, (typeof OPERATIONS)[number]>] extends [never] ? true : never = true;
void EVERY_OPERATION;

/**
 * The SSDK answers an error it does not model with an empty 500 itself, so
 * the function never sees it. Each operation records the class name of
 * such an error (never its message) on the context for the log line.
 */
function recordingErrors(service: RegistrarService): RegistrarServiceService<RegistrarContext> {
  const wrapped: Record<string, unknown> = {};
  for (const op of OPERATIONS) {
    const run = service[op] as (input: unknown, ctx: RegistrarContext) => Promise<unknown>;
    wrapped[op] = async (input: unknown, ctx: RegistrarContext) => {
      try {
        return await run(input, ctx);
      } catch (error) {
        if (!(error instanceof ServiceException)) ctx.error = error instanceof Error ? error.name : typeof error;
        throw error;
      }
    };
  }
  return wrapped as unknown as RegistrarServiceService<RegistrarContext>;
}

/**
 * The dedicated-domain seam the configuration asks for. ACM is called in
 * `us-east-1`, where CloudFront reads certificates; CloudFront's control
 * API is global and signed for `us-east-1`.
 */
export function dedicatedDomainsFor(config: RegistrarConfig): DedicatedDomains {
  if (!config.dedicatedDomains) return new DedicatedDomainsOff();
  return new AwsDedicatedDomains({
    acm: new ACMClient({ ...SDK_CLIENT, region: CERTIFICATE_REGION }),
    cloudfront: new CloudFrontClient({ ...SDK_CLIENT, region: 'us-east-1' }),
    distributionId: config.distributionId,
    lookup: nodeDnsLookup(),
  });
}

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
      secrets: new SecretsManagerClient(SDK_CLIENT),
    }),
    store: new KvsRouteStore({ client: new CloudFrontKeyValueStoreClient(SDK_CLIENT), arn: config.routeTableArn, distributionId: config.distributionId }),
    domains: dedicatedDomainsFor(config),
  });
}

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  cached ??= coldStart();
  return cached(event);
}
