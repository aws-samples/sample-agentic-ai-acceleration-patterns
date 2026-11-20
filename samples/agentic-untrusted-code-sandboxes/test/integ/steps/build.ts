// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Steps that need no stack: the preconditions (spec §8, "checked by the
 * driver before it deploys"), standalone-build, and synth. A failure here
 * saves the deploy, which is the long part of a run.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GetParameterCommand } from '@aws-sdk/client-ssm';
import { type Aws } from '../aws';
import { logsPoliciesNeeded } from '../common';
import { run } from '../deploy';
import { policySnapshot } from '../leftovers';
import { type Recorder } from '../record';

/** The sample root: test/integ/steps -> the package directory. */
export const SAMPLE_DIR = path.resolve(__dirname, '..', '..', '..');
const PRODUCER_DIR = path.resolve(SAMPLE_DIR, '..', 'agentic-runtime-isolation');
/** Service Quotas code of "Max allocated ARM_64 MicroVM memory" (spec §6.1); the unit is GB. */
export const MICROVM_QUOTA_CODE = 'L-CD1C0CC4';
/** Tenants A, B, C, E and a restart (spec §8 preconditions). */
export const MICROVM_QUOTA_FACTOR = 5;
export const MICROVM_MEMORY_MIB = 1024;
export const LOGS_POLICY_LIMIT = 10;
const IDENTITY_STACK = 'TenantIdentity-shared-pool';

/** The quota the run needs, in GB. */
export function neededQuotaGb(memoryMiB: number = MICROVM_MEMORY_MIB): number {
  return (MICROVM_QUOTA_FACTOR * memoryMiB) / 1024;
}

/** Returns the problems with the account before the deploy; empty when it is ready. Read-only, apart from `npm ci` in the producer. */
export async function preconditions(aws: Aws, rec: Recorder): Promise<{ policyBaseline: Record<string, string> }> {
  rec.check(`the stack ${IDENTITY_STACK} exists (a shared fixture; deploy it with the commands in integration-test.md, "How to run it")`, (await aws.stackStatus(IDENTITY_STACK)) !== undefined);
  try {
    await aws.ssm.send(new GetParameterCommand({ Name: '/application-plane/shared/identity/userPoolId' }));
    rec.check('tenant-identity publishes its user pool', true);
  } catch {
    rec.check('tenant-identity publishes its user pool (/application-plane/shared/identity/userPoolId)', false);
  }
  const quota = JSON.parse(await aws.cli(['service-quotas', 'get-service-quota', '--service-code', 'lambda', '--quota-code', MICROVM_QUOTA_CODE])) as { Quota?: { Value?: number } };
  const have = quota.Quota?.Value ?? 0;
  rec.check(`the MicroVM memory quota ${MICROVM_QUOTA_CODE} is at least ${neededQuotaGb()} GB (is ${have})`, have >= neededQuotaGb());
  const policies = await policySnapshot(aws);
  const used = Object.keys(policies).length;
  const needed = logsPoliciesNeeded();
  // A deploy that runs out of slots fails after the VPC and the AgentCore runtime are up (8 to 9 min), so check them all here.
  rec.check(`${needed} free CloudWatch Logs resource policy slots exist, one per dnsFirewall instance and one per agentcore backend (${used} of ${LOGS_POLICY_LIMIT} used)`, LOGS_POLICY_LIMIT - used >= needed);
  const docker = await run('docker', ['info'], 'docker.log').catch(() => ({ code: 1, tail: '', log: '' }));
  rec.check('docker answers (the runner image is built at synth, ADR-0024)', docker.code === 0);
  if (!existsSync(path.join(PRODUCER_DIR, 'node_modules'))) {
    rec.note('installing the producer\'s dependencies (npm ci) for the sample agent bundle');
    const ci = await run('npm', ['ci'], 'producer-npm-ci.log', process.env, PRODUCER_DIR);
    rec.check(`npm ci in agentic-runtime-isolation (exit ${ci.code})`, ci.code === 0);
  }
  if (!existsSync(path.join(PRODUCER_DIR, 'src', 'smithy'))) {
    rec.note('generating the producer\'s Smithy sources (smithy build); the integration app imports them');
    const sm = await run('smithy', ['build'], 'producer-smithy.log', process.env, PRODUCER_DIR).catch(() => ({ code: 1, tail: '', log: '' }));
    rec.check(`smithy build in agentic-runtime-isolation (exit ${sm.code}; the Smithy CLI must be on the path)`, sm.code === 0);
  }
  return { policyBaseline: policies };
}

/** The consumer's `bin/app.ts`: the construct, standalone, every backend, no producer anywhere. */
export const CONSUMER_APP = `import { App, Stack } from 'aws-cdk-lib';
import { UntrustedCodeSandboxes } from 'agentic-untrusted-code-sandboxes';

const app = new App();
const stack = new Stack(app, 'Consumer');
new UntrustedCodeSandboxes(stack, 'Sandboxes', { standalone: true, backends: ['microvm', 'nitro', 'agentcore'] });
`;

/** Checks a module graph for a path through the producer; run by node in the consumer. */
export const GRAPH_CHECK = `require('agentic-untrusted-code-sandboxes');
const hit = Object.keys(require.cache).filter((k) => k.includes('agentic-runtime-isolation'));
if (hit.length > 0) { console.error('the package root reaches the producer: ' + hit.length + ' modules'); process.exit(1); }
console.log('ok');
`;

function pinned(pkg: Record<string, Record<string, string>>, name: string): string {
  return pkg.dependencies?.[name] ?? pkg.devDependencies?.[name] ?? 'latest';
}

/** `npm pack`, then install the tarball into a stub consumer with no producer, compile it and synthesise it; the work folder is removed after. */
export async function standaloneBuild(rec: Recorder): Promise<void> {
  const work = mkdtempSync(path.join(os.tmpdir(), 'rc-standalone-'));
  try {
    await standaloneBuildIn(rec, work);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** `npm pack`, then install the tarball into a stub consumer with no producer, compile it and synthesise it. */
async function standaloneBuildIn(rec: Recorder, work: string): Promise<void> {
  const pkg = JSON.parse(readFileSync(path.join(SAMPLE_DIR, 'package.json'), 'utf8')) as Record<string, Record<string, string>>;
  const compile = await run('npx', ['tsc', '--build'], 'standalone-compile.log', process.env, SAMPLE_DIR);
  rec.check(`the package compiles (exit ${compile.code})`, compile.code === 0);
  const copy = await run('npx', ['ts-node', '--project', 'projenrc/tsconfig.json', 'projenrc/copy-handlers.ts'], 'standalone-handlers.log', process.env, SAMPLE_DIR);
  rec.check(`the handler tree is copied (exit ${copy.code})`, copy.code === 0);
  const packed = await run('npm', ['pack', '--pack-destination', work], 'standalone-pack.log', process.env, SAMPLE_DIR);
  rec.check(`npm pack (exit ${packed.code})`, packed.code === 0);
  if (packed.code !== 0) return;
  const tgz = readdirSync(work).find((f) => f.endsWith('.tgz'));
  rec.check('npm pack wrote a tarball', tgz !== undefined);
  if (!tgz) return;
  const tarball = path.join(work, tgz);
  const consumer = path.join(work, 'consumer');
  mkdirSync(path.join(consumer, 'bin'), { recursive: true });
  writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({
    name: 'rc-integ-consumer',
    private: true,
    dependencies: {
      'agentic-untrusted-code-sandboxes': `file:${tarball}`,
      'aws-cdk-lib': pinned(pkg, 'aws-cdk-lib'),
      'constructs': pinned(pkg, 'constructs'),
    },
    devDependencies: {
      'aws-cdk': pinned(pkg, 'aws-cdk'),
      'ts-node': pinned(pkg, 'ts-node'),
      'typescript': pinned(pkg, 'typescript'),
      '@types/node': pinned(pkg, '@types/node'),
    },
  }, undefined, 2));
  writeFileSync(path.join(consumer, 'cdk.json'), JSON.stringify({ app: 'npx ts-node --prefer-ts-exts bin/app.ts' }, undefined, 2));
  writeFileSync(path.join(consumer, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'commonjs', moduleResolution: 'node', strict: true, esModuleInterop: true, skipLibCheck: true, noEmit: true },
    include: ['bin/**/*.ts'],
  }, undefined, 2));
  writeFileSync(path.join(consumer, 'bin', 'app.ts'), CONSUMER_APP);
  writeFileSync(path.join(consumer, 'graph-check.js'), GRAPH_CHECK);
  const install = await run('npm', ['install', '--no-audit', '--no-fund'], 'standalone-install.log', process.env, consumer);
  rec.check(`npm install succeeds with no peer error (exit ${install.code})`, install.code === 0 && !/ERESOLVE|peer dep/i.test(install.tail));
  const ls = await run('npm', ['ls', 'agentic-runtime-isolation', '--all', '--parseable'], 'standalone-ls.log', process.env, consumer);
  rec.check('the consumer tree has no agentic-runtime-isolation anywhere (npm ls finds none)', ls.code !== 0 && !/agentic-runtime-isolation/.test(ls.tail.replace(/npm (error|ERR!)[^\n]*/g, '')));
  const tsc = await run('npx', ['tsc', '-p', '.'], 'standalone-tsc.log', process.env, consumer);
  rec.check(`tsc compiles the consumer (exit ${tsc.code})`, tsc.code === 0);
  const graph = await run('node', ['graph-check.js'], 'standalone-graph.log', process.env, consumer);
  rec.check(`no module reached from the package root resolves to the producer (exit ${graph.code})`, graph.code === 0);
  const cdk = await run('npx', ['cdk', 'synth', '-q'], 'standalone-synth.log', process.env, consumer);
  rec.check(`cdk synth of UntrustedCodeSandboxes with standalone: true succeeds, runCodeFunction bundle included (exit ${cdk.code})`, cdk.code === 0);
}

/** The unit tests of the two-instance synth (spec §8 `synth`). */
export async function synthTests(rec: Recorder): Promise<void> {
  const r = await run('npx', ['jest', '--runTestsByPath', 'test/integ/synth.cdk.test.ts', '--coverage=false'], 'synth-tests.log', process.env, SAMPLE_DIR);
  rec.check(`the two-instance synth tests pass (exit ${r.code})`, r.code === 0);
}
