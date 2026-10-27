// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Pins the tenant id pattern this sample shares with `tenant-identity`.
 *
 * The two samples are joined at deploy time (this sample passes its tenant
 * id to tenant-identity's `CreateTenant`, control-plane mounting spec M-P-1),
 * so both must accept exactly the same ids. The pattern is deliberately
 * copied rather than imported from a shared folder (samples depend on
 * interfaces, not on each other's code, sample standard §1.1). This test is
 * the drift alarm: change the pattern in one sample and this fails until the
 * other sample moves with it.
 */
const SHARED_ULID_PATTERN = '^[0-9A-HJKMNP-TV-Z]{26}$';

function patternOn(file: string, shape: string): string | undefined {
  const model = readFileSync(join(__dirname, '..', '..', 'model', file), 'utf8');
  const re = new RegExp(`@pattern\\("([^"]+)"\\)\\s*\\nstring ${shape}\\b`);
  return re.exec(model)?.[1];
}

describe('shared id pattern', () => {
  it('TenantId carries the pattern tenant-identity accepts', () => {
    expect(patternOn('__global.smithy', 'TenantId')).toBe(SHARED_ULID_PATTERN);
  });

  it('CellId uses the same ULID pattern', () => {
    expect(patternOn('cell.smithy', 'CellId')).toBe(SHARED_ULID_PATTERN);
  });

  it('accepts a Crockford ULID and rejects look-alikes', () => {
    const re = new RegExp(SHARED_ULID_PATTERN);
    expect(re.test('01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe(true);
    expect(re.test('01ARZ3NDEKTSV4RRFFQ69G5FA')).toBe(false); // 25 chars
    expect(re.test('01arz3ndektsv4rrffq69g5fav')).toBe(false); // lower case
    expect(re.test('01ARZ3NDEKTSV4RRFFQ69G5FAI')).toBe(false); // I is not base32
  });
});
