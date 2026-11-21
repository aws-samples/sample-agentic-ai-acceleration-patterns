// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as fs from 'node:fs';
import * as path from 'node:path';
import { isQuotaId, type QuotaId } from './budget';

/**
 * A slice (spec §3.4): `scripts/stress/slice.sh` and its declaration,
 * `scripts/stress/slice.json`, in a sample. The runner only reads the
 * declaration and calls the script with one verb at a time.
 */

export const VERBS = ['budget', 'deploy', 'seed', 'step', 'run', 'collect', 'teardown'] as const;
export type Verb = (typeof VERBS)[number];

export interface SliceDeclaration {
  /** The sample folder name, `samples/<name>/`. */
  readonly name: string;
  /** Slices this one reads through their published interfaces (P-2). */
  readonly needs: readonly string[];
  /** Scenario ids this slice runs: `PS-n` (platform) or its own (slice mode). */
  readonly scenarios: readonly string[];
  /**
   * The scenarios among `scenarios` that need other slices' interfaces (the edge, the cells
   * the control plane built). They run in platform mode only: the runner leaves them out of a
   * slice-mode run and refuses one named there.
   */
  readonly platformOnly: readonly string[];
  /**
   * The platform steps the slice implements (`slice.sh step <name>`, spec §3.5): parts of its
   * set-up or teardown that must run between another slice's verbs. Only a platform run calls them.
   */
  readonly steps: readonly string[];
  /** Account-wide quotas the slice draws on; its `budget` verb prints how much. */
  readonly quotas: readonly QuotaId[];
}

export interface Slice extends SliceDeclaration {
  /** Absolute path of `slice.sh`. */
  readonly script: string;
}

const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SCENARIO = /^[A-Za-z0-9][A-Za-z0-9-]{0,31}$/;
const STEP = /^[a-z][a-z0-9-]{0,31}$/;

function strings(value: unknown, field: string, file: string, pattern: RegExp): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || !pattern.test(v))) {
    throw new Error(`${file}: "${field}" must be an array of ${pattern}`);
  }
  if (new Set(value).size !== value.length) {
    throw new Error(`${file}: "${field}" has duplicates`);
  }
  return value as string[];
}

/** Validates the text of a `slice.json`; `file` names it in errors. */
export function parseDeclaration(text: string, file: string): SliceDeclaration {
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`${file}: not JSON`);
  }
  const unknownKeys = Object.keys(doc).filter((k) => !['name', 'needs', 'scenarios', 'platformOnly', 'steps', 'quotas'].includes(k));
  if (unknownKeys.length > 0) {
    throw new Error(`${file}: unknown keys ${unknownKeys.join(', ')}`);
  }
  if (typeof doc.name !== 'string' || !NAME.test(doc.name)) {
    throw new Error(`${file}: "name" must match ${NAME}`);
  }
  const needs = strings(doc.needs ?? [], 'needs', file, NAME);
  if (needs.includes(doc.name)) {
    throw new Error(`${file}: a slice cannot need itself`);
  }
  const scenarios = strings(doc.scenarios, 'scenarios', file, SCENARIO);
  if (scenarios.includes('lifecycle')) throw new Error(`${file}: "lifecycle" is the runner's own record, not a scenario`);
  const platformOnly = strings(doc.platformOnly ?? [], 'platformOnly', file, SCENARIO);
  const undeclared = platformOnly.filter((s) => !scenarios.includes(s));
  if (undeclared.length > 0) {
    throw new Error(`${file}: "platformOnly" names ${undeclared.join(', ')}, which "scenarios" does not declare`);
  }
  const steps = strings(doc.steps ?? [], 'steps', file, STEP);
  const quotas = strings(doc.quotas ?? [], 'quotas', file, /.*/);
  const bad = quotas.filter((q) => !isQuotaId(q));
  if (bad.length > 0) {
    throw new Error(`${file}: unknown quotas ${bad.join(', ')}`);
  }
  return { name: doc.name, needs, scenarios, platformOnly, steps, quotas: quotas as QuotaId[] };
}

/** Reads `samples/<name>/scripts/stress/slice.json` under `repoRoot`. */
export function loadSlice(repoRoot: string, name: string): Slice {
  const dir = path.join(repoRoot, 'samples', name, 'scripts', 'stress');
  const file = path.join(dir, 'slice.json');
  if (!fs.existsSync(file)) {
    throw new Error(`no slice for ${name}: ${path.relative(repoRoot, file)} is missing`);
  }
  const declaration = parseDeclaration(fs.readFileSync(file, 'utf8'), path.relative(repoRoot, file));
  if (declaration.name !== name) {
    throw new Error(`${path.relative(repoRoot, file)}: "name" is ${declaration.name}, the folder is ${name}`);
  }
  const script = path.join(dir, 'slice.sh');
  if (!fs.existsSync(script)) {
    throw new Error(`no slice script for ${name}: ${path.relative(repoRoot, script)} is missing`);
  }
  return { ...declaration, script };
}

/**
 * The slices in the order the runner deploys them: every slice after the
 * slices it needs. With one slice (slice mode) its needs are not required;
 * with several (platform mode) every need must be in the run.
 */
export function orderSlices<T extends SliceDeclaration>(slices: readonly T[]): T[] {
  const byName = new Map(slices.map((s) => [s.name, s]));
  if (byName.size !== slices.length) {
    throw new Error('a slice is named twice');
  }
  if (slices.length === 1) {
    return [...slices];
  }
  for (const s of slices) {
    const missing = s.needs.filter((n) => !byName.has(n));
    if (missing.length > 0) {
      throw new Error(`${s.name} needs ${missing.join(', ')}, which the run does not include`);
    }
  }
  const ordered: T[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (s: T, trail: string[]): void => {
    if (state.get(s.name) === 'done') return;
    if (state.get(s.name) === 'visiting') {
      throw new Error(`slice needs form a cycle: ${[...trail, s.name].join(' -> ')}`);
    }
    state.set(s.name, 'visiting');
    for (const n of s.needs) visit(byName.get(n)!, [...trail, s.name]);
    state.set(s.name, 'done');
    ordered.push(s);
  };
  // Visit in the given order so independent slices keep it.
  for (const s of slices) visit(s, []);
  return ordered;
}
