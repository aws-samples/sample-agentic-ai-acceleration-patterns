// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The widgets of the run dashboard, as data (stress ADR-0022, docs/stress-dashboard.design.md
 * §4). `widgetsFor(plan)` returns every widget with its CloudWatch properties; the dashboard
 * stack lays them out and the snapshot step renders the same properties as images, so the
 * two never differ. Metric names that no spike found are not here (README, "Spike results").
 *
 * A widget names the series it draws. `StressRun` series are new in each run (`RunId`), so no
 * widget searches them: a search finds a metric only after it is listed, up to 15 minutes late.
 * Native series whose names a run creates after the dashboard (the router, the distribution,
 * the identity API) are found by `SEARCH`, as the design says; the others are account-wide
 * series with no dimension.
 */

import { K6_SCENARIOS } from '../src/metrics';

/** What a run did: one `(slice, scenario)` pair for each record it writes. */
export interface RunPart {
  readonly slice: string;
  readonly scenario: string;
}

export interface DashboardPlan {
  readonly runId: string;
  readonly tier: string;
  readonly commit: string;
  readonly region: string;
  /** The Region of the identity API when it is not the run's Region (`STRESS_FD_IDENTITY_REGION`). */
  readonly identityRegion?: string;
  readonly runs: readonly RunPart[];
  /** Cell account ids, in the order of `cell-account-1`, `cell-account-2`. */
  readonly cellAccounts: readonly string[];
  /** The budget's `<account label>:<quota id>` pairs the run draws on, for the headroom panels. */
  readonly quotas: readonly string[];
  /** Absolute time range of the dashboard (UTC ISO); without it the dashboard shows the last 3 hours. */
  readonly start?: string;
  readonly end?: string;
}

export interface Widget {
  readonly id: string;
  /** `text` widgets carry markdown; `metric` widgets carry a CloudWatch metric widget. */
  readonly type: 'text' | 'metric';
  readonly title: string;
  readonly width: number;
  readonly height: number;
  readonly properties: Record<string, unknown>;
  /** The section a widget belongs to, for the layout. */
  readonly section: 'A' | 'B' | 'C' | 'D' | 'E';
}

/** The slice whose k6 scenarios the host relay counts (design §5). */
export const RELAY_SLICE = 'agentic-runtime-isolation';
/** The front door's router lives in the edge Region. */
export const EDGE_REGION = 'us-east-1';
/** The refusal reasons the dashboard draws; any other reason is `other` (design §3.1, §5). */
export const REASONS = ['http-401', 'http-403', 'http-429', 'http-500', 'http-502', 'http-503', 'http-504', 'other'] as const;
const STATUS_CLASSES = ['2xx', '3xx', '4xx', '5xx'] as const;
/** The `Status` values the cell's ingress returns (design §3.2). */
const INGRESS_STATUSES = ['200', '401', '403', '404', '429', '500', '502', '503'] as const;
const SDK_SERVICES = ['sts', 'kms', 'dynamodb'] as const;
const MINT_VALUES = ['hit', 'miss'] as const;
const NS = 'StressRun';
const CELL = 'StressCell';

type Metric = unknown[];

/** `[namespace, name, dim, value, ..., options]`. */
const metric = (ns: string, name: string, dims: readonly (readonly [string, string])[], options: Record<string, unknown> = {}): Metric => [
  ns,
  name,
  ...dims.flat(),
  options,
];

const sanitize = (s: string): string => s.replace(/[^A-Za-z0-9]/g, '_').toLowerCase();

/** A metric math expression row. */
const expr = (id: string, expression: string, label: string, options: Record<string, unknown> = {}): Metric => [
  { expression, id, label, ...options },
];

const common = (title: string, region: string, stat: string, period = 60): Record<string, unknown> => ({ title, region, stat, period, view: 'timeSeries', stacked: false });

/** The k6 scenario runs of the relay's slice: the ones the live series cover. */
function liveScenarios(plan: DashboardPlan): string[] {
  return [...new Set(plan.runs.filter((r) => r.slice === RELAY_SLICE && K6_SCENARIOS.includes(r.scenario)).map((r) => r.scenario))];
}

const scenarioNames = (plan: DashboardPlan): string[] => [...new Set(plan.runs.map((r) => r.scenario))];
const has = (plan: DashboardPlan, scenario: string): boolean => plan.runs.some((r) => r.scenario === scenario);

/**
 * One series for each scenario of `scenarios` (hidden), and one expression that sums them under
 * `label`. CloudWatch does not aggregate over the dimensions of a custom metric, so a total over
 * scenarios is a sum of the series named (design §3.1).
 */
function summed(
  plan: DashboardPlan,
  scenarios: readonly string[],
  name: string,
  dims: (s: string) => readonly (readonly [string, string])[],
  id: string,
  label: string,
  exprOptions: Record<string, unknown> = {},
): Metric[] {
  const rows = scenarios.map((s, i): Metric => metric(NS, name, [['RunId', plan.runId], ...dims(s)], { id: `${id}_${i}`, stat: 'Sum', visible: false }));
  return [...rows, expr(id, `SUM([${scenarios.map((_, i) => `${id}_${i}`).join(',')}])`, label, exprOptions)];
}

/** A scenario-less empty widget keeps the layout stable when a run has no such scenarios. */
function note(id: string, section: Widget['section'], title: string, text: string, width = 24, height = 2): Widget {
  return { id, type: 'text', title, width, height, section, properties: { markdown: `### ${title}\n${text}` } };
}

function sectionA(plan: DashboardPlan): Widget[] {
  const r = plan.region;
  const live = liveScenarios(plan);
  const all = scenarioNames(plan);
  const out: Widget[] = [];
  out.push({
    id: 'A1-header',
    type: 'text',
    title: 'Run',
    width: 24,
    height: 3,
    section: 'A',
    properties: {
      markdown: [
        `## Stress run \`${plan.runId}\``,
        `Tier \`${plan.tier}\`, commit \`${plan.commit.slice(0, 7)}\`, Region \`${r}\`. The scenarios of the run: ${all.map((s) => `\`${s}\``).join(', ') || 'none'}.`,
        'A view, not a gate: the result records decide the run. Live widgets trail a minute of load by about three minutes (design, "near-live").',
      ].join('\n'),
    },
  });
  out.push({
    id: 'A1-strip',
    type: 'metric',
    title: 'Scenarios running',
    width: 24,
    height: 4,
    section: 'A',
    properties: {
      ...common('Scenarios running (1 while a scenario\'s run verb runs)', r, 'Maximum'),
      metrics: all.map((s) => metric(NS, 'ScenarioActive', [['RunId', plan.runId], ['Scenario', s]], { label: s })),
      yAxis: { left: { min: 0, max: 1, showUnits: false } },
    },
  });
  if (live.length > 0) {
    const slice = RELAY_SLICE;
    out.push({
      id: 'A2-isolation',
      type: 'metric',
      title: 'Isolation',
      width: 8,
      height: 6,
      section: 'A',
      properties: {
        ...common('A2 Isolation: assertions and mismatches a minute (mismatches must stay 0)', r, 'Sum'),
        metrics: [
          ...summed(plan, live, 'IsolationAssertions', (s) => [['Slice', slice], ['Scenario', s]], 'asserts', 'assertions'),
          ...summed(plan, live, 'IsolationMismatches', (s) => [['Slice', slice], ['Scenario', s]], 'mism', 'mismatches', { yAxis: 'right', color: '#FF2800' }),
        ],
        yAxis: { left: { min: 0 }, right: { min: 0, label: 'mismatches' } },
        annotations: { horizontal: [{ value: 0, label: 'mismatches: 0 expected', yAxis: 'right', color: '#FF2800' }] },
      },
    });
  }
  const finals = plan.runs.filter((x) => x.scenario !== 'lifecycle');
  out.push({
    id: 'A2-final',
    type: 'metric',
    title: 'Isolation totals',
    width: 4,
    height: 6,
    section: 'A',
    properties: {
      view: 'singleValue',
      title: 'A2 Isolation totals of the run (from the records)',
      region: r,
      period: 60,
      stat: 'Sum',
      setPeriodToTimeRange: true,
      sparkline: false,
      metrics: [
        ...finals.map((x, i): Metric => metric(NS, 'IsolationAssertionsFinal', [['RunId', plan.runId], ['Slice', x.slice], ['Scenario', x.scenario]], { id: `fa_${i}`, visible: false })),
        ...finals.map((x, i): Metric => metric(NS, 'IsolationMismatchesFinal', [['RunId', plan.runId], ['Slice', x.slice], ['Scenario', x.scenario]], { id: `fm_${i}`, visible: false })),
        expr('fa', `SUM([${finals.map((_, i) => `fa_${i}`).join(',')}])`, 'assertions'),
        expr('fm', `SUM([${finals.map((_, i) => `fm_${i}`).join(',')}])`, 'mismatches'),
      ],
    },
  });
  if (live.length > 0) {
    out.push({
      id: 'A3-refusals',
      type: 'metric',
      title: 'Refusals',
      width: 8,
      height: 6,
      section: 'A',
      properties: {
        ...common('A3 Refusals: seen and named by the driver, and the running gap', r, 'Sum'),
        metrics: [
          ...summed(plan, live, 'RefusalsSeen', (s) => [['Scenario', s]], 'seen', 'seen'),
          ...summed(plan, live, 'RefusalsNamed', (s) => [['Scenario', s]], 'named', 'named'),
          expr('gap', 'RUNNING_SUM(FILL(seen, 0)) - RUNNING_SUM(FILL(named, 0))', 'unattributed so far', { yAxis: 'right', color: '#FF2800' }),
        ],
      },
    });
    out.push({
      id: 'A3-unattributed',
      type: 'metric',
      title: 'Unattributed',
      width: 4,
      height: 6,
      section: 'A',
      properties: {
        view: 'singleValue',
        title: 'A3 Unattributed refusals (record, after collect)',
        region: r,
        period: 60,
        stat: 'Sum',
        setPeriodToTimeRange: true,
        sparkline: false,
        metrics: live.map((s, i): Metric => metric(NS, 'RefusalsUnattributed', [['RunId', plan.runId], ['Slice', RELAY_SLICE], ['Scenario', s]], { label: s, id: `un_${i}` })),
      },
    });
    out.push({
      id: 'A4-requests',
      type: 'metric',
      title: 'Requests by status class',
      width: 8,
      height: 6,
      section: 'A',
      properties: {
        ...common('A4 Requests by status class, all k6 scenarios', r, 'Sum'),
        metrics: STATUS_CLASSES.flatMap((c) => summed(plan, live, 'Requests', (s) => [['Scenario', s], ['StatusClass', c]], `req${c}`, c)),
      },
    });
    out.push({
      id: 'A5-reasons',
      type: 'metric',
      title: 'Refusals by reason',
      width: 8,
      height: 6,
      section: 'A',
      properties: {
        ...common('A5 Refusals by reason, all k6 scenarios', r, 'Sum'),
        metrics: REASONS.flatMap((reason) => summed(plan, live, 'RefusalsByReason', (s) => [['Scenario', s], ['Reason', reason]], `why${sanitize(reason)}`, reason)),
      },
    });
    out.push({
      id: 'A6-latency',
      type: 'metric',
      title: 'Client latency',
      width: 8,
      height: 6,
      section: 'A',
      properties: {
        ...common('A6 Client latency by scenario, ms (bucketed: right to about 12 %)', r, 'p95'),
        metrics: live.flatMap((s) => ['p50', 'p95', 'p99'].map((stat): Metric => metric(NS, 'ClientLatencyMs', [['RunId', plan.runId], ['Scenario', s]], { stat, label: `${s} ${stat}` }))),
      },
    });
  }
  if (has(plan, 'PS-1')) {
    out.push({
      id: 'A7-onboarding',
      type: 'metric',
      title: 'Onboarding',
      width: 12,
      height: 6,
      section: 'A',
      properties: {
        ...common('A7 Onboarding: ready time and builds in flight', r, 'p95'),
        metrics: [
          metric(NS, 'OnboardReadySeconds', [['RunId', plan.runId]], { stat: 'p50', label: 'ready p50 (s)' }),
          metric(NS, 'OnboardReadySeconds', [['RunId', plan.runId]], { stat: 'p95', label: 'ready p95 (s)' }),
          metric(NS, 'BuildsInFlight', [['RunId', plan.runId]], { stat: 'Maximum', label: 'builds in flight', yAxis: 'right' }),
        ],
      },
    });
  }
  if (has(plan, 'PS-5')) {
    out.push({
      id: 'A8-churn',
      type: 'metric',
      title: 'Churn',
      width: 12,
      height: 6,
      section: 'A',
      properties: {
        ...common('A8 Churn: seconds to routable, suspended and removed', r, 'p99'),
        metrics: ['RoutableSeconds', 'SuspendedSeconds', 'RemovedSeconds'].flatMap((n) =>
          ['p50', 'p99'].map((stat): Metric => metric(NS, n, [['RunId', plan.runId]], { stat, label: `${n.replace('Seconds', '')} ${stat}` })),
        ),
      },
    });
  }
  const slices = [...new Set([...plan.runs.map((x) => x.slice), 'dashboard'])];
  out.push({
    id: 'A9-lifecycle',
    type: 'metric',
    title: 'Deploy and destroy',
    width: 12,
    height: 6,
    section: 'A',
    properties: {
      view: 'bar',
      title: 'A9 Deploy and destroy seconds by slice',
      region: r,
      period: 60,
      stat: 'Maximum',
      setPeriodToTimeRange: true,
      metrics: slices.flatMap((s) =>
        (['deploy', 'destroy'] as const).map((phase): Metric => metric(NS, 'LifecycleSeconds', [['RunId', plan.runId], ['Slice', s], ['Phase', phase]], { label: `${s} ${phase}` })),
      ),
    },
  });
  return out;
}

function sectionB(plan: DashboardPlan): Widget[] {
  const edge = EDGE_REGION;
  const fn = (name: string, stat: string): string => `SEARCH('{AWS/CloudFront,FunctionName,Region} MetricName="${name}"', '${stat}', 60)`;
  return [
    {
      id: 'B1-compute',
      type: 'metric',
      title: 'Router compute',
      width: 8,
      height: 6,
      section: 'B',
      properties: {
        ...common('B1 Router compute utilisation, % (a CloudFront function is throttled at 100)', edge, 'Maximum'),
        metrics: [expr('cu', fn('FunctionComputeUtilization', 'Maximum'), '')],
        annotations: { horizontal: [{ value: 100, label: '100 %', color: '#FF2800' }] },
        yAxis: { left: { min: 0, max: 110 } },
      },
    },
    {
      id: 'B2-errors',
      type: 'metric',
      title: 'Router errors',
      width: 8,
      height: 6,
      section: 'B',
      properties: {
        ...common('B2 Router errors and throttles, with invocations for scale', edge, 'Sum'),
        metrics: [
          expr('ee', `SUM(${fn('FunctionExecutionErrors', 'Sum')})`, 'execution errors', { color: '#FF2800' }),
          expr('th', `SUM(${fn('FunctionThrottles', 'Sum')})`, 'throttles', { color: '#FF2800' }),
          expr('inv', `SUM(${fn('FunctionInvocations', 'Sum')})`, 'invocations', { yAxis: 'right' }),
        ],
      },
    },
    {
      id: 'B3-distribution',
      type: 'metric',
      title: 'Distribution',
      width: 8,
      height: 6,
      section: 'B',
      properties: {
        ...common('B3 Distribution requests and error rates', edge, 'Sum'),
        metrics: [
          expr('rq', 'SUM(SEARCH(\'{AWS/CloudFront,DistributionId,Region} MetricName="Requests"\', \'Sum\', 60))', 'requests'),
          expr('e4', 'AVG(SEARCH(\'{AWS/CloudFront,DistributionId,Region} MetricName="4xxErrorRate"\', \'Average\', 60))', '4xx %', { yAxis: 'right' }),
          expr('e5', 'AVG(SEARCH(\'{AWS/CloudFront,DistributionId,Region} MetricName="5xxErrorRate"\', \'Average\', 60))', '5xx %', { yAxis: 'right', color: '#FF2800' }),
        ],
      },
    },
    {
      id: 'B4-routes',
      type: 'metric',
      title: 'Route table',
      width: 8,
      height: 6,
      section: 'B',
      properties: {
        ...common('B4 Route table bytes (the store holds 5 MB; the alarm is at 80 %)', plan.region, 'Maximum', 300),
        metrics: [metric('TenantFrontDoor', 'RouteTableBytes', [], { label: 'route table bytes' })],
        annotations: { horizontal: [{ value: 4 * 1024 * 1024, label: '80 % of 5 MB', color: '#FF2800' }] },
      },
    },
  ];
}

function sectionC(plan: DashboardPlan): Widget[] {
  const r = plan.region;
  const identity = plan.identityRegion ?? r;
  const api = (name: string, stat: string): string => `SUM(SEARCH('{AWS/ApiGateway,ApiName} MetricName="${name}"', '${stat}', 60))`;
  return [
    {
      id: 'C1-builds',
      type: 'metric',
      title: 'Builds',
      width: 6,
      height: 6,
      section: 'C',
      properties: {
        ...common('C1 CodeBuild, account-wide', r, 'Sum'),
        metrics: [
          metric('AWS/CodeBuild', 'Builds', [], { label: 'started' }),
          metric('AWS/CodeBuild', 'FailedBuilds', [], { label: 'failed', color: '#FF2800' }),
          metric('AWS/CodeBuild', 'QueuedDuration', [], { label: 'queued s (avg)', stat: 'Average', yAxis: 'right' }),
          metric('AWS/CodeBuild', 'Duration', [], { label: 'duration s (avg)', stat: 'Average', yAxis: 'right' }),
        ],
      },
    },
    {
      id: 'C2-workflow',
      type: 'metric',
      title: 'Workflow',
      width: 6,
      height: 6,
      section: 'C',
      properties: {
        ...common('C2 Step Functions executions, account-wide', r, 'Sum'),
        metrics: [
          metric('AWS/States', 'ExecutionsStarted', [], { label: 'started' }),
          metric('AWS/States', 'ExecutionsFailed', [], { label: 'failed', color: '#FF2800' }),
          metric('AWS/States', 'ExecutionThrottled', [], { label: 'throttled', color: '#FF2800' }),
        ],
      },
    },
    {
      id: 'C3-identity',
      type: 'metric',
      title: 'Identity API',
      width: 6,
      height: 6,
      section: 'C',
      properties: {
        ...common('C3 API Gateway calls and errors (the identity API, found by search)', identity, 'Sum'),
        metrics: [expr('ac', api('Count', 'Sum'), 'calls'), expr('a4', api('4XXError', 'Sum'), '4xx'), expr('a5', api('5XXError', 'Sum'), '5xx', { color: '#FF2800' })],
      },
    },
    {
      id: 'C4-lambda',
      type: 'metric',
      title: 'Lambda',
      width: 6,
      height: 6,
      section: 'C',
      properties: {
        ...common('C4 Lambda in the platform account', r, 'Maximum'),
        metrics: [
          metric('AWS/Lambda', 'ConcurrentExecutions', [], { label: 'concurrent (max)' }),
          metric('AWS/Lambda', 'Throttles', [], { label: 'throttles', stat: 'Sum', color: '#FF2800' }),
          metric('AWS/Lambda', 'Errors', [], { label: 'errors', stat: 'Sum', yAxis: 'right' }),
        ],
      },
    },
  ];
}

/** A cell metric of one cell account, read through the observability link. */
const cell = (
  account: string,
  ns: string,
  name: string,
  dims: readonly (readonly [string, string])[],
  options: Record<string, unknown> = {},
): Metric =>
  metric(ns, name, dims, { accountId: account, ...options });

function sectionD(plan: DashboardPlan): Widget[] {
  const r = plan.region;
  const out: Widget[] = [];
  const live = liveScenarios(plan);
  plan.cellAccounts.forEach((account, n) => {
    const label = `cell-account-${n + 1}`;
    const id = (s: string): string => `D${s}-${label}`;
    out.push({
      id: id('1'),
      type: 'metric',
      title: `${label} ingress requests`,
      width: 8,
      height: 6,
      section: 'D',
      properties: {
        ...common(`D1 ${label}: ingress requests by status`, r, 'Sum'),
        metrics: [
          cell(account, CELL, 'IngressRequests', [], { label: 'all' }),
          ...INGRESS_STATUSES.map((s) => cell(account, CELL, 'IngressRequests', [['Status', s]], { label: s })),
        ],
      },
    });
    out.push({
      id: id('2'),
      type: 'metric',
      title: `${label} ingress latency`,
      width: 8,
      height: 6,
      section: 'D',
      properties: {
        ...common(`D2 ${label}: ingress time, ms`, r, 'p95'),
        metrics: [
          ...['p50', 'p95', 'p99'].map((stat) => cell(account, CELL, 'IngressServedMs', [], { stat, label: `served ${stat}` })),
          ...['p50', 'p95'].map((stat) => cell(account, CELL, 'IngressTtfbMs', [], { stat, label: `ttfb ${stat}` })),
        ],
      },
    });
    out.push({
      id: id('3'),
      type: 'metric',
      title: `${label} refusals`,
      width: 8,
      height: 6,
      section: 'D',
      properties: {
        ...common(`D3 ${label}: refusals by the ingress and the authoriser`, r, 'Sum'),
        metrics: [
          cell(account, CELL, 'IngressRefused', [], { label: 'ingress' }),
          cell(account, CELL, 'AuthorizerRefused', [], { label: 'authoriser' }),
          cell(account, CELL, 'AuthorizerTokenRefused', [], { label: 'token refused' }),
        ],
      },
    });
    out.push({
      id: id('4'),
      type: 'metric',
      title: `${label} Lambda`,
      width: 8,
      height: 6,
      section: 'D',
      properties: {
        ...common(`D4 ${label}: Lambda concurrency, throttles and errors`, r, 'Maximum'),
        metrics: [
          cell(account, 'AWS/Lambda', 'ConcurrentExecutions', [], { label: 'concurrent (max)' }),
          cell(account, 'AWS/Lambda', 'Throttles', [], { label: 'throttles', stat: 'Sum', color: '#FF2800' }),
          cell(account, 'AWS/Lambda', 'Errors', [], { label: 'errors', stat: 'Sum', yAxis: 'right' }),
        ],
      },
    });
    out.push({
      id: id('5'),
      type: 'metric',
      title: `${label} SDK retries and mints`,
      width: 8,
      height: 6,
      section: 'D',
      properties: {
        ...common(`D5 ${label}: SDK calls retried by service, and mint lookups`, r, 'Sum'),
        metrics: [
          ...SDK_SERVICES.map((s) => cell(account, CELL, 'SdkRetryLines', [['Service', s]], { label: `retried ${s}` })),
          ...MINT_VALUES.map((m) => cell(account, CELL, 'MintLookups', [['Mint', m]], { label: `mint ${m}`, yAxis: 'right' })),
        ],
      },
    });
    out.push({
      id: id('7'),
      type: 'metric',
      title: `${label} AgentCore`,
      width: 8,
      height: 6,
      section: 'D',
      properties: {
        ...common(`D7 ${label}: AgentCore Runtime`, r, 'Sum'),
        metrics: [
          cell(account, 'AWS/Bedrock-AgentCore', 'Invocations', [['AggregateOperation', 'InvokeAgentRuntime']], { label: 'invocations' }),
          cell(account, 'AWS/Bedrock-AgentCore', 'Sessions', [['AggregateOperation', 'InvokeAgentRuntime']], { label: 'new sessions' }),
          cell(account, 'AWS/Bedrock-AgentCore', 'ActiveSessionCount', [['Service', 'AgentCore.Runtime']], { label: 'active sessions (max)', stat: 'Maximum', yAxis: 'right' }),
          expr(`thr${n}`, 'SUM(SEARCH(\'{AWS/Bedrock-AgentCore,Operation,Protocol} MetricName="Throttles"\', \'Sum\', 60))', 'throttles', { accountId: account, color: '#FF2800' }),
        ],
      },
    });
  });
  if (live.length > 0 && plan.cellAccounts.length > 0) {
    out.push({
      id: 'D6-reconcile',
      type: 'metric',
      title: 'Driver against cells',
      width: 12,
      height: 6,
      section: 'D',
      properties: {
        ...common('D6 The driver\'s 2xx against the cells\' 200 (compare totals over a scenario, not one minute)', r, 'Sum'),
        metrics: [
          ...summed(plan, live, 'Requests', (s) => [['Scenario', s], ['StatusClass', '2xx']], 'drv', 'driver 2xx'),
          ...plan.cellAccounts.map((a, n) => cell(a, CELL, 'IngressRequests', [['Status', '200']], { id: `c200_${n}`, visible: false })),
          expr('cells', `SUM([${plan.cellAccounts.map((_, n) => `c200_${n}`).join(',')}])`, 'cells 200'),
          expr('diff', 'FILL(drv, 0) - FILL(cells, 0)', 'driver minus cells', { yAxis: 'right', color: '#F3C300' }),
        ],
      },
    });
  }
  return out;
}

/** The signal each budgeted quota has on the dashboard (design §6); a quota not here has none. */
function quotaSignal(plan: DashboardPlan, account: string, quota: string, extra: Record<string, unknown> = {}): Metric | undefined {
  const accountId = account === 'platform' ? undefined : plan.cellAccounts[Number(account.slice('cell-account-'.length)) - 1];
  const scoped = (options: Record<string, unknown>): Record<string, unknown> => ({
    ...(accountId === undefined ? {} : { accountId }),
    ...options,
    ...extra,
  });
  const named = (label: string): string => `${account} ${label}`;
  switch (quota) {
    case 'lambda-concurrency':
      return metric('AWS/Lambda', 'ConcurrentExecutions', [], scoped({ stat: 'Maximum', label: named('observed peak') }));
    case 'codebuild-linux-small':
      return metric(NS, 'BuildsInFlight', [['RunId', plan.runId]], { stat: 'Maximum', label: named('builds in flight (driver)'), ...extra });
    case 'sts-assume-role-rps':
    case 'kms-rsa-rps':
    case 'kms-ecc-rps':
      return accountId === undefined
        ? undefined
        : metric(CELL, 'SdkRetryLines', [['Service', quota.startsWith('sts') ? 'sts' : 'kms']], scoped({ stat: 'Sum', label: named('calls retried (a signal, not a rate)') }));
    case 'agentcore-active-sessions':
      return accountId === undefined ? undefined : metric('AWS/Bedrock-AgentCore', 'ActiveSessionCount', [['Service', 'AgentCore.Runtime']], scoped({ stat: 'Maximum', label: named('observed peak') }));
    case 'agentcore-new-sessions-rps':
      return accountId === undefined ? undefined : metric('AWS/Bedrock-AgentCore', 'Sessions', [['AggregateOperation', 'InvokeAgentRuntime']], scoped({ stat: 'Sum', label: named('new sessions a minute') }));
    case 'agentcore-runtime-tps':
      return accountId === undefined ? undefined : metric('AWS/Bedrock-AgentCore', 'Invocations', [['AggregateOperation', 'InvokeAgentRuntime']], scoped({ stat: 'Sum', label: named('invocations a minute') }));
    default:
      return undefined;
  }
}

function sectionE(plan: DashboardPlan): Widget[] {
  const r = plan.region;
  const out: Widget[] = [];
  const pairs = plan.quotas.map((q) => q.split(':') as [string, string]);
  const quotas = [...new Set(pairs.map(([, q]) => q))];
  for (const quota of quotas) {
    const accounts = pairs.filter(([, q]) => q === quota).map(([a]) => a);
    const metrics: Metric[] = [];
    for (const account of accounts) {
      metrics.push(metric(NS, 'QuotaPlannedDraw', [['RunId', plan.runId], ['Account', account], ['Quota', quota]], { stat: 'Maximum', label: `${account} planned draw` }));
      metrics.push(metric(NS, 'QuotaLimit', [['RunId', plan.runId], ['Account', account], ['Quota', quota]], { stat: 'Maximum', label: `${account} limit`, color: '#FF2800' }));
      const signal = quotaSignal(plan, account, quota);
      if (signal !== undefined) metrics.push(signal);
    }
    out.push({
      id: `E1-${quota}`,
      type: 'metric',
      title: quota,
      width: 8,
      height: 6,
      section: 'E',
      properties: { ...common(`E1 ${quota}: planned draw, limit and the signal there is`, r, 'Maximum'), metrics },
    });
  }
  const peaks: Metric[] = [];
  pairs.filter(([, q]) => q === 'lambda-concurrency' || q === 'agentcore-active-sessions').forEach(([account, quota], i) => {
    const signal = quotaSignal(plan, account, quota, { id: `pk${i}`, visible: false });
    if (signal === undefined) return;
    peaks.push(signal);
    peaks.push(metric(NS, 'QuotaLimit', [['RunId', plan.runId], ['Account', account], ['Quota', quota]], { stat: 'Maximum', id: `lm${i}`, visible: false }));
    peaks.push(expr(`pc${i}`, `pk${i} / lm${i} * 100`, `${account} ${quota} peak, % of limit`));
  });
  if (peaks.length > 0) {
    out.push({
      id: 'E2-first',
      type: 'metric',
      title: 'Quota peaks',
      width: 12,
      height: 6,
      section: 'E',
      properties: {
        view: 'bar',
        title: 'E2 Peak as a percent of the limit, for the quotas that have a count signal',
        region: r,
        period: 60,
        stat: 'Maximum',
        setPeriodToTimeRange: true,
        metrics: peaks,
        yAxis: { left: { min: 0, max: 100 } },
      },
    });
  }
  out.push(
    note(
      'E2-note',
      'E',
      'Quotas with no rate signal',
      'STS, KMS and the AgentCore rate quotas show only that calls were retried or throttled, not a rate or a percent of the limit. Cognito groups are a hard cap of 10,000 shown by the planned draw. A quota with no panel above has no signal.',
      12,
      6,
    ),
  );
  return out;
}

/** Every widget of the run dashboard, section by section. */
export function widgetsFor(plan: DashboardPlan): Widget[] {
  return [...sectionA(plan), ...sectionB(plan), ...sectionC(plan), ...sectionD(plan), ...sectionE(plan)];
}

/** A heading for each section, laid above its widgets. */
export const SECTION_TITLES: Record<Widget['section'], string> = {
  A: '## A. The run (StressRun)',
  B: '## B. The edge (us-east-1)',
  C: '## C. The platform account',
  D: '## D. The cell accounts (through the observability link)',
  E: '## E. Quota headroom',
};

/**
 * The dashboard body: a heading for each section, then its widgets left to right in rows of 24
 * columns. `periodOverride` is left alone so a widget keeps its own period.
 */
export function dashboardBody(plan: DashboardPlan): { start?: string; end?: string; widgets: Record<string, unknown>[] } {
  const widgets: Record<string, unknown>[] = [];
  let y = 0;
  const all = widgetsFor(plan);
  for (const section of ['A', 'B', 'C', 'D', 'E'] as const) {
    const mine = all.filter((w) => w.section === section);
    if (mine.length === 0) continue;
    widgets.push({ type: 'text', x: 0, y, width: 24, height: 1, properties: { markdown: SECTION_TITLES[section] } });
    y += 1;
    let x = 0;
    let rowHeight = 0;
    for (const w of mine) {
      if (x + w.width > 24) {
        x = 0;
        y += rowHeight;
        rowHeight = 0;
      }
      widgets.push({ type: w.type, x, y, width: w.width, height: w.height, properties: w.properties });
      x += w.width;
      rowHeight = Math.max(rowHeight, w.height);
    }
    y += rowHeight;
  }
  return { ...(plan.start === undefined || plan.end === undefined ? {} : { start: plan.start, end: plan.end }), widgets };
}

/** The `Region` property of a metric widget: the widget's own, for the snapshot's image call. */
export function widgetRegion(w: Widget, plan: DashboardPlan): string {
  return typeof w.properties.region === 'string' ? w.properties.region : plan.region;
}
