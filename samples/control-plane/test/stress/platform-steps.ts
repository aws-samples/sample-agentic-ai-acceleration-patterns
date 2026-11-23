// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The control-plane slice's steps in a platform run (docs/stress-test.spec.md §3.5, `slice.sh
 * step <name>`): the parts of its set-up and teardown that must run between the front door's
 * verbs. `hooks` and `unhook` put the front door's route hook on the control plane and take it
 * off again; `register` registers the stress application and the cell accounts once the front
 * door's distribution exists (in the driver); `warm-up` places one tenant alone, which builds
 * the first cell. Ids and counts only: never a token, a password or a key. The operator token
 * stays in the environment of the one script that needs it.
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { aws } from './aws';
import { type EdgeInputs, FRONT_DOOR_FILE, parseEdgeInputs } from './edge';
import { assertPlaced, cellsOf, type FleetEnv, placeDeployment, waitDeployments } from './fleet';
import type { Manifest, WarmUp } from './manifest';

/** What the front-door slice publishes (`tenant-front-door.json`), as far as the control plane reads it. */
export interface FrontDoorManifest extends EdgeInputs {
  /** The edge distribution; the stress application's `DISTRIBUTION_ARN` cell parameter takes it. */
  readonly distributionArn?: string;
  /** The `RouteHookAccess` policy the control plane's global hook role takes (`globalHookManagedPolicyArns`). */
  readonly hookPolicyArn?: string;
}

const POLICY_ARN = /^arn:aws[a-z-]*:iam::\d{12}:policy\/[A-Za-z0-9+=,.@_/-]{1,512}$/;
const DISTRIBUTION = /^arn:aws[a-z-]*:cloudfront::\d{12}:distribution\/[A-Z0-9]{8,32}$/;
const COMMIT = /^[0-9a-f]{40}$/;

/**
 * Parses the front-door manifest. The edge and registrar addresses are required (the same
 * checks PS-5 makes); the distribution and the hook policy are checked when present, and
 * a step that needs one says so when it is missing.
 */
export function parseFrontDoor(text: string | undefined, file: string): FrontDoorManifest {
  const edge = parseEdgeInputs(text, file);
  const doc = JSON.parse(text as string) as Record<string, unknown>;
  const distributionArn = doc.distributionArn;
  const hookPolicyArn = doc.hookPolicyArn;
  if (distributionArn !== undefined && (typeof distributionArn !== 'string' || !DISTRIBUTION.test(distributionArn))) {
    throw new Error(`${file} (written by the tenant-front-door slice): distributionArn must be a CloudFront distribution ARN`);
  }
  if (hookPolicyArn !== undefined && (typeof hookPolicyArn !== 'string' || !POLICY_ARN.test(hookPolicyArn))) {
    throw new Error(`${file} (written by the tenant-front-door slice): hookPolicyArn must be an IAM policy ARN`);
  }
  return { ...edge, ...(distributionArn === undefined ? {} : { distributionArn }), ...(hookPolicyArn === undefined ? {} : { hookPolicyArn }) };
}

/** The front-door manifest of this run's prefix, or undefined when the front-door slice is not in the run. */
export function readFrontDoor(home: string, prefix: string): FrontDoorManifest | undefined {
  const file = path.join(home, prefix, FRONT_DOOR_FILE);
  return fs.existsSync(file) ? parseFrontDoor(fs.readFileSync(file, 'utf8'), file) : undefined;
}

/** The file that holds the hook policy ARNs a deploy of the control plane takes (`STRESS_HOOK_POLICY_ARNS`). */
export const hookPolicyFile = (home: string, prefix: string): string => path.join(home, prefix, 'hook-policy-arns');

/** Writes (or, with none, removes) the hook policy file `slice.sh` reads before every deploy of the control plane. */
export function setHookPolicy(home: string, prefix: string, arn: string | undefined): void {
  const file = hookPolicyFile(home, prefix);
  if (arn === undefined) {
    fs.rmSync(file, { force: true });
    return;
  }
  if (!POLICY_ARN.test(arn)) throw new Error('the hook policy must be an IAM policy ARN');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${arn}\n`, { mode: 0o600 });
}

/** The commit the hooks are pinned to: a full SHA that the public repository holds (`STRESS_HOOK_COMMIT`). */
export function hookCommitOf(text: string | undefined): string {
  if (text === undefined || !COMMIT.test(text)) {
    throw new Error('STRESS_HOOK_COMMIT must be the full 40-character commit SHA of a commit in the public repository that holds samples/tenant-front-door/hooks/route-hook.sh (the control plane fetches the hook from there)');
  }
  return text;
}

/** Runs `file args` with `env`, its output on stderr (the runner's log). Resolves with the exit status. */
export function runFile(file: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve) => {
    const child = execFile(file, [...args], { env, maxBuffer: 64 * 1024 * 1024 }, (error) => {
      resolve(error === null ? 0 : typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1);
    });
    child.stdout?.pipe(process.stderr);
    child.stderr?.pipe(process.stderr);
    child.stdin?.end();
  });
}

/**
 * Registers or removes the front door's two global hooks with the front door's own
 * `register-hooks.sh` (front-door spec §5.2). The operator token reaches the script in its
 * environment only. Returns the script's exit status.
 */
export function registerHooks(repo: string, apiUrl: string, token: string, mode: { delete: true } | { commit: string }): Promise<number> {
  const script = path.join(repo, 'samples', 'tenant-front-door', 'scripts', 'register-hooks.sh');
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, AWS_PAGER: '', CONTROL_PLANE_URL: apiUrl, CONTROL_PLANE_TOKEN: token };
  if ('commit' in mode) env.HOOK_SOURCE_VERSION = mode.commit;
  return runFile('bash', [script, ...('delete' in mode ? ['--delete'] : [])], env);
}

const CELL_API_DOMAIN = /^[a-z0-9]{32}\.lambda-url\.[a-z0-9-]+\.on\.aws$/;

/** What `warmUp` needs from outside the control plane: the cell script's published parameter, read in the cell account. */
export interface WarmUpDeps {
  readonly readParameter: (profile: string, region: string, name: string) => Promise<string>;
  readonly now: () => number;
}

export const liveWarmUpDeps: WarmUpDeps = {
  readParameter: async (profile, region, name) => String((await aws(['ssm', 'get-parameter', '--name', name], { profile, region })).Parameter?.Value ?? ''),
  now: Date.now,
};

/** Spec §3.5 step 5. The deployment and the cell build took 759 s in the first platform run at `small`; one hour is the budget. */
const WARM_UP_TIMEOUT_SECONDS = 3600;

/**
 * Places the first seeded tenant alone: its deployment builds the cell (the cell script), the
 * route hook writes the cell and tenant routes, and the step waits until the deployment and
 * the cell are ACTIVE. It then reads the cell API's domain from the cell account and records
 * the tenant, the cell and what the front door's phase two needs in the manifest. A rerun
 * with an ACTIVE warm-up deployment records again and places nothing. Returns undefined
 * (with findings on `f.rec`) on any failure.
 */
export async function warmUp(
  f: FleetEnv,
  manifest: Manifest,
  writeManifest: (m: Manifest) => void,
  deps: WarmUpDeps = liveWarmUpDeps,
): Promise<WarmUp | undefined> {
  const tenant = manifest.seeded[0];
  if (tenant === undefined) {
    f.rec.finding('the manifest has no seeded tenant to warm up: run seed first');
    return undefined;
  }
  // The front door's phase two needs the reader role: refuse before a cell build of about 13 minutes.
  const noRole = f.cellAccounts.filter((a) => a.ingressReaderRoleArn === undefined);
  if (noRole.length > 0) {
    f.rec.finding(`warm-up: ${noRole.length} cell account(s) in the cell accounts file have no ingressReaderRoleArn (platform mode needs it, stress/application/README.md step 1)`);
    return undefined;
  }
  const started = deps.now();
  const placed = await placeDeployment(f, tenant);
  if (placed !== 'accepted' && placed !== 'exists') {
    f.rec.finding(`warm-up tenant ${tenant}: CreateDeployment ${placed}`);
    return undefined;
  }
  const state = (await waitDeployments(f, [tenant], { timeoutSeconds: WARM_UP_TIMEOUT_SECONDS })).get(tenant);
  if (state === undefined || state.status !== 'ACTIVE') {
    f.rec.finding(`warm-up tenant ${tenant}: deployment ${state?.status ?? 'missing'} (${String(state?.statusReason ?? 'no reason').slice(0, 160)})`);
    return undefined;
  }
  const cells = await cellsOf(f);
  const cell = cells.find((c) => c.cellId === state.cellId);
  if (cell === undefined || cell.status !== 'ACTIVE') {
    f.rec.finding(`warm-up tenant ${tenant}: its cell ${state.cellId} is ${cell?.status ?? 'missing'}`);
    return undefined;
  }
  await assertPlaced(f, [state], cells);
  const account = f.cellAccounts.find((a) => a.accountId === cell.accountId);
  if (account === undefined) {
    f.rec.finding(`warm-up tenant ${tenant}: its cell ${cell.cellId} is in an account the run does not list`);
    return undefined;
  }
  const domain = (await deps.readParameter(account.profile, f.region, `/application-plane/cells/${cell.cellId}/api-domain`)).trim();
  if (!CELL_API_DOMAIN.test(domain)) {
    f.rec.finding(`the cell script published no cell API domain for ${cell.cellId}: the cell has no cell API origin (is DISTRIBUTION_ARN set?)`);
    return undefined;
  }
  const warm: WarmUp = {
    tenantId: tenant,
    cellId: cell.cellId,
    accountId: cell.accountId,
    cellApiDomain: domain,
    ...(account.ingressReaderRoleArn === undefined ? {} : { ingressReaderRoleArn: account.ingressReaderRoleArn }),
    ingressParameter: `/application-plane/shared/agent-runtime/StressCell-${cell.cellId}/ingress`,
  };
  writeManifest({ ...manifest, warmUp: warm });
  f.log(`warm-up: tenant ${tenant} ACTIVE in cell ${cell.cellId} (${cell.status}) ${Math.round((deps.now() - started) / 1000)} s after CreateDeployment${cell.createdAt !== undefined && cell.updatedAt !== undefined ? `; cell CREATING to ACTIVE ${Math.round((Date.parse(cell.updatedAt) - Date.parse(cell.createdAt)) / 1000)} s` : ''}`);
  return warm;
}
