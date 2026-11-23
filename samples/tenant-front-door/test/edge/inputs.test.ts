// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { BASE_PROPS, EDGE_ACCOUNT, FULL_HOST_PROPS } from './helpers';
import { TenantFrontDoorInputs, validateInputs } from '../../src/edge/inputs';

const base = BASE_PROPS as TenantFrontDoorInputs;
const host: TenantFrontDoorInputs = { ...base, addressing: 'host' };
const withControlPlane = (patch: object) => ({ ...base, controlPlane: { ...base.controlPlane, ...patch } }) as TenantFrontDoorInputs;
const withIssuer = (issuer: object) => ({ ...base, issuer }) as TenantFrontDoorInputs;

describe('deployment inputs (spec §3.6)', () => {
  it('applies the §3.6 defaults', () => {
    const r = validateInputs(base);
    expect(r.addressing).toBe('single');
    expect(r.tenantClaim).toBe('tenant_id');
    expect(r.tenantRequestsPer5Min).toBe(2000);
    expect(r.ipRequestsPer5Min).toBe(500);
    expect(r.signinKeys).toBeUndefined();
    expect(r.agentIngress).toBeUndefined();
    expect(r.edgeAccount).toBe(EDGE_ACCOUNT);
    expect(validateInputs(host).signinKeys).toEqual({ ids: ['k1'], current: 'k1' });
    expect(validateInputs({ ...base, spaSource: undefined }).spaSource).toBe('build/spa');
  });

  it('accepts every optional input (§3.6)', () => {
    const r = validateInputs(FULL_HOST_PROPS);
    expect(r.signinKeys).toEqual({ ids: ['k1', 'k2'], current: 'k2' });
    expect(r.agentIngress).toEqual({ domainName: 'ingress.example.com', originPath: '/prod' });
    expect(r.issuer.exchange?.origin).toBe('https://exchange.example.com');
    expect(r.warnings).toEqual([]);
  });

  describe('appDomain', () => {
    it('is lower-cased', () => {
      expect(validateInputs({ ...base, appDomain: 'App.Example.COM' }).appDomain).toBe('app.example.com');
    });
    it('is at most 64 characters, ACM\'s limit on a primary name (§3.6)', () => {
      const long = `${'a'.repeat(52)}.example.com`; // 64
      expect(validateInputs({ ...base, appDomain: long }).appDomain).toBe(long);
      expect(() => validateInputs({ ...base, appDomain: `a${long}` })).toThrow(/appDomain must be at most 64 characters/);
    });
    it.each(['example', '*.app.example.com', 'app.example.com.', 'app_x.example.com', ''])('refuses %j', (appDomain) => {
      expect(() => validateInputs({ ...base, appDomain })).toThrow(/appDomain/);
    });
  });

  it('refuses an addressing other than single or host (§3.6)', () => {
    expect(() => validateInputs({ ...base, addressing: 'path' as never })).toThrow(/addressing must be "single" or "host"/);
  });

  describe('hostedZone', () => {
    it('must be the zone of appDomain', () => {
      expect(() => validateInputs({ ...base, hostedZone: { zoneId: 'Z1', zoneName: 'other.example' } })).toThrow(/hostedZone must be the zone of appDomain/);
    });
    it('refuses appDomain at the zone apex in single mode, where its CNAME cannot sit', () => {
      expect(() => validateInputs({ ...base, hostedZone: { zoneId: 'Z1', zoneName: 'app.example.com' } })).toThrow(/zone apex/);
      expect(validateInputs({ ...host, hostedZone: { zoneId: 'Z1', zoneName: 'app.example.com' } }).hostedZone.zoneName).toBe('app.example.com');
    });
    it('needs a zone id', () => {
      expect(() => validateInputs({ ...base, hostedZone: { zoneId: 'z-1', zoneName: 'example.com' } })).toThrow(/hostedZone.zoneId/);
      expect(() => validateInputs({ ...base, hostedZone: undefined as never })).toThrow(/hostedZone is required/);
    });
  });

  it.each([
    ['applicationId', 'Demo_App'],
    ['applicationId', 'a'.repeat(33)],
    ['fleet', 'Fleet'],
    ['fleet', ''],
    ['fleet', '-fleet'],
    ['fleet', 'a'.repeat(33)],
  ])('refuses %s %j (control-plane id patterns)', (key, value) => {
    expect(() => validateInputs({ ...base, [key]: value })).toThrow(new RegExp(key));
  });

  it.each(['arn:aws:iam::111111111111:user/someone', 'arn:aws:iam::1111:role/x', 'role/x'])('refuses edgeOperatorRoleArn %j', (arn) => {
    expect(() => validateInputs({ ...base, edgeOperatorRoleArn: arn })).toThrow(/edgeOperatorRoleArn/);
  });

  describe('controlPlane', () => {
    it.each([
      [{ apiUrl: 'http://control-plane.example.com' }, /controlPlane.apiUrl must be an https URL/],
      [{ apiUrl: 'https://control-plane.example.com?x=1' }, /controlPlane.apiUrl must have no credentials, query or fragment/],
      [{ accountId: '12345' }, /controlPlane.accountId/],
      [{ region: 'Europe' }, /controlPlane.region/],
      [{ vendorIdp: undefined }, /controlPlane.vendorIdp is required/],
      [{ vendorIdp: { ...base.controlPlane.vendorIdp, tokenUrl: 'ftp://x.example.com' } }, /vendorIdp.tokenUrl/],
      [{ vendorIdp: { ...base.controlPlane.vendorIdp, clientSecretArn: 'arn:aws:secretsmanager:eu-central-1:111111111111:secret:nosuffix' } }, /clientSecretArn/], // pragma: allowlist secret
      [{ vendorIdp: { ...base.controlPlane.vendorIdp, clientId: 'a"b' } }, /vendorIdp.clientId/],
    ])('refuses %j', (patch, error) => {
      expect(() => validateInputs(withControlPlane(patch))).toThrow(error);
    });
  });

  describe('issuer', () => {
    it('derives the three endpoints from a Cognito domain (§3.6)', () => {
      const r = validateInputs(withIssuer({ clientId: 'c', scopes: 'openid profile', cognitoDomain: 'login.auth.example.com' })).issuer;
      expect(r.authorize.url).toBe('https://login.auth.example.com/oauth2/authorize');
      expect(r.token.url).toBe('https://login.auth.example.com/oauth2/token');
      expect(r.logout.url).toBe('https://login.auth.example.com/logout');
      expect(r.scopes).toBe('openid profile');
    });
    it('takes the three endpoints instead', () => {
      const r = validateInputs(withIssuer({
        clientId: 'c',
        scopes: ['openid'],
        authorizeEndpoint: 'https://idp.example.com/authorize',
        tokenEndpoint: 'https://tokens.example.com/token',
        logoutEndpoint: 'https://idp.example.com/logout',
      })).issuer;
      expect(r.token.origin).toBe('https://tokens.example.com');
    });
    it.each([
      [{ clientId: 'c', scopes: 'openid' }, /needs cognitoDomain, or all of/],
      [{ clientId: 'c', scopes: 'openid', cognitoDomain: 'a.example.com', tokenEndpoint: 'https://a.example.com/t' }, /not both/],
      [{ clientId: 'c', scopes: 'openid', cognitoDomain: 'https://a.example.com/path' }, /cognitoDomain must be a domain with no path/],
      [{ clientId: 'c', scopes: '', cognitoDomain: 'a.example.com' }, /issuer.scopes/],
      [{ clientId: 'c', scopes: ['open"id'], cognitoDomain: 'a.example.com' }, /issuer.scopes/],
      [{ clientId: '', scopes: 'openid', cognitoDomain: 'a.example.com' }, /issuer.clientId/],
      [{ clientId: 'c', scopes: 'openid', cognitoDomain: 'a.example.com', exchangeEndpoint: 'http://x.example.com' }, /exchangeEndpoint/],
      [{
        clientId: 'c',
        scopes: 'openid',
        authorizeEndpoint: 'https://idp.example.com/a',
        tokenEndpoint: 'https://idp.example.com:8443/t',
        logoutEndpoint: 'https://idp.example.com/l',
      }, /default https port/],
    ])('refuses %j', (issuer, error) => {
      expect(() => validateInputs(withIssuer(issuer))).toThrow(error);
    });
  });

  describe('signinKeys (§3.6, §4.1)', () => {
    it.each([
      [{ ids: [], current: 'k1' }, /one or two key ids/],
      [{ ids: ['k1', 'k2', 'k3'], current: 'k1' }, /one or two key ids/],
      [{ ids: ['k1', 'k1'], current: 'k1' }, /unique/],
      [{ ids: ['K1'], current: 'K1' }, /\[a-z0-9\]\{1,8\}/],
      [{ ids: ['abcdefghi'], current: 'abcdefghi' }, /\[a-z0-9\]\{1,8\}/],
      [{ ids: ['k1'], current: 'k2' }, /current must be one of/],
    ])('refuses %j', (signinKeys, error) => {
      expect(() => validateInputs({ ...host, signinKeys })).toThrow(error);
    });
    it('refuses signinKeys in single mode', () => {
      expect(() => validateInputs({ ...base, signinKeys: { ids: ['k1'], current: 'k1' } })).toThrow(/host mode only/);
    });
  });

  it.each(['', '1tenant', 'tenant id', 'a'.repeat(65)])('refuses tenantClaim %j', (tenantClaim) => {
    expect(() => validateInputs({ ...base, tenantClaim })).toThrow(/tenantClaim/);
  });

  it('refuses the multi-tenant claim as tenantClaim (§3.3 step 5)', () => {
    expect(() => validateInputs({ ...base, tenantClaim: 'tenants' })).toThrow(/multi-tenant claim/);
  });

  describe('agentIngress', () => {
    it('splits the base URL into origin and stage', () => {
      expect(validateInputs({ ...base, agentIngress: 'https://abc.execute-api.eu-central-1.amazonaws.com/prod/' }).agentIngress)
        .toEqual({ domainName: 'abc.execute-api.eu-central-1.amazonaws.com', originPath: '/prod' });
      expect(validateInputs({ ...base, agentIngress: 'https://ingress.example.com' }).agentIngress)
        .toEqual({ domainName: 'ingress.example.com', originPath: undefined });
    });
    it.each(['http://ingress.example.com/prod', 'https://ingress.example.com/prod?x=1', 'https://ingress.example.com/a b'])('refuses %j', (agentIngress) => {
      expect(() => validateInputs({ ...base, agentIngress })).toThrow(/agentIngress/);
    });
  });

  describe('rate inputs (ADR-0009, ADR-0021)', () => {
    it.each([9, 2_000_000_001, 1.5, '100'])('refuses tenantRequestsPer5Min %j', (value) => {
      expect(() => validateInputs({ ...base, tenantRequestsPer5Min: value as number })).toThrow(/tenantRequestsPer5Min must be an integer/);
    });
    it('refuses ipRequestsPer5Min in single mode', () => {
      expect(() => validateInputs({ ...base, ipRequestsPer5Min: 100 })).toThrow(/host mode only/);
    });
    it('warns, and does not refuse, an ipRequestsPer5Min at or above tenantRequestsPer5Min', () => {
      const r = validateInputs({ ...host, ipRequestsPer5Min: 2000, tenantRequestsPer5Min: 2000 });
      expect(r.warnings).toEqual([expect.stringMatching(/per-host rule never binds first/)]);
    });
  });

  it('refuses a reportingEndpoint that is not https', () => {
    expect(() => validateInputs({ ...base, reportingEndpoint: 'http://reports.example.com' })).toThrow(/reportingEndpoint/);
  });

  it.each([
    'arn:aws:sns:us-east-1:111111111111:alarms',
    'arn:aws:sns:eu-central-1:333333333333:alarms',
    'arn:aws:sqs:eu-central-1:111111111111:alarms',
  ])('refuses alarmTopicArn %j outside the main stack\'s account and Region (§3.6)', (alarmTopicArn) => {
    expect(() => validateInputs({ ...base, alarmTopicArn })).toThrow(/alarmTopicArn/);
  });

  it('accepts dedicatedDomains on and off, default off, and only a boolean (§3.6)', () => {
    expect(validateInputs({ ...base, dedicatedDomains: true }).dedicatedDomains).toBe(true);
    expect(validateInputs({ ...base, dedicatedDomains: false }).dedicatedDomains).toBe(false);
    expect(validateInputs(base).dedicatedDomains).toBe(false);
    expect(() => validateInputs({ ...base, dedicatedDomains: 'on' as never })).toThrow(/dedicatedDomains must be true or false/);
  });

  it.each([
    'arn:aws:secretsmanager:us-east-1:111111111111:secret:registrar-client-AbCdEf',
    'arn:aws:secretsmanager:eu-central-1:333333333333:secret:registrar-client-AbCdEf',
    'arn:aws-us-gov:secretsmanager:eu-central-1:111111111111:secret:registrar-client-AbCdEf',
  ])('refuses a vendor IdP secret %j outside the edge account and the control plane\'s Region (ADR-0015)', (clientSecretArn) => {
    expect(() => validateInputs(withControlPlane({ vendorIdp: { ...base.controlPlane.vendorIdp, clientSecretArn } }))).toThrow(/clientSecretArn must name a secret/);
  });

  it('warns that tenantRequestsPer5Min is the cells\' to enforce in single mode (ADR-0009)', () => {
    expect(validateInputs({ ...base, tenantRequestsPer5Min: 1000 }).warnings).toEqual([expect.stringMatching(/no edge rule in single mode/)]);
  });
});
