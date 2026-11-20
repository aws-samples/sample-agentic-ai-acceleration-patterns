// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Instance types the `nitro` backend accepts (spec §3.3, ADR-0045).
 *
 * Nitro Sandboxes on ECS Managed Instances need an instance type with Nitro
 * Enclaves support. The list below is that support, family by family, as the
 * Nitro Enclaves requirements page states it: "all instance types except"
 * the sizes in `except` (Intel and AMD types need 4 vCPUs or more, so
 * `m7i.large` is refused; Graviton types need 2 or more). Accelerated
 * computing families are left out: the sample needs none and the runner
 * image carries no driver. `test/fixtures/nitro-enclaves-instance-types.json`
 * is a copy of the page, and a test compares the two.
 *
 * No aws-cdk-lib import.
 */

/** CPU architecture of a family; one runner image serves one architecture (spec §3.5). */
export type NitroArchitecture = 'x86_64' | 'arm64';

/**
 * Architectures the runner holds a job filter table for (spec §3.5, ADR-0021).
 * Only the x86_64 table has run on a sandbox (S-18, S-19). Synth refuses a
 * type of any other architecture.
 */
export const RUNNER_FILTER_ARCHITECTURES: readonly NitroArchitecture[] = ['x86_64', 'arm64'];

interface FamilyEntry {
  readonly arch: NitroArchitecture;
  /** Sizes the page excludes. */
  readonly except: readonly string[];
}

/** Family, lowercase, to its architecture and excluded sizes. */
export const NITRO_ENCLAVES_FAMILIES: Readonly<Record<string, FamilyEntry>> = {
  m5: { arch: 'x86_64', except: ['large', 'metal'] },
  m5a: { arch: 'x86_64', except: ['large'] },
  m5ad: { arch: 'x86_64', except: ['large'] },
  m5d: { arch: 'x86_64', except: ['large', 'metal'] },
  m5dn: { arch: 'x86_64', except: ['large', 'metal'] },
  m5n: { arch: 'x86_64', except: ['large', 'metal'] },
  m5zn: { arch: 'x86_64', except: ['large', 'metal'] },
  m6a: { arch: 'x86_64', except: ['large', 'metal'] },
  m6g: { arch: 'arm64', except: ['medium', 'metal'] },
  m6gd: { arch: 'arm64', except: ['medium', 'metal'] },
  m6i: { arch: 'x86_64', except: ['large', 'metal'] },
  m6id: { arch: 'x86_64', except: ['large', 'metal'] },
  m6idn: { arch: 'x86_64', except: ['large', 'metal'] },
  m6in: { arch: 'x86_64', except: ['large', 'metal'] },
  m7a: { arch: 'x86_64', except: ['medium', 'large', 'metal-48xl'] },
  m7g: { arch: 'arm64', except: ['medium', 'metal'] },
  m7gd: { arch: 'arm64', except: ['medium', 'metal'] },
  m7i: { arch: 'x86_64', except: ['large', 'metal-24xl', 'metal-48xl'] },
  m8a: { arch: 'x86_64', except: ['medium', 'metal-24xl', 'metal-48xl'] },
  m8azn: { arch: 'x86_64', except: ['medium', 'metal-12xl', 'metal-24xl'] },
  m8g: { arch: 'arm64', except: ['medium', 'metal-24xl', 'metal-48xl'] },
  m8gb: { arch: 'arm64', except: ['medium', 'metal-24xl', 'metal-48xl'] },
  m8gd: { arch: 'arm64', except: ['medium', 'metal-24xl', 'metal-48xl'] },
  m8gn: { arch: 'arm64', except: ['medium', 'metal-24xl', 'metal-48xl'] },
  m8i: { arch: 'x86_64', except: ['large', 'metal-48xl', 'metal-96xl'] },
  m8id: { arch: 'x86_64', except: ['large', 'metal-48xl', 'metal-96xl'] },
  m8in: { arch: 'x86_64', except: ['large', 'metal-48xl', 'metal-96xl'] },
  m8idn: { arch: 'x86_64', except: ['large', 'metal-48xl', 'metal-96xl'] },
  m8ine: { arch: 'x86_64', except: ['large'] },
  m8ib: { arch: 'x86_64', except: ['large', 'metal-48xl', 'metal-96xl'] },
  m8idb: { arch: 'x86_64', except: ['large', 'metal-48xl', 'metal-96xl'] },
  m9g: { arch: 'arm64', except: ['medium', 'metal-48xl'] },
  m9gd: { arch: 'arm64', except: ['medium', 'metal-48xl'] },
  c5: { arch: 'x86_64', except: ['large', 'metal'] },
  c5a: { arch: 'x86_64', except: ['large'] },
  c5ad: { arch: 'x86_64', except: ['large'] },
  c5d: { arch: 'x86_64', except: ['large', 'metal'] },
  c5n: { arch: 'x86_64', except: ['large', 'metal'] },
  c6a: { arch: 'x86_64', except: ['large', 'metal'] },
  c6g: { arch: 'arm64', except: ['medium', 'metal'] },
  c6gd: { arch: 'arm64', except: ['medium', 'metal'] },
  c6gn: { arch: 'arm64', except: ['medium'] },
  c6i: { arch: 'x86_64', except: ['large', 'metal'] },
  c6id: { arch: 'x86_64', except: ['large', 'metal'] },
  c6in: { arch: 'x86_64', except: ['large', 'metal'] },
  c7a: { arch: 'x86_64', except: ['medium', 'large', 'metal-48xl'] },
  c7g: { arch: 'arm64', except: ['medium', 'metal'] },
  c7gd: { arch: 'arm64', except: ['medium', 'metal'] },
  c7i: { arch: 'x86_64', except: ['large', 'metal-24xl', 'metal-48xl'] },
  c8a: { arch: 'x86_64', except: ['medium', 'metal-24xl', 'metal-48xl'] },
  c8g: { arch: 'arm64', except: ['medium', 'metal-24xl', 'metal-48xl'] },
  c8gb: { arch: 'arm64', except: ['medium', 'metal-24xl', 'metal-48xl'] },
  c8gd: { arch: 'arm64', except: ['medium', 'metal-24xl', 'metal-48xl'] },
  c8gn: { arch: 'arm64', except: ['medium', 'metal-24xl', 'metal-48xl'] },
  c8i: { arch: 'x86_64', except: ['large', 'metal-48xl', 'metal-96xl'] },
  c8id: { arch: 'x86_64', except: ['large', 'metal-48xl', 'metal-96xl'] },
  c8in: { arch: 'x86_64', except: ['large', 'metal-48xl', 'metal-96xl'] },
  c8ine: { arch: 'x86_64', except: ['large'] },
  c8ib: { arch: 'x86_64', except: ['large', 'metal-48xl', 'metal-96xl'] },
  c9g: { arch: 'arm64', except: ['medium', 'metal-48xl'] },
  c9gd: { arch: 'arm64', except: ['medium', 'metal-48xl'] },
  r5: { arch: 'x86_64', except: ['large', 'metal'] },
  r5a: { arch: 'x86_64', except: ['large'] },
  r5ad: { arch: 'x86_64', except: ['large'] },
  r5b: { arch: 'x86_64', except: ['large', 'metal'] },
  r5d: { arch: 'x86_64', except: ['large', 'metal'] },
  r5dn: { arch: 'x86_64', except: ['large', 'metal'] },
  r5n: { arch: 'x86_64', except: ['large', 'metal'] },
  r6a: { arch: 'x86_64', except: ['large', 'metal'] },
  r6g: { arch: 'arm64', except: ['medium', 'metal'] },
  r6gd: { arch: 'arm64', except: ['medium', 'metal'] },
  r6i: { arch: 'x86_64', except: ['large', 'metal'] },
  r6id: { arch: 'x86_64', except: ['large', 'metal'] },
  r6idn: { arch: 'x86_64', except: ['large', 'metal'] },
  r6in: { arch: 'x86_64', except: ['large', 'metal'] },
  r7a: { arch: 'x86_64', except: ['medium', 'large', 'metal-48xl'] },
  r7g: { arch: 'arm64', except: ['medium', 'metal'] },
  r7gd: { arch: 'arm64', except: ['medium', 'metal'] },
  r7i: { arch: 'x86_64', except: ['large', 'metal-24xl', 'metal-48xl'] },
  r7iz: { arch: 'x86_64', except: ['large', 'metal-16xl', 'metal-32xl'] },
  r8a: { arch: 'x86_64', except: ['medium', 'metal-24xl', 'metal-48xl'] },
  r8g: { arch: 'arm64', except: ['medium', 'metal-24xl', 'metal-48xl'] },
  r8gb: { arch: 'arm64', except: ['medium', 'metal-24xl', 'metal-48xl'] },
  r8gd: { arch: 'arm64', except: ['medium', 'metal-24xl', 'metal-48xl'] },
  r8gn: { arch: 'arm64', except: ['medium', 'metal-24xl', 'metal-48xl'] },
  r8i: { arch: 'x86_64', except: ['large', 'metal-48xl', 'metal-96xl'] },
  r8id: { arch: 'x86_64', except: ['large', 'metal-48xl', 'metal-96xl'] },
  r8in: { arch: 'x86_64', except: ['large', 'metal-48xl', 'metal-96xl'] },
  r8idn: { arch: 'x86_64', except: ['large', 'metal-48xl', 'metal-96xl'] },
  r8ib: { arch: 'x86_64', except: ['large', 'metal-48xl', 'metal-96xl'] },
  r8idb: { arch: 'x86_64', except: ['large', 'metal-48xl', 'metal-96xl'] },
  r9g: { arch: 'arm64', except: ['medium', 'metal-48xl'] },
  r9gd: { arch: 'arm64', except: ['medium', 'metal-48xl'] },
  x2gd: { arch: 'arm64', except: ['medium', 'metal'] },
  x2idn: { arch: 'x86_64', except: ['metal'] },
  x2iedn: { arch: 'x86_64', except: ['metal'] },
  x2iezn: { arch: 'x86_64', except: ['metal'] },
  x8g: { arch: 'arm64', except: ['medium', 'metal-24xl', 'metal-48xl'] },
  x8aedz: { arch: 'x86_64', except: ['metal-12xl', 'metal-24xl'] },
  x8i: { arch: 'x86_64', except: ['large', 'metal-48xl', 'metal-96xl'] },
  z1d: { arch: 'x86_64', except: ['large', 'metal'] },
  d3: { arch: 'x86_64', except: [] },
  d3en: { arch: 'x86_64', except: [] },
  i3en: { arch: 'x86_64', except: ['large', 'metal'] },
  i4g: { arch: 'arm64', except: [] },
  i4i: { arch: 'x86_64', except: ['large', 'metal'] },
  i7i: { arch: 'x86_64', except: ['large', 'metal-24xl', 'metal-48xl'] },
  i7ie: { arch: 'x86_64', except: ['large', 'metal-24xl', 'metal-48xl'] },
  i8g: { arch: 'arm64', except: ['metal-24xl', 'metal-48xl'] },
  i8ge: { arch: 'arm64', except: ['metal-24xl', 'metal-48xl'] },
};

/** `xlarge`, `2xlarge`, `large`, `metal`, `metal-48xl`, and the small sizes. */
const SIZE = /^(nano|micro|small|medium|large|\d*xlarge|metal(-\d+xl)?)$/;

/**
 * Validates `nitro.instanceTypes` (spec §3.3) and returns the one
 * architecture they share. Throws a message that names the type and the
 * reason; the construct prefixes it.
 */
export function checkInstanceTypes(types: readonly string[]): NitroArchitecture {
  if (types.length === 0) throw new Error('nitro.instanceTypes must name at least one instance type');
  const archs = new Set<NitroArchitecture>();
  for (const type of types) {
    const m = /^([a-z0-9-]+)\.([a-z0-9-]+)$/.exec(type);
    if (m === null || !SIZE.test(m[2])) throw new Error(`nitro.instanceTypes: "${type}" is not an instance type name such as m7i.xlarge`);
    const family = NITRO_ENCLAVES_FAMILIES[m[1]];
    if (family === undefined) {
      throw new Error(`nitro.instanceTypes: "${type}" is not in the table of types with Nitro Enclaves support (ADR-0045)`);
    }
    if (family.except.includes(m[2])) {
      throw new Error(`nitro.instanceTypes: "${type}" has no Nitro Enclaves support (the size is too small or bare metal)`);
    }
    if (!RUNNER_FILTER_ARCHITECTURES.includes(family.arch)) {
      throw new Error(`nitro.instanceTypes: "${type}" is ${family.arch}, and the runner has no job filter table for it (spec §3.5)`);
    }
    archs.add(family.arch);
  }
  if (archs.size > 1) {
    throw new Error('nitro.instanceTypes mixes x86_64 and arm64 types; the nitro runner image has one architecture');
  }
  return [...archs][0];
}
