// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * `/config.json` (spec §3.2, ADR-0006): parse it, and decide where and how
 * this page signs in (§3.5).
 */

import type { ConfigJson } from '../../src/shared/contracts';

export class ConfigError extends Error {}

const HOSTNAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

function str(o: Record<string, unknown>, k: string, optional = false): string | undefined {
  const v = o[k];
  if (v === undefined && optional) return undefined;
  if (typeof v !== 'string' || v.length === 0) throw new ConfigError(`config.json: ${k}`);
  return v;
}

function httpsUrl(o: Record<string, unknown>, k: string, optional = false): string | undefined {
  const v = str(o, k, optional);
  if (v === undefined) return undefined;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new ConfigError(`config.json: ${k}`);
  }
  if (u.protocol !== 'https:' || u.username !== '' || u.password !== '') throw new ConfigError(`config.json: ${k}`);
  return v;
}

/** Checks the fields the SPA uses and drops the rest. `rev` is ignored (§3.2). */
export function parseConfig(raw: unknown): ConfigJson {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new ConfigError('config.json: not an object');
  const o = raw as Record<string, unknown>;
  const signInHost = str(o, 'signInHost', true);
  if (signInHost !== undefined && !HOSTNAME.test(signInHost)) throw new ConfigError('config.json: signInHost');
  const out: Record<string, string> = {
    authorizeEndpoint: httpsUrl(o, 'authorizeEndpoint')!,
    tokenEndpoint: httpsUrl(o, 'tokenEndpoint')!,
    clientId: str(o, 'clientId')!,
    scopes: str(o, 'scopes')!,
    tenantClaim: str(o, 'tenantClaim')!,
  };
  const optional: [string, string | undefined][] = [
    ['exchangeEndpoint', httpsUrl(o, 'exchangeEndpoint', true)],
    ['tenantId', str(o, 'tenantId', true)],
    ['displayName', str(o, 'displayName', true)],
    ['redirectUri', httpsUrl(o, 'redirectUri', true)],
    ['signInHost', signInHost],
  ];
  for (const [k, v] of optional) if (v !== undefined) out[k] = v;
  return out as unknown as ConfigJson;
}

export interface Here {
  /** `location.host`, lower case. */
  readonly host: string;
  /** `location.origin`. */
  readonly origin: string;
}

export type SignInPlan =
  /** A dedicated domain receives no code: sign-in and the session move to `signInHost` (§3.5). */
  | { readonly kind: 'redirect'; readonly url: string }
  | {
    readonly kind: 'here';
    /** `host` when `/config.json` names `redirectUri` (the shared sign-in host), else `single`. */
    readonly mode: 'single' | 'host';
    /** `https://login.<appDomain>/callback` in `host` mode, `https://<appDomain>/` in `single` mode. */
    readonly redirectUri: string;
    /** The tenant the token must name, when the host names one. */
    readonly expectedTenant?: string;
  };

export function signInPlan(config: ConfigJson, here: Here): SignInPlan {
  if (config.signInHost !== undefined && config.signInHost !== here.host) {
    return { kind: 'redirect', url: `https://${config.signInHost}/` };
  }
  if (config.redirectUri !== undefined) {
    return { kind: 'here', mode: 'host', redirectUri: config.redirectUri, expectedTenant: config.tenantId };
  }
  return { kind: 'here', mode: 'single', redirectUri: `${here.origin}/`, expectedTenant: config.tenantId };
}
