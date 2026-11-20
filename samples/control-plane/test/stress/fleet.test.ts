// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import type { CallResult, ControlPlaneApi } from './api';
import { type FleetEnv, placeDeployment, removeAll } from './fleet';
import { Recorder } from './recorder';

jest.mock('./aws', () => ({ ...jest.requireActual('./aws'), sleep: () => Promise.resolve() }));

/** A fake API: `onCall` answers each call; ListDeployments answers from `deployments`. */
function fakeEnv(onCall: (method: string, path: string, body: any) => CallResult, deployments: () => any[]): { env: FleetEnv; bodies: any[] } {
  const rec = new Recorder();
  const bodies: any[] = [];
  const api = {
    call: async (hop: string, method: string, path: string, tenant: string, body?: unknown, expected: readonly number[] = []) => {
      bodies.push(body);
      const r = onCall(method, path, body);
      rec.observe(hop, r, tenant, expected.includes(r.status));
      return r;
    },
    listAll: async () => ({ items: deployments(), status: 200 }),
  } as unknown as ControlPlaneApi;
  return { env: { api, rec, applicationId: 'stress', platformAccount: '1', cellAccounts: [], region: 'eu-central-1', log: () => undefined }, bodies };
}

const ok = (status: number, body: any = {}, errorType?: string): CallResult => ({ status, body, errorType, seconds: 0.01 });

describe('placeDeployment (stress ADR-0013)', () => {
  it('retries an ambiguous placement with the same client token, and takes the replay', async () => {
    let n = 0;
    const { env, bodies } = fakeEnv(
      () => (++n === 1 ? ok(500, { message: 'Deployment placement failed ambiguously: x' }, 'InternalServerError') : ok(202)),
      () => [],
    );
    await expect(placeDeployment(env, 'T1')).resolves.toBe('accepted');
    expect(bodies).toHaveLength(2);
    expect(bodies[0].clientToken).toBe(bodies[1].clientToken);
    expect(env.rec.toRecord({ runId: 'r', tier: 'small', mode: 'slice', slice: 'control-plane', commit: '0123456' }, 's').refusals.unattributed).toBe(0);
  });

  it('gives up on a 500 it cannot attribute, and says full on InsufficientCapacityError', async () => {
    const { env } = fakeEnv(() => ok(500, { message: 'boom' }, 'InternalServerError'), () => []);
    await expect(placeDeployment(env, 'T1')).resolves.toBe('failed');
    const { env: full } = fakeEnv(() => ok(409, { message: 'no room' }, 'InsufficientCapacityError'), () => []);
    await expect(placeDeployment(full, 'T1')).resolves.toBe('full');
  });
});

describe('removeAll (stress ADR-0013)', () => {
  it('deletes a DELETE_FAILED deployment again and counts the retry', async () => {
    let deletes = 0;
    const { env } = fakeEnv(
      () => {
        deletes += 1;
        return ok(202);
      },
      () => (deletes === 1 ? [{ tenantId: 'T1', status: 'DELETE_FAILED' }] : []),
    );
    await expect(removeAll(env, ['T1'], 60)).resolves.toEqual([]);
    expect(deletes).toBe(2);
    expect(env.rec.toRecord({ runId: 'r', tier: 'small', mode: 'slice', slice: 'control-plane', commit: '0123456' }, 's').requests['DELETE_FAILED:retried']).toBe(1);
  });

  it('returns what three deletes did not remove', async () => {
    const { env } = fakeEnv(() => ok(202), () => [{ tenantId: 'T1', status: 'DELETE_FAILED' }]);
    await expect(removeAll(env, ['T1'], 60)).resolves.toEqual(['T1']);
  });
});
