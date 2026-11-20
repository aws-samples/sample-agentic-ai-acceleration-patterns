// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * What the handlers wire up from the function environment (ADR-0032). Tests
 * pass their own `RunCodeDeps` and never reach this module.
 */

import { randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { BACKEND_NAMES, type BackendName, type SandboxBackend, type TenantCredentials } from '../backend';
import { AgentcoreBackend } from '../backends/agentcore';
import { MicrovmBackend } from '../backends/microvm';
import { NitroBackend } from '../backends/nitro';
import { newNonce } from '../protocol';
import { loadConfig, type ToolConfig } from './config';
import { stsCredentialSource, type CredentialSource } from './credentials';
import { Logger } from './log';
import { s3ObjectStore, type ObjectStore } from './objects';
import { Registry } from './registry';

export interface RunCodeDeps {
  readonly config: ToolConfig;
  readonly backends: ReadonlyMap<BackendName, SandboxBackend>;
  readonly credentials: CredentialSource;
  readonly registryFor: (creds: TenantCredentials) => Registry;
  readonly objectsFor: (creds: TenantCredentials) => ObjectStore;
  readonly log: Logger;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly newRunId: () => string;
  readonly newNonce: () => string;
  /** Interval between readiness probes while a call waits for a starting sandbox. */
  readonly pollMs: number;
}

/** The enabled backends' run-time classes, which read their own settings from the environment. */
export function loadBackends(config: ToolConfig, env: Readonly<Record<string, string | undefined>> = process.env): Map<BackendName, SandboxBackend> {
  const make: Record<BackendName, () => SandboxBackend> = {
    microvm: () => new MicrovmBackend(env),
    nitro: () => new NitroBackend(env),
    agentcore: () => new AgentcoreBackend(env),
  };
  return new Map(BACKEND_NAMES.filter((b) => config.backends.includes(b)).map((b) => [b, make[b]()]));
}

/** A registry client that signs with `creds`, or with the function's own role when none are given (reaper, drain, offboard). */
export function registryClient(table: string, creds?: TenantCredentials): Registry {
  const client = new DynamoDBClient(creds === undefined ? {} : {
    credentials: { accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey, sessionToken: creds.sessionToken },
  });
  return new Registry(DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } }), table);
}

let cached: RunCodeDeps | undefined;

/** The deps of this Lambda environment, built once from `process.env`. */
export function defaultDeps(): RunCodeDeps {
  if (cached !== undefined) return cached;
  const config = loadConfig();
  const registries = new WeakMap<TenantCredentials, Registry>();
  const objects = new WeakMap<TenantCredentials, ObjectStore>();
  cached = {
    config,
    backends: loadBackends(config),
    credentials: stsCredentialSource(config.toolTenantRoleArn),
    registryFor: (creds) => {
      let r = registries.get(creds);
      if (r === undefined) {
        r = registryClient(config.table, creds);
        registries.set(creds, r);
      }
      return r;
    },
    objectsFor: (creds) => {
      let o = objects.get(creds);
      if (o === undefined) {
        o = s3ObjectStore(config.bucket, creds);
        objects.set(creds, o);
      }
      return o;
    },
    log: new Logger(undefined, config.perTenantMetrics),
    now: Date.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    newRunId: randomUUID,
    newNonce,
    pollMs: 500,
  };
  return cached;
}
