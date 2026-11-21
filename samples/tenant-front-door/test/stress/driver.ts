// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The front-door slice's driver (docs/stress-test.spec.md §3.4). `slice.sh`
 * runs it with one verb:
 *
 *   driver.ts budget            the slice's draws on account-wide quotas (no credentials)
 *   driver.ts seed              tenants in tenant-identity, their cell namespace and control-plane records, the routes
 *   driver.ts run <scenario>    one scenario: its result record and request log
 *   driver.ts collect           the hops' logs against the driver's counts; the late fields
 *   driver.ts sweep             the run's routes and tenants
 *   driver.ts ingress           platform mode: the cell's ingress base URL, read through the ingress reader role (stdout)
 *   driver.ts await-agents      platform mode: polls until the edge routes `/agents/*` (front-door phase two)
 *
 * In platform mode (STRESS_MODE=platform) `run` and `collect` read the other slices' manifests (platform.ts) instead of
 * the stand-in's outputs and run PS-7 only. It prints ids, counts and timings, never a token, a password or a key.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { DeleteParametersCommand, GetParameterCommand, PutParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { Fixtures, IdentityClient, newUlid, Registrar, retrying, unsignedToken } from './clients';
import { collect } from './collect';
import { request, sleep } from './http';
import { pool, Rate } from './load';
import { drawsOf, parseTier, planOf, tenantsToSeed } from './plan';
import { agentIngressOf, agentsOpen, ingressBaseUrl, manifestDir, needWarmUp, parseControlPlane, parseFrontDoor, parseIdentity, platformTenants, ps7Outputs, readManifest as readPlatformManifest } from './platform';
import { ps7, runScenario, SCENARIOS, type Ctx, type Ps7Ctx, type ScenarioId } from './scenarios';
import { assumedCredentials, ownCredentials, signedCaller } from './sigv4';
import { readEnv, readManifest, readOutputs, readPlatformOutputs, writeManifest, writeRequestLog, type Env, type Manifest, type Outputs, type TenantEntry } from './state';

const SEED_CONCURRENCY = 2;
/** PutParameter and DeleteParameter share a 3 per second account limit (SSM). */
const SSM_PER_SECOND = 3;

function context(env: Env, out: Outputs, manifest: Manifest): Ctx {
  const own = signedCaller(env.region, ownCredentials());
  const hook = signedCaller(env.region, assumedCredentials(out.hookRoleArn, env.region, 'tfd-stress-hook'));
  const operator = signedCaller(env.region, assumedCredentials(out.operatorRoleArn, env.region, 'tfd-stress-operator'));
  return { env, out, manifest, identity: new IdentityClient(out.identityApiUrl, own), registrar: new Registrar(out.registrarUrl, hook, operator) };
}

const namespaceParameter = (out: Outputs, tenantId: string): string => `/application-plane/tenants/${tenantId}/${out.applicationId}/smoke`;

async function putParameter(ssm: SSMClient, gate: Rate, name: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    await gate.take();
    try {
      await ssm.send(new PutParameterCommand({ Name: name, Value: 'stress', Type: 'String', Overwrite: true }));
      return;
    } catch (e) {
      if (attempt >= 8 || (e as Error).name !== 'ThrottlingException') throw e;
      await sleep(Math.min(8000, 500 * 2 ** attempt));
    }
  }
}

async function seed(env: Env, out: Outputs): Promise<void> {
  const plan = planOf(env.tier);
  const total = tenantsToSeed(plan);
  const existing: Manifest = fs.existsSync(path.join(env.stateDir, 'manifest.json')) ? readManifest(env) : { version: 1, tenants: [] };
  const tenants: TenantEntry[] = [...existing.tenants];
  const ctx = context(env, out, { version: 1, tenants });
  const started = Date.now();
  await ctx.identity.ensureScope('app/use');
  const fixtures = new Fixtures(out);
  const ssm = new SSMClient({ region: env.region });
  const gate = new Rate(SSM_PER_SECOND);

  // An entry whose create tenant-identity never confirmed has no username: remove that tenant (404 is fine) and make it again.
  // Only a confirmed delete (or a 404) drops the entry; any other answer keeps it in the manifest, where the sweep finds it.
  for (const t of tenants.filter((x) => x.username === '')) {
    const status = await ctx.identity.deleteTenant(t.tenantId);
    if (status !== 200 && status !== 204 && status !== 404) throw new Error(`could not remove a half-made tenant: DeleteTenant HTTP ${status}; it stays in the manifest`);
  }
  tenants.splice(0, tenants.length, ...tenants.filter((x) => x.username !== ''));
  writeManifest(env, { version: 1, tenants });
  const haveActive = tenants.filter((t) => t.kind === 'active').length;
  const wanted: TenantEntry['kind'][] = [];
  for (let i = haveActive; i < plan.activeTenants; i += 1) wanted.push('active');
  for (let i = tenants.filter((t) => t.kind === 'write').length; i < total - plan.activeTenants; i += 1) wanted.push('write');
  const prefix = env.prefix.toLowerCase().slice(0, 14);
  await pool(wanted, SEED_CONCURRENCY, async (kind) => {
    const tenantId = newUlid();
    const name = `${prefix}-${kind === 'active' ? 'a' : 'w'}-${tenantId.slice(-8).toLowerCase()}`;
    // The manifest knows the tenant before tenant-identity does, so a failure at any step leaves nothing the sweep cannot find.
    const entry: TenantEntry = { tenantId, username: '', kind, name };
    tenants.push(entry);
    writeManifest(env, { version: 1, tenants });
    entry.username = await ctx.identity.createTenant(tenantId, name);
    writeManifest(env, { version: 1, tenants });
  });
  await pool(tenants.filter((t) => t.ready !== true), SEED_CONCURRENCY, async (t) => {
    await putParameter(ssm, gate, namespaceParameter(out, t.tenantId));
    t.ready = true;
    writeManifest(env, { version: 1, tenants });
  });
  // The stand-in control plane's table goes with its stack, so its records are written again for every tenant of the manifest.
  await pool(tenants, 8, (t) => fixtures.tenant(t.tenantId, t.name ?? t.tenantId));
  console.log(`seed: ${tenants.length} tenants (${tenants.filter((t) => t.kind === 'active').length} active, ${tenants.filter((t) => t.kind === 'write').length} write) in ${Math.round((Date.now() - started) / 1000)} s`);

  // The cell's route and the active tenants' routes, through the registrar as the global hook role writes them.
  await fixtures.cell();
  const cell = await retrying(() => ctx.registrar.putCell(out.cellId, out.cellApiDomain), (r) => r.status === 503 || r.status === 0);
  if (cell.status !== 200) throw new Error(`PutCellRoute: HTTP ${cell.status} ${cell.body.slice(0, 160)}`);
  const routed = Date.now();
  await pool(tenants.filter((t) => t.kind === 'active'), SEED_CONCURRENCY, async (t) => {
    const r = await retrying(() => ctx.registrar.putTenant(t.tenantId), (x) => x.status === 503 || x.status === 0, 5);
    if (r.status !== 200) throw new Error(`PutTenantRoute: HTTP ${r.status} ${r.body.slice(0, 160)}`);
  });
  console.log(`seed: ${plan.activeTenants} routes written in ${Math.round((Date.now() - routed) / 1000)} s`);

  // Ready: every active tenant answers 200 five times in a row.
  const ready = Date.now();
  await pool(tenants.filter((t) => t.kind === 'active'), 8, async (t) => {
    const token = await ctx.identity.issueToken(t.tenantId, t.username);
    let streak = 0;
    for (let i = 0; i < 180 && streak < 5; i += 1) {
      const r = await request({ method: 'GET', url: `https://${out.appDomain}/api/whoami`, headers: { authorization: `Bearer ${token}` } });
      streak = r.status === 200 ? streak + 1 : 0;
      if (streak < 5) await sleep(1000);
    }
    if (streak < 5) throw new Error(`the route of an active tenant never became routable within 180 s (${t.tenantId})`);
  });
  console.log(`seed: every active route answered five times in a row ${Math.round((Date.now() - ready) / 1000)} s after the last write`);
}

async function sweep(env: Env, routes: boolean): Promise<number> {
  const file = path.join(env.stateDir, 'manifest.json');
  if (!fs.existsSync(file)) {
    console.log('sweep: no manifest: nothing to remove');
    return 0;
  }
  if (!fs.existsSync(path.join(env.stateDir, 'outputs.json'))) {
    console.error('sweep: the manifest names tenants but there are no deploy outputs to find their account and API by');
    return 1;
  }
  const out = readOutputs(env);
  const manifest = readManifest(env);
  const ctx = context(env, out, manifest);
  const ssm = new SSMClient({ region: env.region });
  let failed = 0;
  await pool(manifest.tenants, SEED_CONCURRENCY, async (t) => {
    // The routes go with the front door's stacks: with `routes` off the registrar is gone and only the tenant remains to remove.
    if (routes) {
      const route = await ctx.registrar.deleteTenant(t.tenantId);
      if (route.status !== 200) {
        failed += 1;
        console.log(`sweep: DeleteTenantRoute HTTP ${route.status}`);
      }
    }
    const id = await ctx.identity.deleteTenant(t.tenantId);
    if (id !== 200 && id !== 204 && id !== 404) {
      failed += 1;
      console.log(`sweep: DeleteTenant HTTP ${id}`);
    }
  });
  const gate = new Rate(SSM_PER_SECOND);
  for (let i = 0; i < manifest.tenants.length; i += 10) {
    const names = manifest.tenants.slice(i, i + 10).map((t) => namespaceParameter(out, t.tenantId));
    for (let attempt = 0; ; attempt += 1) {
      await gate.take();
      try {
        await ssm.send(new DeleteParametersCommand({ Names: names }));
        break;
      } catch (e) {
        if (attempt >= 8 || (e as Error).name !== 'ThrottlingException') throw e;
        await sleep(Math.min(8000, 500 * 2 ** attempt));
      }
    }
  }
  if (routes) {
    const cell = await ctx.registrar.deleteCell(out.cellId);
    if (cell.status !== 200) {
      failed += 1;
      console.log(`sweep: DeleteCellRoute HTTP ${cell.status}`);
    }
  }
  if (failed === 0) fs.rmSync(file);
  console.log(`sweep: ${manifest.tenants.length} tenants, ${routes ? 'their routes and ' : ''}parameters removed; ${failed} failures`);
  return failed === 0 ? 0 : 1;
}

async function run(env: Env, scenario: string): Promise<number> {
  const platform = env.mode === 'platform';
  const known = platform ? ['PS-7'] : (SCENARIOS as readonly string[]);
  if (!known.includes(scenario)) throw new Error(`unknown scenario ${scenario} (${known.join(', ')}${platform ? ' in platform mode; the others are slice mode only' : ''})`);
  if (env.results === '') throw new Error('STRESS_RESULTS is not set');
  const outcome = platform
    ? await ps7(platformContext(env))
    : await runScenario(context(env, readOutputs(env), readManifest(env)), scenario as ScenarioId);
  const record = outcome.record;
  fs.mkdirSync(env.results, { recursive: true });
  fs.writeFileSync(path.join(env.results, `tenant-front-door.${scenario}.json`), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  writeRequestLog(env, scenario, outcome.lines);
  const total = Object.values(record.requests).reduce((a, b) => a + b, 0);
  console.log(`run ${scenario}: ${total} requests; isolation ${record.isolation.mismatches} mismatches in ${record.isolation.assertions} assertions; unattributed refusals ${record.refusals.unattributed}`);
  console.log(`  requests: ${Object.entries(record.requests).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  for (const [hop, p] of Object.entries(record.latency)) console.log(`  ${hop}: p50 ${p.p50.toFixed(3)} s, p95 ${p.p95.toFixed(3)} s, p99 ${p.p99.toFixed(3)} s`);
  for (const n of outcome.notes) console.log(`  ${n}`);
  for (const f of outcome.failures) console.error(`run ${scenario}: FAIL ${f}`);
  return outcome.failures.length === 0 && record.isolation.mismatches === 0 && record.refusals.unattributed === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Platform mode (docs/stress-test.spec.md §3.5, stress ADR-0016, ADR-0017): the manifests of the other slices stand in for
// the stand-in control plane and its fixtures.
// ---------------------------------------------------------------------------

/** The manifests of the platform run, each read the way it names the slice that writes it. */
const manifestFile = (env: Env, name: string): string => path.join(manifestDir(env), name);

function readFrontDoor(env: Env) {
  const file = manifestFile(env, 'tenant-front-door.json');
  return { file, fd: parseFrontDoor(readPlatformManifest(file, 'tenant-front-door'), file) };
}

function readControlPlane(env: Env) {
  const file = manifestFile(env, 'control-plane.json');
  return { file, cp: parseControlPlane(readPlatformManifest(file, 'control-plane'), file) };
}

/** PS-7 in platform mode: tenants, tokens and the cell origin and ingress from the manifests; no registrar, no fixtures. */
function platformContext(env: Env): Ps7Ctx {
  const { file: fdFile, fd } = readFrontDoor(env);
  const { file: cpFile, cp } = readControlPlane(env);
  const idFile = manifestFile(env, 'identity.json');
  const identity = parseIdentity(readPlatformManifest(idFile, 'tenant-identity'), idFile);
  const tenants = platformTenants(cp, planOf(env.tier).activeTenants);
  if (tenants.length < 2) {
    throw new Error(`PS-7 needs two tenants with an identity, ${cpFile} has ${tenants.length}: ${cp.seeded.length} seeded, ${cp.identity.length} with an identity entry (the control-plane slice writes identity[], stress ADR-0017)`);
  }
  const out = ps7Outputs(fd, needWarmUp(cp, cpFile), fdFile);
  return { env, out, manifest: { version: 1, tenants }, identity: new IdentityClient(identity.apiUrl, signedCaller(env.region, ownCredentials())) };
}

/**
 * Phase two, first half: the cell's ingress base URL. Assumes the cell account's ingress reader role with the run's own credentials
 * (held in memory by the credentials provider, never printed or written) and reads the one parameter it allows. Prints the URL alone.
 */
async function ingress(env: Env): Promise<number> {
  const { file, cp } = readControlPlane(env);
  const warm = needWarmUp(cp, file);
  const ssm = new SSMClient({ region: env.region, credentials: assumedCredentials(warm.ingressReaderRoleArn, env.region, 'tfd-stress-phase-two') });
  const r = await ssm.send(new GetParameterCommand({ Name: warm.ingressParameter }));
  console.log(agentIngressOf(ingressBaseUrl(r.Parameter?.Value ?? '')));
  return 0;
}

/** How long phase two waits for the distribution update to reach the edge (a CloudFront deployment takes minutes). */
const AGENTS_WAIT_MS = 600_000;

/** Phase two, second half: polls until the edge routes `/agents/*`, five answers in a row, for up to ten minutes. */
async function awaitAgents(env: Env, waitMs = AGENTS_WAIT_MS): Promise<number> {
  const { fd } = readFrontDoor(env);
  const from = Date.now();
  let streak = 0;
  let last = 'no answer';
  while (Date.now() - from < waitMs) {
    const r = await request({ method: 'GET', url: `${fd.edgeUrl}/agents/${fd.agentBackend}/invocations`, headers: { authorization: `Bearer ${unsignedToken(newUlid())}` } });
    last = r.status === 0 ? `no answer (${r.error ?? 'error'})` : `HTTP ${r.status}`;
    streak = agentsOpen(r.status, r.body) ? streak + 1 : 0;
    if (streak >= 5) {
      console.log(`phase two: the edge routes /agents/* ${Math.round((Date.now() - from) / 1000)} s after the deploy returned`);
      return 0;
    }
    await sleep(5000);
  }
  console.error(`phase two: the edge did not route /agents/* within ${Math.round(waitMs / 60_000)} minutes (the last answer was ${last}, not the router's 403 for an unknown tenant)`);
  return 1;
}

async function main(): Promise<number> {
  const [verb, arg] = process.argv.slice(2);
  switch (verb) {
    case 'budget':
      console.log(JSON.stringify({ draws: drawsOf(parseTier(process.env.STRESS_TIER_JSON)) }));
      return 0;
    case 'seed': {
      const env = readEnv();
      await seed(env, readOutputs(env));
      return 0;
    }
    case 'run': {
      return run(readEnv(), arg ?? '');
    }
    case 'collect': {
      const env = readEnv();
      const r = await collect(env, env.mode === 'platform' ? readPlatformOutputs(env) : readOutputs(env));
      for (const n of r.notes) console.log(`collect: ${n}`);
      for (const f of r.failures) console.error(`collect: FAIL ${f}`);
      return r.failures.length === 0 ? 0 : 1;
    }
    case 'sweep':
      return sweep(readEnv(), arg !== '--no-routes');
    case 'ingress':
      return ingress(readEnv());
    case 'await-agents':
      return awaitAgents(readEnv());
    default:
      console.error('usage: driver.ts budget | seed | run <scenario> | collect | sweep | ingress | await-agents');
      return 2;
  }
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(`driver: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  },
);
