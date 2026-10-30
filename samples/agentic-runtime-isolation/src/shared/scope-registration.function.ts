// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The scope-registration custom resource handler (ADR-0025). A backend owns
 * one or more scopes named `<backend>/<action>`; this handler puts them in
 * tenant-identity's scope catalogue through its platform API, signed with
 * SigV4 (`execute-api`, the stack's Region) by the function's own role, which
 * carries tenant-identity's published `PlatformInvokePolicy`:
 *
 * - Create: `GET /platform/scopes/{scope}` for each scope first. A scope
 *   already in the catalogue whose description is another resource's owner
 *   marker (below) fails the Create: a second stack with the same backend
 *   name must not take the scopes over. Then `PUT /platform/scopes/{scope}`
 *   for each scope. The call is idempotent create-or-replace on the identity
 *   side, so a retried Create is not a duplicate.
 * - Update: `PUT` every scope of the new list (a scope the old list did not
 *   have is owner-checked like a Create), then `DELETE` each scope of the
 *   old list that the new one no longer names. A change of `Backend` returns
 *   the new PhysicalResourceId, so CloudFormation sends a Delete for the old
 *   one and the old backend's scopes go with it.
 * - Delete: `GET` each scope first; `DELETE /platform/scopes/{scope}` only
 *   when its description is this resource's own marker. A scope another
 *   resource owns, or whose owner cannot be read, is left in place.
 *
 * The owner marker is the scope's `description` (`GetScope` returns it): the
 * `Owner` property when the construct passes one, else
 * `<StackId>#<LogicalResourceId>` of the resource that put it. Two resources
 * that would both put `billing/read` therefore see each other, which the
 * fixed-per-backend PhysicalResourceId alone cannot tell apart. Resources
 * given the same `Owner` co-own the names: each passes the check, and the
 * first one deleted removes the scopes for all of them (`AgentBackend.scopeOwner`).
 *
 * Create and Update fail the deployment when a call does not succeed: a
 * backend whose scopes the issuer does not know would refuse every token
 * (the registry entry depends on this resource, so it is never written in
 * that state). A Create refused because another stack owns a scope answers
 * the PhysicalResourceId `scope-registration:<backend>:unclaimed`, and the
 * Delete of the rollback, which carries that id, removes nothing: the
 * scopes were never this resource's. Delete is otherwise best effort: a
 * scope left in the catalogue after the API refused or could not be reached
 * (tenant-identity torn down first) is logged and the stack delete
 * proceeds; tenant-identity tolerates a catalogue entry no backend owns,
 * and the next `PUT` of that name replaces it. The PhysicalResourceId is
 * fixed per backend, so a change of scopes is an Update, never a
 * replacement that would delete the scopes just put.
 *
 * The handler re-validates the properties' shape (an `Owner`, when given, is
 * a non-empty string of at most 256 characters) and that every scope is
 * `<Backend>/<action>` (`backendScopesProblem`): a direct invoke cannot pass
 * a list whose names belong to a different owner than the `Backend` it
 * names. It does not stop a direct invoker from choosing any `Backend`:
 * whoever can invoke the function (or run code as its role, which the
 * `PlatformInvokePolicy` lets reach the whole catalogue) can register or
 * remove any backend's scopes (threat model T-41). The owner marker guards
 * against a second stack, not against that invoker.
 *
 * Every platform call is bounded (10 s per attempt, one retry after a short
 * backoff on 429, 5xx or a transport error), and the whole event is raced
 * against the function's remaining time so CloudFormation always gets an
 * answer before Lambda kills the invocation (an unanswered event stalls the
 * stack for an hour).
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
import { backendScopesProblem, isValidScopeName, scopeOwner } from './registry';

/** The resource properties the construct writes. */
export interface ScopeRegistrationProperties {
  /** tenant-identity's API base URL (`/application-plane/shared/identity/apiUrl`), with or without a trailing slash. */
  readonly ApiUrl: string;
  /** The backend name; the PhysicalResourceId and the description of each scope. */
  readonly Backend: string;
  /** The scopes to register, each `<Backend>/<action>`. */
  readonly Scopes: string[];
  /** An explicit owner marker (1 to 256 characters); absent, the marker is `<StackId>#<LogicalResourceId>`. */
  readonly Owner?: string;
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

export type PlatformMethod = 'GET' | 'PUT' | 'DELETE';

/** What one platform call answered: the status, and the body text (read for a GET only; never logged). */
export interface PlatformResponse {
  readonly status: number;
  readonly body?: string;
}

/** One signed call to the platform API; injectable for tests. Resolves with the response, rejects on a transport error. */
export type PlatformCall = (method: PlatformMethod, url: URL, body?: string) => Promise<PlatformResponse>;

export interface ScopeRegistrationDependencies {
  readonly call: PlatformCall;
  /** The function's Region (`AWS_REGION`): the API URL must be an API Gateway URL in it. */
  readonly region: string;
}

/** Per-attempt bound on one platform call. */
export const CALL_TIMEOUT_MS = 10_000;
/** The backoff before the one retry of a 429, 5xx or transport failure. */
export const RETRY_DELAY_MS = 1_000;
/** How long before Lambda's deadline the handler gives up and answers FAILED. */
export const DEADLINE_MARGIN_MS = 2_000;

/** The route of one scope under the API base URL: `<base>/platform/scopes/<scope>`, the scope URL-encoded (its slash included). */
export function scopeUrl(apiUrl: string, scope: string): URL {
  const base = apiUrl.endsWith('/') ? apiUrl : `${apiUrl}/`;
  return new URL(`platform/scopes/${encodeURIComponent(scope)}`, base);
}

/** The PhysicalResourceId: fixed per backend, so changing the scope list is an Update. */
export function physicalId(backend: string): string {
  return `scope-registration:${backend}`;
}

/** The suffix of the PhysicalResourceId a refused Create answers: its rollback Delete must remove nothing. */
export const UNCLAIMED_SUFFIX = ':unclaimed';

/** The PhysicalResourceId of a Create that found the scopes owned by another stack. */
export function unclaimedId(backend: string): string {
  return `${physicalId(backend)}${UNCLAIMED_SUFFIX}`;
}

/** The longest `Owner` property: PutScope's description holds 256 characters. */
export const OWNER_MAX_LENGTH = 256;

/**
 * The owner marker this resource writes as each scope's description, and
 * reads back to recognise its own scopes: the `Owner` property when given
 * (already validated by `ownerProblem`), else `<StackId>#<LogicalResourceId>`.
 * (PutScope's description is at most 256 characters; a stack ARN plus a
 * logical id stays well under that for any name CDK generates.)
 */
export function ownerMarker(event: Pick<ScopeRegistrationEvent, 'StackId' | 'LogicalResourceId'>, properties?: Pick<ScopeRegistrationProperties, 'Owner'>): string {
  const owner = properties?.Owner;
  if (typeof owner === 'string' && owner.length > 0 && owner.length <= OWNER_MAX_LENGTH) {
    return owner;
  }
  return `${event.StackId}#${event.LogicalResourceId}`;
}

/** Why the `Owner` property is refused, or undefined when absent or acceptable. */
export function ownerProblem(owner: unknown): string | undefined {
  if (owner === undefined) {
    return undefined;
  }
  if (typeof owner !== 'string' || owner.length === 0) {
    return 'Owner must be a non-empty string when given';
  }
  if (owner.length > OWNER_MAX_LENGTH) {
    return `Owner must be at most ${OWNER_MAX_LENGTH} characters`;
  }
  return undefined;
}

/** The description the handler wrote before the owner marker existed; a Delete still recognises it as its own. */
function legacyMarker(backend: string): string {
  return `agentic-runtime-isolation backend ${backend} (ADR-0025)`;
}

/** The API Gateway host pattern the ApiUrl must match: `<api>.execute-api.<region>.amazonaws.com`. */
export function isApiGatewayHost(hostname: string, region: string): boolean {
  return region.length > 0 && hostname.endsWith(`.execute-api.${region}.amazonaws.com`) && hostname.length > `.execute-api.${region}.amazonaws.com`.length;
}

/** The properties as a validated list of scopes, or the message to fail with. */
function scopesOf(properties: ScopeRegistrationProperties, region: string): string[] | string {
  if (typeof properties.ApiUrl !== 'string' || !/^https:\/\//.test(properties.ApiUrl)) {
    return 'ApiUrl must be an https URL';
  }
  let hostname: string;
  try {
    hostname = new URL(properties.ApiUrl).hostname;
  } catch {
    return 'ApiUrl must be an https URL';
  }
  // The role's SigV4 signature for `execute-api` in this Region is only ever
  // sent to an API Gateway endpoint in this Region (threat model T-41: a
  // direct invoker cannot point the function at a host of their choosing).
  if (!isApiGatewayHost(hostname, region)) {
    return `ApiUrl must be an API Gateway URL in ${region || 'this Region'} (<api>.execute-api.${region || '<region>'}.amazonaws.com)`;
  }
  if (typeof properties.Backend !== 'string' || properties.Backend.length === 0) {
    return 'Backend must be the backend name';
  }
  const scopes = properties.Scopes;
  if (!Array.isArray(scopes)) {
    return 'Scopes must be a list of scope names';
  }
  // The construct's own rule (at least one, no duplicates, each a valid name
  // owned by Backend), applied again here: a direct invoke of the function
  // bypasses the construct. This ties the names to the Backend the event
  // names; it does not stop the invoker from naming any Backend (T-41).
  const problem = backendScopesProblem(properties.Backend, scopes);
  if (problem !== undefined) {
    return `Scopes ${problem}`;
  }
  const owner = ownerProblem(properties.Owner);
  if (owner !== undefined) {
    return owner;
  }
  return scopes;
}

/** What the catalogue holds for a scope: absent, present with its description, or unreadable (the reason names the call, never the body). */
type ScopeOwner = { readonly kind: 'absent' } | { readonly kind: 'present'; readonly description?: string } | { readonly kind: 'error'; readonly reason: string };

async function currentOwner(deps: ScopeRegistrationDependencies, properties: ScopeRegistrationProperties, scope: string): Promise<ScopeOwner> {
  let response: PlatformResponse;
  try {
    response = await deps.call('GET', scopeUrl(properties.ApiUrl, scope));
  } catch (error) {
    log.error('scope lookup failed', { backend: properties.Backend, scope, error: errorName(error) });
    return { kind: 'error', reason: `GET /platform/scopes/${scope} failed: ${errorName(error)}` };
  }
  if (response.status === 404) {
    return { kind: 'absent' };
  }
  if (response.status < 200 || response.status >= 300) {
    log.error('scope lookup refused', { backend: properties.Backend, scope, status: response.status });
    return { kind: 'error', reason: `GET /platform/scopes/${scope} returned HTTP ${response.status}` };
  }
  let description: unknown;
  try {
    const parsed = JSON.parse(response.body ?? '') as { scope?: { description?: unknown } };
    description = parsed?.scope?.description;
  } catch {
    description = undefined;
  }
  return { kind: 'present', description: typeof description === 'string' ? description : undefined };
}

/**
 * Fails when a scope is already in the catalogue under a marker that is not
 * this resource's own (a retried Create finds its own marker and goes on).
 * Returns the reason, or undefined when every scope is free or ours.
 */
async function foreignOwnerProblem(
  deps: ScopeRegistrationDependencies,
  properties: ScopeRegistrationProperties,
  scopes: readonly string[],
  marker: string,
): Promise<{ readonly reason: string; readonly foreign: boolean } | undefined> {
  for (const scope of scopes) {
    const owner = await currentOwner(deps, properties, scope);
    if (owner.kind === 'error') {
      return { reason: owner.reason, foreign: false };
    }
    if (owner.kind === 'present' && owner.description !== marker) {
      log.error('scope already registered by another stack', { backend: properties.Backend, scope });
      return { reason: `scope ${scope} already registered by another stack; is another backend named ${properties.Backend} deployed?`, foreign: true };
    }
  }
  return undefined;
}

/** Registers every scope with the owner marker as its description; the first failure ends the loop and names the scope (never the response body). */
async function putScopes(
  deps: ScopeRegistrationDependencies,
  properties: ScopeRegistrationProperties,
  scopes: readonly string[],
  marker: string,
): Promise<string | undefined> {
  for (const scope of scopes) {
    const body = JSON.stringify({ description: marker });
    let response: PlatformResponse;
    try {
      response = await deps.call('PUT', scopeUrl(properties.ApiUrl, scope), body);
    } catch (error) {
      log.error('scope registration failed', { backend: properties.Backend, scope, error: errorName(error) });
      return `PUT /platform/scopes/${scope} failed: ${errorName(error)}`;
    }
    if (response.status < 200 || response.status >= 300) {
      log.error('scope registration refused', { backend: properties.Backend, scope, status: response.status });
      return `PUT /platform/scopes/${scope} returned HTTP ${response.status}`;
    }
  }
  return undefined;
}

/**
 * Removes every scope this resource owns, best effort: a scope whose
 * description is another owner's marker, or whose owner cannot be read, is
 * left in the catalogue (logged); a failed DELETE is logged and the rest
 * are still tried. 404 counts as removed.
 */
async function deleteScopes(
  deps: ScopeRegistrationDependencies,
  properties: ScopeRegistrationProperties,
  scopes: readonly string[],
  marker: string,
): Promise<void> {
  const own = new Set([marker, legacyMarker(properties.Backend)]);
  for (const scope of scopes) {
    const owner = await currentOwner(deps, properties, scope);
    if (owner.kind === 'absent') {
      continue;
    }
    if (owner.kind === 'error') {
      // currentOwner logged the call; the scope stays rather than risk removing another stack's.
      continue;
    }
    if (owner.description === undefined || !own.has(owner.description)) {
      log.error('scope owned by another stack; left in the catalogue', { backend: properties.Backend, scope });
      continue;
    }
    try {
      const response = await deps.call('DELETE', scopeUrl(properties.ApiUrl, scope));
      if ((response.status < 200 || response.status >= 300) && response.status !== 404) {
        log.error('scope removal refused; scope left in the catalogue', { backend: properties.Backend, scope, status: response.status });
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
  const backend = typeof properties.Backend === 'string' ? properties.Backend : 'unknown';
  const id = event.PhysicalResourceId ?? physicalId(backend);
  const marker = ownerMarker(event, properties);

  if (event.RequestType === 'Delete' && id.endsWith(UNCLAIMED_SUFFIX)) {
    // The rollback of a Create that found the scopes owned by another stack: nothing of ours to remove.
    return { status: 'SUCCESS', physicalResourceId: id };
  }

  const scopes = scopesOf(properties, deps.region);
  if (typeof scopes === 'string') {
    if (event.RequestType === 'Delete') {
      // Nothing valid to remove; do not block the stack delete.
      return { status: 'SUCCESS', physicalResourceId: id };
    }
    return { status: 'FAILED', physicalResourceId: id, reason: scopes };
  }

  if (event.RequestType === 'Delete') {
    await deleteScopes(deps, properties, scopes, marker);
    return { status: 'SUCCESS', physicalResourceId: id };
  }

  // An Update that changes Backend answers the new id (fixed per backend):
  // CloudFormation then sends a Delete for the old id with the old
  // properties, which removes the old backend's scopes. The old list is only
  // reconciled below when the backend stays the same.
  const previous = event.OldResourceProperties;
  const sameBackend = event.RequestType === 'Create' || previous === undefined || previous.Backend === properties.Backend;
  const resultId = event.RequestType === 'Update' && !sameBackend ? physicalId(properties.Backend) : id;

  // Create checks every scope; Update checks the ones it adds (the ones it
  // kept were owner-checked when they were added).
  const previousScopes = sameBackend && Array.isArray(previous?.Scopes) ? previous.Scopes : [];
  const toCheck = event.RequestType === 'Create' ? scopes : scopes.filter((s) => !previousScopes.includes(s));
  const foreign = await foreignOwnerProblem(deps, properties, toCheck, marker);
  if (foreign !== undefined) {
    return {
      status: 'FAILED',
      // A Create whose scopes belong to another stack must not have its rollback Delete remove them.
      physicalResourceId: event.RequestType === 'Create' && foreign.foreign ? unclaimedId(properties.Backend) : id,
      reason: foreign.reason,
    };
  }

  const failure = await putScopes(deps, properties, scopes, marker);
  if (failure !== undefined) {
    return { status: 'FAILED', physicalResourceId: id, reason: failure };
  }
  if (event.RequestType === 'Update' && sameBackend) {
    const dropped = previousScopes.filter((s): s is string => isValidScopeName(s) && scopeOwner(s) === properties.Backend && !scopes.includes(s));
    await deleteScopes(deps, properties, dropped, marker);
  }
  return { status: 'SUCCESS', physicalResourceId: resultId };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A status worth one retry: throttled or a server-side failure. */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * The real platform call: SigV4 over `execute-api` in this Region with the
 * function's own credentials (the default provider chain; a test passes
 * fixed ones), sent with fetch. Each attempt is bounded by
 * `AbortSignal.timeout(CALL_TIMEOUT_MS)`; a 429, a 5xx or a transport
 * error (the timeout included) is retried once after `retryDelayMs`. The
 * body is read for a GET only (the owner check parses it) and never logged.
 */
export function signedPlatformCall(
  region: string,
  fetchImpl: typeof fetch = fetch,
  credentials: AwsCredentialIdentity | AwsCredentialIdentityProvider = fromNodeProviderChain(),
  retryDelayMs: number = RETRY_DELAY_MS,
): PlatformCall {
  const signer = new SignatureV4({ service: 'execute-api', region, credentials, sha256: Sha256 });
  const attempt = async (method: PlatformMethod, url: URL, body?: string): Promise<PlatformResponse> => {
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
    const response = await fetchImpl(url.toString(), {
      method,
      headers: signed.headers as Record<string, string>,
      body,
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    if (method === 'GET') {
      const text = await response.text().catch(() => undefined);
      return { status: response.status, body: text };
    }
    await response.arrayBuffer().catch(() => undefined);
    return { status: response.status };
  };
  return async (method, url, body) => {
    let first: PlatformResponse | undefined;
    try {
      first = await attempt(method, url, body);
      if (!isRetryableStatus(first.status)) {
        return first;
      }
    } catch (error) {
      log.error('platform call failed; retrying once', { method, error: errorName(error) });
    }
    await sleep(retryDelayMs);
    try {
      return await attempt(method, url, body);
    } catch (error) {
      if (first !== undefined) {
        // The first answer (throttled or 5xx) is more telling than the retry's transport failure.
        log.error('platform call retry failed', { method, error: errorName(error) });
        return first;
      }
      throw error;
    }
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

/** The part of Lambda's context the handler reads. */
export interface HandlerContext {
  getRemainingTimeInMillis(): number;
}

/** What the entry point is built from; a test passes stubs. */
export interface HandlerOptions {
  /** The platform call; default: `signedPlatformCall(AWS_REGION)`, built on first use. */
  readonly call?: PlatformCall;
  /** The Region; default: `AWS_REGION`. */
  readonly region?: string;
  /** The CloudFormation answer; default: `respond`. */
  readonly respond?: (event: ScopeRegistrationEvent, outcome: ScopeRegistrationOutcome) => Promise<void>;
}

/** The outcome when the handler ran out of time: always an answer, so the stack does not wait for Lambda's timeout. */
class HandlerTimeout extends Error {
  constructor() {
    super('scope registration ran out of time');
    this.name = 'HandlerTimeout';
  }
}

/**
 * Builds the Lambda entry point. The event is raced against the remaining
 * time (`context.getRemainingTimeInMillis() - DEADLINE_MARGIN_MS`; the full
 * margin when no context is given) and a timeout answers FAILED; any other
 * throw answers FAILED with the error's name. CloudFormation is always
 * answered exactly once.
 */
export function createHandler(options: HandlerOptions = {}): (event: ScopeRegistrationEvent, context?: HandlerContext) => Promise<void> {
  let deps: ScopeRegistrationDependencies | undefined;
  const answer = options.respond ?? ((event, outcome) => respond(event, outcome));
  return async (event, context) => {
    const fallbackId = event.PhysicalResourceId ?? physicalId(event.ResourceProperties?.Backend ?? 'unknown');
    let outcome: ScopeRegistrationOutcome;
    let timer: NodeJS.Timeout | undefined;
    try {
      const region = options.region ?? process.env.AWS_REGION ?? '';
      deps ??= { call: options.call ?? signedPlatformCall(region), region };
      const budget = Math.max(0, (context?.getRemainingTimeInMillis() ?? DEADLINE_MARGIN_MS) - DEADLINE_MARGIN_MS);
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new HandlerTimeout()), budget);
      });
      outcome = await Promise.race([handleEvent(event, deps), deadline]);
    } catch (error) {
      log.error('scope registration handler failed', { error: errorName(error) });
      outcome = { status: 'FAILED', physicalResourceId: fallbackId, reason: errorName(error) };
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
    await answer(event, outcome);
  };
}

/** The Lambda entry point. */
export const handler = createHandler();
