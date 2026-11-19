// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * CORS for the token exchange (spec §5.4.1, ADR-0040). The list was checked
 * at synth (`src/shared/allowed-origins.ts`); this module only matches.
 *
 * The match is on the exact string the browser sent: an exact entry, or a
 * pattern `https://*.<domain>` against `https://<one label>.<domain>`.
 * Nothing is lower-cased or trimmed, there is no suffix match, and a
 * pattern takes no port. An unmatched origin is never refused; it only gets
 * no `Access-Control-Allow-Origin`.
 */

/** The part of a Smithy HttpRequest or HttpResponse these helpers touch. */
export interface HasHeaders {
  headers: Record<string, string>;
}

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const PATTERN_PREFIX = 'https://*.';
const FORM_MEDIA_TYPE = 'application/x-www-form-urlencoded';

/** The stack's list, from `ALLOWED_ORIGINS` (entries joined with `,`); unset or '' is no list. */
export function parseAllowedOriginsEnv(value: string | undefined): string[] {
  return value === undefined || value === '' ? [] : value.split(',');
}

/** True if `origin` is allowed by one list entry. */
export function originMatches(allowed: readonly string[], origin: string): boolean {
  for (const entry of allowed) {
    if (entry.startsWith(PATTERN_PREFIX)) {
      const suffix = `.${entry.slice(PATTERN_PREFIX.length)}`;
      if (origin.startsWith('https://') && origin.endsWith(suffix)) {
        const label = origin.slice('https://'.length, origin.length - suffix.length);
        if (LABEL.test(label)) {
          return true;
        }
      }
    } else if (entry === origin) {
      return true;
    }
  }
  return false;
}

/**
 * The single `Origin` value of a REST v1 event, header name matched
 * case-insensitively; undefined if there is none or more than one.
 */
export function requestOrigin(
  multiValueHeaders: Record<string, string[] | undefined> | null | undefined,
): string | undefined {
  const values: string[] = [];
  for (const [name, list] of Object.entries(multiValueHeaders ?? {})) {
    if (name.toLowerCase() === 'origin' && list !== undefined) {
      values.push(...list);
    }
  }
  return values.length === 1 ? values[0] : undefined;
}

/**
 * The headers to add to every answer: `Vary: Origin` whenever the list is
 * set, and `Access-Control-Allow-Origin` for a listed origin. `null` is a
 * literal origin value no entry can equal, so it never matches.
 */
export function corsHeaders(allowed: readonly string[], origin: string | undefined): Record<string, string> {
  if (allowed.length === 0) {
    return {};
  }
  const headers: Record<string, string> = { Vary: 'Origin' };
  if (origin !== undefined && originMatches(allowed, origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

/**
 * Adds `extra` to the answer's headers. `Vary` is merged: its tokens are
 * added to an existing `Vary` of any case, keeping the ones already there.
 * Any other header replaces one of the same name in any case.
 */
export function addHeaders(response: HasHeaders, extra: Record<string, string>): void {
  for (const [name, value] of Object.entries(extra)) {
    const lower = name.toLowerCase();
    const tokens: string[] = [];
    for (const key of Object.keys(response.headers)) {
      if (key.toLowerCase() === lower) {
        if (lower === 'vary') {
          tokens.push(...splitTokens(response.headers[key]));
        }
        delete response.headers[key];
      }
    }
    if (lower === 'vary') {
      for (const token of splitTokens(value)) {
        if (!tokens.some((t) => t.toLowerCase() === token.toLowerCase())) {
          tokens.push(token);
        }
      }
      response.headers[name] = tokens.join(', ');
    } else {
      response.headers[name] = value;
    }
  }
}

function splitTokens(value: string): string[] {
  return value.split(',').map((t) => t.trim()).filter((t) => t !== '');
}

/**
 * Drops media-type parameters from a form `Content-Type`, because the
 * generated deserializer accepts only the bare type and a browser posting a
 * `URLSearchParams` body adds `;charset=UTF-8`. Other types are left alone
 * and refused by the framework as before.
 */
export function normaliseContentType(request: HasHeaders): void {
  for (const key of Object.keys(request.headers)) {
    if (key.toLowerCase() === 'content-type') {
      const bare = request.headers[key].split(';')[0].trim();
      if (bare.toLowerCase() === FORM_MEDIA_TYPE) {
        request.headers[key] = FORM_MEDIA_TYPE;
      }
    }
  }
}
