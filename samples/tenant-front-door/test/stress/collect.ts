// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as fs from 'node:fs';
import * as path from 'node:path';
import { CloudWatchClient, GetMetricStatisticsCommand } from '@aws-sdk/client-cloudwatch';
import { CloudWatchLogsClient, GetQueryResultsCommand, StartQueryCommand } from '@aws-sdk/client-cloudwatch-logs';
import { sleep } from './http';
import { compareCell, expectedAtCell, joinEdge, type EdgeRow } from './join';
import { percentiles, type ResultRecordJson } from './recorder';
import { readRequestLog, type Env, type Outputs } from './state';

/**
 * `collect`: reads the hops' logs for each scenario's window and checks
 * them against what the driver saw (P-7, docs/stress-test.spec.md §3.4).
 * Edge: every request's `x-amz-cf-id` is looked up as `x-edge-request-id` in
 * the standard log (the correlation join, ADR-0028). Cell: its log's count by
 * status equals the number of requests the driver saw reach it, so a
 * refusal at the edge that also reached the origin shows. Router: the
 * function's compute utilization and its error metrics for the window.
 * Writes the edge hop into the scenario's record (late field) and
 * returns the failures; the run fails when there are any.
 */

type Row = Record<string, string>;

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

async function edgeRows(
  client: CloudWatchLogsClient,
  group: string,
  fromMs: number,
  toMs: number,
  chunkSeconds: number,
): Promise<Map<string, EdgeRow>> {
  const rows = new Map<string, EdgeRow>();
  for (let t = fromMs; t < toMs; t += chunkSeconds * 1000) {
    for (const r of await insights(client, group, t, Math.min(toMs, t + chunkSeconds * 1000), EDGE_QUERY)) {
      rows.set(r.id, { id: r.id, status: Number(r.status), resultType: r.resultType ?? '', tenant: r.tenant ?? '', seconds: Number(r.seconds) });
    }
  }
  return rows;
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

/** The scenarios of this slice that have a record in the results folder. */
function recordsOf(env: Env): { scenario: string; file: string; record: ResultRecordJson }[] {
  if (!fs.existsSync(env.results)) return [];
  return fs
    .readdirSync(env.results)
    .filter((f) => f.startsWith('tenant-front-door.') && f.endsWith('.json'))
    .sort()
    .map((f) => ({ scenario: f.slice('tenant-front-door.'.length, -'.json'.length), file: path.join(env.results, f), record: JSON.parse(fs.readFileSync(path.join(env.results, f), 'utf8')) as ResultRecordJson }));
}

export async function collect(env: Env, out: Outputs): Promise<CollectResult> {
  const routerName = out.routerFunction.split('/').pop() as string;
  const failures: string[] = [];
  const notes: string[] = [];
  const edgeLogs = new CloudWatchLogsClient({ region: out.edgeRegion });
  const cellLogs = new CloudWatchLogsClient({ region: out.region });
  const metrics = new CloudWatchClient({ region: out.edgeRegion });
  const chunk = Math.min(60, Math.max(5, Math.floor(8000 / env.tier.peakRps)));
  const deadline = Date.now() + DEADLINE_MS;
  let joinedAll = 0;
  let expectedAll = 0;

  for (const { scenario, file, record } of recordsOf(env)) {
    const lines = readRequestLog(env, scenario);
    const fromMs = Date.parse(record.window.start);
    const toMs = Date.parse(record.window.end);
    // Logs land late: CloudFront's standard log in about half a minute, Insights a little after.
    let join = joinEdge(lines, await edgeRows(edgeLogs, out.edgeLogGroup, fromMs - 60_000, toMs + 60_000, chunk));
    while (join.missing > 0 && Date.now() < deadline) {
      await sleep(15_000);
      join = joinEdge(lines, await edgeRows(edgeLogs, out.edgeLogGroup, fromMs - 60_000, toMs + 60_000, chunk));
    }
    joinedAll += join.matched;
    expectedAll += join.expected;
    if (join.missing > 0) failures.push(`${scenario}: ${join.missing} of ${join.expected} requests have no edge log line for their x-amz-cf-id`);
    for (const m of [...join.statusMismatches, ...join.tenantMismatches]) failures.push(`${scenario}: ${m}`);
    if (join.generatedByFunction !== join.routerRefusals) failures.push(`${scenario}: ${join.routerRefusals - join.generatedByFunction} router refusals are not marked FunctionGeneratedResponse in the edge log`);

    // The cell's own count, once its log is complete: the expected total, or for no expected request, quiet for a minute.
    const want = expectedAtCell(lines);
    let diff: string[] = [];
    let quietSince = Date.now();
    let previous = '';
    for (;;) {
      const got = await cellCounts(cellLogs, out.cellLogGroup, fromMs - 2000, toMs + 2000);
      diff = compareCell(want, got);
      const key = JSON.stringify([...got]);
      if (key !== previous) quietSince = Date.now();
      previous = key;
      const total = [...want.values()].reduce((a, b) => a + b, 0);
      if ((diff.length === 0 && (total > 0 || Date.now() - quietSince > 60_000)) || Date.now() > deadline) break;
      await sleep(10_000);
    }
    for (const d of diff) failures.push(`${scenario}: ${d}`);

    const hops = { ...record.latency, edge: percentiles(join.edgeSeconds) };
    const compute = await routerMetric(metrics, routerName, 'FunctionComputeUtilization', 'Maximum', fromMs, toMs);
    const errors = await routerMetric(metrics, routerName, 'FunctionExecutionErrors', 'Sum', fromMs, toMs);
    const throttles = await routerMetric(metrics, routerName, 'FunctionThrottles', 'Sum', fromMs, toMs);
    if (errors.max > 0 || throttles.max > 0) failures.push(`${scenario}: the router had execution errors or throttles in the window (errors ${errors.max}, throttles ${throttles.max})`);
    const next: ResultRecordJson = {
      ...record,
      latency: join.edgeSeconds.length > 0 ? hops : record.latency,
      quotas: { platform: { ...(compute.points > 0 ? { 'cloudfront-function-compute-utilization-pct': compute.max } : {}) } },
    };
    fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
    notes.push(
      `${scenario}: edge log ${join.matched}/${join.expected} joined on x-amz-cf-id = x-edge-request-id; router refusals marked FunctionGeneratedResponse ${join.generatedByFunction}/${join.routerRefusals}; ` +
        `cell log ${diff.length === 0 ? 'agrees with the driver' : 'DISAGREES'} (reached the cell: ${[...want].map(([s, n]) => `${s}=${n}`).join(' ') || 'none'}); ` +
        `router compute max ${compute.points > 0 ? `${compute.max.toFixed(1)} %` : 'no datapoint yet'}`,
    );
  }
  fs.writeFileSync(path.join(env.stateDir, 'correlation.json'), `${JSON.stringify({ requestsWithId: expectedAll, joinedOnAmzCfId: joinedAll })}\n`);
  notes.push(`correlation: ${joinedAll} of ${expectedAll} requests joined the edge log on x-amz-cf-id = x-edge-request-id`);
  return { failures, notes };
}
