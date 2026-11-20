// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The static table of instance types with Nitro Enclaves support against a
 * copy of the AWS requirements page (test/fixtures/nitro-enclaves-instance-types.json).
 * To refresh the copy, read the page named in `source` again, update the
 * fixture, and fix the table until this test passes.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkInstanceTypes, NITRO_ENCLAVES_FAMILIES } from '../src/backends/nitro-instance-types';

interface Reference { source: string; retrieved: string; families: Record<string, string[]> }
const reference = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'nitro-enclaves-instance-types.json'), 'utf8')) as Reference;

/** Accelerated computing families: the page lists them, the table leaves them out (the sample needs no accelerator). */
const ACCELERATED = /^(dl|f|g|gr|inf|p|trn)\d/;

/** Graviton families carry a `g` among the letters after the generation: m7g, c6gn, x2gd, i8ge, m8gb. */
const isGraviton = (family: string): boolean => /^[a-z]+\d+[a-z]*g[a-z]*$/.test(family);

describe('the instance-type table against the dated copy of the AWS reference list', () => {
  test('the reference is the page and carries a date', () => {
    expect(reference.source).toMatch(/^https:\/\/docs\.aws\.amazon\.com\/enclaves\//);
    expect(reference.retrieved).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Object.keys(reference.families).length).toBeGreaterThan(100);
  });

  test('every family of the table is on the page with exactly the same excluded sizes', () => {
    for (const [family, entry] of Object.entries(NITRO_ENCLAVES_FAMILIES)) {
      expect(reference.families[family]).toBeDefined();
      expect([...entry.except].sort()).toEqual([...reference.families[family]].sort());
    }
  });

  test('every family on the page is in the table, except the accelerated computing families', () => {
    const missing = Object.keys(reference.families).filter((f) => NITRO_ENCLAVES_FAMILIES[f] === undefined);
    expect(missing.length).toBeGreaterThan(0);
    expect(missing.filter((f) => !ACCELERATED.test(f))).toEqual([]);
    expect(Object.keys(NITRO_ENCLAVES_FAMILIES).filter((f) => ACCELERATED.test(f))).toEqual([]);
  });

  test('the architecture of each family follows its name', () => {
    for (const [family, entry] of Object.entries(NITRO_ENCLAVES_FAMILIES)) {
      expect([family, entry.arch]).toEqual([family, isGraviton(family) ? 'arm64' : 'x86_64']);
    }
  });

  test('the sizes the page excludes are refused, and one size above them is accepted', () => {
    for (const [family, excluded] of Object.entries(reference.families)) {
      if (NITRO_ENCLAVES_FAMILIES[family] === undefined) continue;
      for (const size of excluded) {
        expect(() => checkInstanceTypes([`${family}.${size}`])).toThrow(/no Nitro Enclaves support/);
      }
      expect(checkInstanceTypes([`${family}.4xlarge`])).toBe(isGraviton(family) ? 'arm64' : 'x86_64');
    }
  });

  test('Intel and AMD types need 4 vCPUs (the 2 vCPU large is out), Graviton 2 (the 1 vCPU medium is out)', () => {
    expect(() => checkInstanceTypes(['m7i.large'])).toThrow();
    expect(checkInstanceTypes(['m7i.xlarge'])).toBe('x86_64');
    expect(() => checkInstanceTypes(['m7g.medium'])).toThrow();
    expect(checkInstanceTypes(['m7g.large'])).toBe('arm64');
  });
});
