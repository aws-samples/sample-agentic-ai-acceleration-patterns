// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The AWS calls of the control-plane stress slice, through the AWS CLI (the sample carries
 * no SDK client for CloudFormation, IAM, SSM, Cognito or CloudWatch Logs, and a test asset
 * does not add one). Output is parsed in memory. A secret goes to the CLI as input JSON in a
 * memory-backed file (`aws`, below), never in argv and never to disk, and an error
 * reports the command and the error name only, never the CLI's message.
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface AwsOptions {
  readonly profile?: string;
  readonly region?: string;
  /** JSON for `--cli-input-json`, for a value that must not reach argv (a password). */
  readonly input?: unknown;
}

export class AwsError extends Error {
  constructor(readonly command: string, readonly errorName: string) {
    super(`aws ${command} failed (${errorName})`);
  }
}

/** The error code in the CLI's stderr (`An error occurred (Code) when calling ...`), or a fixed word. */
export function errorNameOf(stderr: string): string {
  const m = /An error occurred \(([A-Za-z0-9.]+)\)/.exec(stderr);
  if (m !== null) return m[1];
  if (/does not exist/.test(stderr)) return 'NotFound';
  if (/Unable to locate credentials|ExpiredToken/.test(stderr)) return 'Credentials';
  return 'CliError';
}

/**
 * Runs `aws <args> --output json` and returns the parsed output (`{}` for none). With
 * `input`, the JSON reaches the CLI as `--cli-input-json file://<f>`, where `f` is a 0600
 * file in a 0700 folder on the memory-backed `/dev/shm` (the system temporary folder where
 * there is none), removed as soon as the CLI has exited. The CLI cannot read the JSON from
 * a pipe: it reads the file twice.
 */
export async function aws(args: readonly string[], opts: AwsOptions = {}): Promise<any> {
  if (opts.input === undefined) return awsOnce(args, opts);
  const base = fs.existsSync('/dev/shm') ? '/dev/shm' : os.tmpdir();
  const dir = fs.mkdtempSync(path.join(base, 'cp-stress-'));
  const file = path.join(dir, 'input.json');
  try {
    fs.writeFileSync(file, JSON.stringify(opts.input), { mode: 0o600 });
    return await awsOnce([...args, '--cli-input-json', `file://${file}`], { ...opts, input: undefined });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function awsOnce(args: readonly string[], opts: AwsOptions): Promise<any> {
  const full = [...args, '--output', 'json'];
  if (opts.profile !== undefined) full.push('--profile', opts.profile);
  if (opts.region !== undefined) full.push('--region', opts.region);
  const command = args.slice(0, 2).join(' ');
  return new Promise((resolve, reject) => {
    const child = execFile('aws', full, { maxBuffer: 256 * 1024 * 1024, env: { ...process.env, AWS_PAGER: '' } }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(new AwsError(command, errorNameOf(String(stderr))));
        return;
      }
      try {
        resolve(stdout.trim() === '' ? {} : JSON.parse(stdout));
      } catch {
        reject(new AwsError(command, 'NotJson'));
      }
    });
    child.stdin?.end();
  });
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
