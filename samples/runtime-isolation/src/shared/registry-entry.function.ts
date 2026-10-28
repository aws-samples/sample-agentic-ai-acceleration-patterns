// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The registry-entry custom resource handler (ADR-0024). One backend's stack
 * owns one SSM parameter, `${prefix}backends/<name>`, holding
 * `{ runtimeArn, requiredScopes, status }`:
 *
 * - Create and Update write the entry with `status: active`; the ingress
 *   serves the route within one registry TTL.
 * - Delete first writes `status: draining`, so the ingress refuses new
 *   requests (404) while running streams finish, waits `DrainSeconds` (one
 *   TTL plus the longest stream), then deletes the parameter. A plain
 *   `AWS::SSM::Parameter` would vanish at once on stack delete; this is the
 *   log-drain shape (ADR-0019) applied to the registry.
 *
 * The PhysicalResourceId is the parameter name, so a renamed backend is a
 * new entry followed by a drain of the old one. The handler writes no log on
 * success (its log group would otherwise be recreated by a late line after
 * the stack deleted it, ADR-0019) and one error line on failure. It always
 * answers CloudFormation, like the log drain's waiter.
 */

import * as https from 'node:https';
import { DeleteParameterCommand, ParameterNotFound, PutParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
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

async function put(ssm: SSMClient, name: string, entry: RegistryEntry): Promise<void> {
  await ssm.send(new PutParameterCommand({ Name: name, Type: 'String', Overwrite: true, Value: JSON.stringify(entry) }));
}

/**
 * Handles one event and returns what to tell CloudFormation. Create and
 * Update: write the active entry. Delete: write draining, wait, delete;
 * a parameter that is already gone is not an error.
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
    const drainSeconds = Number(properties.DrainSeconds);
    try {
      await put(deps.ssm, name, entryFrom(properties, 'draining'));
    } catch (error) {
      // A missing or malformed entry cannot be drained; still remove it below.
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
    await put(deps.ssm, name, entryFrom(properties, 'active'));
    return { status: 'SUCCESS', physicalResourceId: name };
  } catch (error) {
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
