// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The router source as CloudFront takes it: within the 10 KB function
 * limit after the stack substitutes realistic values, its only imports
 * `cloudfront` and `crypto`, and every build constant a ROUTER_TOKENS
 * literal.
 */

import * as fs from 'fs';
import { ROUTER_PATH, substitutedSource, tokenValues } from './harness';
import { ROUTER_TOKENS } from '../../src/shared/contracts';

/** CloudFront Functions' code size limit. */
const MAX_FUNCTION_BYTES = 10_240;

describe('router source', () => {
  test('§3.1: with a 64-character appDomain in host mode it is at most 10,240 bytes', () => {
    const appDomain = `${'x'.repeat(52)}.example.com`;
    expect(appDomain).toHaveLength(64);
    const out = substitutedSource(tokenValues({ appDomain, addressing: 'host', tenantClaim: 'custom:tenant_identifier', agentIngress: 'on' }));
    const bytes = Buffer.byteLength(out, 'utf8');
    expect(bytes).toBeLessThanOrEqual(MAX_FUNCTION_BYTES);
  });

  test('§3.1: imports only cloudfront and crypto', () => {
    const src = fs.readFileSync(ROUTER_PATH, 'utf8');
    const imports = src.split('\n').filter((l) => /^\s*import\b/.test(l));
    expect(imports).toEqual(["import cf from 'cloudfront';", "import crypto from 'crypto';"]);
    expect(src).not.toMatch(/\brequire\s*\(|\bexport\b|\beval\s*\(|new Function/);
  });

  test('ROUTER_TOKENS: every token appears once, as a double-quoted literal, and nothing else is compiled in', () => {
    const src = fs.readFileSync(ROUTER_PATH, 'utf8');
    for (const t of Object.values(ROUTER_TOKENS)) {
      expect(src.split(`"${t}"`)).toHaveLength(2);
    }
    expect(src.match(/__TFD_[A-Z_]+__/g)).toHaveLength(Object.keys(ROUTER_TOKENS).length);
  });

  test('no await inside call arguments, which cloudfront-js-2.0 refuses at load (smoke 2026-11-19)', () => {
    const src = fs.readFileSync(ROUTER_PATH, 'utf8');
    const code = src.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    expect(code).not.toMatch(/[\w\])]\s*\(\s*await\b/);
    expect(code).not.toMatch(/,\s*await\b/);
  });

  test('every line fits the 150-character lint limit and the file is ASCII', () => {
    const src = fs.readFileSync(ROUTER_PATH, 'utf8');
    for (const line of src.split('\n')) expect(line.length).toBeLessThanOrEqual(150);
    expect(/^[\x09\x0a\x20-\x7e]*$/.test(src.replace(/§/g, ''))).toBe(true);
  });
});
