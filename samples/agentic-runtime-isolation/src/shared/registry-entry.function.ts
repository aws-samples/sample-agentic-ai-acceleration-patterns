// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The registry-entry custom resource handler (ADR-0024). One backend's stack
 * owns one SSM parameter, `${prefix}backends/<name>`, holding
 * `{ runtimeArn, requiredScopes, status }`:
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
  readonly RequiredScopes?: string[];
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
function entryFrom(properties: RegistryEntryProperties, status: RegistryEntry['status']): RegistryEntry {
  return parseRegistryEntry(
    JSON.stringify({ runtimeArn: properties.RuntimeArn, requiredScopes: properties.RequiredScopes ?? [], status }),
  );
}

/** Writes the entry; `overwrite: false` lets SSM refuse a name another stack already holds. */
async function put(ssm: SSMClient, name: string, entry: RegistryEntry, overwrite: boolean): Promise<void> {
  await ssm.send(new PutParameterCommand({ Name: name, Type: 'String', Overwrite: overwrite, Value: JSON.stringify(entry) }));
}

/**
 * The `runtimeArn` the entry currently holds: undefined when the parameter
 * is gone, null when its value is not an entry (nothing can be routing
 * through it, so the owner cannot be told and it is treated as ours).
 */
async function currentRuntimeArn(ssm: SSMClient, name: string): Promise<string | null | undefined> {
  try {
    const current = await ssm.send(new GetParameterCommand({ Name: name }));
    const value: unknown = JSON.parse(current.Parameter?.Value ?? '');
    const arn = typeof value === 'object' && value !== null ? (value as Record<string, unknown>).runtimeArn : undefined;
    return typeof arn === 'string' ? arn : null;
  } catch (error) {
    if (error instanceof ParameterNotFound) {
      return undefined;
    }
    if (error instanceof SyntaxError) {
      return null;
    }
    throw error;
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
    let current: string | null | undefined;
    try {
      current = await currentRuntimeArn(deps.ssm, name);
    } catch (error) {
      log.error('registry entry read failed', { parameter: name, error: errorName(error) });
      return { status: 'FAILED', physicalResourceId: name, reason: `GetParameter failed: ${errorName(error)}` };
    }
    if (current === undefined) {
      return { status: 'SUCCESS', physicalResourceId: name };
    }
    if (current !== null && current !== properties.RuntimeArn) {
      // Another stack holds the name now; its route must keep working.
      log.warn('registry entry owned by another Runtime; left in place', { parameter: name });
      return { status: 'SUCCESS', physicalResourceId: name };
    }
    const drainSeconds = Number(properties.DrainSeconds);
    try {
      await put(deps.ssm, name, entryFrom(properties, 'draining'), true);
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
    await put(deps.ssm, name, entryFrom(properties, 'active'), event.RequestType === 'Update');
    return { status: 'SUCCESS', physicalResourceId: name };
  } catch (error) {
    if (error instanceof ParameterAlreadyExists) {
      // A name already held by THIS Runtime is a retried Create (a lost
      // CloudFormation answer, a rolled-back stack): reclaim it. Any other
      // owner is a duplicate name, a configuration error, not a fault of
      // this function; no log, the reason reaches the deployer through
      // CloudFormation.
      try {
        if ((await currentRuntimeArn(deps.ssm, name)) === properties.RuntimeArn) {
          await put(deps.ssm, name, entryFrom(properties, 'active'), true);
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
  ssm: new SSMClient({}),
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
