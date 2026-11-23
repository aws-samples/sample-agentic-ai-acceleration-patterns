// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as fs from 'node:fs';
import * as path from 'node:path';
import { CloudWatchClient, GetMetricStatisticsCommand } from '@aws-sdk/client-cloudwatch';
import { CloudWatchLogsClient, GetQueryResultsCommand, StartQueryCommand } from '@aws-sdk/client-cloudwatch-logs';
import { sleep } from './http';
import { compareCell, expectedAtCell, joinEdge, type EdgeRow } from './join';
import { percentiles, type ResultRecordJson } from './recorder';
import { readRequestLog, requestLogPath, type Env, type Outputs, type RequestLine } from './state';

/**
 * `collect`: reads the hops' logs for each scenario's window and checks
 * them against what the driver saw (P-7, docs/stress-test.spec.md §3.4).
 * Edge: every request's `x-amz-cf-id` is looked up as `x-edge-request-id` in
 * the standard log (the correlation join, ADR-0029). Cell: its log's count by
 * status equals the number of requests the driver saw reach it, so a
 * refusal at the edge that also reached the origin shows. Router: the
 * function's compute utilization and its error metrics for the window.
 * Writes the edge hop and the router's compute reading into the scenario's record and
 * returns the failures; the run fails when there are any.
 */

type Row = Record<string, string>;

/** How long collect waits for one scenario's logs. */
const DEADLINE_MS = 300_000;

async function insights(client: CloudWatchLogsClient, group: string, fromMs: number, toMs: number, query: string): Promise<Row[]> {
  const start = await client.send(
    new StartQueryCommand({
      logGroupName: group,
      startTime: Math.floor(fromMs / 1000),
      endTime: Math.ceil(toMs / 1000),
      queryString: query,
      limit: 10000,
    }),
  );
  for (let i = 0; i < 120; i += 1) {
    const r = await client.send(new GetQueryResultsCommand({ queryId: start.queryId }));
    if (r.status === 'Complete') {
      return (r.results ?? []).map((row) => Object.fromEntries(row.map((f) => [f.field ?? '', f.value ?? ''])));
    }
    if (r.status === 'Failed' || r.status === 'Cancelled' || r.status === 'Timeout') throw new Error(`Logs Insights query ${r.status}`);
    await sleep(1000);
  }
  throw new Error('Logs Insights query did not finish in two minutes');
}

const EDGE_QUERY =
  'fields `x-edge-request-id` as id, `sc-status` as status, `x-edge-result-type` as resultType, `viewer-request-log-data` as tenant, `time-taken` as seconds | filter ispresent(id) | limit 10000';

/** Adds the edge log's rows for the window to `rows`; the ids of rows with a status or a time that is not a number go in `skipped`. */
export async function loadEdgeRows(
  client: CloudWatchLogsClient,
  group: string,
  fromMs: number,
  toMs: number,
  chunkSeconds: number,
  rows: Map<string, EdgeRow>,
  skipped: Set<string>,
): Promise<void> {
  for (let t = fromMs; t < toMs; t += chunkSeconds * 1000) {
    for (const r of await insights(client, group, t, Math.min(toMs, t + chunkSeconds * 1000), EDGE_QUERY)) {
      const status = Number(r.status);
      const seconds = Number(r.seconds);
      if (!Number.isFinite(status) || !Number.isFinite(seconds) || r.status === '' || r.seconds === '') {
        skipped.add(r.id);
        continue;
      }
      rows.set(r.id, { id: r.id, status, resultType: r.resultType ?? '', tenant: r.tenant ?? '', seconds });
    }
  }
}

async function cellCounts(client: CloudWatchLogsClient, group: string, fromMs: number, toMs: number): Promise<Map<number, number>> {
  const rows = await insights(client, group, fromMs, toMs, "filter message = 'served' or message = 'refused' | stats count(*) as n by status");
  return new Map(rows.map((r) => [Number(r.status), Number(r.n)]));
}

interface Metric {
  readonly max: number;
  readonly average: number;
  readonly points: number;
}

async function routerMetric(client: CloudWatchClient, fn: string, name: string, stat: 'Maximum' | 'Average' | 'Sum', fromMs: number, toMs: number): Promise<Metric> {
  const r = await client.send(
    new GetMetricStatisticsCommand({
      Namespace: 'AWS/CloudFront',
      MetricName: name,
      Dimensions: [{ Name: 'FunctionName', Value: fn }, { Name: 'Region', Value: 'Global' }],
      // The metric has one datapoint a minute: the minutes the scenario ran in, which a neighbouring scenario may share.
      StartTime: new Date(Math.floor(fromMs / 60_000) * 60_000),
      EndTime: new Date((Math.floor(toMs / 60_000) + 1) * 60_000),
      Period: 60,
      Statistics: [stat],
    }),
  );
  const values = (r.Datapoints ?? []).map((d) => d[stat] ?? 0);
  const sum = values.reduce((a, b) => a + b, 0);
  return { max: values.length === 0 ? 0 : Math.max(...values), average: values.length === 0 ? 0 : sum / values.length, points: values.length };
}

export interface CollectResult {
  readonly failures: string[];
  readonly notes: string[];
}

/**
 * What `collect` reads of the deployment. Slice mode has the demo cell's log group; platform mode has none (the cell is in another
 * account, and its log group is not this slice's to read), so the cell's count is not compared there.
 */
export type CollectOutputs = Pick<Outputs, 'region' | 'edgeRegion' | 'edgeLogGroup' | 'routerFunction'> & { readonly cellLogGroup?: string };

/** The scenarios of this slice that have a record in the results folder. */
function recordsOf(env: Env): { scenario: string; file: string; record: ResultRecordJson }[] {
  if (!fs.existsSync(env.results)) return [];
  return fs
    .readdirSync(env.results)
    .filter((f) => f.startsWith('tenant-front-door.') && f.endsWith('.json'))
    .sort()
    .map((f) => ({ scenario: f.slice('tenant-front-door.'.length, -'.json'.length), file: path.join(env.results, f), record: JSON.parse(fs.readFileSync(path.join(env.results, f), 'utf8')) as ResultRecordJson }));
}

export async function collect(env: Env, out: CollectOutputs): Promise<CollectResult> {
  const routerName = out.routerFunction.split('/').pop() as string;
  const failures: string[] = [];
  const notes: string[] = [];
  const edgeLogs = new CloudWatchLogsClient({ region: out.edgeRegion });
  const cellLogs = new CloudWatchLogsClient({ region: out.region });
  const metrics = new CloudWatchClient({ region: out.edgeRegion });
  const chunk = Math.min(60, Math.max(5, Math.floor(8000 / env.tier.peakRps)));
  let joinedAll = 0;
  let expectedAll = 0;

  const records = recordsOf(env);
  if (records.length === 0) failures.push(`no tenant-front-door.<scenario>.json record in ${env.results}: run a scenario first, there is nothing to check`);
  for (const { scenario, file, record } of records) {
    if (!fs.existsSync(requestLogPath(env, scenario))) {
      failures.push(`${scenario}: no request log ${requestLogPath(env, scenario)}: there is nothing to join with the edge log`);
      continue;
    }
    const lines = readRequestLog(env, scenario);
    const fromMs = Date.parse(record.window.start);
    const toMs = Date.parse(record.window.end);
    // Logs land late: CloudFront's standard log in about half a minute, Insights a little after.
    const rows = new Map<string, EdgeRow>();
    const skipped = new Set<string>();
    await loadEdgeRows(edgeLogs, out.edgeLogGroup, fromMs - 60_000, toMs + 60_000, chunk, rows, skipped);
    // Each scenario waits for its own logs, from the end of its first load: one that is late must not shorten the next one's wait.
    const deadline = Date.now() + DEADLINE_MS;
    const missingLines = (): RequestLine[] => lines.filter((l) => l.id !== '' && !rows.has(l.id) && !skipped.has(l.id));
    while (missingLines().length > 0 && Date.now() < deadline) {
      await sleep(15_000);
      // Only the stretch of the window the missing requests were sent in.
      const at = missingLines().map((l) => l.at);
      const first = at.reduce((a, b) => Math.min(a, b));
      const last = at.reduce((a, b) => Math.max(a, b));
      await loadEdgeRows(edgeLogs, out.edgeLogGroup, first - 5_000, last + 60_000, chunk, rows, skipped);
    }
    const join = joinEdge(lines, rows);
    const own = new Set(lines.map((l) => l.id));
    const badRows = [...skipped].filter((id) => own.has(id) && !rows.has(id)).length;
    if (badRows > 0) failures.push(`${scenario}: ${badRows} of this scenario's edge log rows have a status or a time-taken that is not a number`);
    joinedAll += join.matched;
    expectedAll += join.expected;
    const absent = missingLines().length;
    if (absent > 0) failures.push(`${scenario}: ${absent} of ${join.expected} requests have no edge log line for their x-amz-cf-id`);
    for (const m of [...join.statusMismatches, ...join.tenantMismatches]) failures.push(`${scenario}: ${m}`);
    if (join.generatedByFunction !== join.routerRefusals) failures.push(`${scenario}: ${join.routerRefusals - join.generatedByFunction} router refusals are not marked FunctionGeneratedResponse in the edge log`);

    // The cell's own count, once its log is complete: the expected total, or for no expected request, quiet for a minute.
    // Platform mode skips it: the cell's log group is in another account (the control plane builds the cell there), and the
    // slice has no read access to it. Every other check above and below runs.
    const want = expectedAtCell(lines);
    let diff: string[] = [];
    if (out.cellLogGroup !== undefined) {
      let quietSince = Date.now();
      let previous = '';
      // The cell check has a deadline of its own, after the edge wait.
      const cellDeadline = Date.now() + DEADLINE_MS;
      for (;;) {
        const got = await cellCounts(cellLogs, out.cellLogGroup, fromMs - 2000, toMs + 2000);
        diff = compareCell(want, got);
        const key = JSON.stringify([...got]);
        if (key !== previous) quietSince = Date.now();
        previous = key;
        const total = [...want.values()].reduce((a, b) => a + b, 0);
        // The counts agree: wait until they stop changing, so a line for a request that must not have reached the cell is not missed
        // because it arrives after the poll that found them equal. A minute when nothing is expected, half of that when something is.
        const quiet = Date.now() - quietSince > (total > 0 ? 30_000 : 60_000);
        if (diff.length === 0 && quiet) break;
        if (Date.now() > cellDeadline) {
          // The counts agree but the log never stayed quiet: the check did not run to its end.
          if (diff.length === 0) failures.push(`${scenario}: the cell log was still changing at the deadline; a request that should not have reached the origin may not be shown yet`);
          break;
        }
        await sleep(10_000);
      }
      for (const d of diff) failures.push(`${scenario}: ${d}`);
    }

    const hops = { ...record.latency, edge: percentiles(join.edgeSeconds) };
    const compute = await routerMetric(metrics, routerName, 'FunctionComputeUtilization', 'Maximum', fromMs, toMs);
    // CloudFront publishes a datapoint a minute, and only when there was something to count: no point means the metric has not arrived,
    // and a minute shared with a neighbouring scenario counts its errors too.
    // With invocations counted for the same minutes, an error metric with no datapoint means none: there was nothing to count.
    const invoked = (await routerMetric(metrics, routerName, 'FunctionInvocations', 'Sum', fromMs, toMs)).points > 0;
    const bad: string[] = [];
    let unchecked = 0;
    for (const name of ['FunctionExecutionErrors', 'FunctionThrottles', 'FunctionValidationErrors']) {
      const m = await routerMetric(metrics, routerName, name, 'Sum', fromMs, toMs);
      if (m.points === 0 && !invoked) unchecked += 1;
      else if (m.max > 0) bad.push(`${name} ${m.max}`);
    }
    if (bad.length > 0) failures.push(`${scenario}: the router reported ${bad.join(', ')} in the minutes of the window (a neighbouring scenario's minute may share them)`);
    if (unchecked > 0) notes.push(`${scenario}: ${unchecked} of 3 router error metrics had no datapoint yet and were not checked`);
    const next: ResultRecordJson = {
      ...record,
      latency: join.edgeSeconds.length > 0 ? hops : record.latency,
      quotas: { platform: { ...(compute.points > 0 ? { 'cloudfront-function-compute-utilization-pct': compute.max } : {}) } },
    };
    fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
    notes.push(
      `${scenario}: edge log ${join.matched}/${join.expected} joined on x-amz-cf-id = x-edge-request-id; router refusals marked FunctionGeneratedResponse ${join.generatedByFunction}/${join.routerRefusals}; ` +
        `cell log ${out.cellLogGroup === undefined ? 'not compared (platform mode: the cell\'s log group is in another account)' : `${diff.length === 0 ? 'agrees with the driver' : 'DISAGREES'} (reached the cell: ${[...want].map(([s, n]) => `${s}=${n}`).join(' ') || 'none'})`}; ` +
        `router compute max ${compute.points > 0 ? `${compute.max.toFixed(1)} %` : 'no datapoint yet'}`,
    );
  }
  notes.push(`correlation: ${joinedAll} of ${expectedAll} requests joined the edge log on x-amz-cf-id = x-edge-request-id`);
  return { failures, notes };
}
