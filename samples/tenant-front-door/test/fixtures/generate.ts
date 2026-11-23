// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// Regenerates test/fixtures/signin-state.json and config-json.json from route-table.json:
//   npx ts-node --project tsconfig.json test/fixtures/generate.ts
// The fixture tests then pin the output; regenerate only when the contract changes.
import * as fs from 'fs';
import * as path from 'path';
import { decodeSigninEntry } from '../../src/shared/route-table';
import { mintState } from '../support/signin-state';

const dir = __dirname;
const rt = JSON.parse(fs.readFileSync(path.join(dir, 'route-table.json'), 'utf8'));
const signinValue: string = rt.valid.find((f: { kind: string }) => f.kind === 'signin').value;
const signin = decodeSigninEntry(signinValue);
const now = 1795080000;
const host = '01hzx8k9p0qrst7vwxyz1a2b3c.tenants.example.com';
const nonce = 'AbCdEfGhIjKlMnOp_-0123';

const good = { v: 1 as const, kid: 'k2', h: host, n: nonce, exp: now + 600 };
const logout = { v: 1 as const, kid: 'k2', h: host, exp: now + 600 };
const oldKey = { v: 1 as const, kid: 'k1', h: host, n: nonce, exp: now + 600 };
const expired = { v: 1 as const, kid: 'k2', h: host, n: nonce, exp: now };
const goodState = mintState(signin, good);
// A 32-byte MAC is 43 base64url characters; the last carries 2 unused bits,
// so a neighbouring character decodes to the same bytes.
function flipLast(s: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'; // pragma: allowlist secret
  const i = alphabet.indexOf(s[s.length - 1]);
  // Same top 4 bits, other low 2 bits: index i - i % 4 + (i + 1) % 4.
  const j = i - (i % 4) + ((i + 1) % 4);
  return s.slice(0, -1) + alphabet[j];
}
const [enc, mac] = goodState.split('.');
const tampered = Buffer.from(JSON.stringify({ ...good, h: 'other.tenants.example.com' })).toString('base64url') + '.' + mac;
const unknownKid = Buffer.from(JSON.stringify({ ...good, kid: 'k9' })).toString('base64url') + '.' + mac;

fs.writeFileSync(
  path.join(dir, 'signin-state.json'),
  JSON.stringify(
    {
      _comment:
        'Golden sign-in state cases (spec §3.5, ADR-0016), signed with the signin entry from route-table.json. The router is tested against these; test/support/signin-state.ts is the reference that checks them.',
      signin: signinValue,
      nowSeconds: now,
      valid: [
        { name: 'signin-state with nonce, current key', payload: good, state: goodState },
        { name: 'logout state, no nonce', payload: logout, state: mintState(signin, logout) },
        { name: 'previous key still listed', payload: oldKey, state: mintState(signin, oldKey) },
      ],
      invalid: [
        { name: 'expired (exp equals now)', why: 'expired', state: mintState(signin, expired) },
        { name: 'payload changed, MAC kept', why: 'hmac', state: tampered },
        { name: 'kid not in the signin entry', why: 'kid', state: unknownKid },
        { name: 'MAC from another payload', why: 'hmac', state: `${enc}.${mintState(signin, logout).split('.')[1]}` },
        { name: 'MAC with a non-canonical last character', why: 'hmac', state: `${enc}.${flipLast(mac)}` },
        { name: 'MAC with a character outside base64url', why: 'hmac', state: `${enc}.${mac}!` },
        { name: 'payload is JSON null', why: 'shape', state: `${Buffer.from('null').toString('base64url')}.${mac}` },
        { name: 'payload is a JSON array', why: 'shape', state: `${Buffer.from('[1]').toString('base64url')}.${mac}` },
        { name: 'no dot', why: 'shape', state: enc },
        { name: 'payload not JSON', why: 'shape', state: `${Buffer.from('nope').toString('base64url')}.${mac}` },
      ],
    },
    null,
    2,
  ) + '\n',
);

const app = {
  authorizeEndpoint: 'https://auth.example.com/oauth2/authorize',
  tokenEndpoint: 'https://auth.example.com/oauth2/token',
  clientId: 'exampleclientid',
  scopes: 'openid sample/read',
  tenantClaim: 'tenant_id',
  exchangeEndpoint: 'https://api.example.com/prod/oauth2/token',
};
const tenant = { tenantId: '01HZX8K9P0QRST7VWXYZ1A2B3C', displayName: 'Acme Corp', rev: 1795080000000 };
const dedicated = { tenantId: '01HZX8K9P0QRST7VWXYZ1A2B3E', displayName: "Example 'Two' / Ltd", rev: 1795080000123 };
const dedicatedPooledHost = '01hzx8k9p0qrst7vwxyz1a2b3e.tenants.example.com';
fs.writeFileSync(
  path.join(dir, 'config-json.json'),
  JSON.stringify(
    {
      _comment:
        'Golden /config.json bodies (spec §3.2, §3.5) for the route-table.json entries, appDomain app.example.com in single mode and tenants.example.com in host mode. The router generates these; the SPA reads them. Field order is not part of the contract.',
      cases: [
        { name: 'single, appDomain', addressing: 'single', host: 'app.example.com', body: app },
        {
          name: 'single, dedicated domain',
          addressing: 'single',
          host: 'portal.example.com',
          body: { ...app, ...dedicated, signInHost: 'app.example.com' },
        },
        {
          name: 'host, pooled tenant host',
          addressing: 'host',
          host,
          body: { ...app, ...tenant, redirectUri: 'https://login.tenants.example.com/callback' },
        },
        {
          name: 'host, dedicated domain',
          addressing: 'host',
          host: 'portal.example.com',
          body: { ...app, ...dedicated, redirectUri: 'https://login.tenants.example.com/callback', signInHost: dedicatedPooledHost },
        },
      ],
    },
    null,
    2,
  ) + '\n',
);
