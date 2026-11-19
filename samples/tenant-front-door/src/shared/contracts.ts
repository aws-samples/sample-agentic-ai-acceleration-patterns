// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The contracts between the slices that are not the route table or the
 * registrar API: what the router sends a cell, what `/config.json` holds,
 * the sign-in `state`, what the hooks read and what the stack publishes.
 * The registrar API is the Smithy model in `model/`; the route table is
 * `route-table.ts`.
 */

// ---------------------------------------------------------------------------
// Router to cell (spec §3.2, §3.3 step 7, §3.5)
// ---------------------------------------------------------------------------

/** The bearer token, copied from `Authorization`, which origin access control overwrites (ADR-0011). */
export const HEADER_TENANT_TOKEN = 'x-tenant-token';

/** The lower-case tenant id the router routed on: a hint the cell checks against the verified `tenant_id`. */
export const HEADER_TENANT_ROUTE = 'x-tenant-route';

/** OAC signs a request body with this header (ADR-0011); the SPA sends it on `PUT` and `POST`. */
export const HEADER_CONTENT_SHA256 = 'x-amz-content-sha256';

/** The exactly four headers the `/api/*` origin request policy forwards (§3.2). */
export const API_FORWARDED_HEADERS: readonly string[] = [
  HEADER_TENANT_TOKEN,
  HEADER_TENANT_ROUTE,
  'content-type',
  HEADER_CONTENT_SHA256,
];

/** The token claim that names one tenant (`tenant-identity` P-6). */
export const TENANT_CLAIM = 'tenant_id';

/** The multi-tenant claim the edge refuses with 401 (§3.3 step 5). */
export const MULTI_TENANT_CLAIM = 'tenants';

// ---------------------------------------------------------------------------
// Addressing and request paths (§3.2, §3.6)
// ---------------------------------------------------------------------------

/** `single`: one host, the tenant from the token. `host`: one host per tenant under `appDomain`. */
export type Addressing = 'single' | 'host';

/** The sign-in host's label in `host` mode (ADR-0016). */
export const SIGNIN_HOST_LABEL = 'login';

// ---------------------------------------------------------------------------
// /config.json (§3.2, ADR-0006)
// ---------------------------------------------------------------------------

/**
 * What the router generates for `/config.json`. Public settings only. The
 * tenant fields are present where the file names a tenant: on a pooled or
 * dedicated host in `host` mode, and on a dedicated domain in `single`
 * mode.
 */
export interface ConfigJson {
  readonly authorizeEndpoint: string;
  readonly tokenEndpoint: string;
  readonly clientId: string;
  readonly scopes: string;
  readonly logoutEndpoint: string;
  /** Present when the `issuer` input names `exchangeEndpoint` (§3.5). */
  readonly exchangeEndpoint?: string;
  /** Upper-cased control-plane form, which the token exchange expects. */
  readonly tenantId?: string;
  readonly displayName?: string;
  /** `https://login.<appDomain>/callback`, `host` mode. */
  readonly redirectUri?: string;
  /** The route entry's `dt`, wherever a tenant is named; the SPA ignores it (§4.2). */
  readonly rev?: number;
  /** On a dedicated domain: where sign-in happens (§3.5). */
  readonly signInHost?: string;
}

// ---------------------------------------------------------------------------
// Sign-in state, host mode (§3.5, ADR-0016)
// ---------------------------------------------------------------------------

/** The `state` lifetime. */
export const SIGNIN_STATE_TTL_SECONDS = 600;

/**
 * The signed `state` payload: `base64url(JSON) + "." + base64url(HMAC-SHA256)`
 * over the encoded payload, with the `signin` key `kid` names. `/logout`'s
 * state has no `n`.
 */
export interface SigninStatePayload {
  readonly v: 1;
  readonly kid: string;
  /** The minting request's lower-cased `Host`: a pooled tenant host. */
  readonly h: string;
  /** The SPA's nonce, 16 to 64 base64url characters. */
  readonly n?: string;
  /** Unix seconds. */
  readonly exp: number;
}

// ---------------------------------------------------------------------------
// Hooks (§3.4, §5.2; control-plane R-42, R-43)
// ---------------------------------------------------------------------------

/** The cell script output the route hook sends as `apiDomain`. */
export const OUTPUT_FRONT_DOOR_API_DOMAIN = 'frontDoorApiDomain';

/** The optional deployment parameter that carries a requested dedicated domain (control-plane ADR-0039). */
export const PARAM_FRONT_DOOR_CUSTOM_DOMAIN = 'PARAM_FRONT_DOOR_CUSTOM_DOMAIN';

/** The two global hooks `register-hooks.sh` puts. */
export const HOOK_POST = 'front-door-post';
export const HOOK_PRE = 'front-door-pre';

/** The route hook's bound on waiting for propagation after the registrar answers (§4.2). */
export const ROUTE_PROPAGATION_WAIT_SECONDS = 45;

// ---------------------------------------------------------------------------
// Published parameters (§6.4)
// ---------------------------------------------------------------------------

/** In the edge account. */
export const PARAM_EDGE = '/application-plane/shared/front-door/edge';

/** In each cell account, written by the application's shared stack. */
export function paramCellCopy(applicationId: string): string {
  return `/application-plane/applications/${applicationId}/shared/front-door`;
}

/** In the control plane's account, written by `RouteHookAccess`. */
export function paramHook(applicationId: string): string {
  return `/application-plane/applications/${applicationId}/shared/front-door-hook`;
}

/** The value of `PARAM_EDGE`: one JSON document. */
export interface EdgeParameter {
  readonly version: 1;
  readonly appDomain: string;
  readonly addressing: Addressing;
  readonly applicationId: string;
  readonly distributionArn: string;
  readonly registrarUrl: string;
  readonly tenantClaim: string;
  readonly reservedLabels: readonly string[];
}

/** The value of `paramCellCopy`: what `CellRouteAccess` needs. */
export interface CellCopyParameter {
  readonly distributionArn: string;
}

/** The value of `paramHook`: what the route hook needs. */
export interface HookParameter {
  readonly registrarUrl: string;
}
