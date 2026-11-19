// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Synth-time check of the `allowedOrigins` input (spec §3.3, §5.4.1,
 * ADR-0040). Imported by the CDK app only, never by a function entry, so
 * `tldts` (the Public Suffix List rules) never reaches a bundle. The
 * runtime match lives in `src/token-exchange/cors.ts`.
 */

import { getPublicSuffix } from 'tldts';

/** At most this many entries (§5.4.1). */
export const MAX_ALLOWED_ORIGINS = 20;
/** At most this many characters, entries joined with `,` (§5.4.1). */
export const MAX_ALLOWED_ORIGINS_LENGTH = 1024;

const LABEL = '(?!-)[a-z0-9-]{1,63}(?<!-)';
const NAME = `${LABEL}(?:\\.${LABEL})+`;
const PORT = '[1-9][0-9]{0,4}';
const EXACT = new RegExp(`^https://(${NAME})(?::(${PORT}))?$`);
const PATTERN = new RegExp(`^https://\\*\\.(${NAME})$`);

/**
 * Domains where other customers' pages sit one label under the domain or
 * under one of its subdomains (S3 path-style URLs on `s3.amazonaws.com`,
 * `s3.eu-central-1.amazonaws.com`), though neither is always a public
 * suffix. A pattern under them is refused (§5.4.1); a vendor's own AWS
 * hostname goes in as an exact entry.
 */
export const SHARED_HOSTING_DOMAINS: readonly string[] = ['amazonaws.com', 'amazonaws.com.cn'];

/**
 * S3 path-style endpoints (`s3.amazonaws.com`, `s3.eu-central-1.amazonaws.com`,
 * `s3-eu-west-1.amazonaws.com`, `s3.dualstack.<region>.amazonaws.com`): one
 * origin serves every bucket's path-style pages, so an exact entry for one
 * of them trusts all of those pages (§5.4.1).
 */
const S3_PATH_STYLE_HOST = /^s3(?:[.-][a-z0-9-]+)*\.amazonaws\.com(?:\.cn)?$/;

/**
 * Turns the context value or stack prop into a list. A missing value, an
 * empty string and `[]` all mean no list. A string is split on `,` with no
 * trimming, so `a, b` or `a,,b` fails the entry check below.
 */
export function readAllowedOrigins(value: unknown): string[] {
  if (value === undefined || value === null || value === '') {
    return [];
  }
  if (typeof value === 'string') {
    return value.split(',');
  }
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
    return [...value];
  }
  throw new Error('allowedOrigins must be a comma-separated string or a list of strings');
}

/** Throws, naming the entry, unless every entry and the list as a whole pass §5.4.1. */
export function validateAllowedOrigins(origins: readonly string[]): void {
  if (origins.length > MAX_ALLOWED_ORIGINS) {
    throw new Error(`allowedOrigins has ${origins.length} entries; at most ${MAX_ALLOWED_ORIGINS} are allowed`);
  }
  const joined = origins.join(',');
  if (joined.length > MAX_ALLOWED_ORIGINS_LENGTH) {
    throw new Error(
      `allowedOrigins is ${joined.length} characters; at most ${MAX_ALLOWED_ORIGINS_LENGTH} are allowed`,
    );
  }
  const seen = new Set<string>();
  for (const entry of origins) {
    checkEntry(entry);
    if (seen.has(entry)) {
      throw new Error(`allowedOrigins entry '${entry}' is repeated`);
    }
    seen.add(entry);
  }
}

function checkEntry(entry: string): void {
  const refuse = (why: string): never => {
    throw new Error(`allowedOrigins entry '${entry}' is refused: ${why} (spec §5.4.1)`);
  };
  const exact = EXACT.exec(entry);
  if (exact !== null) {
    checkName(exact[1], refuse);
    if (S3_PATH_STYLE_HOST.test(exact[1])) {
      refuse(`'${exact[1]}' serves every bucket's S3 path-style pages from one origin`);
    }
    const port = exact[2];
    if (port !== undefined) {
      const n = Number(port);
      if (n > 65535) refuse('port above 65535');
      if (n === 443) refuse('browsers leave :443 out of Origin, so it never matches');
    }
    return;
  }
  const pattern = PATTERN.exec(entry);
  if (pattern !== null) {
    const domain = pattern[1];
    checkName(domain, refuse);
    if (getPublicSuffix(domain, { allowPrivateDomains: true }) === domain) {
      refuse(`'${domain}' is a public suffix, so the pattern would trust hosts other parties run`);
    }
    if (SHARED_HOSTING_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`))) {
      refuse(`other customers' pages sit one label under '${domain}' (S3 path-style URLs)`);
    }
    return;
  }
  refuse('not https://<host>[:<port>] or https://*.<domain> in lower case');
}

function checkName(name: string, refuse: (why: string) => never): void {
  if (name.length > 253) refuse('host longer than 253 characters');
  const labels = name.split('.');
  // A URL parser reads a host whose last label is a number (decimal or
  // 0x-hex) as an IPv4 address, so such an entry could never match.
  if (/^(?:[0-9]+|0x[0-9a-f]*)$/.test(labels[labels.length - 1])) refuse('an IP address is not a host name');
}
