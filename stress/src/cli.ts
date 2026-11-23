// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { parseLimits, QUOTAS } from './budget';
import { awsCliPublish, Emitter, emitFromCli } from './metrics';
import { parseRecord, renderResults } from './result';
import { planRun, runStress } from './runner';
import { TIERS, tierOf, tierProblems } from './tiers';

/**
 * `run.sh <command>`:
 *   check                                    the tiers and every slice.json in the repository
 *   tier   <name>                            the tier as JSON (also exported to slices as STRESS_TIER_JSON)
 *   plan   --tier T --slices a,b             the order and mode a run would use
 *   run    --tier T --slices a,b [--scenarios x,y] [--limits file] [--remove-fixtures]
 *          [--dashboard | --no-dashboard] [--keep-dashboard]
 *   report <results dir>                     a run's results file, to stdout
 *   quotas                                   the budgeted quotas and their Service Quotas codes
 *   emit   <metric> <value> [Dim=value ...]  one StressRun data point (a slice's script; needs STRESS_METRICS=1)
 *   dashboard up|snapshot|down --run <id>    a run's dashboard by hand, from the plan in its run folder
 *                                            (stress/dashboard/README.md)
 */

const repoRoot = path.resolve(__dirname, '..', '..');
const dashboardScript = path.join(repoRoot, 'stress', 'dashboard', 'dashboard.sh');

function list(value: string | undefined): string[] {
  return (value ?? '').split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}

function slicesInRepo(): string[] {
  const samples = path.join(repoRoot, 'samples');
  return fs.readdirSync(samples).filter((d) => fs.existsSync(path.join(samples, d, 'scripts', 'stress', 'slice.json')));
}

async function main(argv: string[]): Promise<number> {
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
      'dashboard': { type: 'boolean', default: false },
      'no-dashboard': { type: 'boolean', default: false },
      'keep-dashboard': { type: 'boolean', default: false },
      'run': { type: 'string' },
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
    case 'tier': {
      process.stdout.write(`${JSON.stringify(tierOf(positionals[0] ?? values.tier), null, 2)}\n`);
      return 0;
    }
    case 'plan': {
      const { slices, mode } = planRun({ repoRoot, tier: values.tier ?? '', slices: list(values.slices) });
      process.stdout.write(`${mode}: ${slices.map((s) => s.name).join(' -> ')}\n`);
      return 0;
    }
    case 'run': {
      const tier = tierOf(values.tier);
      const home = process.env.STRESS_HOME ?? path.join(os.homedir(), '.aaa-stress');
      const prefix = process.env.STRESS_PREFIX ?? 'stress';
      const runId = process.env.STRESS_RUN_ID ?? new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, 'Z');
      const commit = execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      const limits = values.limits === undefined ? undefined : parseLimits(fs.readFileSync(values.limits, 'utf8'), values.limits, tier.cellAccounts);
      // The dashboard is for platform runs (stress ADR-0022); --dashboard turns it on for a slice
      // run too (a slice run has no front door and no cell account to show), --no-dashboard off.
      const sliceNames = list(values.slices);
      if (values.dashboard && values['no-dashboard']) throw new Error('--dashboard and --no-dashboard exclude each other');
      const withDashboard = !values['no-dashboard'] && (values.dashboard || sliceNames.length > 1);
      const region = process.env.AWS_REGION ?? '';
      if (withDashboard && region === '') throw new Error('the dashboard needs AWS_REGION (the platform account\'s Region); set it or pass --no-dashboard');
      if (withDashboard && (process.env.STRESS_CELL_ACCOUNTS ?? '') === '') {
        process.stderr.write('dashboard: STRESS_CELL_ACCOUNTS is not set, so the dashboard shows no cell account (stress/dashboard/README.md)\n');
      }
      const metrics = withDashboard ? new Emitter(awsCliPublish(region), runId, (l) => process.stderr.write(`${l}\n`)) : undefined;
      const summary = await runStress({
        metrics,
        dashboard: withDashboard
          ? { script: dashboardScript, keep: values['keep-dashboard'] && !values['remove-fixtures'], region }
          : undefined,
        repoRoot,
        tier: tier.name,
        slices: list(values.slices),
        scenarios: values.scenarios === undefined ? undefined : list(values.scenarios),
        home,
        prefix,
        runId,
        commit,
        limits,
        removeFixtures: values['remove-fixtures'],
      });
      // After a hangup stdout is a dead terminal: a failed summary write must not change the exit code.
      process.stdout.on('error', () => undefined);
      process.stdout.write(`run ${summary.runId} (${summary.mode}: ${summary.order.join(' -> ')}): ${summary.failures.length === 0 ? 'PASSED' : 'FAILED'}\n`);
      for (const f of summary.failures) process.stdout.write(`  ${f}\n`);
      process.stdout.write(`results: ${summary.resultsFile ?? 'none (no valid record)'}\n`);
      // 129, 130 or 143 after SIGHUP, SIGINT or SIGTERM, so a caller can tell an interrupted run from a failed one.
      if (summary.signal !== undefined) return 128 + os.constants.signals[summary.signal];
      return summary.failures.length === 0 ? 0 : 1;
    }
    case 'report': {
      // Re-renders from the records alone: it has no verdict and no "Dashboard" section (the runner's results.md has both).
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
    case 'emit': {
      return emitFromCli(rest, process.env, awsCliPublish(process.env.AWS_REGION ?? ''), (l) => process.stderr.write(`${l}\n`));
    }
    case 'dashboard': {
      const verb = positionals[0];
      if (verb !== 'up' && verb !== 'snapshot' && verb !== 'down') throw new Error('dashboard needs up, snapshot or down');
      // The run's own plan, written by the runner when the run started: the run folder holds it.
      const runId = values.run ?? process.env.STRESS_RUN_ID;
      if (runId === undefined) throw new Error('dashboard needs --run <run id>');
      const home = process.env.STRESS_HOME ?? path.join(os.homedir(), '.aaa-stress');
      const prefix = process.env.STRESS_PREFIX ?? 'stress';
      // The run id and the prefix make a path and reach a stack name: the runner's own rule for both.
      if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(runId)) throw new Error('--run must be a run id: letters, digits and hyphens');
      if (!/^[A-Za-z][A-Za-z0-9]{0,39}$/.test(prefix)) throw new Error('STRESS_PREFIX must be 1 to 40 letters and digits, starting with a letter');
      const runDir = path.join(home, prefix, runId);
      const planFile = path.join(runDir, 'dashboard-plan.json');
      if (!fs.existsSync(planFile)) throw new Error(`${planFile} does not exist: only a run made with the dashboard on has a plan`);
      const r = spawnSync('bash', [dashboardScript, verb], {
        stdio: 'inherit',
        env: {
          ...process.env,
          STRESS_PREFIX: prefix,
          STRESS_HOME: home,
          STRESS_RUN_ID: runId,
          STRESS_RUN_DIR: runDir,
          STRESS_DASHBOARD_PLAN_FILE: planFile,
        },
      });
      return r.status ?? 1;
    }
    case 'quotas': {
      for (const [id, q] of Object.entries(QUOTAS)) {
        const code = 'quotaCode' in q ? `${q.serviceCode} ${q.quotaCode}` : 'not in Service Quotas';
        process.stdout.write(`${id}\t${code}\tdefault ${q.defaultLimit}\t${q.description}\n`);
      }
      return 0;
    }
    default:
      process.stderr.write('usage: run.sh check | tier <name> | plan | run | report <dir> | quotas (see src/cli.ts)\n');
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exitCode = 1;
  },
);
