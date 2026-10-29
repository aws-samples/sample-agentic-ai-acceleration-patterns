// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { INVALID_SCOPE, SCOPE_TENANT_ADMIN } from '../../src/shared/constants';
import { InvalidInputError } from '../../src/shared/errors';
import {
  assertAttributeFits,
  assertGrantableScopes,
  assertRegistrableScope,
  assertTenantScopes,
  decodeScopeList,
  decodeScopeMap,
  decodeScopeMapEntry,
  effectiveScopes,
  encodeScopeList,
  encodeScopeMap,
  isReservedScope,
  isScopeName,
  SCOPE_REFUSALS,
  scopeOwner,
} from '../../src/shared/scopes';

/**
 * The shared scope rules (spec §8.1, ADR-0034, ADR-0035, ADR-0036): names,
 * the three validations the doors run, `held` without the admin scope, and
 * the two encodings of `custom:scopes`.
 */

const T1 = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const T2 = '01BX5ZZKBKACTAV9WEVGEMMVRZ';

function refusal(fn: () => void): string {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidInputError);
    return (error as Error).message;
  }
  throw new Error('expected a refusal');
}

describe('scope names (ADR-0034)', () => {
  it.each(['sample/read', 'billing-v2/invoke', 'a/b', 'default/chat-0'])('%s is a scope name', (name) => {
    expect(isScopeName(name)).toBe(true);
  });

  it.each(['Sample/read', 'sample', 'sample/', '/read', 'sample/read/x', 'sample read', 'sample_x/read', '', 'a/', 42])(
    '%j is not a scope name',
    (name) => {
      expect(isScopeName(name)).toBe(false);
    },
  );

  it('the owner is the text before the slash; tenant-admin is reserved', () => {
    expect(scopeOwner('billing/read')).toBe('billing');
    expect(isReservedScope(SCOPE_TENANT_ADMIN)).toBe(true);
    expect(isReservedScope('tenant-admin/anything')).toBe(true);
    expect(isReservedScope('tenant-admins/users')).toBe(false);
  });

  it('every refusal message starts with the invalid_scope prefix and names no input', () => {
    for (const message of Object.values(SCOPE_REFUSALS)) {
      expect(message.startsWith(`${INVALID_SCOPE}: `)).toBe(true);
    }
  });
});

describe('assertRegistrableScope (PutScope, ADR-0034)', () => {
  it('accepts a well-formed name under any owner but tenant-admin', () => {
    expect(() => assertRegistrableScope('billing/read')).not.toThrow();
    expect(refusal(() => assertRegistrableScope('tenant-admin/billing'))).toBe(SCOPE_REFUSALS.reservedOwner);
    expect(refusal(() => assertRegistrableScope(SCOPE_TENANT_ADMIN))).toBe(SCOPE_REFUSALS.reservedOwner);
    expect(refusal(() => assertRegistrableScope('Billing/read'))).toBe(SCOPE_REFUSALS.malformed);
  });
});

describe('assertTenantScopes (CreateTenant / UpdateTenant, ADR-0035)', () => {
  const catalogue = new Set(['sample/read', 'sample/write']);

  it('accepts an empty list and any subset of the catalogue', () => {
    expect(() => assertTenantScopes([], catalogue)).not.toThrow();
    expect(() => assertTenantScopes(['sample/write', 'sample/read'], catalogue)).not.toThrow();
  });

  it('refuses a duplicate, a malformed name, an unregistered name and the admin scope', () => {
    expect(refusal(() => assertTenantScopes(['sample/read', 'sample/read'], catalogue))).toBe(SCOPE_REFUSALS.duplicate);
    expect(refusal(() => assertTenantScopes(['Sample/read'], catalogue))).toBe(SCOPE_REFUSALS.malformed);
    expect(refusal(() => assertTenantScopes(['billing/read'], catalogue))).toBe(SCOPE_REFUSALS.notInCatalogue);
    expect(refusal(() => assertTenantScopes([SCOPE_TENANT_ADMIN], catalogue))).toBe(SCOPE_REFUSALS.adminScope);
  });

  it('an empty catalogue (cold start) refuses every name', () => {
    expect(refusal(() => assertTenantScopes(['sample/read'], new Set()))).toBe(SCOPE_REFUSALS.notInCatalogue);
  });
});

describe('assertGrantableScopes (UpdateUser / UpdateTenantUser, ADR-0036)', () => {
  const entitled = ['sample/read', 'sample/write'];

  it('accepts an empty list and any subset of the tenant entitlement', () => {
    expect(() => assertGrantableScopes([], entitled)).not.toThrow();
    expect(() => assertGrantableScopes(['sample/write'], entitled)).not.toThrow();
  });

  it('refuses a duplicate, a malformed name, a scope the tenant does not hold, and the admin scope', () => {
    expect(refusal(() => assertGrantableScopes(['sample/read', 'sample/read'], entitled))).toBe(SCOPE_REFUSALS.duplicate);
    expect(refusal(() => assertGrantableScopes(['sample read'], entitled))).toBe(SCOPE_REFUSALS.malformed);
    expect(refusal(() => assertGrantableScopes(['billing/read'], entitled))).toBe(SCOPE_REFUSALS.notEntitled);
    expect(refusal(() => assertGrantableScopes([SCOPE_TENANT_ADMIN], entitled))).toBe(SCOPE_REFUSALS.adminScope);
  });

  it('a tenant with no scopes can only be granted nothing', () => {
    expect(() => assertGrantableScopes([], [])).not.toThrow();
    expect(refusal(() => assertGrantableScopes(['sample/read'], []))).toBe(SCOPE_REFUSALS.notEntitled);
  });
});

describe('effectiveScopes = catalogue ∩ entitlement ∩ grant (spec §8.1)', () => {
  const catalogue = new Set(['sample/read', 'sample/write', 'billing/read']);

  it('an absent grant means all of the entitlement that is in the catalogue, in entitlement order', () => {
    expect(effectiveScopes(catalogue, ['sample/write', 'sample/read', 'gone/x'], undefined)).toEqual(['sample/write', 'sample/read']);
  });

  it('a grant cuts the entitlement and never adds to it', () => {
    expect(effectiveScopes(catalogue, ['sample/read', 'sample/write'], ['sample/write', 'billing/read'])).toEqual(['sample/write']);
    expect(effectiveScopes(catalogue, ['sample/read'], [])).toEqual([]);
  });

  it('an empty catalogue or an empty entitlement yields nothing', () => {
    expect(effectiveScopes(new Set(), ['sample/read'], undefined)).toEqual([]);
    expect(effectiveScopes(catalogue, [], undefined)).toEqual([]);
  });
});

describe('custom:scopes encodings (ADR-0036)', () => {
  it('single-tenant: space-separated list; empty list is the empty string, absent is undefined', () => {
    expect(encodeScopeList(['a/b', 'c/d'])).toBe('a/b c/d');
    expect(encodeScopeList([])).toBe('');
    expect(decodeScopeList('a/b  c/d')).toEqual(['a/b', 'c/d']);
    expect(decodeScopeList('')).toEqual([]);
    expect(decodeScopeList(undefined)).toBeUndefined();
  });

  it('multi-tenant: a JSON object keyed by tenant id, one key replaced at a time', () => {
    const first = encodeScopeMap(undefined, T1, ['a/b']);
    expect(JSON.parse(first)).toEqual({ [T1]: 'a/b' });
    const second = encodeScopeMap(first, T2, []);
    expect(JSON.parse(second)).toEqual({ [T1]: 'a/b', [T2]: '' });
    const replaced = encodeScopeMap(second, T1, ['c/d', 'a/b']);
    expect(JSON.parse(replaced)).toEqual({ [T1]: 'c/d a/b', [T2]: '' });
  });

  it('multi-tenant decoding: missing key or absent attribute is undefined; a present key is its list', () => {
    const value = JSON.stringify({ [T1]: 'a/b c/d', [T2]: '' });
    expect(decodeScopeMapEntry(value, T1)).toEqual(['a/b', 'c/d']);
    expect(decodeScopeMapEntry(value, T2)).toEqual([]);
    expect(decodeScopeMapEntry(value, '01C0ABCDEFGHJKMNPQRSTVWXYZ')).toBeUndefined();
    expect(decodeScopeMapEntry(undefined, T1)).toBeUndefined();
  });

  it.each(['a/b c/d', '[]', '42', 'null', '{"x": 1}', '{bad json'])(
    'multi-tenant decoding of %j (not a JSON object of strings) is "nothing" for every tenant, and encoding replaces it',
    (bad) => {
      expect(decodeScopeMap(bad)).toBeUndefined();
      expect(decodeScopeMapEntry(bad, T1)).toEqual([]);
      expect(JSON.parse(encodeScopeMap(bad, T1, ['a/b']))).toEqual({ [T1]: 'a/b' });
    },
  );

  it('an encoded value longer than the Cognito limit is refused before the write', () => {
    expect(() => assertAttributeFits('x'.repeat(2048))).not.toThrow();
    expect(refusal(() => assertAttributeFits('x'.repeat(2049)))).toBe(SCOPE_REFUSALS.tooLong);
  });
});
