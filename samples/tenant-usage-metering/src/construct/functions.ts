// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * One shape for every function of the construct: Node 24 on ARM, bundled
 * with esbuild (no Docker), the JSON log format, its own `DESTROY` log
 * group, and the role spec §3.5 names for it. The role is passed in, so CDK
 * adds no managed policy; the role gets write access to its log group and
 * nothing else here.
 */

import * as path from 'node:path';
import { type Duration, RemovalPolicy } from 'aws-cdk-lib';
import type * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';

const SRC_ROOT = path.join(__dirname, '..');

export interface FunctionOptions {
  /** Path under src/. */
  readonly entry: string;
  readonly handler?: string;
  readonly role: iam.IRole;
  readonly timeout: Duration;
  readonly memorySize?: number;
  readonly environment: Record<string, string>;
  readonly logRetention: logs.RetentionDays;
  readonly description: string;
  readonly reservedConcurrentExecutions?: number;
}

export function createFunction(scope: Construct, id: string, options: FunctionOptions): NodejsFunction {
  const logGroup = new logs.LogGroup(scope, `${id}Logs`, {
    retention: options.logRetention,
    removalPolicy: RemovalPolicy.DESTROY, // sample only
  });
  const fn = new NodejsFunction(scope, id, {
    entry: path.join(SRC_ROOT, options.entry),
    handler: options.handler ?? 'handler',
    runtime: lambda.Runtime.NODEJS_24_X,
    architecture: lambda.Architecture.ARM_64,
    memorySize: options.memorySize ?? 256,
    timeout: options.timeout,
    role: options.role,
    logGroup,
    loggingFormat: lambda.LoggingFormat.JSON,
    environment: options.environment,
    description: options.description,
    reservedConcurrentExecutions: options.reservedConcurrentExecutions,
    bundling: {
      minify: true,
      sourceMap: false,
      externalModules: [],
      // The Smithy SSDK validates `@pattern` with re2-wasm, which loads
      // `re2.wasm` from `__dirname` at init; esbuild inlines the JavaScript
      // but not the .wasm file (tenant-encrypted-ingestion ADR-0024).
      commandHooks: {
        beforeBundling: () => [],
        beforeInstall: () => [],
        afterBundling: (inputDir: string, outputDir: string) => [
          `cp "${path.join(inputDir, 'node_modules', 're2-wasm', 'build', 'wasm', 're2.wasm')}" "${outputDir}/re2.wasm"`,
        ],
      },
    },
  });
  logGroup.grantWrite(options.role);
  return fn;
}
