// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import type { LambdaFunctionURLEvent } from 'aws-lambda';
import { CELL_API_ENV } from '../../src/demo-cell/env';

const ENV: Record<string, string> = {
  [CELL_API_ENV.issuer]: 'https://issuer.example.com/pool',
  [CELL_API_ENV.jwksUrl]: 'https://issuer.example.com/pool/.well-known/jwks.json',
  [CELL_API_ENV.allowedClientIds]: 'a,b',
  [CELL_API_ENV.tenantClaim]: 'tenant_id',
  [CELL_API_ENV.applicationId]: 'demo',
  [CELL_API_ENV.cellId]: 'cell-a',
  [CELL_API_ENV.tenantRequestsPer5Min]: '2000',
  [CELL_API_ENV.limitTable]: 'limits',
};

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

const event = { rawPath: '/api/whoami', headers: {}, requestContext: { http: { method: 'GET' } } } as unknown as LambdaFunctionURLEvent;

async function invoke(env: Record<string, string | undefined>) {
  process.env = { ...saved, ...env };
  let handler!: (e: LambdaFunctionURLEvent) => Promise<unknown>;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    handler = require('../../src/demo-cell/cell-api.function').handler;
  });
  return handler(event);
}

describe('demo cell API entry: the environment DemoCellApi sets (CELL_API_ENV)', () => {
  test('builds from a full environment and refuses a request with no token', async () => {
    const write = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const res = (await invoke(ENV)) as { statusCode: number };
    write.mockRestore();
    expect(res.statusCode).toBe(403);
  });

  test.each(Object.keys(ENV).filter((k) => k !== CELL_API_ENV.limitTable))('fails when %s is missing', async (name) => {
    await expect(invoke({ ...ENV, [name]: undefined })).rejects.toThrow(new RegExp(name));
  });

  test('needs the table only while the limit is on', async () => {
    await expect(invoke({ ...ENV, [CELL_API_ENV.limitTable]: undefined })).rejects.toThrow(CELL_API_ENV.limitTable);
    const write = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const res = (await invoke({ ...ENV, [CELL_API_ENV.limitTable]: undefined, [CELL_API_ENV.tenantRequestsPer5Min]: '0' })) as { statusCode: number };
    write.mockRestore();
    expect(res.statusCode).toBe(403);
  });

  test.each(['-1', '1.5', 'many'])('refuses a limit of %s', async (limit) => {
    await expect(invoke({ ...ENV, [CELL_API_ENV.tenantRequestsPer5Min]: limit })).rejects.toThrow(/non-negative integer/);
  });
});
