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

/**
 * OAC signs a request body with this header (ADR-0011); the SPA sends it on
 * `PUT` and `POST`. CloudFront refuses `x-amz-*` names in an origin request
 * policy, so it is not in `API_FORWARDED_HEADERS`: origin access control
 * reads it from the viewer request itself (§3.2).
 */
export const HEADER_CONTENT_SHA256 = 'x-amz-content-sha256';

/** The exactly three headers the `/api/*` origin request policy forwards (§3.2). */
export const API_FORWARDED_HEADERS: readonly string[] = [
  HEADER_TENANT_TOKEN,
  HEADER_TENANT_ROUTE,
  'content-type',
];

/**
 * The default of the `tenantClaim` input (§3.6): the token claim that names
 * one tenant (`tenant-identity` P-6). The router and the cell read the
 * configured value, never this constant directly.
 */
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
  /** The `tenantClaim` input (§3.6): the claim the SPA reads the tenant from, as the router and the cell do. */
  readonly tenantClaim: string;
  /** Present when the `issuer` input names `exchangeEndpoint` (§3.5). */
  readonly exchangeEndpoint?: string;
  /** Upper-cased control-plane form, which the token exchange expects. */
  readonly tenantId?: string;
  readonly displayName?: string;
  /**
   * `https://login.<appDomain>/callback`, `host` mode only. Absent in
   * `single` mode, where the SPA uses `https://<appDomain>/`. The SPA signs
   * out through the router's `/logout`, so the issuer's logout endpoint is
   * not in this file (§3.5).
   */
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

/** The query parameter of `GET /signin-state?nonce=<base64url>` (§3.3 step 8, §3.5). The payload field is `n`. */
export const SIGNIN_STATE_QUERY_NONCE = 'nonce';

/** The SPA's nonce (§3.3 step 8). */
export const SIGNIN_NONCE = /^[A-Za-z0-9_-]{16,64}$/;

/** `/signin-state`'s answer. */
export interface SigninStateResponse {
  readonly state: string;
}

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

/** The control-plane events each hook runs on (§3.2; control-plane R-45). */
export const HOOK_POST_EVENTS: readonly string[] = ['CELL_CREATE', 'CELL_UPDATE', 'DEPLOYMENT_CREATE', 'DEPLOYMENT_UPDATE'];
export const HOOK_PRE_EVENTS: readonly string[] = ['CELL_DELETE', 'DEPLOYMENT_DELETE'];

/** The route hook's path in this repository, the `script` of both hooks (§5.2). */
export const ROUTE_HOOK_SCRIPT = 'samples/tenant-front-door/hooks/route-hook.sh';

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

/**
 * A registrar stage URL, `https://<api id>.execute-api.<region>.<suffix>/<stage>/`,
 * the form `RestApi.url` takes: the `registrarUrl` of `PARAM_EDGE` and of
 * `paramHook`. Groups: the API id, the Region, the stage.
 */
export const REGISTRAR_URL = /^https:\/\/([a-z0-9]{10})\.execute-api\.([a-z0-9-]+)\.amazonaws\.com(?:\.cn)?\/([A-Za-z0-9_-]{1,128})\/$/;

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

/**
 * The value of `paramCellCopy`: the edge distribution's ARN as a plain
 * string, what `CellRouteAccess` needs. Plain, not JSON, so a cell stack
 * reads it with a CloudFormation SSM parameter, which cannot parse JSON
 * (ADR-0026).
 */
export type CellCopyParameter = string;

/**
 * The value of `paramHook`: one JSON document, what the route hook needs.
 * `appDomain` and `addressing` let it poll a tenant's host in `host` mode
 * (§4.2).
 */
export interface HookParameter {
  readonly version: 1;
  /** The registrar's stage URL, ending in `/`. */
  readonly registrarUrl: string;
  readonly appDomain: string;
  readonly addressing: Addressing;
}

/**
 * The cell's own namespace for one tenant (§3.5): its hosts check reads
 * it. Built from the verified claim in the control-plane form (upper case),
 * never from the lower-case `x-tenant-route` hint, because SSM names are
 * case-sensitive.
 */
export function paramTenantNamespace(verifiedTenantId: string, applicationId: string): string {
  return `/application-plane/tenants/${verifiedTenantId.toUpperCase()}/${applicationId}/`;
}

// ---------------------------------------------------------------------------
// Router build constants (S1 writes the function, S2 bundles it)
// ---------------------------------------------------------------------------

/**
 * A CloudFront Function has no environment, so the stack replaces these
 * tokens in the router's source before it creates the function. The source
 * writes each token as a double-quoted string literal, for example
 * `const APP_DOMAIN = "__TFD_APP_DOMAIN__";`, and `substituteRouterTokens`
 * replaces the whole literal, quotes included, with `JSON.stringify(value)`.
 * The KeyValueStore is the one associated with the function, read with
 * `cf.kvs()`, so no id is compiled in.
 */
export const ROUTER_TOKENS = {
  /** Lower-case `appDomain`. */
  appDomain: '__TFD_APP_DOMAIN__',
  /** `single` or `host`. */
  addressing: '__TFD_ADDRESSING__',
  /** The `tenantClaim` input. */
  tenantClaim: '__TFD_TENANT_CLAIM__',
  /** `on` when `agentIngress` is set, else `off` (§3.3 step 3). */
  agentIngress: '__TFD_AGENT_INGRESS__',
  /** Comma-separated `RESERVED_LABELS`. */
  reservedLabels: '__TFD_RESERVED_LABELS__',
} as const;

export type RouterTokenValues = { readonly [K in keyof typeof ROUTER_TOKENS]: string };

/**
 * Replaces every `"__TFD_X__"` literal in the router source with the
 * JSON-encoded value. Throws when a token is missing from the source or any
 * `__TFD_` is left over.
 */
export function substituteRouterTokens(source: string, values: RouterTokenValues): string {
  let out = source;
  for (const [name, token] of Object.entries(ROUTER_TOKENS) as [keyof typeof ROUTER_TOKENS, string][]) {
    const literal = `"${token}"`;
    if (!out.includes(literal)) throw new Error(`router source has no ${literal}`);
    out = out.split(literal).join(JSON.stringify(values[name]));
  }
  if (out.includes('__TFD_')) throw new Error('router source has an unknown __TFD_ token');
  return out;
}

// ---------------------------------------------------------------------------
// Dedicated domains (§3.4 step 5, §5.1, ADR-0018): S3 writes, S6 and S2 read
// ---------------------------------------------------------------------------

/** The challenge record's name prefix: `_tfd-challenge.<d>`. */
export const CHALLENGE_RECORD_PREFIX = '_tfd-challenge.';

/** The challenge record's value prefix: `tfd-verify=<token>`. */
export const CHALLENGE_VALUE_PREFIX = 'tfd-verify=';

/** How long a challenge token is valid. */
export const CHALLENGE_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Tag the registrar puts on a dedicated domain's ACM certificate and distribution tenant: the lower-case tenant id. */
export const TAG_TENANT_ID = 'tenant-front-door:tenant';

/** Tag the registrar puts on the same resources: the multi-tenant distribution's id. */
export const TAG_DISTRIBUTION_ID = 'tenant-front-door:distribution';

/**
 * The cost allocation tag on the same resources (standard §4.4): the
 * tenant id in the control plane's own upper-case form, so Cost Explorer
 * and CUR split a dedicated domain's cost by the control plane's tenant.
 */
export const TAG_COST_TENANT_ID = 'TenantId';

/**
 * ACM statuses that never become `ISSUED`. The registrar counts such a
 * certificate as absent and requests a new one; the sweeper deletes a
 * registrar certificate in one of them that nothing uses, whatever its
 * tenant's `d`, an hour after its `CreatedAt` (spec §3.4 step 5 sub-step 6).
 */
export const TERMINAL_CERTIFICATE_STATUSES: readonly string[] = ['FAILED', 'VALIDATION_TIMED_OUT', 'REVOKED', 'EXPIRED'];

// ---------------------------------------------------------------------------
// Registrar environment (S2 sets it, S3 reads it)
// ---------------------------------------------------------------------------

/** The registrar function's environment variable names. */
export const REGISTRAR_ENV = {
  /** ARN of the route table KeyValueStore. */
  routeTableArn: 'ROUTE_TABLE_ARN',
  appDomain: 'APP_DOMAIN',
  addressing: 'ADDRESSING',
  applicationId: 'APPLICATION_ID',
  /** The control plane API's base URL. */
  controlPlaneUrl: 'CONTROL_PLANE_URL',
  controlPlaneAccount: 'CONTROL_PLANE_ACCOUNT',
  /** The one Region every cell origin must be in (§3.4 step 3). */
  controlPlaneRegion: 'CONTROL_PLANE_REGION',
  /** The vendor IdP's token endpoint for the reader token (ADR-0015). */
  vendorIdpTokenUrl: 'VENDOR_IDP_TOKEN_URL',
  vendorIdpClientId: 'VENDOR_IDP_CLIENT_ID',
  /** Secrets Manager ARN of the client secret. */
  vendorIdpSecretArn: 'VENDOR_IDP_SECRET_ARN',
  /** Names the admitted `<fleet>-global-hook` role. */
  fleet: 'FLEET',
  edgeOperatorRoleArn: 'EDGE_OPERATOR_ROLE_ARN',
  /** `on` or `off`. */
  dedicatedDomains: 'DEDICATED_DOMAINS',
  /** The multi-tenant distribution; dedicated distribution tenants attach to it. */
  distributionId: 'DISTRIBUTION_ID',
  /** The stack's connection group; dedicated distribution tenants join it, so its routing endpoint is their CNAME target. */
  connectionGroupId: 'CONNECTION_GROUP_ID',
} as const;

// ---------------------------------------------------------------------------
// Sweeper: spec §3.1, §3.4 step 5, ADR-0018, ADR-0020, ADR-0022
// ---------------------------------------------------------------------------

/**
 * The sweeper function's environment variable names. The lister starts its
 * pages on its own function through `AWS_LAMBDA_FUNCTION_NAME`, which
 * Lambda sets, so the stack sets no function name and the function's
 * environment does not reference the function.
 */
export const SWEEPER_ENV = {
  /** ARN of the route table KeyValueStore. */
  routeTableArn: 'ROUTE_TABLE_ARN',
  /** The multi-tenant distribution whose dedicated distribution tenants the removal job deletes. */
  distributionId: 'DISTRIBUTION_ID',
  /** The pooled distribution tenant's id, which the removal job skips before it reads any tag. */
  pooledTenantId: 'POOLED_TENANT_ID',
  /** Name of the sweeper's own DynamoDB table (ADR-0020). */
  tableName: 'SWEEPER_TABLE_NAME',
} as const;

/** The jobs one sweeper function runs, chosen by the invocation's `job`. */
export const SWEEPER_JOB = {
  /** Two-phase removal of dedicated distribution tenants and certificates, every 15 minutes. */
  remove: 'remove',
  /** The daily re-check's lister: the daily schedule, the starter and a run by hand. */
  recheck: 'recheck',
  /** One page of the daily re-check, started by the lister only. */
  page: 'page',
} as const;

/** The 15-minute schedule's input. */
export const SWEEPER_REMOVE_INPUT = JSON.stringify({ job: SWEEPER_JOB.remove });

/** The daily schedule's input, which the starter also sends. It names no date (ADR-0022). */
export const SWEEPER_RECHECK_INPUT = JSON.stringify({ job: SWEEPER_JOB.recheck });

/** What the lister sends each page: its UTC date, the page number from 1 and the page's stored tenant ids. */
export interface SweeperPageEvent {
  readonly job: typeof SWEEPER_JOB.page;
  /** `YYYY-MM-DD`, the lister's UTC date. */
  readonly runDay: string;
  readonly page: number;
  readonly tenantIds: readonly string[];
}

export type SweeperEvent =
  | { readonly job: typeof SWEEPER_JOB.remove }
  | { readonly job: typeof SWEEPER_JOB.recheck }
  | SweeperPageEvent;

/** Entries per page (§3.4 step 5): 500 ids of at most 63 characters, about 33 KB of payload. */
export const SWEEPER_PAGE_SIZE = 500;

/** The sweeper table's keys and time-to-live attribute: string `pk` and `sk`, on demand, PITR. */
export const SWEEPER_TABLE = {
  partitionKey: 'pk',
  sortKey: 'sk',
  timeToLiveAttribute: 'expiresAt',
  /** `pk` of an entry item; its `sk` is `<tenantId>#<d>`. */
  entryPk: 'ENTRY',
  /** `pk` of a run item; its `sk` is the run's UTC date. */
  runPk: 'RUN',
} as const;

/** The sweeper table's item attributes. */
export const SWEEPER_ATTR = {
  /** Entry item: the UTC date of the last outcome recorded. */
  lastCheckedDay: 'lastCheckedDay',
  /** Entry item: `pass`, `miss` or `error`. */
  lastOutcome: 'lastOutcome',
  /** Entry item: consecutive checks after that day's outcome. */
  missStreak: 'missStreak',
  errorStreak: 'errorStreak',
  /** Entry item: the same counts before that day's outcome. */
  missBefore: 'missBefore',
  errorBefore: 'errorBefore',
  /** Run item: the number of pages the lister started, zero included. */
  pagesStarted: 'pagesStarted',
  /** Run item: a number set of the pages that recorded their last entry. */
  pagesFinished: 'pagesFinished',
  /** Run item: Unix seconds, 14 days out. */
  expiresAt: 'expiresAt',
} as const;

/** How long a run item is kept. */
export const SWEEPER_RUN_TTL_SECONDS = 14 * 24 * 60 * 60;

/**
 * The re-check's counts: embedded metric format lines in the sweeper's log,
 * namespace `TenantFrontDoor` (the registrar's `METRIC_NAMESPACE`),
 * dimension `DistributionId` (`METRIC_DIMENSION_DISTRIBUTION`), unit Count.
 */
export const SWEEPER_METRIC_NAMESPACE = 'TenantFrontDoor';
export const SWEEPER_METRICS = {
  /** 1 for each write that records a miss and leaves `missStreak` at 3 or more. Three-miss alarm. */
  threeMiss: 'DomainChallengeThreeMiss',
  /** 1 for each write that leaves `errorStreak` at 3 or more. `unverifiable` alarm. */
  unverifiable: 'DomainChallengeUnverifiable',
  /** One value per lister run: the previous day's missing pages. Missing-pages and no-lister alarms. */
  missingPages: 'SweeperMissingPages',
} as const;

/** The `message` of the sweeper's log lines that the alarms' runbook and the integration test read. */
export const SWEEPER_LOG = {
  threeMiss: 'three-miss',
  unverifiable: 'unverifiable',
  stalePage: 'stale-page',
  entryGone: 'tenant entry gone',
  pageReads: 'page reads',
} as const;

/** The starter custom resource's one property: the sweeper function it invokes on Create. */
export interface SweeperStarterProperties {
  readonly SweeperFunctionName: string;
}
