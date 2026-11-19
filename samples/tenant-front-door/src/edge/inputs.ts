// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The deployment inputs (spec §3.6) and their synth-time validation. Every
 * check runs before a construct is created, with no network call, and
 * throws a message that names the input. `validateInputs` returns the
 * normalised values the stacks use.
 */

import { Addressing, MULTI_TENANT_CLAIM, TENANT_CLAIM } from '../shared/contracts';
import { SIGNIN_KID } from '../shared/route-table';

/** The public Route 53 zone for `appDomain`, in the edge account (§3.6). */
export interface HostedZoneInput {
  readonly zoneId: string;
  readonly zoneName: string;
}

/** The vendor IdP client the registrar reads the control plane with (ADR-0015). */
export interface VendorIdpInput {
  /** The token endpoint, `https`. */
  readonly tokenUrl: string;
  readonly clientId: string;
  /** Full Secrets Manager ARN of the client secret. */
  readonly clientSecretArn: string;
}

/** The control plane the front door serves (§3.6). */
export interface ControlPlaneInput {
  /** The control plane API's base URL, `https`. */
  readonly apiUrl: string;
  /** Names the `<fleet>-global-hook` role the registrar admits. */
  readonly accountId: string;
  /** The Region every cell origin is in; the main stack deploys here too (§3.1). */
  readonly region: string;
  readonly vendorIdp: VendorIdpInput;
}

/**
 * The SPA's issuer (§3.6): either `cognitoDomain`, from which the three
 * endpoints are derived, or all three endpoints.
 */
export interface IssuerInput {
  readonly clientId: string;
  /** Space-separated, or a list. */
  readonly scopes: string | readonly string[];
  /** A Cognito user-pool domain: `/oauth2/authorize`, `/oauth2/token` and `/logout` are derived from it. */
  readonly cognitoDomain?: string;
  readonly authorizeEndpoint?: string;
  readonly tokenEndpoint?: string;
  readonly logoutEndpoint?: string;
  /** The multi-tenant token exchange, when the issuer serves it apart from its token endpoint (§3.5). */
  readonly exchangeEndpoint?: string;
}

/** The `signin` key ids, `host` mode only (§3.6, §4.1). */
export interface SigninKeysInput {
  readonly ids: readonly string[];
  readonly current: string;
}

/** The deployment inputs of spec §3.6. */
export interface TenantFrontDoorInputs {
  readonly appDomain: string;
  readonly hostedZone: HostedZoneInput;
  /** Default `single`. */
  readonly addressing?: Addressing;
  readonly applicationId: string;
  readonly controlPlane: ControlPlaneInput;
  readonly fleet: string;
  readonly edgeOperatorRoleArn: string;
  readonly issuer: IssuerInput;
  /** `host` mode only. Default `{ ids: ['k1'], current: 'k1' }`. */
  readonly signinKeys?: SigninKeysInput;
  /** Default `tenant_id`. */
  readonly tenantClaim?: string;
  /** Path of the built SPA: `index.html` and `csp.json` at its root. Default `build/spa`. */
  readonly spaSource?: string;
  /** Agent ingress base URL (`https://<host>/<stage>`); omit to leave `/agents/*` off. */
  readonly agentIngress?: string;
  /** Default off. On arrives with build slice S6. */
  readonly dedicatedDomains?: boolean;
  /** Default 2,000. */
  readonly tenantRequestsPer5Min?: number;
  /** `host` mode only. Default 500. */
  readonly ipRequestsPer5Min?: number;
  /** CSP and Reporting API endpoint, `https`. */
  readonly reportingEndpoint?: string;
  /** SNS topic in the main stack's account and Region, the ALARM action of every alarm. */
  readonly alarmTopicArn?: string;
}

/** An `https` origin and the full URL it came from. */
export interface Endpoint {
  readonly url: string;
  readonly origin: string;
}

/** The issuer's public settings, normalised: what the `app` key holds and the CSP names (§4.1, §7.1). */
export interface ResolvedIssuer {
  readonly clientId: string;
  readonly scopes: string;
  readonly authorize: Endpoint;
  readonly token: Endpoint;
  readonly logout: Endpoint;
  readonly exchange?: Endpoint;
}

/** The validated inputs, defaults applied. */
export interface ResolvedInputs {
  readonly appDomain: string;
  readonly hostedZone: HostedZoneInput;
  readonly addressing: Addressing;
  readonly applicationId: string;
  readonly controlPlane: ControlPlaneInput;
  readonly fleet: string;
  readonly edgeOperatorRoleArn: string;
  /** The edge account: the account of `edgeOperatorRoleArn` (§3.6). */
  readonly edgeAccount: string;
  readonly partition: string;
  readonly issuer: ResolvedIssuer;
  /** Present in `host` mode only. */
  readonly signinKeys?: SigninKeysInput;
  readonly tenantClaim: string;
  readonly spaSource: string;
  readonly agentIngress?: { readonly domainName: string; readonly originPath?: string };
  readonly tenantRequestsPer5Min: number;
  readonly ipRequestsPer5Min: number;
  readonly reportingEndpoint?: string;
  readonly alarmTopicArn?: string;
  /** Warnings the stacks add as annotations. */
  readonly warnings: readonly string[];
}

/** ACM's limit on a certificate's primary name (§3.6). */
export const MAX_APP_DOMAIN_LENGTH = 64;

/** WAF's bounds on a rate-based rule's limit. */
export const MIN_RATE_LIMIT = 10;
export const MAX_RATE_LIMIT = 2_000_000_000;

export const DEFAULT_TENANT_REQUESTS_PER_5_MIN = 2_000;
export const DEFAULT_IP_REQUESTS_PER_5_MIN = 500;
export const DEFAULT_SPA_SOURCE = 'build/spa';
export const DEFAULT_SIGNIN_KEYS: SigninKeysInput = { ids: ['k1'], current: 'k1' };

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOSTNAME = new RegExp(`^${LABEL}(?:\\.${LABEL})+$`);
const ACCOUNT = /^\d{12}$/;
const REGION = /^[a-z]{2}(?:-[a-z]+)+-\d$/;
const PARTITION = '(aws|aws-cn|aws-us-gov)';
const APPLICATION_ID = /^[a-z0-9-]{1,32}$/;
const FLEET = /^[a-z0-9-]{1,32}$/;
const ZONE_ID = /^[A-Z0-9]{1,32}$/;
const ROLE_ARN = new RegExp(`^arn:${PARTITION}:iam::(\\d{12}):role/[\\w+=,.@/-]{1,512}$`);
const SECRET_ARN = new RegExp(`^arn:${PARTITION}:secretsmanager:([a-z0-9-]+):(\\d{12}):secret:[\\w/+=.@-]+-[A-Za-z0-9]{6}$`);
const TOPIC_ARN = new RegExp(`^arn:${PARTITION}:sns:([a-z0-9-]+):(\\d{12}):[\\w-]{1,256}$`);
/** An OAuth client id with no character that needs JSON or header escaping. */
const CLIENT_ID = /^[A-Za-z0-9._~+-]{1,128}$/;
/** RFC 6749 scope-token. */
const SCOPE = /^[\x21\x23-\x5b\x5d-\x7e]+$/;
/** A JWT claim name the router can compile in as a plain string. */
const CLAIM = /^[A-Za-z_][A-Za-z0-9_:.-]{0,63}$/;

/** Validates every §3.6 input and applies the defaults. Throws a message naming the input. */
export function validateInputs(inputs: TenantFrontDoorInputs): ResolvedInputs {
  const warnings: string[] = [];

  if (inputs.dedicatedDomains !== undefined && typeof inputs.dedicatedDomains !== 'boolean') {
    throw new InputError('dedicatedDomains', 'must be true or false');
  }
  if (inputs.dedicatedDomains) {
    throw new InputError('dedicatedDomains', 'is not available yet: dedicated domains arrive in build slice S6. Leave it off');
  }

  const appDomain = hostname('appDomain', inputs.appDomain);
  if (appDomain.length > MAX_APP_DOMAIN_LENGTH) {
    throw new InputError('appDomain', `must be at most ${MAX_APP_DOMAIN_LENGTH} characters (ACM's limit on a certificate's primary name)`);
  }

  const addressing = inputs.addressing ?? 'single';
  if (addressing !== 'single' && addressing !== 'host') {
    throw new InputError('addressing', 'must be "single" or "host"');
  }

  const hostedZone = validateHostedZone(inputs.hostedZone, appDomain, addressing);

  const applicationId = matching('applicationId', inputs.applicationId, APPLICATION_ID, '[a-z0-9-]{1,32}');
  const fleet = matching('fleet', inputs.fleet, FLEET, '[a-z0-9-]{1,32}');

  const roleMatch = ROLE_ARN.exec(requireString('edgeOperatorRoleArn', inputs.edgeOperatorRoleArn));
  if (roleMatch === null) {
    throw new InputError('edgeOperatorRoleArn', 'must be an IAM role ARN, arn:<partition>:iam::<account>:role/<name>');
  }
  const [, partition, edgeAccount] = roleMatch;

  const controlPlane = validateControlPlane(inputs.controlPlane);
  // The registrar reads it with its own identity policy, from the main
  // stack's Region, so the secret sits beside it (ADR-0015).
  const secret = SECRET_ARN.exec(controlPlane.vendorIdp.clientSecretArn)!;
  if (secret[1] !== partition || secret[2] !== controlPlane.region || secret[3] !== edgeAccount) {
    throw new InputError('controlPlane.vendorIdp.clientSecretArn', 'must name a secret in the edge account, the control plane\'s Region and the edgeOperatorRoleArn partition');
  }
  const issuer = validateIssuer(inputs.issuer);

  let signinKeys: SigninKeysInput | undefined;
  if (addressing === 'host') {
    signinKeys = validateSigninKeys(inputs.signinKeys ?? DEFAULT_SIGNIN_KEYS);
  } else if (inputs.signinKeys !== undefined) {
    throw new InputError('signinKeys', 'applies to host mode only; remove it in single mode');
  }

  const tenantClaim = inputs.tenantClaim ?? TENANT_CLAIM;
  if (typeof tenantClaim !== 'string' || !CLAIM.test(tenantClaim)) {
    throw new InputError('tenantClaim', 'must be a claim name of at most 64 characters from [A-Za-z0-9_:.-], starting with a letter or _');
  }
  if (tenantClaim === MULTI_TENANT_CLAIM) {
    throw new InputError('tenantClaim', `must not be "${MULTI_TENANT_CLAIM}", the multi-tenant claim the edge refuses (§3.3 step 5)`);
  }

  const spaSource = inputs.spaSource ?? DEFAULT_SPA_SOURCE;
  requireString('spaSource', spaSource);

  const agentIngress = inputs.agentIngress === undefined ? undefined : validateAgentIngress(inputs.agentIngress);

  const tenantRequestsPer5Min = rate('tenantRequestsPer5Min', inputs.tenantRequestsPer5Min ?? DEFAULT_TENANT_REQUESTS_PER_5_MIN);
  if (addressing === 'single' && inputs.tenantRequestsPer5Min !== undefined) {
    warnings.push(
      `tenantRequestsPer5Min (${tenantRequestsPer5Min}) has no edge rule in single mode: each cell limits its verified tenants `
      + 'to it (spec §6.1, ADR-0009); configure the cells with the same value',
    );
  }
  if (addressing === 'single' && inputs.ipRequestsPer5Min !== undefined) {
    throw new InputError('ipRequestsPer5Min', 'applies to host mode only; remove it in single mode');
  }
  const ipRequestsPer5Min = rate('ipRequestsPer5Min', inputs.ipRequestsPer5Min ?? DEFAULT_IP_REQUESTS_PER_5_MIN);
  if (addressing === 'host' && ipRequestsPer5Min >= tenantRequestsPer5Min) {
    warnings.push(
      `ipRequestsPer5Min (${ipRequestsPer5Min}) is not below tenantRequestsPer5Min (${tenantRequestsPer5Min}): `
      + 'the per-host rule never binds first for one address (ADR-0021)',
    );
  }

  const reportingEndpoint = inputs.reportingEndpoint === undefined ? undefined : httpsUrl('reportingEndpoint', inputs.reportingEndpoint).url;

  let alarmTopicArn: string | undefined;
  if (inputs.alarmTopicArn !== undefined) {
    const topic = TOPIC_ARN.exec(requireString('alarmTopicArn', inputs.alarmTopicArn));
    if (topic === null) {
      throw new InputError('alarmTopicArn', 'must be an SNS topic ARN');
    }
    if (topic[1] !== partition || topic[2] !== controlPlane.region || topic[3] !== edgeAccount) {
      throw new InputError('alarmTopicArn', 'must name a topic in the main stack\'s account and Region (the edge account, the control plane\'s Region)');
    }
    alarmTopicArn = inputs.alarmTopicArn;
  }

  return {
    appDomain,
    hostedZone,
    addressing,
    applicationId,
    controlPlane,
    fleet,
    edgeOperatorRoleArn: inputs.edgeOperatorRoleArn,
    edgeAccount,
    partition,
    issuer,
    signinKeys,
    tenantClaim,
    spaSource,
    agentIngress,
    tenantRequestsPer5Min,
    ipRequestsPer5Min,
    reportingEndpoint,
    alarmTopicArn,
    warnings,
  };
}

/** A synth-time input error; the message starts with the input's name. */
export class InputError extends Error {
  constructor(input: string, problem: string) {
    super(`tenant-front-door input ${input} ${problem} (spec §3.6)`);
    this.name = 'InputError';
  }
}

function validateHostedZone(zone: HostedZoneInput | undefined, appDomain: string, addressing: Addressing): HostedZoneInput {
  if (zone === undefined || typeof zone !== 'object') {
    throw new InputError('hostedZone', 'is required: { "zoneId": "...", "zoneName": "..." }');
  }
  const zoneId = matching('hostedZone.zoneId', zone.zoneId, ZONE_ID, '[A-Z0-9]{1,32}');
  const zoneName = hostname('hostedZone.zoneName', zone.zoneName);
  if (appDomain !== zoneName && !appDomain.endsWith(`.${zoneName}`)) {
    throw new InputError('hostedZone', `must be the zone of appDomain: ${appDomain} is not in ${zoneName}`);
  }
  if (addressing === 'single' && appDomain === zoneName) {
    // The front door points appDomain at the connection group's routing
    // endpoint with a CNAME (spike S-1), which cannot sit at a zone apex.
    throw new InputError('appDomain', 'must be below the hostedZone apex in single mode: its CNAME cannot sit at the zone apex');
  }
  return { zoneId, zoneName };
}

function validateControlPlane(cp: ControlPlaneInput | undefined): ControlPlaneInput {
  if (cp === undefined || typeof cp !== 'object') {
    throw new InputError('controlPlane', 'is required: { apiUrl, accountId, region, vendorIdp: { tokenUrl, clientId, clientSecretArn } }');
  }
  const apiUrl = httpsUrl('controlPlane.apiUrl', cp.apiUrl).url;
  const accountId = matching('controlPlane.accountId', cp.accountId, ACCOUNT, '12 digits');
  const region = matching('controlPlane.region', cp.region, REGION, 'an AWS Region name');
  const idp = cp.vendorIdp;
  if (idp === undefined || typeof idp !== 'object') {
    throw new InputError('controlPlane.vendorIdp', 'is required: { tokenUrl, clientId, clientSecretArn }');
  }
  const tokenUrl = httpsUrl('controlPlane.vendorIdp.tokenUrl', idp.tokenUrl).url;
  const clientId = matching('controlPlane.vendorIdp.clientId', idp.clientId, CLIENT_ID, '[A-Za-z0-9._~+-]{1,128}');
  const clientSecretArn = matching(
    'controlPlane.vendorIdp.clientSecretArn',
    idp.clientSecretArn,
    SECRET_ARN,
    'a full Secrets Manager secret ARN, with its six-character suffix',
  );
  return { apiUrl, accountId, region, vendorIdp: { tokenUrl, clientId, clientSecretArn } };
}

function validateIssuer(issuer: IssuerInput | undefined): ResolvedIssuer {
  if (issuer === undefined || typeof issuer !== 'object') {
    throw new InputError('issuer', 'is required: { clientId, scopes, cognitoDomain } or { clientId, scopes, authorizeEndpoint, tokenEndpoint, logoutEndpoint }');
  }
  const clientId = matching('issuer.clientId', issuer.clientId, CLIENT_ID, '[A-Za-z0-9._~+-]{1,128}');
  const scopeList = typeof issuer.scopes === 'string' ? issuer.scopes.split(' ').filter((s) => s !== '') : issuer.scopes;
  if (!Array.isArray(scopeList) || scopeList.length === 0 || !scopeList.every((s) => typeof s === 'string' && SCOPE.test(s))) {
    throw new InputError('issuer.scopes', 'must hold at least one OAuth scope, each without spaces, quotes or backslashes');
  }

  const explicit = [issuer.authorizeEndpoint, issuer.tokenEndpoint, issuer.logoutEndpoint];
  let authorize: Endpoint;
  let token: Endpoint;
  let logout: Endpoint;
  if (issuer.cognitoDomain !== undefined) {
    if (explicit.some((e) => e !== undefined)) {
      throw new InputError('issuer', 'takes cognitoDomain or the three endpoints, not both');
    }
    const raw = requireString('issuer.cognitoDomain', issuer.cognitoDomain);
    const domain = httpsUrl('issuer.cognitoDomain', raw.includes('://') ? raw : `https://${raw}`, { originOnly: true });
    authorize = endpoint(`${domain.origin}/oauth2/authorize`);
    token = endpoint(`${domain.origin}/oauth2/token`);
    logout = endpoint(`${domain.origin}/logout`);
  } else {
    if (explicit.some((e) => e === undefined)) {
      throw new InputError('issuer', 'needs cognitoDomain, or all of authorizeEndpoint, tokenEndpoint and logoutEndpoint');
    }
    authorize = httpsUrl('issuer.authorizeEndpoint', issuer.authorizeEndpoint);
    token = httpsUrl('issuer.tokenEndpoint', issuer.tokenEndpoint);
    logout = httpsUrl('issuer.logoutEndpoint', issuer.logoutEndpoint);
  }
  const exchange = issuer.exchangeEndpoint === undefined ? undefined : httpsUrl('issuer.exchangeEndpoint', issuer.exchangeEndpoint);
  return { clientId, scopes: scopeList.join(' '), authorize, token, logout, exchange };
}

function validateSigninKeys(keys: SigninKeysInput): SigninKeysInput {
  if (keys === null || typeof keys !== 'object' || !Array.isArray(keys.ids)) {
    throw new InputError('signinKeys', 'must be { "ids": ["k1"], "current": "k1" }');
  }
  if (keys.ids.length < 1 || keys.ids.length > 2) {
    throw new InputError('signinKeys.ids', 'must hold one or two key ids');
  }
  if (!keys.ids.every((id) => typeof id === 'string' && SIGNIN_KID.test(id))) {
    throw new InputError('signinKeys.ids', 'must each match [a-z0-9]{1,8}');
  }
  if (new Set(keys.ids).size !== keys.ids.length) {
    throw new InputError('signinKeys.ids', 'must be unique');
  }
  if (!keys.ids.includes(keys.current)) {
    throw new InputError('signinKeys.current', 'must be one of signinKeys.ids');
  }
  return { ids: [...keys.ids], current: keys.current };
}

function validateAgentIngress(value: string): { domainName: string; originPath?: string } {
  const url = httpsUrl('agentIngress', value);
  const parsed = new URL(url.url);
  const path = parsed.pathname.replace(/\/+$/, '');
  if (path !== '' && !/^(?:\/[A-Za-z0-9._~-]+)+$/.test(path)) {
    throw new InputError('agentIngress', 'must have a plain origin path, for example https://<host>/prod');
  }
  return { domainName: parsed.hostname, originPath: path === '' ? undefined : path };
}

function httpsUrl(input: string, value: unknown, options: { originOnly?: boolean } = {}): Endpoint {
  const raw = requireString(input, value);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new InputError(input, 'must be an https URL');
  }
  if (url.protocol !== 'https:') {
    throw new InputError(input, 'must be an https URL');
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new InputError(input, 'must have no credentials, query or fragment');
  }
  if (url.port !== '') {
    throw new InputError(input, 'must use the default https port');
  }
  if (!HOSTNAME.test(url.hostname)) {
    throw new InputError(input, 'must name a DNS host');
  }
  if (options.originOnly === true && url.pathname !== '/') {
    throw new InputError(input, 'must be a domain with no path');
  }
  return endpoint(url.href);
}

function endpoint(href: string): Endpoint {
  const url = new URL(href);
  return { url: url.href, origin: url.origin };
}

function hostname(input: string, value: unknown): string {
  const host = requireString(input, value).toLowerCase();
  if (!HOSTNAME.test(host)) {
    throw new InputError(input, 'must be a DNS name of two or more labels, with no wildcard and no trailing dot');
  }
  return host;
}

function matching(input: string, value: unknown, pattern: RegExp, form: string): string {
  const s = requireString(input, value);
  if (!pattern.test(s)) {
    throw new InputError(input, `must match ${form}`);
  }
  return s;
}

function rate(input: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < MIN_RATE_LIMIT || value > MAX_RATE_LIMIT) {
    throw new InputError(input, `must be an integer from ${MIN_RATE_LIMIT} to ${MAX_RATE_LIMIT}`);
  }
  return value;
}

function requireString(input: string, value: unknown): string {
  if (typeof value !== 'string' || value === '') {
    throw new InputError(input, 'is required');
  }
  return value;
}
