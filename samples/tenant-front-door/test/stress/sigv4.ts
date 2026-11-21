// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { Sha256 } from '@aws-crypto/sha256-js';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { SignatureV4 } from '@smithy/signature-v4';
import type { AwsCredentialIdentity, AwsCredentialIdentityProvider } from '@smithy/types';
import { request, type HttpResult } from './http';

/**
 * SigV4 calls to API Gateway (`execute-api`): the tenant-identity platform
 * API with the caller's own credentials, and the route registrar with the
 * credentials of the stand-in global hook role or the edge operator role.
 * Credentials stay in memory; nothing here prints them.
 */

export interface Caller {
  call(method: string, url: string, body?: unknown): Promise<HttpResult>;
}

export function ownCredentials(): AwsCredentialIdentityProvider {
  return fromNodeProviderChain();
}

/** Credentials of `roleArn`, assumed with the caller's own, renewed five minutes before they expire. */
export function assumedCredentials(roleArn: string, region: string, sessionName: string): AwsCredentialIdentityProvider {
  const sts = new STSClient({ region });
  let cached: AwsCredentialIdentity | undefined;
  let renewAt = 0;
  // Concurrent callers share one AssumeRole.
  let pending: Promise<AwsCredentialIdentity> | undefined;
  const assume = async (): Promise<AwsCredentialIdentity> => {
    const out = await sts.send(new AssumeRoleCommand({ RoleArn: roleArn, RoleSessionName: sessionName, DurationSeconds: 3600 }));
    const c = out.Credentials;
    if (c?.AccessKeyId === undefined || c.SecretAccessKey === undefined || c.Expiration === undefined) throw new Error(`AssumeRole ${roleArn} returned no credentials`);
    cached = { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken, expiration: c.Expiration };
    renewAt = c.Expiration.getTime() - 5 * 60_000;
    return cached;
  };
  return async () => {
    if (cached !== undefined && Date.now() <= renewAt) return cached;
    pending ??= assume().finally(() => {
      pending = undefined;
    });
    return pending;
  };
}

/** The Region an API Gateway URL names (`<id>.execute-api.<region>.amazonaws.com`); the registrar and tenant-identity may be in different Regions. */
export function regionOf(url: string, fallback: string): string {
  return /^[a-z0-9]+\.execute-api\.([a-z0-9-]+)\.amazonaws\.com$/.exec(new URL(url).hostname)?.[1] ?? fallback;
}

export function signedCaller(region: string, credentials: AwsCredentialIdentityProvider): Caller {
  const signers = new Map<string, SignatureV4>();
  const signerFor = (r: string): SignatureV4 => {
    let s = signers.get(r);
    if (s === undefined) {
      s = new SignatureV4({ service: 'execute-api', region: r, credentials, sha256: Sha256 });
      signers.set(r, s);
    }
    return s;
  };
  return {
    async call(method, url, body) {
      const u = new URL(url);
      const text = body === undefined ? undefined : JSON.stringify(body);
      const headers: Record<string, string> = { host: u.host };
      if (text !== undefined) headers['content-type'] = 'application/json';
      const signed = await signerFor(regionOf(url, region)).sign({
        method,
        protocol: 'https:',
        hostname: u.hostname,
        path: u.pathname,
        query: Object.fromEntries(u.searchParams),
        headers,
        body: text,
      });
      return request({ method, url, headers: signed.headers, body: text, bodyLimit: 65536 });
    },
  };
}
