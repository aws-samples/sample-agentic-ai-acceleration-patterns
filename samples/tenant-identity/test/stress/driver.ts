// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The tenant-identity stress slice's driver, called by
 * `scripts/stress/slice.sh` (platform stress test, docs/stress-test.spec.md
 * §3.4). One command per verb that needs the API:
 *
 *   budget                  print the slice's quota draws, no credentials
 *   publish | unpublish     the one SSM parameter the next slice reads
 *   seed                    create or reuse the tier's tenants and users
 *   run <scenario>          PS-1, token-rate or create-tenant-burst
 *   collect                 add what API Gateway counted to this run's records
 *   sweep [--seeded]        delete what the scenarios and the seed created
 *
 * Output is counts, ids of tenants and HTTP statuses. It never prints a token,
 * a password or a key (scripts/CONVENTIONS.md).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { CloudWatchClient, GetMetricStatisticsCommand } from '@aws-sdk/client-cloudwatch';
import { DeleteParameterCommand, PutParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { ulid } from 'ulid';
import {
  emptyManifest,
  type Manifest,
  type ManifestTenant,
  type ManifestUser,
  manifestPath,
  readManifest,
  writeManifest,
} from './manifest';
import { createUser, createTenantWithAdmin, type Ctx, deleteTenant, Pacer, sleep, timed, withRetry } from './ops';
import { drawsOf, parameterNameOf, parseMode, parseTier, planOf, SEED_PACE_PER_SECOND, stackNameOf } from './plan';
import { Recorder } from './recorder';
import { createTenantBurst, emailOf, ps1, type ScenarioEnv, type Store, tokenRate } from './scenarios';
import { AccessTokenVerifier, ExchangeClient, PlatformClient, region, TenantClient } from '../e2e/clients';

function need(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') {
    throw new Error(`${name} is not set`);
  }
  return v;
}

const SCENARIOS: Readonly<Record<string, (env: ScenarioEnv) => Promise<void>>> = {
  'PS-1': ps1,
  'token-rate': tokenRate,
  'create-tenant-burst': createTenantBurst,
};

interface Deployed {
  readonly stack: string;
  readonly apiUrl: string;
  readonly apiId: string;
  readonly userPoolId: string;
  readonly appClientId: string;
}

async function describeStack(stack: string): Promise<Deployed | undefined> {
  const cfn = new CloudFormationClient({ region: region() });
  let outputs: { OutputKey?: string; OutputValue?: string }[] | undefined;
  try {
    outputs = (await cfn.send(new DescribeStacksCommand({ StackName: stack }))).Stacks?.[0]?.Outputs;
  } catch (e) {
    if (/does not exist/.test((e as Error).message)) {
      return undefined;
    }
    throw new Error(`DescribeStacks failed (${(e as Error).name})`);
  }
  const get = (key: string): string => {
    const v = outputs?.find((o) => o.OutputKey === key)?.OutputValue;
    if (v === undefined) {
      throw new Error(`stack ${stack} has no output ${key}`);
    }
    return v;
  };
  const apiUrl = get('ApiUrl');
  const apiId = /^https:\/\/([a-z0-9]+)\.execute-api\./.exec(apiUrl)?.[1];
  if (apiId === undefined) {
    throw new Error(`stack ${stack}: ApiUrl is not an execute-api URL`);
  }
  return { stack, apiUrl: apiUrl.endsWith('/') ? apiUrl : `${apiUrl}/`, apiId, userPoolId: get('UserPoolId'), appClientId: get('AppClientId') };
}

async function connect(stack: string): Promise<{ ctx: Ctx; deployed: Deployed }> {
  const deployed = await describeStack(stack);
  if (deployed === undefined) {
    throw new Error(`stack ${stack} is not deployed: run deploy first`);
  }
  return {
    deployed,
    ctx: {
      platform: new PlatformClient(deployed.apiUrl),
      exchange: new ExchangeClient(deployed.apiUrl),
      tenantApi: new TenantClient(deployed.apiUrl),
      verifier: AccessTokenVerifier.forPool(deployed.userPoolId, deployed.appClientId),
      clientId: deployed.appClientId,
    },
  };
}

/** The manifest, kept in memory and written through on every change. */
class ManifestStore implements Store {
  constructor(private manifest: Manifest, private readonly file: string) {}

  get seeded(): readonly ManifestTenant[] {
    return this.manifest.seeded;
  }

  get transient(): readonly string[] {
    return this.manifest.transient;
  }

  update(change: (m: Manifest) => Manifest): void {
    this.manifest = change(this.manifest);
    writeManifest(this.file, this.manifest);
  }

  addTransient(ids: readonly string[]): void {
    this.update((m) => ({ ...m, transient: [...new Set([...m.transient, ...ids])] }));
  }

  removeTransient(ids: readonly string[]): void {
    const gone = new Set(ids);
    this.update((m) => ({ ...m, transient: m.transient.filter((id) => !gone.has(id)) }));
  }
}

function openStore(prefix: string, stack: string, tierName: string, commit: string): ManifestStore {
  const file = manifestPath(need('STRESS_HOME'), prefix);
  const existing = readManifest(file);
  return new ManifestStore(existing ?? emptyManifest(prefix, stack, tierName, commit), file);
}

// ---------------------------------------------------------------------------
// seed
// ---------------------------------------------------------------------------

const seedName = (index: number): string => `s-${String(index).padStart(4, '0')}`;

async function seed(prefix: string, stack: string): Promise<number> {
  const plan = planOf(parseTier(process.env.STRESS_TIER_JSON), parseMode(process.env.STRESS_MODE));
  const { ctx } = await connect(stack);
  const store = openStore(prefix, stack, plan.tier.name, need('STRESS_COMMIT'));
  const rec = new Recorder();
  const pacer = new Pacer(SEED_PACE_PER_SECOND);
  const tag = 'seed';

  // Keep what a manifest lists and the pool still has; drop the rest.
  const kept: ManifestTenant[] = [];
  // A tier that shrank leaves the surplus in the manifest, for sweep to delete.
  const surplus = store.seeded.slice(plan.seedTenants);
  for (const t of store.seeded.slice(0, plan.seedTenants)) {
    await pacer.wait();
    const r = await withRetry(() => timed(rec, 'get-tenant', t.tenantId, () => ctx.platform.call<{ tenant: { status: string } }>('GET', `platform/tenants/${t.tenantId}`)));
    if (r.status === 200 && r.body.tenant.status === 'ACTIVE') {
      kept.push(t);
    }
  }
  store.update((m) => ({ ...m, tier: plan.tier.name, commit: need('STRESS_COMMIT'), seeded: [...kept, ...surplus] }));
  const have = new Map(kept.map((t) => [t.name, t]));

  for (let index = 0; index < plan.seedTenants; index += 1) {
    const name = seedName(index);
    let tenant = have.get(name);
    if (tenant === undefined) {
      const tenantId = ulid();
      const adminEmail = emailOf(prefix, tag, `${name}-a`);
      await pacer.wait();
      store.addTransient([tenantId]);
      const adminName = await createTenantWithAdmin(ctx, rec, { tenantId, name: `${prefix}-${name}`, adminEmail });
      if (adminName === undefined) {
        continue;
      }
      tenant = { tenantId, name, admin: { username: adminName, email: adminEmail }, users: [] };
    }
    // The first `activeTenants` tenants hold the extra users.
    const users: ManifestUser[] = [...tenant.users];
    if (index < plan.activeTenants) {
      for (let k = users.length + 1; k <= plan.extraUsers; k += 1) {
        await pacer.wait();
        const email = emailOf(prefix, tag, `${name}-u${k}`);
        const username = await createUser(ctx, rec, tenant.tenantId, email);
        if (username === undefined) {
          break;
        }
        users.push({ username, email });
      }
    }
    const done: ManifestTenant = { ...tenant, users };
    store.update((m) => ({
      ...m,
      seeded: [...m.seeded.filter((s) => s.tenantId !== done.tenantId), done].sort((a, b) => a.name.localeCompare(b.name)),
    }));
    store.removeTransient([done.tenantId]);
  }

  const wanted = Array.from({ length: plan.seedTenants }, (_, i) => seedName(i));
  const complete = wanted.every((name, i) => {
    const t = store.seeded.find((s) => s.name === name);
    return t !== undefined && (i >= plan.activeTenants || t.users.length === plan.extraUsers);
  });
  const { requests } = rec.totals;
  process.stdout.write(`seed: ${wanted.filter((n) => store.seeded.some((s) => s.name === n)).length} of ${plan.seedTenants} tenants, ${requests} calls, ${rec.findings.length} findings\n`);
  for (const f of rec.findings.slice(0, 20)) {
    process.stdout.write(`  ${f}\n`);
  }
  return complete && rec.findings.length === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

async function run(prefix: string, stack: string, scenario: string): Promise<number> {
  const scenarioFn = SCENARIOS[scenario];
  if (scenarioFn === undefined) {
    throw new Error(`unknown scenario ${scenario}: ${Object.keys(SCENARIOS).join(', ')}`);
  }
  const plan = planOf(parseTier(process.env.STRESS_TIER_JSON), parseMode(process.env.STRESS_MODE));
  const { ctx } = await connect(stack);
  const store = openStore(prefix, stack, plan.tier.name, need('STRESS_COMMIT'));
  const rec = new Recorder();
  const tag = ulid().slice(-8).toLowerCase();
  try {
    await scenarioFn({ ctx, plan, rec, store, prefix, tag });
  } catch (e) {
    rec.finding(`${scenario} stopped: ${(e as Error).name}: ${(e as Error).message.slice(0, 200)}`);
  }
  const record = rec.toRecord(
    { runId: need('STRESS_RUN_ID'), tier: plan.tier.name, mode: plan.mode, slice: 'tenant-identity', commit: need('STRESS_COMMIT') },
    scenario,
  );
  fs.mkdirSync(need('STRESS_RESULTS'), { recursive: true });
  fs.writeFileSync(path.join(need('STRESS_RESULTS'), `tenant-identity.${scenario}.json`), `${JSON.stringify(record, null, 2)}\n`);
  const t = rec.totals;
  process.stdout.write(`${scenario}: ${t.requests} calls, ${t.assertions} isolation assertions, ${t.mismatches} mismatches, ${rec.findings.length} findings\n`);
  for (const f of rec.findings.slice(0, 25)) {
    process.stdout.write(`  ${f}\n`);
  }
  return rec.findings.length === 0 && t.assertions > 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// collect
// ---------------------------------------------------------------------------

interface RecordFile {
  window: { start: string; end: string };
  requests: Record<string, number>;
  refusals: { unattributed: number };
}

const MINUTE = 60_000;

async function apiSum(cw: CloudWatchClient, apiName: string, metric: string, start: Date, end: Date): Promise<number> {
  const out = await cw.send(
    new GetMetricStatisticsCommand({
      Namespace: 'AWS/ApiGateway',
      MetricName: metric,
      Dimensions: [{ Name: 'ApiName', Value: apiName }],
      StartTime: start,
      EndTime: end,
      Period: 60,
      Statistics: ['Sum'],
    }),
  );
  return (out.Datapoints ?? []).reduce((a, d) => a + (d.Sum ?? 0), 0);
}

/**
 * Late fields (spec §3.4): API Gateway's own count of 5XX over the run's
 * scenarios, minus the 5XX the driver saw, is a server error the driver cannot
 * attribute (P-7). Scenarios run back to back and CloudWatch's finest period
 * is a minute, so adjacent scenarios share a bucket: the count is over the
 * union of the windows, and what is left over goes on the latest record.
 * CloudWatch delivers metrics late (finding F-6), so the count of calls is
 * waited for first, for up to four minutes.
 */
async function collect(stack: string): Promise<number> {
  const dir = need('STRESS_RESULTS');
  const cw = new CloudWatchClient({ region: region() });
  const apiName = `${stack}-api`;
  const files = fs.readdirSync(dir).filter((f) => f.startsWith('tenant-identity.') && !f.endsWith('.lifecycle.json') && f.endsWith('.json'));
  const docs = files.map((file) => ({ file, full: path.join(dir, file), doc: JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as RecordFile }));
  if (docs.length === 0) {
    process.stdout.write('collect: no record of this slice\n');
    return 0;
  }
  const first = Math.min(...docs.map((d) => Date.parse(d.doc.window.start)));
  const last = Math.max(...docs.map((d) => Date.parse(d.doc.window.end)));
  const start = new Date(Math.floor(first / MINUTE) * MINUTE);
  const end = new Date(Math.ceil(last / MINUTE) * MINUTE + MINUTE);
  const sum = (pick: (k: string) => boolean): number =>
    docs.reduce((a, d) => a + Object.entries(d.doc.requests).filter(([k]) => pick(k)).reduce((b, [, n]) => b + n, 0), 0);
  // A transport failure (status 0) never reached the API.
  const reached = sum((k) => !k.startsWith('0:'));
  const seen5xx = sum((k) => /^5\d\d/.test(k));
  const deadline = Date.now() + 4 * MINUTE;
  let counted = await apiSum(cw, apiName, 'Count', start, end);
  while (counted < 0.9 * reached && Date.now() < deadline) {
    await sleep(20_000);
    counted = await apiSum(cw, apiName, 'Count', start, end);
  }
  const api5xx = await apiSum(cw, apiName, '5XXError', start, end);
  const extra = Math.max(0, Math.round(api5xx - seen5xx));
  process.stdout.write(`collect: driver ${reached} calls, API Gateway counted ${Math.round(counted)}; 5XX driver ${seen5xx}, API ${Math.round(api5xx)}\n`);
  if (counted < 0.9 * reached) {
    process.stdout.write('  warning: API Gateway metrics had not caught up after 4 minutes\n');
  }
  if (extra === 0) {
    return 0;
  }
  const latest = docs.reduce((a, b) => (Date.parse(b.doc.window.end) >= Date.parse(a.doc.window.end) ? b : a));
  latest.doc.refusals.unattributed += extra;
  fs.writeFileSync(latest.full, `${JSON.stringify(latest.doc, null, 2)}\n`);
  process.stdout.write(`  ${extra} 5XX the driver did not see, recorded as unattributed refusals on ${latest.file}\n`);
  return 1;
}

// ---------------------------------------------------------------------------
// sweep
// ---------------------------------------------------------------------------

async function sweep(prefix: string, stack: string, includeSeeded: boolean): Promise<number> {
  const store = openStore(prefix, stack, 'unknown', process.env.STRESS_COMMIT ?? '');
  const ids = [...store.transient, ...(includeSeeded ? store.seeded.map((t) => t.tenantId) : [])];
  if (ids.length === 0) {
    process.stdout.write('sweep: no tenant to delete\n');
    return 0;
  }
  const deployed = await describeStack(stack);
  if (deployed === undefined) {
    // The pool went with the stack: nothing of the manifest's can be left.
    store.update((m) => ({ ...m, seeded: includeSeeded ? [] : m.seeded, transient: [] }));
    process.stdout.write(`sweep: stack gone, ${ids.length} manifest tenants went with it\n`);
    return 0;
  }
  const { ctx } = await connect(stack);
  const rec = new Recorder();
  const pacer = new Pacer(SEED_PACE_PER_SECOND);
  let failed = 0;
  for (const id of ids) {
    await pacer.wait();
    if (await deleteTenant(ctx, rec, id)) {
      store.removeTransient([id]);
      if (includeSeeded) {
        store.update((m) => ({ ...m, seeded: m.seeded.filter((t) => t.tenantId !== id) }));
      }
    } else {
      failed += 1;
    }
  }
  // Prove it: every deleted tenant now reads 404.
  let left = 0;
  for (const id of ids.filter((i) => !store.transient.includes(i))) {
    const r = await withRetry(() => timed(rec, 'get-tenant', id, () => ctx.platform.call('GET', `platform/tenants/${id}`)));
    if (r.status !== 404) {
      left += 1;
    }
  }
  process.stdout.write(`sweep: ${ids.length - failed} of ${ids.length} tenants deleted, ${left} still readable\n`);
  return failed === 0 && left === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// publish
// ---------------------------------------------------------------------------

async function publish(prefix: string, stack: string): Promise<void> {
  const d = await describeStack(stack);
  if (d === undefined) {
    throw new Error(`stack ${stack} is not deployed`);
  }
  const ssm = new SSMClient({ region: region() });
  await ssm.send(
    new PutParameterCommand({
      Name: parameterNameOf(prefix),
      Type: 'String',
      Overwrite: true,
      Description: 'Platform stress test: the stress tenant-identity deployment (ids only, no secret)',
      Value: JSON.stringify({ stack, region: region(), apiUrl: d.apiUrl, apiId: d.apiId, userPoolId: d.userPoolId, appClientId: d.appClientId }),
    }),
  );
  process.stdout.write(`published ${parameterNameOf(prefix)}\n`);
}

async function unpublish(prefix: string): Promise<void> {
  const ssm = new SSMClient({ region: region() });
  try {
    await ssm.send(new DeleteParameterCommand({ Name: parameterNameOf(prefix) }));
    process.stdout.write(`removed ${parameterNameOf(prefix)}\n`);
  } catch (e) {
    if ((e as Error).name !== 'ParameterNotFound') {
      throw e;
    }
  }
}

// ---------------------------------------------------------------------------

async function main(argv: string[]): Promise<number> {
  const [command, arg] = argv;
  if (command === 'budget') {
    const plan = planOf(parseTier(process.env.STRESS_TIER_JSON), parseMode(process.env.STRESS_MODE));
    process.stdout.write(`${JSON.stringify({ draws: drawsOf(plan) })}\n`);
    return 0;
  }
  const prefix = need('STRESS_PREFIX');
  const stack = stackNameOf(prefix);
  switch (command) {
    case 'seed': return seed(prefix, stack);
    case 'run': return run(prefix, stack, arg ?? '');
    case 'collect': return collect(stack);
    case 'sweep': return sweep(prefix, stack, arg === '--seeded');
    case 'publish': await publish(prefix, stack); return 0;
    case 'unpublish': await unpublish(prefix); return 0;
    default:
      process.stderr.write('usage: driver.ts budget | seed | run <scenario> | collect | sweep [--seeded] | publish | unpublish\n');
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    process.stderr.write(`${(e as Error).name}: ${(e as Error).message.slice(0, 300)}\n`);
    process.exitCode = 1;
  },
);
