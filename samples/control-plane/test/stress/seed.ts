// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The record reads the slice's `seed` and `register` verbs share: polling a record's Get,
 * and the two checks `seed` makes on the manifest's tenants. The manifest is the only list
 * `sweep` deletes tenants from, so an id leaves it only when the control plane says the
 * tenant is gone (404); every other answer keeps it or stops the seed.
 */

import type { ControlPlaneApi } from './api';
import { sleep } from './aws';

const enc = encodeURIComponent;

/** Polls a record's Get until `done` says so, at most `seconds`. */
export async function pollRecord(
  api: ControlPlaneApi,
  hop: string,
  p: string,
  tenant: string,
  done: (status: number, body: any) => boolean,
  seconds = 300,
): Promise<boolean> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const r = await api.call(hop, 'GET', p, tenant, undefined, [404]);
    if (done(r.status, r.body)) return true;
    await sleep(5000);
  }
  return false;
}

/**
 * The ids whose tenant record still exists, in order. Drops an id only on a 404: a tenant
 * still CREATING or one that failed stays, so the seed waits for it or `sweep` deletes it.
 * Any answer other than 200 or 404 (a throttle, a server error, a transport failure)
 * throws, and the manifest keeps every id.
 */
export async function existingTenants(api: ControlPlaneApi, ids: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (const id of ids) {
    const r = await api.call('get-tenant', 'GET', `/tenants/${enc(id)}`, id, undefined, [404]);
    if (r.status === 200) out.push(id);
    else if (r.status !== 404) throw new Error(`GetTenant ${id} answered HTTP ${r.status}`);
  }
  return out;
}

/** Waits until each tenant is terminal, then throws unless every one is ACTIVE. */
export async function awaitTenantsActive(api: ControlPlaneApi, ids: readonly string[], seconds = 120): Promise<void> {
  for (const id of ids) {
    let status: string | undefined;
    const settled = await pollRecord(api, 'get-tenant', `/tenants/${enc(id)}`, id, (s, b) => {
      status = s === 200 ? String(b?.tenant?.status) : undefined;
      return status !== undefined && /^(ACTIVE|[A-Z]+_FAILED)$/.test(status);
    }, seconds);
    if (!settled || status !== 'ACTIVE') throw new Error(`tenant ${id} is ${status ?? 'not found'}`);
  }
}
