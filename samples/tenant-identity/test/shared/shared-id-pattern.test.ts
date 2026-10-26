// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ULID_PATTERN } from '../../src/shared/constants';

/**
 * Pins the tenant id pattern this sample shares with `control-plane`.
 *
 * The two samples are joined at deploy time (control-plane passes its tenant
 * id to this sample's `CreateTenant`, control-plane mounting spec M-P-1), so
 * both must accept exactly the same ids. The pattern is deliberately copied
 * rather than imported from a shared folder (samples depend on interfaces,
 * not on each other's code, sample standard §1.1). This test is the drift
 * alarm: change the pattern in one sample and this fails until the other
 * sample and this constant move with it.
 */
const SHARED_ULID_PATTERN = '^[0-9A-HJKMNP-TV-Z]{26}$';

describe('shared tenant id pattern', () => {
  it('matches the pattern control-plane uses for TenantId', () => {
    expect(ULID_PATTERN.source).toBe(SHARED_ULID_PATTERN);
  });

  it('is the pattern on TenantId in the Smithy model', () => {
    const model = readFileSync(join(__dirname, '..', '..', 'model', '__global.smithy'), 'utf8');
    const tenantId = /@pattern\("([^"]+)"\)\s*\nstring TenantId\b/.exec(model);
    expect(tenantId?.[1]).toBe(SHARED_ULID_PATTERN);
  });

  it('accepts a Crockford ULID and rejects look-alikes', () => {
    const re = new RegExp(SHARED_ULID_PATTERN);
    expect(re.test('01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe(true);
    expect(re.test('01ARZ3NDEKTSV4RRFFQ69G5FA')).toBe(false); // 25 chars
    expect(re.test('01arz3ndektsv4rrffq69g5fav')).toBe(false); // lower case
    expect(re.test('01ARZ3NDEKTSV4RRFFQ69G5FAI')).toBe(false); // I is not base32
  });
});
