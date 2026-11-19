// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FIXTURES } from './helpers';
import { buildContentSecurityPolicy, MAX_CSP_LENGTH, readCspHashes } from '../../src/edge/csp';

const H1 = "'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='";
const H2 = "'sha384-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'";
const S1 = "'sha256-SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS='";

const base = {
  hashes: { scriptSrc: [H1, H2], styleSrc: [] },
  tokenOrigin: 'https://login.auth.example.com',
  authorizeOrigin: 'https://login.auth.example.com',
  reporting: false,
};

function spaDir(csp: unknown, withIndex = true): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tfd-spa-'));
  if (withIndex) fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html>');
  if (csp !== undefined) fs.writeFileSync(path.join(dir, 'csp.json'), typeof csp === 'string' ? csp : JSON.stringify(csp));
  return dir;
}

describe('Content-Security-Policy (spec §7.1, ADR-0008, ADR-0023)', () => {
  it('builds every §7.1 directive in order, single mode', () => {
    expect(buildContentSecurityPolicy(base)).toBe([
      "default-src 'self'",
      `script-src ${H1} ${H2} 'strict-dynamic' 'report-sample'`,
      "connect-src 'self' https://login.auth.example.com",
      "img-src 'self' data:",
      "style-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self' https://login.auth.example.com",
      "frame-ancestors 'none'",
      "worker-src 'none'",
      "require-trusted-types-for 'script'",
    ].join('; '));
  });

  it('adds the exchange origin, the sign-in host, the style hashes and report-to fd when set', () => {
    const csp = buildContentSecurityPolicy({
      ...base,
      hashes: { scriptSrc: [H1], styleSrc: [S1] },
      tokenOrigin: 'https://tokens.example.com',
      exchangeOrigin: 'https://exchange.example.com',
      signinOrigin: 'https://login.app.example.com',
      reporting: true,
    });
    expect(csp).toContain("connect-src 'self' https://tokens.example.com https://exchange.example.com;");
    expect(csp).toContain("form-action 'self' https://login.auth.example.com https://login.app.example.com;");
    expect(csp).toContain(`style-src 'self' ${S1};`);
    expect(csp.endsWith("require-trusted-types-for 'script'; report-to fd")).toBe(true);
  });

  it('names an origin once when the exchange shares the token origin', () => {
    const csp = buildContentSecurityPolicy({ ...base, exchangeOrigin: base.tokenOrigin });
    expect(csp).toContain("connect-src 'self' https://login.auth.example.com;");
  });

  it(`refuses a policy over CloudFront's ${MAX_CSP_LENGTH} characters`, () => {
    const many = Array.from({ length: 40 }, (_, i) => `'sha384-${String(i).padStart(64, 'A')}'`);
    expect(() => buildContentSecurityPolicy({ ...base, hashes: { scriptSrc: many, styleSrc: [] } })).toThrow(/over CloudFront's 1783/);
  });

  describe('csp.json, the contract with the SPA build', () => {
    it('reads the fixture', () => {
      const hashes = readCspHashes(path.join(FIXTURES, 'spa'));
      expect(hashes.scriptSrc).toHaveLength(3);
      expect(hashes.styleSrc).toEqual([]);
    });
    it('treats an absent style-src as none and drops repeats', () => {
      expect(readCspHashes(spaDir({ 'script-src': [H1, H1] }))).toEqual({ scriptSrc: [H1], styleSrc: [] });
    });
    it.each([
      [undefined, /must hold the built SPA/],
      ['not json', /is not JSON/],
      [{ 'script-src': [] }, /names no script-src hash/],
      [{ 'script-src': ['sha256-unquoted='] }, /script-src must be a list of hash sources/],
      [{ 'script-src': [H1], 'style-src': ["'unsafe-inline'"] }, /style-src must be a list of hash sources/],
      [{ 'script-src': "'sha256-x='" }, /script-src must be a list/],
    ])('refuses %j', (csp, error) => {
      expect(() => readCspHashes(spaDir(csp))).toThrow(error);
    });
    it('needs index.html beside it', () => {
      expect(() => readCspHashes(spaDir({ 'script-src': [H1] }, false))).toThrow(/index.html/);
    });
  });
});
