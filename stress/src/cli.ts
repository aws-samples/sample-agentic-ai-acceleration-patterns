// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { QUOTAS, type Limits } from './budget';
import { parseRecord, renderResults } from './result';
import { planRun, runStress } from './runner';
import { TIERS, tierProblems } from './tiers';

/**
 * `run.sh <command>`:
 *   check                                    tiers and every slice.json in the repository
 *   plan   --tier T --slices a,b             the order and mode a run would use
 *   run    --tier T --slices a,b [--scenarios x,y] [--limits file] [--remove-fixtures]
 *   report <results dir>                     render a run's results.md to stdout
 *   quotas                                   the budgeted quotas and their codes
 */

const repoRoot = path.resolve(__dirname, '..', '..');

function list(value: string | undefined): string[] {
  return (value ?? '').split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}

function slicesInRepo(): string[] {
  const samples = path.join(repoRoot, 'samples');
  return fs.readdirSync(samples).filter((d) => fs.existsSync(path.join(samples, d, 'scripts', 'stress', 'slice.json')));
}

function main(argv: string[]): number {
  const [command, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      'tier': { type: 'string', default: process.env.STRESS_TIER },
      'slices': { type: 'string' },
      'scenarios': { type: 'string' },
      'limits': { type: 'string' },
      'remove-fixtures': { type: 'boolean', default: false },
    },
  });
  switch (command) {
    case 'check': {
      const problems = Object.values(TIERS).flatMap(tierProblems);
      const names = slicesInRepo();
      for (const n of names) {
        try {
          planRun({ repoRoot, tier: 'small', slices: [n] });
        } catch (e) {
          problems.push((e as Error).message);
        }
      }
      for (const p of problems) process.stderr.write(`${p}\n`);
      process.stdout.write(`tiers ${Object.keys(TIERS).join(', ')}; slices ${names.length === 0 ? 'none yet' : names.join(', ')}\n`);
      return problems.length === 0 ? 0 : 1;
    }
    case 'plan': {
      const { slices, mode } = planRun({ repoRoot, tier: values.tier ?? '', slices: list(values.slices) });
      process.stdout.write(`${mode}: ${slices.map((s) => s.name).join(' -> ')}\n`);
      return 0;
    }
    case 'run': {
      const home = process.env.STRESS_HOME ?? path.join(os.homedir(), '.aaa-stress');
      const prefix = process.env.STRESS_PREFIX ?? 'stress';
      const runId = process.env.STRESS_RUN_ID ?? new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, 'Z');
      const commit = execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      const limits = values.limits === undefined ? undefined : (JSON.parse(fs.readFileSync(values.limits, 'utf8')) as Limits);
      const summary = runStress({
        repoRoot,
        tier: values.tier ?? '',
        slices: list(values.slices),
        scenarios: values.scenarios === undefined ? undefined : list(values.scenarios),
        home,
        prefix,
        runId,
        commit,
        limits,
        removeFixtures: values['remove-fixtures'],
      });
      process.stdout.write(`run ${summary.runId} (${summary.mode}: ${summary.order.join(' -> ')}): ${summary.failures.length === 0 ? 'PASSED' : 'FAILED'}\n`);
      for (const f of summary.failures) process.stdout.write(`  ${f}\n`);
      process.stdout.write(`results: ${summary.resultsFile}\n`);
      return summary.failures.length === 0 ? 0 : 1;
    }
    case 'report': {
      const dir = positionals[0];
      if (dir === undefined) throw new Error('report needs a results folder');
      const records = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .sort()
        .map((f) => parseRecord(fs.readFileSync(path.join(dir, f), 'utf8'), f));
      process.stdout.write(renderResults(records));
      return 0;
    }
    case 'quotas': {
      for (const [id, q] of Object.entries(QUOTAS)) {
        const code = 'quotaCode' in q ? `${q.serviceCode} ${q.quotaCode}` : 'not in Service Quotas';
        process.stdout.write(`${id}\t${code}\tdefault ${q.defaultLimit}\t${q.description}\n`);
      }
      return 0;
    }
    default:
      process.stderr.write('usage: run.sh check | plan | run | report <dir> | quotas (see src/cli.ts)\n');
      return 2;
  }
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  process.stderr.write(`${(e as Error).message}\n`);
  process.exitCode = 1;
}
