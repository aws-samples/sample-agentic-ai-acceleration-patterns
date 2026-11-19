// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The Content-Security-Policy of the response headers policy (spec §7.1,
 * ADR-0008, ADR-0023). The SPA build writes the hash sources of its inline
 * scripts and styles to `csp.json` at the root of `spaSource`; the stack
 * reads it at synth and builds the rest of the policy from its inputs, with
 * no network call.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** The file the SPA build writes next to `index.html`. */
export const CSP_FILE = 'csp.json';

/** CloudFront's limit on a CSP value in a response headers policy (ADR-0008). */
export const MAX_CSP_LENGTH = 1783;

/** The reporting endpoint's name in `Reporting-Endpoints` and `report-to` (§7.1). */
export const REPORT_GROUP = 'fd';

/** A CSP hash source, quotes included: `'sha256-<base64>'`. */
const HASH_SOURCE = /^'sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2}'$/;

/** The `csp.json` contract with the SPA build (build slice S4). */
export interface CspHashes {
  readonly scriptSrc: readonly string[];
  readonly styleSrc: readonly string[];
}

/** Reads and checks `<spaSource>/csp.json`. Throws when it is missing or malformed. */
export function readCspHashes(spaSource: string): CspHashes {
  const file = path.join(spaSource, CSP_FILE);
  if (!fs.existsSync(path.join(spaSource, 'index.html')) || !fs.existsSync(file)) {
    throw new Error(`spaSource ${spaSource} must hold the built SPA: index.html and ${CSP_FILE} (spec §3.6, §7.1)`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`${file} is not JSON`);
  }
  const o = parsed as Record<string, unknown>;
  const scriptSrc = hashList(file, o, 'script-src');
  const styleSrc = hashList(file, o, 'style-src');
  if (scriptSrc.length === 0) {
    throw new Error(`${file} names no script-src hash: the SPA's entry, import map and callback script each need one (§7.1)`);
  }
  return { scriptSrc, styleSrc };
}

function hashList(file: string, o: Record<string, unknown>, key: string): string[] {
  const list = o?.[key] ?? [];
  if (!Array.isArray(list) || !list.every((h) => typeof h === 'string' && HASH_SOURCE.test(h))) {
    throw new Error(`${file} ${key} must be a list of hash sources such as 'sha256-<base64>'`);
  }
  return [...new Set(list as string[])];
}

export interface CspSettings {
  readonly hashes: CspHashes;
  /** Origin of the issuer's token endpoint. */
  readonly tokenOrigin: string;
  /** Origin of `exchangeEndpoint`, when set. */
  readonly exchangeOrigin?: string;
  /** Origin of the issuer's authorize endpoint. */
  readonly authorizeOrigin: string;
  /** `https://login.<appDomain>` in `host` mode. */
  readonly signinOrigin?: string;
  /** True when `reportingEndpoint` is set. */
  readonly reporting: boolean;
}

/** Builds the §7.1 policy, directive by directive. Throws when it exceeds CloudFront's limit. */
export function buildContentSecurityPolicy(s: CspSettings): string {
  const directives = [
    "default-src 'self'",
    `script-src ${[...s.hashes.scriptSrc, "'strict-dynamic'", "'report-sample'"].join(' ')}`,
    `connect-src ${unique(["'self'", s.tokenOrigin, s.exchangeOrigin]).join(' ')}`,
    "img-src 'self' data:",
    `style-src ${["'self'", ...s.hashes.styleSrc].join(' ')}`,
    "object-src 'none'",
    "base-uri 'none'",
    `form-action ${unique(["'self'", s.authorizeOrigin, s.signinOrigin]).join(' ')}`,
    "frame-ancestors 'none'",
    "worker-src 'none'",
    "require-trusted-types-for 'script'",
  ];
  if (s.reporting) {
    directives.push(`report-to ${REPORT_GROUP}`);
  }
  const policy = directives.join('; ');
  if (policy.length > MAX_CSP_LENGTH) {
    throw new Error(
      `The Content-Security-Policy is ${policy.length} characters, over CloudFront's ${MAX_CSP_LENGTH}: `
      + 'drop the previous release\'s hashes from csp.json (ADR-0008)',
    );
  }
  return policy;
}

function unique(values: (string | undefined)[]): string[] {
  return [...new Set(values.filter((v): v is string => v !== undefined))];
}
