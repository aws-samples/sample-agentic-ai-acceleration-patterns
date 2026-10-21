// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Clients for the spec §10 end-to-end scenario, run against deployed stacks.
 *
 * Everything the scenario needs to talk to a deployed topology stack:
 *   - stack discovery through CloudFormation outputs (spec §3.3);
 *   - a SigV4-signed fetch client for `/platform/*` (ADR-0005, spec §3.2);
 *   - a form-POST token-exchange client for `POST /oauth2/token` (§5.4);
 *   - a bearer-token client for `/tenant/*` (§5.2);
 *   - a JWT verification helper (reference `aws-jwt-verify`) that verifies
 *     every token the scenario asserts on, against the issuer the registry
 *     (topology 1) or the published pool parameters (2, 3) name (§3.2).
 *
 * Hygiene (spec N-4, N-6, N-7): this module never logs or prints a token, a
 * refresh token, or a password. On a failed assertion the scenario prints
 * claim *names* and tenant ids, never token values.
 */

import { Sha256 } from '@aws-crypto/sha256-js';
import {
  CloudFormationClient,
  DescribeStacksCommand,
} from '@aws-sdk/client-cloudformation';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { HttpRequest } from '@smithy/protocol-http';
import { SignatureV4 } from '@smithy/signature-v4';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { fetchJwks } from 'aws-jwt-verify/jwk';
import type { Topology } from '../../src/shared/constants';
import { issuerFor } from '../../src/shared/constants';

// ---------------------------------------------------------------------------
// Region
// ---------------------------------------------------------------------------

/** The single Region the stacks are deployed in (spec §10, one Region). */
export function region(): string {
  const value = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
  if (value === undefined || value === '') {
    throw new Error('AWS_REGION must name the Region the stacks are deployed in');
  }
  return value;
}

// ---------------------------------------------------------------------------
// Stack discovery (spec §3.3): outputs of `${E2E_STACK_PREFIX}-${topology}`
// ---------------------------------------------------------------------------

/** The stack outputs the CDK worker publishes (TODO.md cross-worker contract). */
export interface StackOutputs {
  /** API Gateway stage URL, trailing slash (output key `ApiUrl`). */
  readonly apiUrl: string;
  readonly topology: Topology;
  readonly registryTableName: string;
  /** shared-pool* only. */
  readonly userPoolId?: string;
  readonly appClientId?: string;
}

const OUTPUT_KEYS = {
  apiUrl: 'ApiUrl',
  topology: 'Topology',
  registryTableName: 'RegistryTableName',
  userPoolId: 'UserPoolId',
  appClientId: 'AppClientId',
} as const;

/** `TenantIdentity` unless overridden (matches the `integ`/`e2e` task env). */
export function stackPrefix(): string {
  const value = process.env.E2E_STACK_PREFIX;
  return value === undefined || value === '' ? 'TenantIdentity' : value;
}

export function stackName(topology: Topology): string {
  return `${stackPrefix()}-${topology}`;
}

/** Reads the stack's CloudFormation outputs once per topology. */
export async function discoverStack(topology: Topology): Promise<StackOutputs> {
  const cfn = new CloudFormationClient({ region: region() });
  const name = stackName(topology);
  const result = await cfn.send(new DescribeStacksCommand({ StackName: name }));
  const stack = result.Stacks?.[0];
  if (stack === undefined) {
    throw new Error(`Stack ${name} not found; deploy it before running the e2e scenario`);
  }
  const outputs = new Map<string, string>();
  for (const o of stack.Outputs ?? []) {
    if (o.OutputKey !== undefined && o.OutputValue !== undefined) {
      outputs.set(o.OutputKey, o.OutputValue);
    }
  }
  const apiUrl = outputs.get(OUTPUT_KEYS.apiUrl);
  const registryTableName = outputs.get(OUTPUT_KEYS.registryTableName);
  if (apiUrl === undefined || registryTableName === undefined) {
    throw new Error(`Stack ${name} is missing required outputs (ApiUrl, RegistryTableName)`);
  }
  return {
    apiUrl: apiUrl.endsWith('/') ? apiUrl : `${apiUrl}/`,
    topology,
    registryTableName,
    userPoolId: outputs.get(OUTPUT_KEYS.userPoolId),
    appClientId: outputs.get(OUTPUT_KEYS.appClientId),
  };
}

// ---------------------------------------------------------------------------
// HTTP result shape
// ---------------------------------------------------------------------------

export interface HttpResult<T = unknown> {
  readonly status: number;
  readonly body: T;
  /** The parsed `error` code for RFC 6749 responses (§5.4), when present. */
  readonly oauthError?: string;
}

function joinUrl(base: string, path: string): string {
  const b = base.endsWith('/') ? base.slice(0, -1) : base;
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${b}${p}`;
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text === '') {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ---------------------------------------------------------------------------
// Platform API client: SigV4 over execute-api (spec §3.2, ADR-0005)
// ---------------------------------------------------------------------------

export class PlatformClient {
  private readonly signer: SignatureV4;

  constructor(private readonly apiUrl: string) {
    this.signer = new SignatureV4({
      service: 'execute-api',
      region: region(),
      credentials: fromNodeProviderChain(),
      sha256: Sha256,
    });
  }

  /**
   * Signs and sends a request to a `/platform/*` route. `path` is the route
   * beginning `platform/...`; the stage prefix is already in `apiUrl`.
   */
  async call<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<HttpResult<T>> {
    const url = new URL(joinUrl(this.apiUrl, path));
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = { host: url.hostname };
    if (payload !== undefined) {
      headers['content-type'] = 'application/json';
    }
    const request = new HttpRequest({
      protocol: url.protocol,
      hostname: url.hostname,
      method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      headers,
      body: payload,
    });
    const signed = await this.signer.sign(request);
    const res = await fetch(url.toString(), {
      method,
      headers: signed.headers as Record<string, string>,
      body: payload,
    });
    return { status: res.status, body: (await readJson(res)) as T };
  }
}

// ---------------------------------------------------------------------------
// Token exchange client: form POST, no authoriser (spec §5.4, ADR-0011)
// ---------------------------------------------------------------------------

export interface ExchangeParams {
  readonly grantType?: string;
  readonly clientId: string;
  readonly subjectToken: string;
  readonly subjectTokenType?: string;
  readonly requestedTokenType?: string;
  readonly resource?: string;
  readonly scope: string;
  /** Unsupported RFC 8693 parameters, to prove they are rejected (§5.4). */
  readonly audience?: string;
  readonly actorToken?: string;
  readonly actorTokenType?: string;
}

export interface ExchangeSuccess {
  readonly access_token: string;
  readonly issued_token_type: string;
  readonly token_type: string;
  readonly expires_in: number;
  readonly scope: string;
}

export class ExchangeClient {
  constructor(private readonly apiUrl: string) {}

  /** Posts the RFC 8693 form and returns the raw HTTP result (§5.4). */
  async exchange(params: ExchangeParams): Promise<HttpResult> {
    const form = new URLSearchParams();
    form.set(
      'grant_type',
      params.grantType ?? 'urn:ietf:params:oauth:grant-type:token-exchange',
    );
    form.set('client_id', params.clientId);
    form.set('subject_token', params.subjectToken);
    form.set(
      'subject_token_type',
      params.subjectTokenType ?? 'urn:ietf:params:oauth:token-type:refresh_token',
    );
    if (params.requestedTokenType !== undefined) {
      form.set('requested_token_type', params.requestedTokenType);
    }
    if (params.resource !== undefined) {
      form.set('resource', params.resource);
    }
    form.set('scope', params.scope);
    if (params.audience !== undefined) {
      form.set('audience', params.audience);
    }
    if (params.actorToken !== undefined) {
      form.set('actor_token', params.actorToken);
    }
    if (params.actorTokenType !== undefined) {
      form.set('actor_token_type', params.actorTokenType);
    }
    const res = await fetch(joinUrl(this.apiUrl, 'oauth2/token'), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    const parsed = (await readJson(res)) as Record<string, unknown> | undefined;
    const oauthError =
      parsed !== undefined && typeof parsed.error === 'string' ? parsed.error : undefined;
    return { status: res.status, body: parsed, oauthError };
  }
}

// ---------------------------------------------------------------------------
// Tenant API client: Authorization: Bearer <narrowed token> (spec §5.2)
// ---------------------------------------------------------------------------

export class TenantClient {
  constructor(private readonly apiUrl: string) {}

  /** Calls a `/tenant/*` route with the bearer token (no body for GET/DELETE). */
  async call<T = unknown>(
    method: string,
    path: string,
    token: string,
    body?: unknown,
  ): Promise<HttpResult<T>> {
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    const payload = body === undefined ? undefined : JSON.stringify(body);
    if (payload !== undefined) {
      headers['content-type'] = 'application/json';
    }
    const res = await fetch(joinUrl(this.apiUrl, path), { method, headers, body: payload });
    return { status: res.status, body: (await readJson(res)) as T };
  }

  /** A call with no Authorization header, to show the gateway answers 401. */
  async callAnonymous(method: string, path: string): Promise<HttpResult> {
    const res = await fetch(joinUrl(this.apiUrl, path), { method });
    return { status: res.status, body: await readJson(res) };
  }
}

// ---------------------------------------------------------------------------
// JWT verification (spec §3.2). Reference: aws-jwt-verify.
// ---------------------------------------------------------------------------

/** A decoded payload; claim names are safe to print, token values are not. */
export type Claims = Record<string, unknown>;

/** base64url-decode a JWT payload WITHOUT verifying (diagnostics only). */
export function decodeClaims(token: string): Claims {
  const part = token.split('.')[1];
  if (part === undefined) {
    throw new Error('not a JWT');
  }
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Claims;
}

/** The pool id is the last path segment of a Cognito issuer URL. */
function poolIdFromIssuer(issuer: string): string {
  const seg = issuer.split('/').pop();
  if (seg === undefined || seg === '') {
    throw new Error('issuer has no pool id');
  }
  return seg;
}

/**
 * Verifies a Cognito **access** token against a pool's JWKS and app client,
 * requiring `token_use == "access"` (spec §3.2). Pre-caches the JWKS so a
 * token can still be verified after the pool is deleted (spec §10 step 9).
 */
export class AccessTokenVerifier {
  /** Build from an explicit pool id (topologies 2, 3: published parameters). */
  static forPool(userPoolId: string, clientId: string): AccessTokenVerifier {
    return new AccessTokenVerifier(userPoolId, clientId, issuerFor(region(), userPoolId));
  }

  /** Build from the issuer the registry names (topology 1: GetTenant.issuer). */
  static forIssuer(issuer: string, clientId: string): AccessTokenVerifier {
    return new AccessTokenVerifier(poolIdFromIssuer(issuer), clientId, issuer);
  }

  private readonly verifier: ReturnType<typeof CognitoJwtVerifier.create>;

  private constructor(
    readonly userPoolId: string,
    readonly clientId: string,
    readonly issuer: string,
  ) {
    this.verifier = CognitoJwtVerifier.create({
      userPoolId,
      clientId,
      tokenUse: 'access',
    });
  }

  /** The JWKS URL for this pool (spec §10 step 9 asserts it 404s after delete). */
  jwksUrl(): string {
    return `${this.issuer}/.well-known/jwks.json`;
  }

  /**
   * Loads the pool's JWKS now and caches it in the verifier, so verification
   * no longer needs the network. Call before `DeleteTenant` in topology 1 so
   * step 9 can verify a pre-deletion token after the pool (and its JWKS
   * endpoint) is gone.
   */
  async primeJwksCache(): Promise<void> {
    const jwks = await fetchJwks(this.jwksUrl());
    this.verifier.cacheJwks(jwks, this.userPoolId);
  }

  /** Verifies the token (network unless primed) and returns its claims. */
  async verify(token: string): Promise<Claims> {
    return (await this.verifier.verify(token)) as unknown as Claims;
  }

  /** Verifies using only the cached JWKS, never the network (step 9). */
  verifyCached(token: string): Claims {
    return this.verifier.verifySync(token) as unknown as Claims;
  }
}
