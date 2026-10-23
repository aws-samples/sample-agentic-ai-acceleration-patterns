// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The teardown custom resource handler (ADR-0022). On stack Delete it drains the
 * registry (every tenant offboarded, pool and all) before CloudFormation
 * removes the registry table and the shared pool. On Create and Update it
 * does nothing and answers at once.
 *
 * Built once at cold start, exactly like platform.function.ts (P-1): the
 * optional pool/trigger env vars are read unconditionally and handed to
 * `createProvisioner`, which validates what its topology needs. No topology
 * branch lives here.
 *
 * It reports through the pre-signed ResponseURL with a node https PUT, the
 * same shape log-drain's waiter uses — but in TypeScript, with `respond` and
 * the HTTP `send` both injectable so tests never touch the network. A
 * try/finally guarantees a response is always sent, and a FAILED Reason
 * carries the error class name only, never a message that could echo data
 * (N-6).
 */

import * as https from 'https';
import { URL } from 'url';
import { APIGatewayClient } from '@aws-sdk/client-api-gateway';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { CloudFormationCustomResourceEvent } from 'aws-lambda';
import { drainTenants, type DrainDeps } from './tenant-drain';
import { ENV, parseTopology, requireEnv } from '../shared/constants';
import { errorName } from '../shared/logger';
import { DynamoDBRegistry } from '../shared/registry';
import { ApiGatewayTenantApiKeys } from '../shared/tenant-api-keys';
import { createProvisioner } from '../topology';

// --- Cold-start wiring (mirrors platform.function.ts) ----------------------

const topology = parseTopology(process.env[ENV.topology]);
const region = requireEnv('AWS_REGION');

const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const registry = new DynamoDBRegistry(
  requireEnv(ENV.tableName),
  documentClient,
  requireEnv(ENV.poolIndexName),
);

const cognito = new CognitoIdentityProviderClient({});

// Read the optional env vars without branching on the topology (P-1).
const userPoolId = process.env[ENV.userPoolId];
const appClientId = process.env[ENV.appClientId];
const triggerFunctionArn = process.env[ENV.triggerFunctionArn];
const stackName = process.env[ENV.stackName];

const provisioner = createProvisioner(topology, {
  cognito,
  region,
  sharedPool:
    userPoolId !== undefined && appClientId !== undefined ? { userPoolId, appClientId } : undefined,
  triggerFunctionArn,
  stackName,
});

// The drain only deletes keys, so it needs no usage plan (ADR-0025).
const apiKeys = new ApiGatewayTenantApiKeys(new APIGatewayClient({}), undefined);

// --- CloudFormation custom-resource response -------------------------------

export type CfnStatus = 'SUCCESS' | 'FAILED';

/** The body CloudFormation expects at the pre-signed ResponseURL. */
export interface CfnResponseBody {
  readonly Status: CfnStatus;
  readonly Reason: string;
  readonly PhysicalResourceId: string;
  readonly StackId: string;
  readonly RequestId: string;
  readonly LogicalResourceId: string;
}

/** Injectable transport so tests never make a real HTTP PUT. */
export type Send = (responseUrl: string, body: string) => Promise<void>;

/** Default transport: a node https PUT, like log-drain's WAITER_SOURCE. */
export const httpsSend: Send = (responseUrl, body) => {
  const url = new URL(responseUrl);
  return new Promise<void>((resolve) => {
    const req = https.request(
      {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: 'PUT',
        headers: { 'content-type': '', 'content-length': Buffer.byteLength(body) },
      },
      (res) => {
        res.resume();
        res.on('end', resolve);
      },
    );
    // A transport failure must not wedge the stack op: CloudFormation times
    // the resource out on its own. Resolve so the handler still returns.
    req.on('error', () => resolve());
    req.end(body);
  });
};

/**
 * Builds the response body and PUTs it. Exported for tests; `send` defaults
 * to the https transport but is injectable. The Reason is a fixed string or
 * an error class name only — never a message (N-6).
 */
export async function respond(
  event: CloudFormationCustomResourceEvent,
  status: CfnStatus,
  reason: string,
  send: Send = httpsSend,
): Promise<void> {
  const body: CfnResponseBody = {
    Status: status,
    Reason: reason,
    // PhysicalResourceId is absent on Create events (it is the id CloudFormation
    // assigns afterwards), present on Update/Delete. Default when absent.
    PhysicalResourceId: ('PhysicalResourceId' in event ? event.PhysicalResourceId : undefined) ?? 'tenant-drain',
    StackId: event.StackId,
    RequestId: event.RequestId,
    LogicalResourceId: event.LogicalResourceId,
  };
  await send(event.ResponseURL, JSON.stringify(body));
}

/** Overridable so tests inject mocked registry/provisioner and transport. */
export interface HandlerOverrides {
  readonly deps?: DrainDeps;
  readonly send?: Send;
}

/**
 * The handler. Create/Update answer SUCCESS at once; Delete drains the
 * registry and answers SUCCESS, or FAILED with the error class name if the
 * drain throws. A try/finally guarantees exactly one response is sent.
 */
export async function handle(
  event: CloudFormationCustomResourceEvent,
  overrides: HandlerOverrides = {},
): Promise<void> {
  const deps = overrides.deps ?? { registry, provisioner, apiKeys };
  const send = overrides.send;
  let status: CfnStatus = 'SUCCESS';
  let reason = 'See ADR-0022';
  try {
    if (event.RequestType === 'Delete') {
      await drainTenants(deps);
    }
    // Create and Update: nothing to do (ADR-0022).
  } catch (error) {
    status = 'FAILED';
    // N-6: the class name only, never a message that could carry data.
    reason = errorName(error);
  } finally {
    await respond(event, status, reason, send);
  }
}

export const handler = (event: CloudFormationCustomResourceEvent): Promise<void> => handle(event);
