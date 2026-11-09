// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The registry-entry custom resource handler (ADR-0024). One backend's stack
 * owns one SSM parameter, `${prefix}backends/<name>`, holding
 * `{ runtimeArn, needs, tools, version, status }` (v2, ADR-0032):
 *
 * - Create writes the entry with `status: active` and refuses to overwrite:
 *   two stacks claiming one backend name is a deploy-time failure naming
 *   the duplicate, not a silent takeover of the route. Update overwrites
 *   (the name is this stack's own). The ingress serves the route within one
 *   registry TTL.
 * - Delete first reads the entry and touches it only while its `runtimeArn`
 *   is this stack's Runtime: a different ARN means another stack owns the
 *   name now (a failed-then-rolled-back claim, or a backend moved between
 *   stacks), and deleting it would cut that backend's route. Then it writes
 *   `status: draining`, so the ingress refuses new requests (404) while
 *   running streams finish, waits `DrainSeconds` (one TTL plus the longest
 *   stream), then deletes the parameter. A plain `AWS::SSM::Parameter`
 *   would vanish at once on stack delete; this is the log-drain shape
 *   (ADR-0019) applied to the registry.
 *
 * The PhysicalResourceId is the parameter name, so a renamed backend is a
 * new entry followed by a drain of the old one. The handler writes no log on
 * success (its log group would otherwise be recreated by a late line after
 * the stack deleted it, ADR-0019) and one error line on failure. It always
 * answers CloudFormation, like the log drain's waiter.
 */

import * as https from 'node:https';
import {
  DeleteParameterCommand,
  GetParameterCommand,
  ParameterAlreadyExists,
  ParameterNotFound,
  PutParameterCommand,
  SSMClient,
} from '@aws-sdk/client-ssm';
import { errorName, log } from './logger';
import { parseRegistryEntry, type RegistryEntry } from './registry';

/** The resource properties the construct writes; CloudFormation delivers scalars as strings. */
export interface RegistryEntryProperties {
  readonly ParameterName: string;
  readonly RuntimeArn: string;
  readonly Needs?: string[];
  readonly Tools?: string[];
  /** (ADR-0048) The agents this agent may hand a transaction to; absent writes an empty list. */
  readonly DelegatesTo?: string[];
  readonly DrainSeconds: string | number;
  /** The custom-resource framework's own property; ignored. */
  readonly ServiceToken?: string;
}

export interface RegistryEntryEvent {
  readonly RequestType: 'Create' | 'Update' | 'Delete';
  readonly ResponseURL: string;
  readonly StackId: string;
  readonly RequestId: string;
  readonly LogicalResourceId: string;
  readonly PhysicalResourceId?: string;
  readonly ResourceProperties: RegistryEntryProperties;
  readonly OldResourceProperties?: RegistryEntryProperties;
}

export interface RegistryEntryOutcome {
  readonly status: 'SUCCESS' | 'FAILED';
  readonly physicalResourceId: string;
  readonly reason?: string;
}

export interface RegistryEntryDependencies {
  readonly ssm: SSMClient;
  /** Injectable for tests; the real one waits `ms` milliseconds. */
  readonly sleep: (ms: number) => Promise<void>;
}

/** The entry one request writes; validated with the same parser the ingress uses, so a bad value fails here, not at request time. */
function entryFrom(properties: RegistryEntryProperties, status: RegistryEntry['status'], version: number): RegistryEntry {
  return parseRegistryEntry(
    JSON.stringify({
      runtimeArn: properties.RuntimeArn,
      needs: properties.Needs ?? [],
      tools: properties.Tools ?? [],
      delegatesTo: properties.DelegatesTo ?? [],
      version,
      status,
    }),
  );
}

/**
 * The entry's current `version` (spec §4.3): 0 when the parameter is gone or
 * holds no readable version (a v1 entry), so the next write is version 1 or
 * one more than what is there.
 */
async function currentVersion(ssm: SSMClient, name: string): Promise<number> {
  return (await currentEntry(ssm, name))?.version ?? 0;
}

/** Writes the entry; `overwrite: false` lets SSM refuse a name another stack already holds. */
async function put(ssm: SSMClient, name: string, entry: RegistryEntry, overwrite: boolean): Promise<void> {
  await ssm.send(new PutParameterCommand({ Name: name, Type: 'String', Overwrite: overwrite, Value: JSON.stringify(entry) }));
}

/**
 * The `runtimeArn` and `version` the entry currently holds: undefined when
 * the parameter is gone; `runtimeArn` null when its value is not an entry
 * (nothing can be routing through it, so the owner cannot be told and it is
 * treated as ours).
 */
async function currentEntry(ssm: SSMClient, name: string): Promise<{ runtimeArn: string | null; version: number } | undefined> {
  let raw: string;
  try {
    const current = await ssm.send(new GetParameterCommand({ Name: name }));
    raw = current.Parameter?.Value ?? '';
  } catch (error) {
    if (error instanceof ParameterNotFound) {
      return undefined;
    }
    throw error;
  }
  try {
    const value = JSON.parse(raw) as unknown;
    const record = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
    const version = typeof record.version === 'number' && Number.isInteger(record.version) && record.version > 0 ? record.version : 0;
    return { runtimeArn: typeof record.runtimeArn === 'string' ? record.runtimeArn : null, version };
  } catch {
    return { runtimeArn: null, version: 0 };
  }
}

/**
 * Handles one event and returns what to tell CloudFormation. Create: write
 * the active entry without overwrite (a held name fails the deploy). Update:
 * overwrite it. Delete: read, and if the entry is still this Runtime's,
 * write draining, wait, delete; a parameter that is already gone, or that
 * another stack has since claimed, is left alone and is not an error.
 */
export async function handleEvent(event: RegistryEntryEvent, deps: RegistryEntryDependencies): Promise<RegistryEntryOutcome> {
  const properties = event.ResourceProperties;
  const name = properties.ParameterName;
  if (typeof name !== 'string' || !name.startsWith('/')) {
    return {
      status: 'FAILED',
      physicalResourceId: event.PhysicalResourceId ?? 'registry-entry',
      reason: 'ParameterName must be an absolute SSM parameter name',
    };
  }

  if (event.RequestType === 'Delete') {
    let current: { runtimeArn: string | null; version: number } | undefined;
    try {
      current = await currentEntry(deps.ssm, name);
    } catch (error) {
      log.error('registry entry read failed', { parameter: name, error: errorName(error) });
      return { status: 'FAILED', physicalResourceId: name, reason: `GetParameter failed: ${errorName(error)}` };
    }
    if (current === undefined) {
      return { status: 'SUCCESS', physicalResourceId: name };
    }
    if (current.runtimeArn !== null && current.runtimeArn !== properties.RuntimeArn) {
      // Another stack holds the name now; its route must keep working.
      log.warn('registry entry owned by another Runtime; left in place', { parameter: name });
      return { status: 'SUCCESS', physicalResourceId: name };
    }
    const drainSeconds = Number(properties.DrainSeconds);
    try {
      await put(deps.ssm, name, entryFrom(properties, 'draining', Math.max(1, current.version)), true);
    } catch (error) {
      // A malformed entry cannot be drained; still remove it below.
      log.error('registry entry drain write failed', { parameter: name, error: errorName(error) });
    }
    if (Number.isFinite(drainSeconds) && drainSeconds > 0) {
      await deps.sleep(drainSeconds * 1000);
    }
    try {
      await deps.ssm.send(new DeleteParameterCommand({ Name: name }));
    } catch (error) {
      if (!(error instanceof ParameterNotFound)) {
        log.error('registry entry delete failed', { parameter: name, error: errorName(error) });
        return { status: 'FAILED', physicalResourceId: name, reason: `DeleteParameter failed: ${errorName(error)}` };
      }
    }
    return { status: 'SUCCESS', physicalResourceId: name };
  }

  try {
    // Create writes version 1; Update bumps it, so the mint cache key changes
    // and the next request mints the new grant (ADR-0036).
    const version = event.RequestType === 'Update' ? (await currentVersion(deps.ssm, name)) + 1 : 1;
    await put(deps.ssm, name, entryFrom(properties, 'active', version), event.RequestType === 'Update');
    return { status: 'SUCCESS', physicalResourceId: name };
  } catch (error) {
    if (error instanceof ParameterAlreadyExists) {
      // A name already held by THIS Runtime is a retried Create (a lost
      // CloudFormation answer, a rolled-back stack): reclaim it. Any other
      // owner is a duplicate name, a configuration error, not a fault of
      // this function; no log, the reason reaches the deployer through
      // CloudFormation.
      try {
        const held = await currentEntry(deps.ssm, name);
        if (held?.runtimeArn === properties.RuntimeArn) {
          await put(deps.ssm, name, entryFrom(properties, 'active', held.version + 1), true);
          return { status: 'SUCCESS', physicalResourceId: name };
        }
      } catch (readError) {
        log.error('registry entry read failed', { parameter: name, error: errorName(readError) });
        return { status: 'FAILED', physicalResourceId: name, reason: `GetParameter failed: ${errorName(readError)}` };
      }
      return {
        status: 'FAILED',
        physicalResourceId: name,
        reason: `backend name is already registered at ${name}; another stack owns it (choose another name or delete that backend first)`,
      };
    }
    log.error('registry entry write failed', { parameter: name, error: errorName(error) });
    return { status: 'FAILED', physicalResourceId: name, reason: `PutParameter failed: ${errorName(error)}` };
  }
}

/** Answers CloudFormation through the pre-signed ResponseURL; never throws (a lost answer stalls the stack for an hour). */
export function respond(event: RegistryEntryEvent, outcome: RegistryEntryOutcome, request: typeof https.request = https.request): Promise<void> {
  const body = JSON.stringify({
    Status: outcome.status,
    Reason: outcome.reason ?? 'See ADR-0024',
    PhysicalResourceId: outcome.physicalResourceId,
    StackId: event.StackId,
    RequestId: event.RequestId,
    LogicalResourceId: event.LogicalResourceId,
  });
  const url = new URL(event.ResponseURL);
  return new Promise((resolve) => {
    const req = request(
      {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: 'PUT',
        headers: { 'content-type': '', 'content-length': Buffer.byteLength(body) },
      },
      (res) => {
        res.resume();
        res.on('end', resolve);
      },
    );
    req.on('error', () => resolve());
    req.end(body);
  });
}

const defaults: RegistryEntryDependencies = {
  // Parameter Store allows 3 PutParameter / DeleteParameter per second per account and
  // Region (ADR-0042): retry a throttled write with backoff instead of failing the stack.
  ssm: new SSMClient({ retryMode: 'adaptive', maxAttempts: 8 }),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** The Lambda entry point. */
export const handler = async (event: RegistryEntryEvent): Promise<void> => {
  let outcome: RegistryEntryOutcome;
  try {
    outcome = await handleEvent(event, defaults);
  } catch (error) {
    log.error('registry entry handler failed', { error: errorName(error) });
    outcome = {
      status: 'FAILED',
      physicalResourceId: event.PhysicalResourceId ?? event.ResourceProperties?.ParameterName ?? 'registry-entry',
      reason: errorName(error),
    };
  }
  await respond(event, outcome);
};
