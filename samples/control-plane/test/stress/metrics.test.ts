// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildsArgs, emit, sampleArgs } from './metrics';
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

  describe('emit', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-'));
    fs.mkdirSync(path.join(repo, 'stress', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'stress', 'lib', 'cli.js'), '');
    const on = { STRESS_METRICS: '1', STRESS_REPO: repo };

    it('calls the runner\'s own emitter when the run has its metrics on', () => {
      const calls: string[][] = [];
      expect(emit(['BuildsInFlight', '3'], on, (file, args) => void calls.push([file, ...args]))).toBe(true);
      expect(calls).toEqual([['node', path.join(repo, 'stress', 'lib', 'cli.js'), 'emit', 'BuildsInFlight', '3']]);
    });

    it('does nothing without the switch, without a repository or CLI, or without arguments', () => {
      const run = jest.fn();
      expect(emit(['BuildsInFlight', '3'], { STRESS_REPO: repo }, run)).toBe(false);
      expect(emit(['BuildsInFlight', '3'], { STRESS_METRICS: '1' }, run)).toBe(false);
      expect(emit(['BuildsInFlight', '3'], { STRESS_METRICS: '1', STRESS_REPO: '/nonexistent' }, run)).toBe(false);
      expect(emit(undefined, on, run)).toBe(false);
      expect(run).not.toHaveBeenCalled();
    });
  });

  it('leaves the recorder as it was when the run has no metrics: a sample is still kept', () => {
    const rec = new Recorder();
    rec.sample('ready', 10);
    rec.quotaPeak('platform', 'codebuild-linux-small', 3);
    expect(rec.toRecord({ runId: 'r', tier: 'small', mode: 'slice', slice: 'control-plane', commit: 'abc1234' }, 'PS-1').latency.ready?.p50).toBe(10);
  });
});
