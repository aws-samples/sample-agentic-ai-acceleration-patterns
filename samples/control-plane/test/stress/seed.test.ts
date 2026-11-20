// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import type { CallResult, ControlPlaneApi } from './api';
import { awaitTenantsActive, deleteTenants, existingTenants } from './seed';

jest.mock('./aws', () => ({ ...jest.requireActual('./aws'), sleep: () => Promise.resolve() }));

/**
 * A fake API: `answers` gives each tenant's GetTenant answers in turn, the last one repeated;
 * `deletes` gives each tenant's DeleteTenant answer.
 */
function fakeApi(answers: Record<string, CallResult[]>, deletes: Record<string, CallResult> = {}): { api: ControlPlaneApi; calls: string[] } {
  const calls: string[] = [];
  const seen = new Map<string, number>();
  const api = {
    call: async (_hop: string, method: string, path: string) => {
      calls.push(method === 'GET' ? path : `${method} ${path}`);
      const id = path.split('/').pop()!;
      if (method === 'DELETE') return deletes[id];
      const n = seen.get(id) ?? 0;
      seen.set(id, n + 1);
      const list = answers[id];
      return list[Math.min(n, list.length - 1)];
    },
  } as unknown as ControlPlaneApi;
  return { api, calls };
}

const tenant = (status: string): CallResult => ({ status: 200, body: { tenant: { status } }, seconds: 0.01 });
const http = (status: number, errorType?: string): CallResult => ({ status, body: {}, errorType, seconds: 0.01 });

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

  it('throws when a tenant settles in a failed status, and names the remedy', async () => {
    const { api } = fakeApi({ A: [tenant('ACTIVE')], B: [tenant('CREATING'), tenant('CREATE_FAILED')] });
    await expect(awaitTenantsActive(api, ['A', 'B'])).rejects.toThrow(
      'tenant B is CREATE_FAILED: delete it with `slice.sh teardown --fixtures`, then seed again',
    );
  });

  it('throws with the last status when the wait times out', async () => {
    const { api } = fakeApi({ A: [tenant('CREATING')] });
    await expect(awaitTenantsActive(api, ['A'], 0.05)).rejects.toThrow('tenant A is CREATING');
  });
});

describe('deleteTenants (sweep)', () => {
  it('drops a tenant whose delete answers 404, and one whose delete is accepted and whose Get then answers 404', async () => {
    const { api, calls } = fakeApi({ B: [tenant('DELETING'), http(404)] }, { A: http(404), B: http(202) });
    await expect(deleteTenants(api, ['A', 'B'])).resolves.toEqual({ gone: ['A', 'B'], kept: [] });
    expect(calls).toEqual(['DELETE /tenants/A', 'DELETE /tenants/B', '/tenants/B', '/tenants/B']);
  });

  it('keeps a tenant whose delete answers 409 or 5xx, and never polls it', async () => {
    const { api, calls } = fakeApi({}, { A: http(409, 'ConflictError'), B: http(503), C: http(404) });
    await expect(deleteTenants(api, ['A', 'B', 'C'])).resolves.toEqual({
      gone: ['C'],
      kept: [
        { id: 'A', reason: 'DeleteTenant answered HTTP 409 (ConflictError)' },
        { id: 'B', reason: 'DeleteTenant answered HTTP 503' },
      ],
    });
    expect(calls).toEqual(['DELETE /tenants/A', 'DELETE /tenants/B', 'DELETE /tenants/C']);
  });

  it('keeps a tenant whose accepted delete ends DELETE_FAILED', async () => {
    const { api } = fakeApi({ A: [tenant('DELETING'), tenant('DELETE_FAILED')] }, { A: http(202) });
    await expect(deleteTenants(api, ['A'])).resolves.toEqual({ gone: [], kept: [{ id: 'A', reason: 'DELETE_FAILED' }] });
  });

  it('keeps a tenant still there at the deadline', async () => {
    const { api } = fakeApi({ A: [tenant('DELETING')] }, { A: http(202) });
    await expect(deleteTenants(api, ['A'], 0.05)).resolves.toEqual({ gone: [], kept: [{ id: 'A', reason: 'DELETING after 0.05 s' }] });
  });
});
