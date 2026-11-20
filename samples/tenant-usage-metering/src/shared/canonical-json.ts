// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Canonical JSON in the sense of RFC 8785 for the values this sample stores:
 * objects, arrays, strings, booleans, null and integers. Object members are
 * sorted by their UTF-16 code units, which is what RFC 8785 specifies, and
 * strings use `JSON.stringify`'s escaping, which matches RFC 8785 for
 * strings. The recount's tie-break (spec §4.9) compares these strings, so it
 * does not depend on which object format an event was read from.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value) || !Number.isInteger(value)) {
        throw new TypeError(`canonicalJson supports integers only, got ${value}`);
      }
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
      }
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, member]) => member !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`).join(',')}}`;
    }
    default:
      throw new TypeError(`canonicalJson cannot encode a ${typeof value}`);
  }
}
