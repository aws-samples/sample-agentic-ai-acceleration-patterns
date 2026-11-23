// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BUILDS_EVERY_MS, buildsArgs, FLUSH_DEADLINE_MS, metricsQueue, type Run, sampleArgs } from './metrics';
import { Recorder } from './recorder';

describe('the control-plane slice figures for the run dashboard (stress ADR-0022)', () => {
  it('maps PS-1 ready times and the three PS-5 change times, and no other hop', () => {
    expect(sampleArgs('ready', 165.9)).toEqual(['OnboardReadySeconds', '165.9']);
    expect(sampleArgs('routable', 118.25)).toEqual(['RoutableSeconds', '118.25']);
    expect(sampleArgs('suspended', 4)).toEqual(['SuspendedSeconds', '4']);
    expect(sampleArgs('removed', 30.0004)).toEqual(['RemovedSeconds', '30']);
    for (const hop of ['warm-up-ready', 'rerun-ready', 'resumed', 'wave', 'put-account', 'cell-create']) expect(sampleArgs(hop, 1)).toBeUndefined();
    expect(sampleArgs('ready', Number.NaN)).toBeUndefined();
    expect(sampleArgs('ready', -1)).toBeUndefined();
  });

  it('counts the builds in flight from the platform build quota only', () => {
    expect(buildsArgs('platform', 'codebuild-linux-small', 12)).toEqual(['BuildsInFlight', '12']);
    expect(buildsArgs('cell-account-1', 'codebuild-linux-small', 12)).toBeUndefined();
    expect(buildsArgs('platform', 'lambda-concurrency', 12)).toBeUndefined();
  });

  describe('the queue', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-'));
    fs.mkdirSync(path.join(repo, 'stress', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'stress', 'lib', 'cli.js'), '');
    const on = { STRESS_METRICS: '1', STRESS_REPO: repo };
    const cli = path.join(repo, 'stress', 'lib', 'cli.js');

    /** A runner whose calls end when the test says so; it records the order they started in and how many ran at once. */
    function manual() {
      const started: string[][] = [];
      const pending: (() => void)[] = [];
      let running = 0;
      let most = 0;
      const run: Run = (file, args, _options, done) => {
        started.push([file, ...args]);
        running += 1;
        most = Math.max(most, running);
        pending.push(() => {
          running -= 1;
          done();
        });
      };
      return { run, started, finishNext: () => pending.shift()!(), most: () => most };
    }

    it('calls the runner\'s own emitter when the run has its metrics on', async () => {
      const m = manual();
      const q = metricsQueue(on, m.run);
      expect(q.emit(['BuildsInFlight', '3'])).toBe(true);
      await Promise.resolve();
      expect(m.started).toEqual([['node', cli, 'emit', 'BuildsInFlight', '3']]);
    });

    it('sends one call at a time, in order, and flush waits for all of them', async () => {
      const m = manual();
      const q = metricsQueue(on, m.run);
      q.emit(['OnboardReadySeconds', '1']);
      q.emit(['OnboardReadySeconds', '2']);
      q.emit(['OnboardReadySeconds', '3']);
      let flushed = false;
      void q.flush().then(() => {
        flushed = true;
      });
      for (let i = 0; i < 3; i += 1) {
        await new Promise((r) => setImmediate(r));
        expect(m.started.length).toBe(i + 1);
        expect(flushed).toBe(false);
        m.finishNext();
      }
      await q.flush();
      expect(flushed).toBe(true);
      expect(m.started.map((s) => s[4])).toEqual(['1', '2', '3']);
      expect(m.most()).toBe(1);
    });

    it('does nothing without the switch, without a repository or CLI, or without arguments', () => {
      const run = jest.fn();
      expect(metricsQueue({ STRESS_REPO: repo }, run).emit(['BuildsInFlight', '3'])).toBe(false);
      expect(metricsQueue({ STRESS_METRICS: '1' }, run).emit(['BuildsInFlight', '3'])).toBe(false);
      expect(metricsQueue({ STRESS_METRICS: '1', STRESS_REPO: '/nonexistent' }, run).emit(['BuildsInFlight', '3'])).toBe(false);
      expect(metricsQueue(on, run).emit(undefined)).toBe(false);
      expect(run).not.toHaveBeenCalled();
    });

    it('sends the builds in flight at most every 15 seconds, and at once when they fall to none', () => {
      const run: Run = (_f, _a, _o, done) => done();
      const q = metricsQueue(on, run);
      expect(q.builds('platform', 'codebuild-linux-small', 5, 1_000)).toBe(true);
      expect(q.builds('platform', 'codebuild-linux-small', 6, 1_000 + BUILDS_EVERY_MS - 1)).toBe(false);
      expect(q.builds('platform', 'codebuild-linux-small', 0, 1_000 + BUILDS_EVERY_MS - 1)).toBe(true);
      expect(q.builds('platform', 'codebuild-linux-small', 4, 1_000 + 2 * BUILDS_EVERY_MS)).toBe(true);
      expect(q.builds('cell-account-1', 'codebuild-linux-small', 4, 1_000 + 9 * BUILDS_EVERY_MS)).toBe(false);
    });
  });

  describe('the queue under failure', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-'));
    fs.mkdirSync(path.join(repo, 'stress', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'stress', 'lib', 'cli.js'), '');
    const on = { STRESS_METRICS: '1', STRESS_REPO: repo };

    it('goes on with the calls behind a call that throws', async () => {
      const seen: string[] = [];
      const run: Run = (_f, args, _o, done) => {
        seen.push(args[2]!);
        if (args[3] === '1') throw new Error('spawn failed');
        done();
      };
      const q = metricsQueue(on, run);
      q.emit(['OnboardReadySeconds', '1']);
      q.emit(['OnboardReadySeconds', '2']);
      await q.flush();
      expect(seen).toEqual(['OnboardReadySeconds', 'OnboardReadySeconds']);
    });

    it('stops waiting for a call that never ends after FLUSH_DEADLINE_MS', async () => {
      jest.useFakeTimers();
      try {
        const q = metricsQueue(on, () => undefined);
        q.emit(['OnboardReadySeconds', '1']);
        let flushed = false;
        void q.flush().then(() => {
          flushed = true;
        });
        await jest.advanceTimersByTimeAsync(FLUSH_DEADLINE_MS - 1);
        expect(flushed).toBe(false);
        await jest.advanceTimersByTimeAsync(2);
        expect(flushed).toBe(true);
      } finally {
        jest.useRealTimers();
      }
    });

    it('keeps the last builds figure that was held back and sends it on flush', async () => {
      const sent: string[] = [];
      const run: Run = (_f, args, _o, done) => {
        sent.push(args[3]!);
        done();
      };
      const q = metricsQueue(on, run);
      expect(q.builds('platform', 'codebuild-linux-small', 5, 1_000)).toBe(true);
      expect(q.builds('platform', 'codebuild-linux-small', 7, 2_000)).toBe(false);
      expect(q.builds('platform', 'codebuild-linux-small', 9, 3_000)).toBe(false);
      await q.flush();
      expect(sent).toEqual(['5', '9']);
      await q.flush();
      expect(sent).toEqual(['5', '9']);
    });
  });

  it('leaves the recorder as it was when the run has no metrics: a sample is still kept', () => {
    const rec = new Recorder();
    rec.sample('ready', 10);
    rec.quotaPeak('platform', 'codebuild-linux-small', 3);
    expect(rec.toRecord({ runId: 'r', tier: 'small', mode: 'slice', slice: 'control-plane', commit: 'abc1234' }, 'PS-1').latency.ready?.p50).toBe(10);
  });
});
