// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Lambda entry of the demo cell API (`cell-api.ts`). Configuration comes
 * from the environment `DemoCellApi` sets (`CELL_API_ENV`); the clients and
 * the JWKS cache live for the container.
 */

import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from 'aws-lambda';
import { createCellApi, type CellApi } from './cell-api';
import { CELL_API_ENV } from './env';
import { HostsCheck } from './hosts';
import { TenantLimiter } from './limiter';
import { TokenVerifier } from './token';

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`demo cell API: environment variable ${name} is not set`);
  }
  return value;
}

/** One line per fail-open (ADR-0009): the tenant and the error's class name, never its message. */
function logFailOpen(tenantId: string, error: unknown): void {
  const name = error instanceof Error ? error.name : typeof error;
  process.stdout.write(JSON.stringify({ level: 'ERROR', message: 'tenant limit check failed; admitting', tenantId, error: name }) + '\n');
}

let api: CellApi | undefined;

function build(): CellApi {
  const limit = Number(required(CELL_API_ENV.tenantRequestsPer5Min));
  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error(`demo cell API: ${CELL_API_ENV.tenantRequestsPer5Min} must be a non-negative integer`);
  }
  return createCellApi({
    cellId: required(CELL_API_ENV.cellId),
    verifier: new TokenVerifier({
      issuer: required(CELL_API_ENV.issuer),
      jwksUrl: required(CELL_API_ENV.jwksUrl),
      allowedClientIds: required(CELL_API_ENV.allowedClientIds).split(',').map((c) => c.trim()).filter((c) => c.length > 0),
      tenantClaim: required(CELL_API_ENV.tenantClaim),
    }),
    hosts: new HostsCheck(required(CELL_API_ENV.applicationId)),
    limiter: new TenantLimiter(
      { tableName: limit > 0 ? required(CELL_API_ENV.limitTable) : '', requestsPer5Min: limit },
      { onError: logFailOpen },
    ),
  });
}

export async function handler(event: LambdaFunctionURLEvent): Promise<LambdaFunctionURLResult> {
  api ??= build();
  return api(event);
}
