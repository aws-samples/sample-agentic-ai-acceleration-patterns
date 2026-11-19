// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Reference for the `/config.json` the router generates (spec §3.2, §3.5),
 * for tests only. The router cannot import it; it is tested against
 * `test/fixtures/config-json.json`, which this module checks.
 */

import { Addressing, ConfigJson, SIGNIN_HOST_LABEL } from '../../src/shared/contracts';
import type { AppEntry, TenantEntry } from '../../src/shared/route-table';

export interface ConfigInput {
  readonly addressing: Addressing;
  readonly appDomain: string;
  /** The lower-cased request host. */
  readonly host: string;
  readonly app: AppEntry;
  /** The tenant the host names (`host#` entry's `t`), when it names one. */
  readonly tenant?: { readonly id: string; readonly entry: TenantEntry };
}

export function configJsonFor(input: ConfigInput): ConfigJson {
  const { app } = input;
  const base: Record<string, unknown> = {
    authorizeEndpoint: app.az,
    tokenEndpoint: app.tk,
    clientId: app.cid,
    scopes: app.sc,
  };
  if (app.ex !== undefined) base.exchangeEndpoint = app.ex;
  if (input.tenant === undefined) return base as unknown as ConfigJson;

  const pooledHost = input.host.endsWith(`.${input.appDomain}`);
  base.tenantId = input.tenant.id.toUpperCase();
  base.displayName = input.tenant.entry.n;
  base.rev = input.tenant.entry.dt;
  if (input.addressing === 'host') {
    base.redirectUri = `https://${SIGNIN_HOST_LABEL}.${input.appDomain}/callback`;
  }
  if (!pooledHost) {
    base.signInHost = input.addressing === 'host' ? `${input.tenant.id}.${input.appDomain}` : input.appDomain;
  }
  return base as unknown as ConfigJson;
}
