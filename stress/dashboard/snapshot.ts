// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Saves a PNG of each metric widget of a run's dashboard, for the run's window, into
 * `<run folder>/dashboard/<widget id>.png` (stress ADR-0022, design §9). The images come from the
 * same widget properties the dashboard has, so they show what it showed. Run by `dashboard.sh
 * snapshot` from `stress/`, with the credentials of the platform account.
 *
 * Environment: `STRESS_DASHBOARD_PLAN_FILE`, `STRESS_CELL_ACCOUNTS`, `STRESS_RUN_DIR`. The run
 * folder is outside the repository and the images are not committed.
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { planFromFiles } from './plan';
import { type DashboardPlan, type Widget, widgetRegion, widgetsFor } from './widgets';

const PIXELS = { width: 900, height: 320 };

/** The properties `GetMetricWidgetImage` takes: the widget's own, with a size and the run's window. */
export function imageProperties(w: Widget, plan: DashboardPlan): Record<string, unknown> {
  return {
    ...w.properties,
    region: widgetRegion(w, plan),
    width: PIXELS.width,
    height: PIXELS.height,
    start: plan.start ?? '-PT3H',
    end: plan.end ?? 'PT0H',
  };
}

function awsImage(region: string, properties: Record<string, unknown>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      'aws',
      ['cloudwatch', 'get-metric-widget-image', '--region', region, '--metric-widget', JSON.stringify(properties), '--query', 'MetricWidgetImage', '--output', 'text'],
      { maxBuffer: 16 * 1024 * 1024, timeout: 120_000 },
      (error, stdout, stderr) => {
        if (error !== null) reject(new Error(stderr.trim().split('\n')[0] ?? error.message));
        else resolve(Buffer.from(stdout.trim(), 'base64'));
      },
    );
  });
}

async function main(): Promise<number> {
  const planFile = process.env.STRESS_DASHBOARD_PLAN_FILE;
  const runDir = process.env.STRESS_RUN_DIR;
  if (planFile === undefined || runDir === undefined) throw new Error('STRESS_DASHBOARD_PLAN_FILE and STRESS_RUN_DIR must be set');
  const plan = planFromFiles(planFile, process.env.STRESS_CELL_ACCOUNTS);
  const dir = path.join(runDir, 'dashboard');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let failed = 0;
  let saved = 0;
  for (const w of widgetsFor(plan).filter((x) => x.type === 'metric')) {
    try {
      const png = await awsImage(widgetRegion(w, plan), imageProperties(w, plan));
      fs.writeFileSync(path.join(dir, `${w.id}.png`), png, { mode: 0o600 });
      saved += 1;
    } catch (e) {
      failed += 1;
      process.stderr.write(`snapshot: ${w.id}: ${(e as Error).message}\n`);
    }
  }
  process.stdout.write(`snapshot: ${saved} images in ${dir}, ${failed} failed\n`);
  return failed === 0 ? 0 : 1;
}

if (require.main === module) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      process.stderr.write(`${(e as Error).message}\n`);
      process.exitCode = 1;
    },
  );
}
