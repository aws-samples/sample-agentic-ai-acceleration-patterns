// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The integration test's route table helper (spec §10), run by
 * `scripts/integ.sh` under the test role. It uses the sample's own store
 * client and codec, so the fixture is written with the store's ETag as
 * every other writer does.
 *
 *   edge-tool.ts host-put <kvsArn> <host> <tenantId> <account>   step 2 fixture
 *   edge-tool.ts host-delete <kvsArn> <host>                     step 24
 *   edge-tool.ts entry <kvsArn> <key>                            a redacted entry
 *   edge-tool.ts state <kvsArn> <host> [expiresIn]               step 18: a state signed with the live key
 *
 * `entry` prints the entry's fields with the challenge token and the
 * `signin` key replaced by whether they are present, never their values
 * (scripts/CONVENTIONS.md). `state` prints the signed state, which the
 * driver keeps in a variable; the key never leaves this process.
 */

import { CloudFrontKeyValueStoreClient } from '@aws-sdk/client-cloudfront-keyvaluestore';
import { KvsRouteStore } from '../../src/registrar/route-store';
import { decodeSigninEntry, encodeEntry, hostEntry, hostKey, KEY_SIGNIN, toStoredId } from '../../src/shared/route-table';
import { mintState } from '../support/signin-state';

/** Replaces secret-bearing fields with their presence. */
export function redact(raw: string | undefined): Record<string, unknown> | null {
  if (raw === undefined) return null;
  const entry = JSON.parse(raw) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(entry)) {
    if (k === 'dk') out.dkPresent = true;
    else if (k === 'k') out.kids = Object.keys(v as Record<string, string>).sort();
    else out[k] = v;
  }
  return out;
}

async function main(): Promise<void> {
  const [mode, arn, ...rest] = process.argv.slice(2);
  const store = new KvsRouteStore({ client: new CloudFrontKeyValueStoreClient({ region: 'us-east-1' }), arn });
  switch (mode) {
    case 'host-put': {
      const [host, tenantId, account] = rest;
      await store.update(async () => ({
        puts: { [hostKey(host)]: encodeEntry(hostEntry({ t: toStoredId(tenantId), ac: account })) },
        result: undefined,
      }));
      console.log(`wrote ${hostKey(host)}`);
      return;
    }
    case 'host-delete': {
      await store.update(async (read) => (await read(hostKey(rest[0]))) === undefined
        ? { result: undefined }
        : { deletes: [hostKey(rest[0])], result: undefined });
      console.log(`removed ${hostKey(rest[0])}`);
      return;
    }
    case 'entry': {
      const value = await store.update(async (read) => ({ result: await read(rest[0]) }));
      console.log(JSON.stringify(redact(value)));
      return;
    }
    case 'state': {
      const [host, expiresIn] = rest;
      const raw = await store.update(async (read) => ({ result: await read(KEY_SIGNIN) }));
      if (raw === undefined) throw new Error('no signin key: the front door is not in host mode');
      const signin = decodeSigninEntry(raw);
      const exp = Math.floor(Date.now() / 1000) + Number(expiresIn ?? 600);
      console.log(mintState(signin, { v: 1, kid: signin.cur, h: host.toLowerCase(), n: 'integ-nonce-0000000000', exp }));
      return;
    }
    default:
      throw new Error('usage: edge-tool.ts host-put|host-delete|entry|state <kvsArn> ...');
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'edge-tool failed');
    process.exit(1);
  });
}
