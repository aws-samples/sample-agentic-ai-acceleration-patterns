// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadSlice, orderSlices, parseDeclaration, type SliceDeclaration } from '../src/slice';

const decl = (name: string, needs: string[] = []): SliceDeclaration => ({ name, needs, scenarios: ['PS-1'], platformOnly: [], quotas: [] });

describe('slice declaration (spec §3.4)', () => {
  it('parses a declaration', () => {
    const d = parseDeclaration(JSON.stringify({ name: 'control-plane', needs: ['tenant-identity'], scenarios: ['PS-1', 'PS-5', 'placement-race'], platformOnly: ['PS-5'], quotas: ['codebuild-linux-small'] }), 'f');
    expect(d).toEqual({ name: 'control-plane', needs: ['tenant-identity'], scenarios: ['PS-1', 'PS-5', 'placement-race'], platformOnly: ['PS-5'], quotas: ['codebuild-linux-small'] });
  });

  it('defaults platformOnly to none', () => {
    expect(parseDeclaration(JSON.stringify({ name: 'a', scenarios: ['S1'] }), 'f').platformOnly).toEqual([]);
  });

  it.each([
    ['unknown key', { name: 'a', scenarios: [], extra: 1 }, /unknown keys extra/],
    ['bad name', { name: 'A_b', scenarios: [] }, /"name"/],
    ['self need', { name: 'a', needs: ['a'], scenarios: [] }, /itself/],
    ['duplicate scenario', { name: 'a', scenarios: ['S1', 'S1'] }, /duplicates/],
    ['missing scenarios', { name: 'a' }, /"scenarios"/],
    ['unknown quota', { name: 'a', scenarios: [], quotas: ['sqs'] }, /unknown quotas sqs/],
    ['reserved scenario', { name: 'a', scenarios: ['lifecycle'] }, /runner's own record/],
    ['platform-only scenario the slice does not declare', { name: 'a', scenarios: ['S1'], platformOnly: ['PS-2'] }, /"platformOnly" names PS-2/],
    ['bad platform-only entry', { name: 'a', scenarios: ['S1'], platformOnly: 'S1' }, /"platformOnly" must be an array/],
  ])('refuses %s', (_n, doc, pattern) => {
    expect(() => parseDeclaration(JSON.stringify(doc), 'f')).toThrow(pattern);
  });

  it('orders every slice after the slices it needs, keeping the given order otherwise', () => {
    const order = orderSlices([
      decl('agentic-runtime-isolation', ['tenant-front-door', 'control-plane', 'tenant-identity']),
      decl('tenant-front-door', ['control-plane', 'tenant-identity']),
      decl('control-plane', ['tenant-identity']),
      decl('tenant-identity'),
    ]).map((s) => s.name);
    expect(order).toEqual(['tenant-identity', 'control-plane', 'tenant-front-door', 'agentic-runtime-isolation']);
  });

  it('keeps the given order of slices that do not need each other', () => {
    expect(orderSlices([decl('b'), decl('a')]).map((s) => s.name)).toEqual(['b', 'a']);
  });

  it('runs one slice alone without its needs (slice mode)', () => {
    expect(orderSlices([decl('control-plane', ['tenant-identity'])]).map((s) => s.name)).toEqual(['control-plane']);
  });

  it('refuses a missing need, a cycle and a duplicate in platform mode', () => {
    expect(() => orderSlices([decl('a', ['b']), decl('c')])).toThrow(/a needs b/);
    expect(() => orderSlices([decl('a', ['b']), decl('b', ['a'])])).toThrow(/cycle: a -> b -> a/);
    expect(() => orderSlices([decl('a'), decl('a')])).toThrow(/twice/);
  });

  it('loads a slice from samples/<name>/scripts/stress and checks the name matches the folder', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slice-'));
    const dir = path.join(root, 'samples', 'demo', 'scripts', 'stress');
    fs.mkdirSync(dir, { recursive: true });
    expect(() => loadSlice(root, 'demo')).toThrow(/slice.json is missing/);
    fs.writeFileSync(path.join(dir, 'slice.json'), JSON.stringify({ name: 'other', scenarios: [] }));
    expect(() => loadSlice(root, 'demo')).toThrow(/the folder is demo/);
    fs.writeFileSync(path.join(dir, 'slice.json'), JSON.stringify({ name: 'demo', scenarios: [] }));
    expect(() => loadSlice(root, 'demo')).toThrow(/slice.sh is missing/);
    fs.writeFileSync(path.join(dir, 'slice.sh'), '');
    expect(loadSlice(root, 'demo').script).toBe(path.join(dir, 'slice.sh'));
  });
});
