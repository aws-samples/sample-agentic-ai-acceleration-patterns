// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The scope-registration custom resource handler (ADR-0025). A backend owns
 * one or more scopes named `<backend>/<action>`; this handler puts them in
 * tenant-identity's scope catalogue through its platform API, signed with
 * SigV4 (`execute-api`, the stack's Region) by the function's own role, which
 * carries tenant-identity's published `PlatformInvokePolicy`:
 *
 * - Create: `PUT /platform/scopes/{scope}` for each scope. The call is
 *   idempotent create-or-replace on the identity side, so a retried Create
 *   is not a duplicate.
 * - Update: `PUT` every scope of the new list, then `DELETE` each scope of
 *   the old list that the new one no longer names.
 * - Delete: `DELETE /platform/scopes/{scope}` for each scope. The identity
 *   side answers 204 whether or not the scope exists.
 *
 * Create and Update fail the deployment when a call does not succeed: a
 * backend whose scopes the issuer does not know would refuse every token
 * (the registry entry depends on this resource, so it is never written in
 * that state). Delete is best effort: a scope left in the catalogue after
 * the API refused or could not be reached (tenant-identity torn down first)
 * is logged and the stack delete proceeds; tenant-identity tolerates a
 * catalogue entry no backend owns, and the next `PUT` of that name replaces
 * it. The PhysicalResourceId is fixed per backend, so a change of scopes is
 * an Update, never a replacement that would delete the scopes just put.
 *
 * The handler writes no log on success (its log group would otherwise be
 * recreated by a late line after the stack deleted it, ADR-0019), one error
 * line per failed call, and always answers CloudFormation.
 */

import * as https from 'node:https';
import { Sha256 } from '@aws-crypto/sha256-js';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { HttpRequest } from '@smithy/protocol-http';
import { SignatureV4 } from '@smithy/signature-v4';
import type { AwsCredentialIdentity, AwsCredentialIdentityProvider } from '@smithy/types';
import { errorName, log } from './logger';
import { isValidScopeName } from './registry';

/** The resource properties the construct writes. */
export interface ScopeRegistrationProperties {
  /** tenant-identity's API base URL (`/application-plane/shared/identity/apiUrl`), with or without a trailing slash. */
  readonly ApiUrl: string;
  /** The backend name; the PhysicalResourceId and the description of each scope. */
  readonly Backend: string;
  /** The scopes to register, each `<Backend>/<action>`. */
  readonly Scopes: string[];
  /** The custom-resource framework's own property; ignored. */
  readonly ServiceToken?: string;
}

export interface ScopeRegistrationEvent {
  readonly RequestType: 'Create' | 'Update' | 'Delete';
  readonly ResponseURL: string;
  readonly StackId: string;
  readonly RequestId: string;
  readonly LogicalResourceId: string;
  readonly PhysicalResourceId?: string;
  readonly ResourceProperties: ScopeRegistrationProperties;
  readonly OldResourceProperties?: ScopeRegistrationProperties;
}

export interface ScopeRegistrationOutcome {
  readonly status: 'SUCCESS' | 'FAILED';
  readonly physicalResourceId: string;
  readonly reason?: string;
}

/** One signed call to the platform API; injectable for tests. Resolves with the HTTP status, rejects on a transport error. */
export type PlatformCall = (method: 'PUT' | 'DELETE', url: URL, body?: string) => Promise<number>;

export interface ScopeRegistrationDependencies {
  readonly call: PlatformCall;
}

/** The route of one scope under the API base URL: `<base>/platform/scopes/<scope>`, the scope URL-encoded (its slash included). */
export function scopeUrl(apiUrl: string, scope: string): URL {
  const base = apiUrl.endsWith('/') ? apiUrl : `${apiUrl}/`;
  return new URL(`platform/scopes/${encodeURIComponent(scope)}`, base);
}

/** The catalogue route itself (`GET /platform/scopes`), for a reachability probe. */
export function catalogueUrl(apiUrl: string): URL {
  const base = apiUrl.endsWith('/') ? apiUrl : `${apiUrl}/`;
  return new URL('platform/scopes', base);
}

/** The PhysicalResourceId: fixed per backend, so changing the scope list is an Update. */
export function physicalId(backend: string): string {
  return `scope-registration:${backend}`;
}

/** The properties as a validated list of scopes, or the message to fail with. */
function scopesOf(properties: ScopeRegistrationProperties): string[] | string {
  if (typeof properties.ApiUrl !== 'string' || !/^https:\/\//.test(properties.ApiUrl)) {
    return 'ApiUrl must be an https URL';
  }
  if (typeof properties.Backend !== 'string' || properties.Backend.length === 0) {
    return 'Backend must be the backend name';
  }
  const scopes = properties.Scopes;
  if (!Array.isArray(scopes) || scopes.length === 0 || !scopes.every(isValidScopeName)) {
    return 'Scopes must be a non-empty list of scope names';
  }
  return scopes;
}

/** Registers every scope; the first failure ends the loop and names the scope (never the response body). */
async function putScopes(
  deps: ScopeRegistrationDependencies,
  properties: ScopeRegistrationProperties,
  scopes: readonly string[],
): Promise<string | undefined> {
  for (const scope of scopes) {
    const body = JSON.stringify({ description: `agentic-runtime-isolation backend ${properties.Backend} (ADR-0025)` });
    let status: number;
    try {
      status = await deps.call('PUT', scopeUrl(properties.ApiUrl, scope), body);
    } catch (error) {
      log.error('scope registration failed', { backend: properties.Backend, scope, error: errorName(error) });
      return `PUT /platform/scopes/${scope} failed: ${errorName(error)}`;
    }
    if (status < 200 || status >= 300) {
      log.error('scope registration refused', { backend: properties.Backend, scope, status });
      return `PUT /platform/scopes/${scope} returned HTTP ${status}`;
    }
  }
  return undefined;
}

/** Removes every scope, best effort: a failure is logged and the rest are still tried. 404 counts as removed. */
async function deleteScopes(deps: ScopeRegistrationDependencies, properties: ScopeRegistrationProperties, scopes: readonly string[]): Promise<void> {
  for (const scope of scopes) {
    try {
      const status = await deps.call('DELETE', scopeUrl(properties.ApiUrl, scope));
      if ((status < 200 || status >= 300) && status !== 404) {
        log.error('scope removal refused; scope left in the catalogue', { backend: properties.Backend, scope, status });
      }
    } catch (error) {
      log.error('scope removal failed; scope left in the catalogue', { backend: properties.Backend, scope, error: errorName(error) });
    }
  }
}

/**
 * Handles one event and returns what to tell CloudFormation. Create and
 * Update put the scopes (Update also deletes the ones dropped); Delete
 * removes them, best effort.
 */
export async function handleEvent(event: ScopeRegistrationEvent, deps: ScopeRegistrationDependencies): Promise<ScopeRegistrationOutcome> {
  const properties = event.ResourceProperties;
  const id = event.PhysicalResourceId ?? physicalId(typeof properties.Backend === 'string' ? properties.Backend : 'unknown');
  const scopes = scopesOf(properties);
  if (typeof scopes === 'string') {
    if (event.RequestType === 'Delete') {
      // Nothing valid to remove; do not block the stack delete.
      return { status: 'SUCCESS', physicalResourceId: id };
    }
    return { status: 'FAILED', physicalResourceId: id, reason: scopes };
  }

  if (event.RequestType === 'Delete') {
    await deleteScopes(deps, properties, scopes);
    return { status: 'SUCCESS', physicalResourceId: id };
  }

  const failure = await putScopes(deps, properties, scopes);
  if (failure !== undefined) {
    return { status: 'FAILED', physicalResourceId: id, reason: failure };
  }
  if (event.RequestType === 'Update') {
    const previous = event.OldResourceProperties?.Scopes;
    if (Array.isArray(previous)) {
      const dropped = previous.filter((s): s is string => isValidScopeName(s) && !scopes.includes(s));
      await deleteScopes(deps, properties, dropped);
    }
  }
  return { status: 'SUCCESS', physicalResourceId: id };
}

/**
 * The real platform call: SigV4 over `execute-api` in this Region with the
 * function's own credentials (the default provider chain; a test passes
 * fixed ones), sent with fetch. Only the status is read; the body is never
 * logged.
 */
export function signedPlatformCall(
  region: string,
  fetchImpl: typeof fetch = fetch,
  credentials: AwsCredentialIdentity | AwsCredentialIdentityProvider = fromNodeProviderChain(),
): PlatformCall {
  const signer = new SignatureV4({ service: 'execute-api', region, credentials, sha256: Sha256 });
  return async (method, url, body) => {
    const headers: Record<string, string> = { host: url.hostname };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
    }
    const request = new HttpRequest({
      protocol: url.protocol,
      hostname: url.hostname,
      method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      headers,
      body,
    });
    const signed = await signer.sign(request);
    const response = await fetchImpl(url.toString(), { method, headers: signed.headers as Record<string, string>, body });
    await response.arrayBuffer().catch(() => undefined);
    return response.status;
  };
}

/** Answers CloudFormation through the pre-signed ResponseURL; never throws (a lost answer stalls the stack for an hour). */
export function respond(
  event: ScopeRegistrationEvent,
  outcome: ScopeRegistrationOutcome,
  request: typeof https.request = https.request,
): Promise<void> {
  const body = JSON.stringify({
    Status: outcome.status,
    Reason: outcome.reason ?? 'See ADR-0025',
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

let defaults: ScopeRegistrationDependencies | undefined;

/** The Lambda entry point. */
export const handler = async (event: ScopeRegistrationEvent): Promise<void> => {
  let outcome: ScopeRegistrationOutcome;
  try {
    defaults ??= { call: signedPlatformCall(process.env.AWS_REGION ?? '') };
    outcome = await handleEvent(event, defaults);
  } catch (error) {
    log.error('scope registration handler failed', { error: errorName(error) });
    outcome = {
      status: 'FAILED',
      physicalResourceId: event.PhysicalResourceId ?? physicalId(event.ResourceProperties?.Backend ?? 'unknown'),
      reason: errorName(error),
    };
  }
  await respond(event, outcome);
};
