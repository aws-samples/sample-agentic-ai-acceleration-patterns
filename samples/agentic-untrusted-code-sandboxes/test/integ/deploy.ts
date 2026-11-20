// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Deploy and destroy of the integration stack (ADR-0008: the CDK CLI drives
 * the test).
 *
 * The deploy runs `cdk deploy` as a child process with an argument list (no
 * shell). The destroy goes through the CloudFormation API, from the driver's
 * own `finally` and signal handlers, so it runs without a CLI or a wrapper
 * script. A stack delete through the API is the same operation the CLI's
 * destroy performs, so the `teardown` step still tests the consumer's path
 * (C-6).
 */

import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import * as path from 'node:path';
import { GetAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore-control';
import {
  DeleteStackCommand, DescribeStackEventsCommand, ListStackResourcesCommand, waitUntilStackDeleteComplete,
} from '@aws-sdk/client-cloudformation';
import { type Aws } from './aws';
import { stateDir, type OwnedResource } from './state';

/** The CDK app command: the integration app under ts-node, with the test tsconfig. */
export const APP_COMMAND = 'npx ts-node -P test/tsconfig.json --prefer-ts-exts test/integ.sandboxes.ts';
export const CLOUD_ASSEMBLY = 'cdk.integ.out';

/** Runs a command with an argument list; the combined output goes to a log file, and only its tail is returned. */
export function run(
  command: string, args: string[], logName: string, env: NodeJS.ProcessEnv = process.env, cwd?: string,
): Promise<{ code: number; tail: string; log: string }> {
  mkdirSync(stateDir(env), { recursive: true, mode: 0o700 });
  const log = path.join(stateDir(env), logName);
  const out = createWriteStream(log, { flags: 'w', mode: 0o600 });
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    const keep = (b: Buffer): void => {
      out.write(b);
      tail = (tail + b.toString('utf8')).slice(-4000);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('error', reject);
    child.on('close', (code) => {
      out.end();
      resolve({ code: code ?? 1, tail, log });
    });
  });
}

/** Synthesises the integration app into its own cloud assembly. */
export async function synth(prefix: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const r = await run('npx', ['cdk', 'synth', '-q', '--app', APP_COMMAND, '--output', CLOUD_ASSEMBLY], 'synth.log', { ...env, INTEG_PREFIX: prefix });
  if (r.code !== 0) throw new Error(`synth failed (log ${r.log}): ${r.tail.slice(-800)}`);
}

/** `cdk deploy --all`; the outputs file is read by the caller through the stack outputs, not from the log. */
export async function deployStacks(prefix: string, concurrency: number, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const r = await run('npx', [
    'cdk', 'deploy', '--all', '--app', APP_COMMAND, '--output', CLOUD_ASSEMBLY, '--require-approval', 'never',
    '--concurrency', String(concurrency),
  ], 'deploy.log', { ...env, INTEG_PREFIX: prefix });
  if (r.code !== 0) throw new Error(`deploy failed (log ${r.log}): ${r.tail.slice(-1200)}`);
}

/** Everything the stack owns now; the leftover check later looks for exactly these. */
export async function snapshotResources(aws: Aws, stackName: string): Promise<OwnedResource[]> {
  const out: OwnedResource[] = [];
  let token: string | undefined;
  do {
    const r = await aws.cfn.send(new ListStackResourcesCommand({ StackName: stackName, NextToken: token }));
    for (const s of r.StackResourceSummaries ?? []) {
      if (s.ResourceType && s.LogicalResourceId && s.PhysicalResourceId) {
        out.push({ type: s.ResourceType, logicalId: s.LogicalResourceId, physicalId: s.PhysicalResourceId });
      }
    }
    token = r.NextToken;
  } while (token);
  return out;
}

/** Runtime names and image names, which prefix the log groups AgentCore and Lambda create after the deploy. */
export async function serviceNames(aws: Aws, resources: readonly OwnedResource[]): Promise<{ runtimeNames: string[]; imageNames: string[] }> {
  const runtimeNames: string[] = [];
  for (const r of resources.filter((x) => x.type === 'AWS::BedrockAgentCore::Runtime')) {
    const g = await aws.agentcoreControl.send(new GetAgentRuntimeCommand({ agentRuntimeId: r.physicalId.split('/').pop() ?? r.physicalId })).catch(() => undefined);
    if (g?.agentRuntimeName) runtimeNames.push(g.agentRuntimeName);
  }
  const imageNames = resources.filter((x) => x.type === 'AWS::Lambda::MicrovmImage').map((x) => x.physicalId.split('/').pop() ?? x.physicalId).filter((n) => n !== '');
  return { runtimeNames, imageNames };
}

export interface DestroyResult {
  readonly ok: boolean;
  readonly status: string;
  /** FAILED resources with the first 200 characters of the reason, for the report. */
  readonly failures: string[];
}

/**
 * Deletes the stack through the CloudFormation API and waits (up to 60
 * minutes). A stack that does not exist is a success. On failure the failed
 * resources are listed, and one retry is made, since a drain or a service
 * delete that failed once usually passes the second time.
 */
export async function destroyStack(aws: Aws, stackName: string): Promise<DestroyResult> {
  let status = (await aws.stackStatus(stackName)) ?? 'DELETE_COMPLETE';
  for (let attempt = 0; attempt < 2 && status !== 'DELETE_COMPLETE'; attempt++) {
    await aws.cfn.send(new DeleteStackCommand({ StackName: stackName }));
    try {
      await waitUntilStackDeleteComplete({ client: aws.cfn, maxWaitTime: 3600 }, { StackName: stackName });
    } catch {
      // DELETE_FAILED or a timeout: the status read below decides, and the next pass retries once
    }
    status = (await aws.stackStatus(stackName)) ?? 'DELETE_COMPLETE';
  }
  if (status === 'DELETE_COMPLETE') return { ok: true, status, failures: [] };
  const failures: string[] = [];
  const events = await aws.cfn.send(new DescribeStackEventsCommand({ StackName: stackName }));
  for (const e of events.StackEvents ?? []) {
    if (e.ResourceStatus?.endsWith('_FAILED')) failures.push(`${e.LogicalResourceId}: ${(e.ResourceStatusReason ?? '').slice(0, 200)}`);
    if (failures.length >= 8) break;
  }
  return { ok: false, status, failures };
}
