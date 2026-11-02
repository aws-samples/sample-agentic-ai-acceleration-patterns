// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { selectTenant, TenantSelectionError } from '../../src/shared/tenant';

/** Tenant selection (spec P-3, §5.1, §6.2.1, ADR-0038). */
function refusal(fn: () => unknown): { status: number; reason: string } {
  try {
    fn();
  } catch (err) {
    if (err instanceof TenantSelectionError) {
      return { status: err.status, reason: err.reason };
    }
    throw err;
  }
  throw new Error('expected a TenantSelectionError');
}

describe('selectTenant', () => {
  it('a single-tenant token selects its tenant, with or without a matching header', () => {
    expect(selectTenant({ tenant_id: 't-a' }, undefined, false)).toBe('t-a');
    expect(selectTenant({ tenant_id: 't-a' }, 't-a', false)).toBe('t-a');
    expect(selectTenant({ tenant_id: 't-a' }, 't-a', true)).toBe('t-a');
  });

  it('the header can never add a tenant the token does not name', () => {
    expect(refusal(() => selectTenant({ tenant_id: 't-a' }, 't-b', false))).toEqual({ status: 403, reason: 'tenant_not_allowed' });
    expect(refusal(() => selectTenant({ tenants: ['t-a', 't-b'] }, 't-c', true))).toEqual({ status: 403, reason: 'tenant_not_allowed' });
  });

  it('a multi-tenant token needs multiTenant and a header naming one of its tenants', () => {
    expect(selectTenant({ tenants: ['t-a', 't-b'] }, 't-b', true)).toBe('t-b');
    expect(refusal(() => selectTenant({ tenants: ['t-a'] }, 't-a', false))).toEqual({ status: 403, reason: 'multi_tenant_token' });
    expect(refusal(() => selectTenant({ tenants: ['t-a', 't-b'] }, undefined, true))).toEqual({ status: 400, reason: 'tenant_required' });
  });

  it('refuses tokens with both claims, neither, or malformed tenants', () => {
    expect(refusal(() => selectTenant({ tenant_id: 't-a', tenants: ['t-a'] }, 't-a', true))).toEqual({ status: 403, reason: 'tenant_not_allowed' });
    expect(refusal(() => selectTenant({}, undefined, true))).toEqual({ status: 403, reason: 'no_tenant' });
    expect(refusal(() => selectTenant({ tenant_id: '' }, undefined, false))).toEqual({ status: 403, reason: 'no_tenant' });
    expect(refusal(() => selectTenant({ tenant_id: 42 }, undefined, false))).toEqual({ status: 403, reason: 'no_tenant' });
    expect(refusal(() => selectTenant({ tenants: [] }, 't-a', true))).toEqual({ status: 403, reason: 'no_tenant' });
    expect(refusal(() => selectTenant({ tenants: 't-a' }, 't-a', true))).toEqual({ status: 403, reason: 'no_tenant' });
    expect(refusal(() => selectTenant({ tenants: ['t a'] }, 't-a', true))).toEqual({ status: 403, reason: 'no_tenant' });
  });

  it('refuses a malformed header with 400 before looking at the claims', () => {
    expect(refusal(() => selectTenant({ tenant_id: 't-a' }, 't a', false))).toEqual({ status: 400, reason: 'malformed_tenant_header' });
    expect(refusal(() => selectTenant({ tenant_id: 't-a' }, 'x'.repeat(65), false))).toEqual({ status: 400, reason: 'malformed_tenant_header' });
    expect(refusal(() => selectTenant({ tenant_id: 't-a' }, '', false))).toEqual({ status: 400, reason: 'malformed_tenant_header' });
  });
});
