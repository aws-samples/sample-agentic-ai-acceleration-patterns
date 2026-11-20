// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import type { CallResult, ControlPlaneApi } from './api';
import { awaitTenantsActive, existingTenants } from './seed';

jest.mock('./aws', () => ({ ...jest.requireActual('./aws'), sleep: () => Promise.resolve() }));

/** A fake API: `answers` gives each tenant's GetTenant answers in turn, the last one repeated. */
function fakeApi(answers: Record<string, CallResult[]>): { api: ControlPlaneApi; calls: string[] } {
  const calls: string[] = [];
  const seen = new Map<string, number>();
  const api = {
    call: async (_hop: string, _method: string, path: string) => {
      calls.push(path);
      const id = path.split('/').pop()!;
      const n = seen.get(id) ?? 0;
      seen.set(id, n + 1);
      const list = answers[id];
      return list[Math.min(n, list.length - 1)];
    },
  } as unknown as ControlPlaneApi;
  return { api, calls };
}

const tenant = (status: string): CallResult => ({ status: 200, body: { tenant: { status } }, seconds: 0.01 });
const http = (status: number): CallResult => ({ status, body: {}, seconds: 0.01 });

describe('existingTenants (seed)', () => {
  it('drops only the tenants that answer 404, and keeps CREATING and failed ones', async () => {
    const { api } = fakeApi({ A: [tenant('ACTIVE')], B: [tenant('CREATING')], C: [tenant('CREATE_FAILED')], D: [http(404)] });
    await expect(existingTenants(api, ['A', 'B', 'C', 'D'])).resolves.toEqual(['A', 'B', 'C']);
  });

  it('throws on a throttle, a server error or a transport failure instead of forgetting the id', async () => {
    for (const status of [429, 500, 0]) {
      const { api } = fakeApi({ A: [tenant('ACTIVE')], B: [http(status)] });
      await expect(existingTenants(api, ['A', 'B'])).rejects.toThrow(`GetTenant B answered HTTP ${status}`);
    }
  });
});

describe('awaitTenantsActive (seed)', () => {
  it('polls a CREATING tenant until it is ACTIVE', async () => {
    const { api, calls } = fakeApi({ A: [tenant('CREATING'), tenant('CREATING'), tenant('ACTIVE')], B: [tenant('ACTIVE')] });
    await expect(awaitTenantsActive(api, ['A', 'B'])).resolves.toBeUndefined();
    expect(calls).toEqual(['/tenants/A', '/tenants/A', '/tenants/A', '/tenants/B']);
  });

  it('throws when a tenant settles in a failed status', async () => {
    const { api } = fakeApi({ A: [tenant('ACTIVE')], B: [tenant('CREATING'), tenant('CREATE_FAILED')] });
    await expect(awaitTenantsActive(api, ['A', 'B'])).rejects.toThrow('tenant B is CREATE_FAILED');
  });

  it('throws with the last status when the wait times out', async () => {
    const { api } = fakeApi({ A: [tenant('CREATING')] });
    await expect(awaitTenantsActive(api, ['A'], 0.05)).rejects.toThrow('tenant A is CREATING');
  });
});
