// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The AWS calls of the control-plane stress slice, through the AWS CLI (the sample carries
 * no SDK client for CloudFormation, IAM, SSM, Cognito or CloudWatch Logs, and a test asset
 * does not add one). Output is parsed in memory. A secret goes to the CLI on stdin
 * (`--cli-input-json file:///dev/stdin`), never in argv and never to disk, and an error
 * reports the command and the error name only, never the CLI's message.
 */

import { execFile } from 'node:child_process';

export interface AwsOptions {
  readonly profile?: string;
  readonly region?: string;
  /** JSON written to the CLI's stdin, for `--cli-input-json file:///dev/stdin`. */
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

/** Runs `aws <args> --output json` and returns the parsed output (`{}` for none). */
export function aws(args: readonly string[], opts: AwsOptions = {}): Promise<any> {
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
    if (opts.input !== undefined) {
      child.stdin?.end(JSON.stringify(opts.input));
    } else {
      child.stdin?.end();
    }
  });
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
