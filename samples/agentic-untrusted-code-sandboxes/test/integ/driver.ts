// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The integration test driver (spec §8, ADR-0008, ADR-0058). Run by
 * `scripts/integ.sh` (the `integ` task), never imported.
 *
 *   driver.ts run         deploy, every step, destroy, leftover check (default)
 *   driver.ts destroy     destroy what an interrupted run left, then check
 *   driver.ts cleanup     `destroy`, unless the last run finished its teardown (the wrapper's exit trap)
 *   driver.ts leftovers   list what a run left; read-only, deletes nothing
 *   driver.ts synth       synthesise the integration app only
 *
 * The destroy runs in a `finally` and from the SIGINT and SIGTERM handlers,
 * so it also runs when a step crashes or the run is stopped; the shell
 * wrapper's exit trap calls `destroy` once more for a driver that was killed.
 * Nothing printed or recorded holds a token, nonce, credential, code, input
 * or output (scripts/CONVENTIONS.md).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { Aws } from './aws';
import { deployConcurrency, runRegion, stackPrefix } from './common';
import { Ctx } from './ctx';
import { deployStacks, destroyStack, serviceNames, snapshotResources, synth } from './deploy';
import { checkLeftovers, formatFindings, leftoverExitCode } from './leftovers';
import { formatRecord, Recorder } from './record';
import { runPhase, skipPhase } from './runner';
import { readState, stateDir, withState, writeState, type RunState } from './state';
import { matrix, STEPS, unitKey } from './steps';
import { preconditions, standaloneBuild, synthTests } from './steps/build';
import { IMPLS } from './steps/index';
import { destroyAndCheck, prepareTeardown, teardownUnit, type TeardownOutcome } from './steps/teardown';

async function runAll(): Promise<number> {
  const region = runRegion();
  const prefix = stackPrefix();
  const concurrency = deployConcurrency();
  const aws = new Aws(region);
  const rec = new Recorder(region);
  const startedAt = new Date().toISOString();
  const runId = Date.now().toString(36);
  process.stdout.write(`integration run ${runId}: prefix ${prefix}, Region ${region}, deploy concurrency ${concurrency}\n`);

  let state: RunState | undefined;
  let ctx: Ctx | undefined;
  let deployStarted = false;
  let tearing: Promise<void> | undefined;

  const doTeardown = async (): Promise<void> => {
    if (!deployStarted || !state) return;
    const steps = matrix(STEPS.filter((s) => s.name === 'teardown'));
    let outcome: TeardownOutcome | undefined;
    rec.begin('teardown: prepare');
    try {
      if (ctx && !ctx.aborted) await prepareTeardown(ctx);
    } catch (e) {
      rec.crashed(e);
    }
    rec.end();
    try {
      outcome = await destroyAndCheck(aws, rec, prefix, state);
    } catch (e) {
      rec.begin('teardown: destroy');
      rec.crashed(e);
      rec.end();
    }
    steps.forEach((u, i) => {
      rec.begin(unitKey(u));
      if (outcome) teardownUnit(rec, u, outcome, i === 0);
      else rec.check('the stack was destroyed', false);
      rec.end();
    });
    if (outcome) writeState(withState(state, { destroyed: outcome.destroyed && outcome.findings.every((f) => f.known) }));
  };
  /** One teardown per run, whoever asks first; a signal during it waits for the same one. */
  const teardown = (): Promise<void> => {
    tearing ??= doTeardown();
    return tearing;
  };

  let stopping = false;
  /**
   * A signal stops the run at the next step: the step in flight ends at its next call, the teardown runs from the
   * `finally` below and the record is written there. A second signal exits at once (the exit trap of the wrapper
   * then destroys what is left).
   */
  let signalledAt = 0;
  const onSignal = (signal: string): void => {
    // `npx` forwards the signal and the terminal sends it too, so a second one within 2 s is the same Ctrl-C.
    if (stopping && Date.now() - signalledAt > 2000) process.exit(130);
    if (stopping) return;
    signalledAt = Date.now();
    stopping = true;
    if (ctx) ctx.aborted = true;
    process.stdout.write(`${signal}: stopping at the next step, then destroying the stack\n`);
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));

  try {
    rec.begin('preconditions');
    const pre = await preconditions(aws, rec);
    rec.end();
    if (!rec.failed && !stopping) {
      rec.begin('standalone-build');
      await standaloneBuild(rec);
      rec.end();
      if (!stopping) {
        rec.begin('synth');
        await synthTests(rec);
        rec.end();
      }
    }
    if (stopping) {
      rec.begin('run');
      rec.check('the run was stopped before the deploy', false);
      rec.end();
    }
    if (rec.failed) {
      skipPhase(rec, STEPS, 'after-deploy', stopping ? 'the run was stopped' : 'a check before the deploy failed');
      skipPhase(rec, STEPS, 'teardown', 'nothing was deployed');
      return finish(rec, startedAt);
    }

    state = {
      prefix,
      region,
      stackName: prefix,
      startedAt,
      destroyed: false,
      resources: [],
      policyBaseline: pre.policyBaseline,
      runtimeNames: [],
      imageNames: [],
    };
    writeState(state);
    deployStarted = true;
    await rec.time('deploy', async () => {
      await synth(prefix);
      await deployStacks(prefix, concurrency);
    });
    const outputs = await aws.stackOutputs(prefix);
    const resources = await snapshotResources(aws, prefix);
    const names = await serviceNames(aws, resources);
    state = withState(state, { resources, queryLogGroupArn: outputs.QueryLogGroupArn, ...names });
    writeState(state);
    ctx = new Ctx(aws, rec, prefix, outputs, runId);
    ctx.aborted = stopping;
    await runPhase(rec, ctx, STEPS, 'after-deploy', IMPLS, () => stopping);
    if (stopping) {
      // Skipped units are not failures, so a stopped run records its own: it must not exit 0.
      rec.begin('run');
      rec.check('the run was stopped before every unit ran', false);
      rec.end();
    }
  } catch (e) {
    rec.begin('run');
    rec.crashed(e);
    rec.end();
  } finally {
    await teardown();
  }
  return finish(rec, startedAt);
}

function finish(rec: Recorder, startedAt: string): number {
  const record = rec.toJSON(startedAt);
  mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  const file = path.join(stateDir(), `record-${startedAt.replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify(record, undefined, 2), { mode: 0o600 });
  process.stdout.write(`\n${formatRecord(record)}\n\nrun record: ${file}\n`);
  return rec.failed ? 1 : 0;
}

/** After an interruption: destroy the stack the state names (or the prefix's), then list what is left. */
async function destroyOnly(): Promise<number> {
  const region = runRegion();
  const prefix = stackPrefix();
  const aws = new Aws(region);
  const state = readState(prefix, region);
  const r = await destroyStack(aws, prefix);
  process.stdout.write(`stack ${prefix}: ${r.status}${r.failures.length > 0 ? ` (${r.failures.join(' | ')})` : ''}\n`);
  const findings = await checkLeftovers(aws, prefix, state);
  process.stdout.write(`${formatFindings(findings)}\n`);
  if (state) writeState(withState(state, { destroyed: leftoverExitCode(findings) === 0 }));
  return leftoverExitCode(findings);
}

async function leftoversOnly(): Promise<number> {
  const region = runRegion();
  const prefix = stackPrefix();
  const findings = await checkLeftovers(new Aws(region), prefix, readState(prefix, region));
  process.stdout.write(`${formatFindings(findings)}\n`);
  return leftoverExitCode(findings);
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'run';
  const commands: Record<string, () => Promise<number>> = {
    run: runAll,
    destroy: destroyOnly,
    leftovers: leftoversOnly,
    cleanup: async () => {
      const state = readState(stackPrefix(), runRegion());
      return state === undefined || state.destroyed ? 0 : destroyOnly();
    },
    synth: async () => {
      await synth(stackPrefix());
      return 0;
    },
  };
  const fn = commands[command];
  if (!fn) throw new Error(`unknown command ${command}; use run, destroy, cleanup, leftovers or synth`);
  process.exitCode = await fn();
}

main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}\n`);
  process.exitCode = 1;
});
