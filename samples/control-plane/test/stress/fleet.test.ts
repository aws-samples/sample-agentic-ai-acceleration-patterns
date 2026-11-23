// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import type { CallResult, ControlPlaneApi } from './api';
import { type FleetEnv, paced, placeDeployment, removeAll } from './fleet';
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
  const conflict = { tenantId: 'T1', status: 'DELETE_FAILED', statusReason: 'Tenant delete failed: DynamoDb.TransactionCanceledException' };
  const ID = { runId: 'r', tier: 'small', mode: 'slice', slice: 'control-plane', commit: '0123456' };

  it('deletes a deployment that failed on a transaction conflict again and counts the retry', async () => {
    let deletes = 0;
    const { env } = fakeEnv(
      () => {
        deletes += 1;
        return ok(202);
      },
      () => (deletes === 1 ? [conflict] : []),
    );
    await expect(removeAll(env, ['T1'], 5, 60)).resolves.toEqual([]);
    expect(deletes).toBe(2);
    expect(env.rec.toRecord(ID, 's').requests['DELETE_FAILED:retried']).toBe(1);
    expect(env.rec.findings).toEqual([]);
  });

  it('returns what three deletes did not remove, and never retries another failure', async () => {
    const { env } = fakeEnv(() => ok(202), () => [conflict]);
    await expect(removeAll(env, ['T1'], 5, 60)).resolves.toEqual(['T1']);
    let deletes = 0;
    const other = fakeEnv(
      () => {
        deletes += 1;
        return ok(202);
      },
      () => [{ ...conflict, statusReason: 'Tenant delete failed: the build failed' }],
    );
    await expect(removeAll(other.env, ['T1'], 5, 60)).resolves.toEqual(['T1']);
    expect(deletes).toBe(1);
    expect(other.env.rec.findings).toEqual(['tenant T1: deployment DELETE_FAILED (Tenant delete failed: the build failed)']);
  });
});

describe('paced', () => {
  it('keeps at most the limit in flight', async () => {
    const started: string[] = [];
    const done = new Set<string>();
    let peak = 0;
    // Each read of the deployments finishes the oldest operation still running.
    const { env } = fakeEnv(() => ok(200), () => {
      const running = started.find((t) => !done.has(t));
      if (running !== undefined) done.add(running);
      return started.map((t) => ({ tenantId: t, status: done.has(t) ? 'ACTIVE' : 'CREATING' }));
    });
    const refused = await paced(env, ['A', 'B', 'C', 'D', 'E'], 2, 60, async (t) => {
      started.push(t);
      peak = Math.max(peak, started.filter((x) => !done.has(x)).length);
      return t !== 'E';
    }, (d) => d?.status === 'ACTIVE');
    expect(peak).toBe(2);
    expect(started).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(refused).toEqual(['E']);
  });

  it('starts the whole wave at once when unpaced (STRESS_UNPACED=1)', async () => {
    const started: string[] = [];
    let peak = 0;
    const { env } = fakeEnv(() => ok(200), () => started.map((t) => ({ tenantId: t, status: 'ACTIVE' })));
    await paced({ ...env, unpaced: true }, ['A', 'B', 'C', 'D', 'E'], 2, 60, async (t) => {
      started.push(t);
      peak = started.length;
      return true;
    }, (d) => d?.status === 'ACTIVE');
    expect(peak).toBe(5);
  });
});
