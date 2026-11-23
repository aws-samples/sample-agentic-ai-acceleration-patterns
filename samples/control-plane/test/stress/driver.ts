// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The control-plane stress slice's driver, called by `scripts/stress/slice.sh` (platform
 * stress test, docs/stress-test.spec.md §3.4). One command per step that needs the API or
 * the accounts:
 *
 *   budget                   the slice's quota draws, no credentials
 *   check-accounts           the cell account check (spec §3.7), before every run
 *   register                 PutApplication (the stress application) and PutAccount (each cell account)
 *   seed                     the tier's tenant records, from the manifest when it exists
 *   run <scenario>           PS-1, placement-race, read-rate or build-limit-scaling; PS-5, churn through the edge (platform mode only)
 *   collect                  server-side 5xx in each record's window (P-7)
 *   sweep [--seeded]         remove the run's deployments, cells and tenants
 *   unregister               DeleteAccount and DeleteApplication
 *   cell-leftovers           what of the stress application is left in the cell accounts
 *
 * Output is counts, ids and HTTP statuses: never a token, a password or a key
 * (scripts/CONVENTIONS.md). The operator token lives in memory for one command.
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { type AccountState, accountProblems, type RoleState, type StackState } from './account-check';
import { ControlPlaneApi, operatorToken } from './api';
import { aws, AwsError, sleep } from './aws';
import { type Edge, liveEdge, readEdgeInputs } from './edge';
import { cellsOf, deploymentsOf, type FleetEnv, removeAll } from './fleet';
import { allTenants, emptyManifest, type Manifest, manifestPath, readManifest, writeManifest } from './manifest';
import {
  APPLICATION_ID,
  applicationDefinition,
  type CellAccountInput,
  drawsOf,
  maxCellsPerAccount,
  parseBuildLimit,
  parseCellAccounts,
  parseMode,
  parseTier,
  stackNamesOf,
  tenantSetsOf,
  type TierSizes,
} from './plan';
import { type Identity, Recorder, type ResultRecordJson } from './recorder';
import { SCENARIOS, type ScenarioEnv } from './scenarios';
import { awaitTenantsActive, deleteTenants, existingTenants, pollRecord } from './seed';

const SLICE = 'control-plane';
const log = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

function need(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') throw new Error(`${name} is not set`);
  return v;
}

/** The error's own message for errors this driver throws, its name and command for the AWS CLI's. */
function errorText(e: unknown): string {
  if (e instanceof AwsError) return e.message;
  if (e instanceof Error && Object.getPrototypeOf(e) === Error.prototype) return e.message;
  return (e as Error)?.name ?? 'Error';
}

const region = (): string => need('AWS_REGION');
const tier = (): TierSizes => parseTier(process.env.STRESS_TIER_JSON);
const names = () => stackNamesOf(process.env.STRESS_PREFIX);
const buildLimit = (): number => parseBuildLimit(process.env.STRESS_BUILD_LIMIT);

async function outputsOf(stack: string): Promise<Record<string, string>> {
  const out = await aws(['cloudformation', 'describe-stacks', '--stack-name', stack], { region: region() });
  return Object.fromEntries(((out.Stacks?.[0]?.Outputs ?? []) as any[]).map((o) => [String(o.OutputKey), String(o.OutputValue)]));
}

async function platformAccount(): Promise<string> {
  return String((await aws(['sts', 'get-caller-identity'])).Account);
}

function cellAccounts(t: TierSizes, platform: string): CellAccountInput[] {
  const file = need('STRESS_CELL_ACCOUNTS');
  return parseCellAccounts(fs.readFileSync(file, 'utf8'), path.basename(file), t, platform);
}

interface Connected {
  readonly api: (rec: Recorder) => ControlPlaneApi;
  readonly platform: string;
  readonly accounts: CellAccountInput[];
  readonly outputs: { readonly setup: Record<string, string>; readonly controlPlane: Record<string, string> };
}

async function connect(): Promise<Connected> {
  const n = names();
  const [setup, controlPlane, platform] = await Promise.all([outputsOf(n.setup), outputsOf(n.controlPlane), platformAccount()]);
  for (const [k, o] of [['UserPoolId', setup], ['OperatorClientId', setup], ['SourceLocation', setup], ['ApiUrl', controlPlane]] as const) {
    if (o[k] === undefined) throw new Error(`stack output ${k} is missing: run deploy first`);
  }
  const token = await operatorToken(setup.UserPoolId, setup.OperatorClientId);
  return {
    api: (rec) => new ControlPlaneApi(controlPlane.ApiUrl, token, rec.observe.bind(rec)),
    platform,
    accounts: cellAccounts(tier(), platform),
    outputs: { setup, controlPlane },
  };
}

function fleetEnv(c: Connected, rec: Recorder): FleetEnv {
  return { api: c.api(rec), rec, applicationId: APPLICATION_ID, platformAccount: c.platform, cellAccounts: c.accounts, region: region(), log };
}

function manifestFile(): string {
  return manifestPath(need('STRESS_HOME'), need('STRESS_PREFIX'));
}

function loadManifest(): Manifest {
  const m = readManifest(manifestFile());
  if (m === undefined) throw new Error('no manifest: run seed first');
  return m;
}

// --- check-accounts -------------------------------------------------------------------------

async function gather(a: CellAccountInput, regions: readonly string[], fleet: string): Promise<AccountState> {
  const caller = await aws(['sts', 'get-caller-identity'], { profile: a.profile });
  if (String(caller.Account) !== a.accountId) throw new Error(`profile of ${a.label} is not account ${a.accountId}`);
  const partition = String(caller.Arn).split(':')[1];
  const stacks: StackState[] = [];
  for (const r of regions) {
    const out = await aws(['cloudformation', 'describe-stacks'], { profile: a.profile, region: r });
    for (const s of (out.Stacks ?? []) as any[]) {
      stacks.push({
        name: String(s.StackName),
        arn: String(s.StackId),
        region: r,
        roleArn: s.RoleARN === undefined ? undefined : String(s.RoleARN),
        tags: Object.fromEntries(((s.Tags ?? []) as any[]).map((t) => [String(t.Key), String(t.Value)])),
        rootArn: s.RootId === undefined ? undefined : String(s.RootId),
      });
    }
  }
  const listed = await aws(['iam', 'list-roles'], { profile: a.profile });
  const roles: RoleState[] = ((listed.Roles ?? []) as any[]).map((r) => ({
    name: String(r.RoleName),
    path: String(r.Path),
    arn: String(r.Arn),
    trust: r.AssumeRolePolicyDocument,
  }));
  const getRole = async (name: string): Promise<RoleState | undefined> => {
    try {
      const r = (await aws(['iam', 'get-role', '--role-name', name], { profile: a.profile })).Role;
      const attached = (await aws(['iam', 'list-attached-role-policies', '--role-name', name], { profile: a.profile })).AttachedPolicies ?? [];
      const inlineNames = ((await aws(['iam', 'list-role-policies', '--role-name', name], { profile: a.profile })).PolicyNames ?? []) as string[];
      const inline = [];
      for (const policy of inlineNames) {
        const doc = await aws(['iam', 'get-role-policy', '--role-name', name, '--policy-name', policy], { profile: a.profile });
        inline.push({ name: policy, document: doc.PolicyDocument });
      }
      return {
        name,
        path: String(r.Path),
        arn: String(r.Arn),
        trust: r.AssumeRolePolicyDocument,
        boundaryArn: r.PermissionsBoundary?.PermissionsBoundaryArn,
        attached: (attached as any[]).map((p) => String(p.PolicyArn)),
        inline,
      };
    } catch (e) {
      if (e instanceof AwsError && e.errorName === 'NoSuchEntity') return undefined;
      throw e;
    }
  };
  const [cell, tenant] = await Promise.all([getRole(`${fleet}-cell-provisioning`), getRole(`${fleet}-tenant-provisioning`)]);
  return { accountId: a.accountId, partition, stacks, roles, pair: { cell, tenant } };
}

async function checkAccounts(): Promise<number> {
  const t = tier();
  const platform = await platformAccount();
  const accounts = cellAccounts(t, platform);
  const regions = (process.env.STRESS_REGIONS ?? region()).split(',').filter((r) => r !== '');
  let failed = 0;
  for (const a of accounts) {
    const state = await gather(a, regions, names().fleet);
    const problems = accountProblems(state, {
      fleet: names().fleet,
      accountBaseStackArns: a.accountBaseStackArns,
      policySuffix: process.env.STRESS_CELL_POLICY_SUFFIX ?? '',
      platformAccountId: platform,
    });
    log(`account check ${a.label}: ${state.stacks.length} stacks, ${state.roles.length} roles in ${regions.join(', ')}: ${problems.length === 0 ? 'passed' : `${problems.length} problems`}`);
    for (const p of problems) log(`  ${a.label}: ${p}`);
    if (problems.length > 0) failed += 1;
  }
  return failed === 0 ? 0 : 1;
}

// --- register / unregister ------------------------------------------------------------------

async function register(): Promise<number> {
  const c = await connect();
  const t = tier();
  const rec = new Recorder();
  const api = c.api(rec);
  const definition = applicationDefinition(t, c.outputs.setup.SourceLocation, process.env.STRESS_CELL_POLICY_SUFFIX ?? '');
  const app = `/applications/${APPLICATION_ID}`;
  const put = await api.call('put-application', 'PUT', app, '-', definition);
  if (put.status !== 202) {
    log(`PutApplication: HTTP ${put.status} ${put.errorType ?? ''}`);
    return 1;
  }
  if (!(await pollRecord(api, 'get-application', app, '-', (s, b) => s === 200 && /^(ACTIVE|[A-Z]+_FAILED)$/.test(String(b?.application?.status))))) return 1;
  const appStatus = (await api.call('get-application', 'GET', app, '-')).body?.application?.status;
  log(`application ${APPLICATION_ID}: ${appStatus}`);
  if (appStatus !== 'ACTIVE') return 1;
  for (const a of c.accounts) {
    const p = `/accounts/${a.accountId}`;
    const r = await api.call('put-account', 'PUT', p, '-', { owner: 'VENDOR', maxCells: maxCellsPerAccount(t), applicationIds: [APPLICATION_ID] });
    if (r.status !== 202) {
      log(`PutAccount ${a.label}: HTTP ${r.status} ${r.errorType ?? ''}`);
      return 1;
    }
    await pollRecord(api, 'get-account', p, '-', (s, b) => s === 200 && /^(ACTIVE|[A-Z]+_FAILED)$/.test(String(b?.account?.status)));
    const status = (await api.call('get-account', 'GET', p, '-')).body?.account?.status;
    log(`account ${a.label}: ${status}, maxCells ${maxCellsPerAccount(t)}`);
    if (status !== 'ACTIVE') return 1;
  }
  return 0;
}

async function unregister(): Promise<number> {
  const c = await connect();
  const api = c.api(new Recorder());
  let status = 0;
  const gone = async (p: string, hop: string): Promise<void> => {
    const r = await api.call(`delete-${hop}`, 'DELETE', p, '-', undefined, [404]);
    if (r.status !== 202 && r.status !== 404) {
      log(`Delete ${p}: HTTP ${r.status} ${r.errorType ?? ''}`);
      status = 1;
      return;
    }
    if (!(await pollRecord(api, `get-${hop}`, p, '-', (s) => s === 404))) {
      log(`${p} is still there`);
      status = 1;
    }
  };
  // Every account the application was registered in, also one no longer in the file.
  const listed = await api.listAll('list-accounts', '/accounts', 'accounts');
  const registered = listed.items.filter((a) => (a.applicationIds ?? []).includes(APPLICATION_ID)).map((a) => String(a.accountId));
  const accounts = new Set([...c.accounts.map((a) => a.accountId), ...registered]);
  for (const id of accounts) await gone(`/accounts/${id}`, 'account');
  await gone(`/applications/${APPLICATION_ID}`, 'application');
  log(status === 0 ? 'unregister: no account or application left' : 'unregister: something is left');
  return status;
}

// --- seed --------------------------------------------------------------------------------------

async function seed(): Promise<number> {
  const c = await connect();
  const t = tier();
  const sets = tenantSetsOf(t);
  const file = manifestFile();
  const api = c.api(new Recorder());
  const prefix = need('STRESS_PREFIX');
  let m = readManifest(file) ?? emptyManifest(prefix, t.name, need('STRESS_COMMIT'));
  // Keep every tenant whose record still exists, failed ones too, so sweep deletes them.
  m = { ...m, seeded: await existingTenants(api, m.seeded), churn: await existingTenants(api, m.churn), extra: await existingTenants(api, m.extra) };
  writeManifest(file, m);
  const create = async (set: 'seeded' | 'churn' | 'extra', wanted: number): Promise<void> => {
    while (m[set].length < wanted) {
      const r = await api.call('create-tenant', 'POST', '/tenants', '-', { name: `${prefix}-${set}-${m[set].length + 1}`, description: 'platform stress test' });
      const id = r.body?.tenant?.tenantId;
      if (r.status !== 202 || typeof id !== 'string') throw new Error(`CreateTenant answered HTTP ${r.status}`);
      m = { ...m, [set]: [...m[set], id] };
      writeManifest(file, m);
    }
  };
  await create('seeded', sets.seeded);
  await create('churn', sets.churn);
  await create('extra', sets.extra);
  await awaitTenantsActive(api, allTenants(m));
  log(`seed: ${m.seeded.length} seeded, ${m.churn.length} churn, ${m.extra.length} extra tenants`);
  return 0;
}

// --- run ---------------------------------------------------------------------------------------

function identity(): Identity {
  return { runId: need('STRESS_RUN_ID'), tier: tier().name, mode: parseMode(process.env.STRESS_MODE), slice: SLICE, commit: need('STRESS_COMMIT') };
}

/** The front door's edge and registrar for PS-5, from the front-door slice's manifest (platform mode only). */
function edgeOf(): Edge {
  if (parseMode(process.env.STRESS_MODE) !== 'platform') throw new Error('PS-5 runs in platform mode only: it needs the front door');
  return liveEdge(readEdgeInputs(need('STRESS_HOME'), need('STRESS_PREFIX')), region());
}

function setBuildLimitCommand(limit: number): Promise<number> {
  const script = need('STRESS_SLICE_SCRIPT');
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = execFile('bash', [script, 'set-build-limit', String(limit)], { env: process.env, maxBuffer: 64 * 1024 * 1024 }, (error) => {
      if (error !== null) reject(new Error(`set-build-limit ${limit} failed`));
      else resolve((Date.now() - started) / 1000);
    });
    child.stdout?.pipe(process.stderr);
    child.stderr?.pipe(process.stderr);
  });
}

async function run(scenario: string): Promise<number> {
  const fn = SCENARIOS[scenario];
  if (fn === undefined) throw new Error(`unknown scenario ${scenario}`);
  // PS-5 reads the edge, which only a platform run has: take its address from the front-door
  // manifest before anything is created, so a missing one stops the scenario with the fix.
  const edge = scenario === 'PS-5' ? edgeOf() : undefined;
  const c = await connect();
  const rec = new Recorder();
  const s: ScenarioEnv = {
    ...fleetEnv(c, rec),
    tier: tier(),
    manifest: loadManifest(),
    buildLimit: buildLimit(),
    setBuildLimit: setBuildLimitCommand,
    ...(edge === undefined ? {} : { edge }),
  };
  try {
    await fn(s);
  } catch (e) {
    rec.finding(`${scenario} stopped: ${errorText(e)}`);
  }
  const record = rec.toRecord(identity(), scenario);
  const out = path.join(need('STRESS_RESULTS'), `${SLICE}.${scenario}.json`);
  fs.writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  const totals = rec.totals;
  log(`${scenario}: ${totals.requests} requests, ${totals.assertions} isolation assertions, ${totals.mismatches} mismatches, ${record.refusals.unattributed} unattributed`);
  for (const f of rec.findings.slice(0, 50)) log(`  finding: ${f}`);
  return rec.findings.length === 0 ? 0 : 1;
}

// --- collect -----------------------------------------------------------------------------------

async function accessLogGroup(): Promise<string> {
  const out = await aws(['cloudformation', 'describe-stack-resources', '--stack-name', names().controlPlane], { region: region() });
  const r = ((out.StackResources ?? []) as any[]).find((x) => x.ResourceType === 'AWS::Logs::LogGroup' && String(x.LogicalResourceId).startsWith('ApiAccessLogs'));
  if (r === undefined) throw new Error('the control plane stack has no API access log group');
  return String(r.PhysicalResourceId);
}

async function serverErrors(group: string, start: string, end: string): Promise<number> {
  const q = await aws([
    'logs', 'start-query', '--log-group-name', group,
    // The record's own window: API Gateway logs a request when it arrives, after the
    // driver's clock started and before it stopped, so no padding reaches the next record.
    '--start-time', String(Math.floor(Date.parse(start) / 1000)), '--end-time', String(Math.ceil(Date.parse(end) / 1000)),
    '--query-string', 'filter status >= 500 | stats count(*) as n',
  ], { region: region() });
  for (let i = 0; i < 60; i += 1) {
    await sleep(2000);
    const r = await aws(['logs', 'get-query-results', '--query-id', String(q.queryId)], { region: region() });
    if (r.status === 'Complete') {
      const n = ((r.results ?? []) as any[][]).flat().find((f) => f.field === 'n')?.value;
      return Number(n ?? 0);
    }
    if (r.status === 'Failed' || r.status === 'Cancelled') throw new Error('the access log query failed');
  }
  throw new Error('the access log query did not complete');
}

/**
 * P-7 from the server's side: the 5xx API Gateway logged in each record's window. A 5xx the
 * driver did not see (a reply lost after the server answered) names no tenant, so the excess
 * over the driver's own count is added to `unattributed`. Waits for late log delivery first.
 */
async function collect(): Promise<number> {
  const dir = need('STRESS_RESULTS');
  const runId = need('STRESS_RUN_ID');
  const files = fs.readdirSync(dir).filter((f) => f.startsWith(`${SLICE}.`) && f.endsWith('.json'));
  if (files.length === 0) return 0;
  await sleep(60_000);
  const group = await accessLogGroup();
  for (const f of files) {
    const file = path.join(dir, f);
    const r = JSON.parse(fs.readFileSync(file, 'utf8')) as ResultRecordJson;
    if (r.runId !== runId || r.scenario === 'lifecycle') continue;
    const seen = Object.entries(r.requests).filter(([k]) => /^5/.test(k)).reduce((a, [, v]) => a + v, 0);
    const logged = await serverErrors(group, r.window.start, r.window.end);
    const extra = Math.max(0, logged - seen);
    log(`collect ${r.scenario}: ${logged} server errors logged, ${seen} seen by the driver`);
    if (extra > 0) {
      const updated = { ...r, refusals: { ...r.refusals, unattributed: r.refusals.unattributed + extra } };
      fs.writeFileSync(file, `${JSON.stringify(updated, null, 2)}\n`, { mode: 0o600 });
    }
  }
  return 0;
}

// --- sweep ---------------------------------------------------------------------------------------

/**
 * Removes the run's deployments, then, with `seeded`, the seeded ones and every empty cell
 * of the application (their delete scripts destroy the cell stacks), then the tenants that
 * no longer have a deployment. Without `seeded` the seeded fleet stays (a fixture tier).
 * A tenant leaves the manifest only once it is gone (`deleteTenants`); one that is kept
 * fails the sweep, so the teardown keeps the stacks a rerun needs to delete it.
 */
async function sweep(seeded: boolean): Promise<number> {
  const c = await connect();
  const rec = new Recorder();
  const f = fleetEnv(c, rec);
  const m = readManifest(manifestFile());
  if (m === undefined) {
    log('sweep: no manifest, nothing to sweep');
  }
  const transient = m === undefined ? [] : [...m.churn, ...m.extra];
  const all = await deploymentsOf(f);
  const owned = new Set([...transient, ...(seeded && m !== undefined ? m.seeded : [])]);
  // With seeded, every deployment of the stress application goes, also one a lost manifest no longer lists.
  const targets = [...all.keys()].filter((t) => seeded || owned.has(t));
  // A DELETE_FAILED deployment takes another delete (removeAll): up to three rounds.
  const stuck = await removeAll(f, targets, buildLimit(), 3600);
  let status = stuck.length === 0 ? 0 : 1;
  if (stuck.length > 0) log(`sweep: ${stuck.length} deployments could not be removed; cells stay`);
  if (seeded && stuck.length === 0) {
    const cells = await cellsOf(f);
    for (const cell of cells) {
      const r = await f.api.call('delete-cell', 'DELETE', `/cells/${cell.cellId}`, '-', undefined, [404]);
      if (r.status !== 202 && r.status !== 404) {
        log(`DeleteCell ${cell.cellId}: HTTP ${r.status} ${r.errorType ?? ''}`);
        status = 1;
      }
    }
    const deadline = Date.now() + 3600 * 1000;
    for (;;) {
      const remaining = await cellsOf(f);
      if (remaining.length === 0) break;
      if (remaining.some((x) => x.status === 'DELETE_FAILED') || Date.now() > deadline) {
        log(`sweep: ${remaining.length} cells left (${remaining.map((x) => x.status).join(', ')})`);
        status = 1;
        break;
      }
      await sleep(30_000);
    }
  }
  if (m !== undefined) {
    const after = await deploymentsOf(f);
    const tenants = (seeded ? allTenants(m) : transient).filter((t) => !after.has(t));
    const { gone, kept } = await deleteTenants(f.api, tenants);
    const keep = (ids: readonly string[]): string[] => ids.filter((t) => !gone.includes(t));
    writeManifest(manifestFile(), { ...m, seeded: keep(m.seeded), churn: keep(m.churn), extra: keep(m.extra) });
    for (const k of kept) log(`sweep: tenant ${k.id} stays in the manifest: ${k.reason}`);
    if (kept.length > 0) status = 1;
    log(`sweep: ${targets.length} deployments and ${gone.length} tenants removed`);
  }
  return status;
}

// --- cell-leftovers ------------------------------------------------------------------------

/** What of the stress application is left in each cell account: cell stacks, cell and tenant parameters, cell roles and log groups. */
async function cellLeftovers(): Promise<number> {
  const t = tier();
  const accounts = cellAccounts(t, await platformAccount());
  let found = 0;
  for (const a of accounts) {
    const opts = { profile: a.profile, region: region() };
    const stacks = ((await aws(['cloudformation', 'describe-stacks'], opts)).Stacks ?? []).map((s: any) => String(s.StackName)).filter((n: string) => n.startsWith('StressCell-'));
    const params: string[] = [];
    for (const p of ['/application-plane/cells', '/application-plane/tenants']) {
      const out = await aws(['ssm', 'get-parameters-by-path', '--path', p, '--recursive', '--query', 'Parameters[].Name'], opts);
      params.push(...((out ?? []) as string[]));
    }
    const roles = ((await aws(['iam', 'list-roles', '--path-prefix', '/cell/'], { profile: a.profile })).Roles ?? [])
      .map((r: any) => String(r.RoleName))
      .filter((n: string) => n.startsWith('StressCell-'));
    const groups = ((await aws(['logs', 'describe-log-groups', '--log-group-name-prefix', '/aws/lambda/StressCell-'], opts)).logGroups ?? []).map((g: any) => String(g.logGroupName));
    const other = ((await aws(['logs', 'describe-log-groups'], opts)).logGroups ?? [])
      .map((g: any) => String(g.logGroupName))
      .filter((n: string) => n.includes('StressCell-') && !groups.includes(n));
    const total = stacks.length + params.length + roles.length;
    log(`${a.label}: ${stacks.length} cell stacks, ${params.length} cell or tenant parameters, ${roles.length} cell roles; ${groups.length + other.length} cell log groups (listed, not counted)`);
    for (const n of [...stacks, ...params, ...roles, ...groups, ...other]) log(`  ${a.label}: ${n}`);
    found += total;
  }
  return found === 0 ? 0 : 1;
}

// --- main ----------------------------------------------------------------------------------------

async function main(argv: readonly string[]): Promise<number> {
  const [command, arg] = argv;
  switch (command) {
    case 'budget':
      process.stdout.write(`${JSON.stringify({ draws: drawsOf(tier(), buildLimit()) })}\n`);
      return 0;
    case 'check-accounts':
      return checkAccounts();
    case 'register':
      return register();
    case 'unregister':
      return unregister();
    case 'seed':
      return seed();
    case 'run':
      if (arg === undefined) throw new Error('run needs a scenario');
      return run(arg);
    case 'collect':
      return collect();
    case 'sweep':
      return sweep(arg === '--seeded');
    case 'cell-leftovers':
      return cellLeftovers();
    case 'status': {
      // Counts only: the stress application's deployments and cells by status.
      const f = fleetEnv(await connect(), new Recorder());
      const count = (xs: { status: string }[]): string =>
        Object.entries(xs.reduce<Record<string, number>>((a, x) => ({ ...a, [x.status]: (a[x.status] ?? 0) + 1 }), {})).map(([k, v]) => `${k} ${v}`).join(', ') || 'none';
      log(`deployments: ${count([...(await deploymentsOf(f)).values()])}; cells: ${count(await cellsOf(f))}`);
      return 0;
    }
    default:
      throw new Error(`unknown command ${String(command)}`);
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    log(`driver: ${errorText(e)}`);
    process.exit(2);
  },
);
