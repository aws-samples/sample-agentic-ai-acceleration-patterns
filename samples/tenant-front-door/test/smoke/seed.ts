// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Smoke-test route fixtures, written straight to the route table (spec §10
 * step 2 shortcut): with no control plane the registrar refuses every write
 * that reads it, so the smoke seeds the cell and tenant routes itself, with
 * the store's ETag and the sample's own codec.
 *
 *   npx ts-node test/smoke/seed.ts put <kvsArn> <cellId> <account> <apiDomain> <tenantId>=<name> ...
 *   npx ts-node test/smoke/seed.ts get <kvsArn> <key>
 *   npx ts-node test/smoke/seed.ts delete <kvsArn> <cellId> <tenantId> ...
 */

import { CloudFrontKeyValueStoreClient } from '@aws-sdk/client-cloudfront-keyvaluestore';
import { KvsRouteStore } from '../../src/registrar/route-store';
import { cellEntry, cellKey, encodeEntry, sanitiseDisplayName, tenantEntry, tenantKey, toStoredId } from '../../src/shared/route-table';

async function main(): Promise<void> {
  const [mode, arn, ...rest] = process.argv.slice(2);
  const store = new KvsRouteStore({ client: new CloudFrontKeyValueStoreClient({ region: 'us-east-1' }), arn });
  if (mode === 'put') {
    const [cellId, account, apiDomain, ...tenants] = rest;
    const cell = toStoredId(cellId);
    const now = process.env.SEED_DT === undefined ? Date.now() : Number(process.env.SEED_DT);
    const puts: Record<string, string> = { [cellKey(cell)]: encodeEntry(cellEntry({ ac: account, o: apiDomain })) };
    for (const t of tenants) {
      const [id, name] = t.split('=');
      puts[tenantKey(toStoredId(id))] = encodeEntry(tenantEntry({ c: cell, ac: account, dt: now, s: 'active', n: sanitiseDisplayName(name) }));
    }
    await store.update(async () => ({ puts, result: undefined }));
    console.log(`seeded ${Object.keys(puts).join(', ')}`);
  } else if (mode === 'get') {
    const value = await store.update(async (read) => ({ result: await read(rest[0]) }));
    console.log(value ?? '');
  } else if (mode === 'delete') {
    const [cellId, ...tenants] = rest;
    const deletes = [cellKey(toStoredId(cellId)), ...tenants.map((t) => tenantKey(toStoredId(t)))];
    await store.update(async () => ({ deletes, result: undefined }));
    console.log(`deleted ${deletes.join(', ')}`);
  } else {
    throw new Error('usage: seed.ts put|get|delete <kvsArn> ...');
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
