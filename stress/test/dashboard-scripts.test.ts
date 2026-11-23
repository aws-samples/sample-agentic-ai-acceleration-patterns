// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const DASHBOARD_SH = path.resolve(__dirname, '..', 'dashboard', 'dashboard.sh');
const REMOVE_SINK_SH = path.resolve(__dirname, '..', 'dashboard', 'remove-sink.sh');

interface State {
  /** `absent`, `denied`, or a stack status. */
  status: string;
  /** The value of the `stress:part` tag, or `None`. */
  tag?: string;
  /** What `list-dashboards` prints for the run dashboard's name. */
  dashboards?: string;
  sink?: string;
  links?: string;
}

/** A stub `aws` that answers from files, so the scripts' decisions are run, not read. */
function bench(state: State) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-scripts-'));
  benches.push(dir);
  const put = (name: string, value: string): void => fs.writeFileSync(path.join(dir, name), `${value}\n`);
  put('status', state.status);
  put('tag', state.tag ?? 'None');
  put('dashboards', state.dashboards ?? 'None');
  put('sink', state.sink ?? 'None');
  put('links', state.links ?? '0');
  fs.writeFileSync(path.join(dir, 'calls'), '');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, 'aws'),
    [
      '#!/usr/bin/env bash',
      'echo "$*" >> "$STUB/calls"',
      'case "$1 $2" in',
      '  "cloudformation describe-stacks")',
      '    st="$(cat "$STUB/status")"',
      '    if [[ "$st" == absent ]]; then echo "An error occurred (ValidationError) when calling the DescribeStacks operation: Stack with id X does not exist" >&2; exit 254; fi',
      '    if [[ "$st" == denied ]]; then echo "An error occurred (AccessDenied) when calling the DescribeStacks operation: not allowed" >&2; exit 254; fi',
      '    if [[ "$*" == *Tags* ]]; then',
      '      if [[ "$st" == tagfail ]]; then echo "An error occurred (Throttling) when calling the DescribeStacks operation: rate exceeded" >&2; exit 254; fi',
      '      cat "$STUB/tag"',
      '    else',
      '      if [[ "$st" == tagfail ]]; then echo CREATE_COMPLETE; else echo "$st"; fi',
      '    fi ;;',
      '  "cloudformation delete-stack") echo absent > "$STUB/status"; echo None > "$STUB/sink" ;;',
      '  "cloudwatch list-dashboards") cat "$STUB/dashboards" ;;',
      '  "sts get-caller-identity") echo 111122223333 ;;',
      '  "oam list-sinks") cat "$STUB/sink" ;;',
      '  "oam list-attached-links") cat "$STUB/links" ;;',
      'esac',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(bin, 'npx'), ['#!/usr/bin/env bash', 'echo "npx $*" >> "$STUB/calls"', ''].join('\n'), { mode: 0o755 });
  return {
    calls: (): string => fs.readFileSync(path.join(dir, 'calls'), 'utf8'),
    run(script: string, args: string[] = [], extra: Record<string, string> = {}) {
      const r = spawnSync('bash', [script, ...args], {
        encoding: 'utf8',
        timeout: 30_000,
        env: { PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME, STUB: dir, AWS_REGION: 'eu-west-2', STRESS_PREFIX: 'StressT', ...extra },
      });
      return { status: r.status, out: r.stdout, err: r.stderr };
    },
  };
}

const benches: string[] = [];
afterAll(() => {
  for (const dir of benches) fs.rmSync(dir, { recursive: true, force: true });
});

// dashboard.sh runs `npm ci` when stress/node_modules is missing, so these tests need it installed (or a network).
describe('dashboard.sh down (stress/dashboard/dashboard.sh)', () => {
  it('removes its own stack and checks nothing is left', () => {
    const b = bench({ status: 'CREATE_COMPLETE', tag: 'run-dashboard' });
    const r = b.run(DASHBOARD_SH, ['down']);
    expect(r.status).toBe(0);
    expect(r.out).toContain('destroy_seconds=');
    expect(r.out).toContain('leftovers: none');
    expect(b.calls()).toContain('cloudformation delete-stack --stack-name StressT-dashboard');
  });

  it('has nothing to do when the stack is not there', () => {
    const b = bench({ status: 'absent' });
    const r = b.run(DASHBOARD_SH, ['down']);
    expect(r.status).toBe(0);
    expect(r.out).toContain('nothing to remove');
    expect(b.calls()).not.toContain('delete-stack');
  });

  it('leaves a stack of that name that is not a run dashboard alone, and exits 0', () => {
    for (const tag of ['None', 'something-else']) {
      const b = bench({ status: 'CREATE_COMPLETE', tag });
      const r = b.run(DASHBOARD_SH, ['down']);
      expect(r.status).toBe(0);
      expect(r.err).toContain('not ours');
      expect(b.calls()).not.toContain('delete-stack');
    }
  });

  it('stops on a describe failure that is not "does not exist"', () => {
    const b = bench({ status: 'denied' });
    const r = b.run(DASHBOARD_SH, ['down']);
    expect(r.status).toBe(1);
    expect(r.err).toContain('describe-stacks StressT-dashboard failed');
    expect(b.calls()).not.toContain('delete-stack');
  });

  it('fails, and removes nothing, when the tags of the stack cannot be read', () => {
    const down = bench({ status: 'tagfail' });
    const r = down.run(DASHBOARD_SH, ['down']);
    expect(r.status).toBe(1);
    expect(r.err).toContain('could not read its tags');
    expect(down.calls()).not.toContain('delete-stack');
    const up = bench({ status: 'tagfail' });
    const u = up.run(DASHBOARD_SH, ['up'], { STRESS_DASHBOARD_PLAN_FILE: path.join(os.tmpdir(), 'no-plan.json') });
    expect(u.status).toBe(1);
    expect(u.err).toContain('could not read its tags');
  });

  it('reports a dashboard that is still there as a leftover and exits 1', () => {
    const b = bench({ status: 'absent', dashboards: 'StressT-run' });
    const r = b.run(DASHBOARD_SH, ['down']);
    expect(r.status).toBe(1);
    expect(r.err).toContain('leftover: the dashboard StressT-run is still there');
  });

  it('deploys over its own stack with `up`, and over no stack', () => {
    for (const status of ['CREATE_COMPLETE', 'absent']) {
      const b = bench({ status, tag: 'run-dashboard' });
      const r = b.run(DASHBOARD_SH, ['up'], { STRESS_DASHBOARD_PLAN_FILE: path.join(os.tmpdir(), 'no-plan.json') });
      expect(r.status).toBe(0);
      expect(r.out).toContain('stack=StressT-dashboard deploy_seconds=');
      expect(b.calls()).toContain('npx cdk --app');
    }
  });

  it('refuses `up` over a stack of its name that is not a run dashboard', () => {
    const b = bench({ status: 'CREATE_COMPLETE', tag: 'None' });
    const r = b.run(DASHBOARD_SH, ['up'], { STRESS_DASHBOARD_PLAN_FILE: path.join(os.tmpdir(), 'no-plan.json') });
    expect(r.status).toBe(1);
    expect(r.err).toContain('is not a run dashboard');
  });
});

describe('remove-sink.sh (stress/dashboard/remove-sink.sh)', () => {
  const SINK = 'arn:aws:oam:eu-west-2:111122223333:sink/abc';

  it('has nothing to do when the stack does not exist', () => {
    const b = bench({ status: 'absent' });
    const r = b.run(REMOVE_SINK_SH);
    expect(r.status).toBe(0);
    expect(r.out).toContain('nothing to remove');
  });

  it('does not treat a denied describe as "absent"', () => {
    const b = bench({ status: 'denied' });
    const r = b.run(REMOVE_SINK_SH);
    expect(r.status).toBe(1);
    expect(r.err).toContain('describe-stacks StressRunSink failed');
    expect(b.calls()).not.toContain('delete-stack');
  });

  it('leaves a stack of that name without the sink tag alone', () => {
    const b = bench({ status: 'CREATE_COMPLETE', tag: 'None', sink: SINK });
    const r = b.run(REMOVE_SINK_SH);
    expect(r.status).toBe(1);
    expect(r.err).toContain('not touching it');
    expect(b.calls()).not.toContain('delete-stack');
  });

  it('refuses while a link is attached', () => {
    const b = bench({ status: 'CREATE_COMPLETE', tag: 'run-sink', sink: SINK, links: '2' });
    const r = b.run(REMOVE_SINK_SH);
    expect(r.status).toBe(1);
    expect(r.err).toContain('2 attached link');
    expect(b.calls()).not.toContain('delete-stack');
  });

  it('removes its own sink when no link is attached', () => {
    const b = bench({ status: 'CREATE_COMPLETE', tag: 'run-sink', sink: SINK, links: '0' });
    const r = b.run(REMOVE_SINK_SH);
    expect(r.status).toBe(0);
    expect(r.out).toContain('leftovers: none');
    expect(b.calls()).toContain('delete-stack --stack-name StressRunSink');
  });
});
