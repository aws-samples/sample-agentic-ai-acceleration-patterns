// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The integration test's route table helper (spec §10), run by
 * `scripts/integ.sh` under the test role. It writes with the store's ETag,
 * as every other writer does, and with the sample's own codec, using
 * `PutKey` and `DeleteKey`, the two writes the test role holds (spec §6.1).
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

// The data API signs with SigV4A; the pure-JS signer is loaded for its side effect (no CRT build).
import '@aws-sdk/signature-v4a';
import {
  CloudFrontKeyValueStoreClient,
  ConflictException,
  DeleteKeyCommand,
  DescribeKeyValueStoreCommand,
  GetKeyCommand,
  PutKeyCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-cloudfront-keyvaluestore';
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

const client = new CloudFrontKeyValueStoreClient({ region: 'us-east-1' });

async function read(arn: string, key: string): Promise<string | undefined> {
  try {
    return (await client.send(new GetKeyCommand({ KvsARN: arn, Key: key }))).Value;
  } catch (error) {
    if (error instanceof ResourceNotFoundException) return undefined;
    throw error;
  }
}

/** One write with the store's ETag, as every writer does (§4.1); a few attempts on a conflict. */
async function withEtag(arn: string, write: (etag: string) => Promise<unknown>): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    const etag = (await client.send(new DescribeKeyValueStoreCommand({ KvsARN: arn }))).ETag ?? '';
    try {
      await write(etag);
      return;
    } catch (error) {
      if (!(error instanceof ConflictException) || attempt >= 5) throw error;
    }
  }
}

async function main(): Promise<void> {
  const [mode, arn, ...rest] = process.argv.slice(2);
  switch (mode) {
    case 'host-put': {
      const [host, tenantId, account] = rest;
      const Value = encodeEntry(hostEntry({ t: toStoredId(tenantId), ac: account }));
      await withEtag(arn, (IfMatch) => client.send(new PutKeyCommand({ KvsARN: arn, Key: hostKey(host), Value, IfMatch })));
      console.log(`wrote ${hostKey(host)}`);
      return;
    }
    case 'host-delete': {
      if ((await read(arn, hostKey(rest[0]))) !== undefined) {
        await withEtag(arn, (IfMatch) => client.send(new DeleteKeyCommand({ KvsARN: arn, Key: hostKey(rest[0]), IfMatch })));
      }
      console.log(`removed ${hostKey(rest[0])}`);
      return;
    }
    case 'entry':
      console.log(JSON.stringify(redact(await read(arn, rest[0]))));
      return;
    case 'state': {
      const [host, expiresIn] = rest;
      const raw = await read(arn, KEY_SIGNIN);
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
