// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { createHash } from 'node:crypto';
import { ACMClient, RequestCertificateCommand } from '@aws-sdk/client-acm';
import {
  CloudFrontClient,
  CreateDistributionTenantCommand,
  GetDistributionTenantByDomainCommand,
  ListTagsForResourceCommand,
  UpdateDistributionTenantCommand,
} from '@aws-sdk/client-cloudfront';
import {
  acmMock,
  certificateArn,
  cloudFrontMock,
  DISTRIBUTION_ID,
  distributionTenantArn,
  dtTags,
  FakeAcm,
  FakeCloudFront,
  FakeDns,
  installAcm,
  installCloudFront,
  OTHER_DISTRIBUTION_ID,
  ownTags,
  validationRecord,
} from './domains-support';
import { CELL, CELL_ACCOUNT, DT, harness, type Harness, json, restEvent, TENANT, TENANT_2, testConfig } from './support';
import { AwsDedicatedDomains, distributionTenantName, MAX_ROUNDS, newChallengeToken, RECORD_READS } from '../../src/registrar/dedicated-domains';
import { CHALLENGE_TTL_SECONDS, TAG_COST_TENANT_ID, TAG_DISTRIBUTION_ID, TAG_TENANT_ID } from '../../src/shared/contracts';
import {
  cellEntry,
  cellKey,
  decodeTenantEntry,
  encodeEntry,
  hostEntry,
  hostKey,
  type TenantEntry,
  tenantEntry,
  tenantKey,
} from '../../src/shared/route-table';

const t = TENANT.toLowerCase();
const t2 = TENANT_2.toLowerCase();
const c = CELL.toLowerCase();
const D = 'portal.example.com';
const D_OLD = 'old-portal.example.com';
const NAME = `_tfd-challenge.${D}`;
const NOW_MS = DT + 86_400_000;
const NOW_S = Math.floor(NOW_MS / 1000);
const TOKEN_1 = '1'.repeat(43);
const TOKEN_2 = '2'.repeat(43);
const record = (token: string): string => `tfd-verify=${token}`;
const CONNECTION_GROUP_ID = 'cg_example';

interface Rig extends Harness {
  readonly dns: FakeDns;
  readonly acm: FakeAcm;
  readonly cf: FakeCloudFront;
  readonly domainsImpl: AwsDedicatedDomains;
  /** The seam's own waits: DNS lookup gaps and validation-record reads. */
  readonly domainSleeps: number[];
}

function rig(): Rig {
  const dns = new FakeDns();
  const acm = new FakeAcm();
  const cf = new FakeCloudFront();
  installAcm(acm);
  installCloudFront(cf);
  const tokens = [TOKEN_1, TOKEN_2, '3'.repeat(43), '4'.repeat(43), '5'.repeat(43), '6'.repeat(43)];
  const domainSleeps: number[] = [];
  const domainsImpl = new AwsDedicatedDomains({
    acm: new ACMClient({ region: 'us-east-1' }),
    cloudfront: new CloudFrontClient({ region: 'us-east-1' }),
    distributionId: DISTRIBUTION_ID,
    connectionGroupId: CONNECTION_GROUP_ID,
    lookup: dns,
    now: () => NOW_MS,
    sleep: async (ms) => void domainSleeps.push(ms),
    newToken: () => tokens.shift()!,
  });
  const h = harness(testConfig({ dedicatedDomains: true, distributionId: DISTRIBUTION_ID }), domainsImpl);
  h.cp.deployment(TENANT, { status: 'ACTIVE' });
  h.kvs.items.set(cellKey(c), encodeEntry(cellEntry({ ac: CELL_ACCOUNT, o: 'abcdefghijklmnopqrstuvwxyz012345.lambda-url.eu-central-1.on.aws' })));
  seedTenant(h, {});
  return Object.assign(h, { dns, acm, cf, domainsImpl, domainSleeps });
}

function seedTenant(h: Harness, fields: Partial<Parameters<typeof tenantEntry>[0]>, tenantId = t): void {
  h.kvs.items.set(tenantKey(tenantId), encodeEntry(tenantEntry({ c, ac: CELL_ACCOUNT, dt: DT, s: 'active', n: 'Acme Corp', ...fields })));
}

function stored(h: Harness, tenantId = t): TenantEntry {
  return decodeTenantEntry(h.kvs.items.get(tenantKey(tenantId))!);
}

async function put(h: Harness, customDomain = D): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const res = await h.handler(restEvent('PUT', `/tenants/${TENANT}`, 'operator', { customDomain }));
  return { statusCode: res.statusCode, body: json(res.body) };
}

/** A tenant route with a passed challenge for D. */
function passed(h: Rig, dk = TOKEN_1): void {
  seedTenant(h, { d: D, dk });
}

function issuedCertificate(h: Rig, n = 1): string {
  const arn = certificateArn(n);
  h.acm.add(arn, { domain: D, status: 'ISSUED', tags: ownTags(t), record: validationRecord(D) });
  return arn;
}

let logSpy: jest.SpyInstance;
beforeEach(() => {
  logSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
});
afterEach(() => logSpy.mockRestore());

// ===========================================================================
// Sub-step 1: a new domain
// ===========================================================================

describe('§3.4 step 5 sub-step 1: a new domain is written first, with a new challenge', () => {
  test('202 domain-challenge with the TXT record; d, dk and dx 7 days out; no lookup, no certificate', async () => {
    const h = rig();
    const res = await put(h);
    expect(res.statusCode).toBe(202);
    expect(res.body).toEqual({
      tenantId: TENANT,
      dt: DT,
      stage: 'domain-challenge',
      record: { name: NAME, type: 'TXT', value: record(TOKEN_1) },
      expiresAt: NOW_S + CHALLENGE_TTL_SECONDS,
    });
    expect(stored(h)).toEqual(expect.objectContaining({ c, ac: CELL_ACCOUNT, dt: DT, s: 'active', n: 'Acme Corp', d: D, dk: TOKEN_1, dx: NOW_S + CHALLENGE_TTL_SECONDS }));
    expect(h.dns.txtNames).toEqual([]);
    expect(acmMock.commandCalls(RequestCertificateCommand)).toHaveLength(0);
    expect(h.kvs.items.has(hostKey(D))).toBe(false);
  });

  test('the token is 32 random bytes, base64url without padding (43 characters)', () => {
    const a = newChallengeToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(a, 'base64url')).toHaveLength(32);
    expect(newChallengeToken()).not.toBe(a);
  });

  test('a suspended tenant keeps s', async () => {
    const h = rig();
    seedTenant(h, { s: 'suspended' });
    await put(h);
    expect(stored(h).s).toBe('suspended');
  });

  test('a changed domain removes the old d, its challenge and its host#<d>, and disables its distribution tenant', async () => {
    const h = rig();
    seedTenant(h, { d: D_OLD, dk: TOKEN_2 });
    h.kvs.items.set(hostKey(D_OLD), encodeEntry(hostEntry({ t, ac: CELL_ACCOUNT })));
    h.cf.add(D_OLD, { Id: 'dt_old', DistributionId: DISTRIBUTION_ID, Tags: dtTags(t), Enabled: true });
    const res = await put(h);
    expect(res.statusCode).toBe(202);
    expect(stored(h)).toEqual(expect.objectContaining({ d: D, dk: TOKEN_1 }));
    expect(h.kvs.items.has(hostKey(D_OLD))).toBe(false);
    expect(h.cf.tenants.get(D_OLD)!.tenant.Enabled).toBe(false);
  });

  test('§3.4 step 4: a registrar certificate for the domain tagged with another tenant is 409, and no challenge is issued', async () => {
    const h = rig();
    h.acm.add(certificateArn(9), { domain: D, status: 'PENDING_VALIDATION', tags: ownTags(t2) });
    const res = await put(h);
    expect(res.statusCode).toBe(409);
    expect(JSON.stringify(res.body)).not.toContain(t2);
    expect(stored(h).d).toBeUndefined();
  });

  test('§3.4 step 4: a certificate tagged with another distribution is another claim: 409', async () => {
    const h = rig();
    h.acm.add(certificateArn(9), { domain: D, status: 'ISSUED', tags: ownTags(t, OTHER_DISTRIBUTION_ID) });
    expect((await put(h)).statusCode).toBe(409);
  });

  test('§3.4 step 4: the claim check reads every page of the certificate list', async () => {
    const h = rig();
    h.acm.pageSize = 1;
    h.acm.add(certificateArn(7), { domain: 'unrelated.example.com', status: 'ISSUED', tags: [] });
    h.acm.add(certificateArn(8), { domain: D, status: 'ISSUED', tags: [] });
    h.acm.add(certificateArn(9), { domain: D, status: 'ISSUED', tags: ownTags(t2) });
    expect((await put(h)).statusCode).toBe(409);
  });

  test('a certificate for the domain without the registrar tags is not a claim', async () => {
    const h = rig();
    h.acm.add(certificateArn(9), { domain: D, status: 'ISSUED', tags: [{ Key: 'team', Value: 'web' }] });
    expect((await put(h)).statusCode).toBe(202);
  });

  test('a repeat with the challenge open looks the record up and keeps the token', async () => {
    const h = rig();
    await put(h);
    const res = await put(h);
    expect(res.statusCode).toBe(202);
    expect(res.body).toEqual(expect.objectContaining({ stage: 'domain-challenge', challenge: 'missing', record: { name: NAME, type: 'TXT', value: record(TOKEN_1) } }));
    expect(stored(h).dk).toBe(TOKEN_1);
  });
});

// ===========================================================================
// Sub-step 2: the challenge is open
// ===========================================================================

describe('§3.4 step 5 sub-step 2: the open challenge', () => {
  function open(h: Rig, dx = NOW_S + 3600): void {
    seedTenant(h, { d: D, dk: TOKEN_1, dx });
  }

  test.each([
    ['missing', [] as never[], []],
    ['mismatch', [[[record(TOKEN_2)]]], []],
    ['unresolved', ['ESERVFAIL'], []],
    ['mismatch', [[[record(TOKEN_1)]]], [['elsewhere.example.net']]],
  ])('202 domain-challenge %s, the same record; nothing written, no certificate', async (challenge, txt, cname) => {
    const h = rig();
    open(h);
    h.dns.script(txt as never, cname as never);
    const before = h.kvs.items.get(tenantKey(t));
    const res = await put(h);
    expect(res.statusCode).toBe(202);
    expect(res.body).toEqual({ tenantId: TENANT, dt: DT, stage: 'domain-challenge', challenge, record: { name: NAME, type: 'TXT', value: record(TOKEN_1) }, expiresAt: NOW_S + 3600 });
    expect(h.kvs.items.get(tenantKey(t))).toBe(before);
    expect(acmMock.commandCalls(RequestCertificateCommand)).toHaveLength(0);
  });

  test('an expired challenge gets a new token and expiry, with no lookup; the old token no longer passes', async () => {
    const h = rig();
    const expired = '0'.repeat(43);
    seedTenant(h, { d: D, dk: expired, dx: NOW_S });
    h.dns.script([[[record(expired)]]]);
    const res = await put(h);
    expect(res.statusCode).toBe(202);
    expect(res.body).toEqual(expect.objectContaining({ stage: 'domain-challenge', record: { name: NAME, type: 'TXT', value: record(TOKEN_1) }, expiresAt: NOW_S + CHALLENGE_TTL_SECONDS }));
    expect(res.body.challenge).toBeUndefined();
    expect(stored(h)).toEqual(expect.objectContaining({ d: D, dk: TOKEN_1, dx: NOW_S + CHALLENGE_TTL_SECONDS }));
    expect(h.dns.txtNames).toEqual([]);
  });

  test('a pass removes dx, keeps dk, and requests the certificate in the same call: 202 certificate with ACM\'s record', async () => {
    const h = rig();
    open(h);
    h.dns.script([[[record(TOKEN_1)]]]);
    const res = await put(h);
    expect(res.statusCode).toBe(202);
    const v = validationRecord(D);
    expect(res.body).toEqual({ tenantId: TENANT, dt: DT, stage: 'certificate', record: { name: v.Name, type: 'CNAME', value: v.Value } });
    expect(stored(h)).toEqual(expect.objectContaining({ d: D, dk: TOKEN_1 }));
    expect(stored(h).dx).toBeUndefined();
    const req = acmMock.commandCalls(RequestCertificateCommand)[0].args[0].input;
    expect(req).toEqual({
      DomainName: D,
      ValidationMethod: 'DNS',
      IdempotencyToken: expect.stringMatching(/^[0-9a-f]{32}$/),
      Tags: [{ Key: TAG_TENANT_ID, Value: t }, { Key: TAG_DISTRIBUTION_ID, Value: DISTRIBUTION_ID }, { Key: TAG_COST_TENANT_ID, Value: TENANT }],
    });
  });

  test('§3.4 step 5: a pass is not written when another writer replaced dk meanwhile; the new token is looked up', async () => {
    const h = rig();
    open(h);
    h.dns.script([[[record(TOKEN_1)]]]);
    let raced = false;
    h.kvs.beforeUpdate = () => {
      if (raced) return false;
      raced = true;
      seedTenant(h, { d: D, dk: TOKEN_2, dx: NOW_S + 3600 });
      h.kvs.version++;
      return true;
    };
    const res = await put(h);
    expect(res.statusCode).toBe(202);
    expect(res.body).toEqual(expect.objectContaining({ stage: 'domain-challenge', challenge: 'mismatch', record: expect.objectContaining({ value: record(TOKEN_2) }) }));
    expect(stored(h)).toEqual(expect.objectContaining({ dk: TOKEN_2, dx: NOW_S + 3600 }));
    expect(acmMock.commandCalls(RequestCertificateCommand)).toHaveLength(0);
  });

  test('§3.4 step 5: an operator write that loses to a delete gets 409', async () => {
    const h = rig();
    open(h);
    h.dns.script([[[record(TOKEN_1)]]]);
    h.kvs.beforeUpdate = () => {
      if (!h.kvs.items.has(tenantKey(t))) return false;
      h.kvs.items.delete(tenantKey(t));
      h.kvs.version++;
      return true;
    };
    expect((await put(h)).statusCode).toBe(409);
  });

  test('§3.4 step 5: another tenant\'s host#<d> written during the race is 409', async () => {
    const h = rig();
    open(h);
    h.dns.script([[[record(TOKEN_1)]]]);
    h.kvs.beforeUpdate = () => {
      if (h.kvs.items.has(hostKey(D))) return false;
      h.kvs.set(hostKey(D), encodeEntry(hostEntry({ t: t2, ac: CELL_ACCOUNT })));
      return true;
    };
    const res = await put(h);
    expect(res.statusCode).toBe(409);
    expect(JSON.stringify(res.body)).not.toContain(t2);
  });
});

// ===========================================================================
// Sub-steps 3, 4 and 6: the certificate
// ===========================================================================

describe('§3.4 step 5 sub-steps 3, 4 and 6: the certificate', () => {
  test('a repeat while pending finds the certificate and requests none', async () => {
    const h = rig();
    passed(h);
    h.acm.add(certificateArn(1), { domain: D, status: 'PENDING_VALIDATION', tags: ownTags(t), record: validationRecord(D) });
    const res = await put(h);
    expect(res.statusCode).toBe(202);
    expect(res.body.stage).toBe('certificate');
    expect(acmMock.commandCalls(RequestCertificateCommand)).toHaveLength(0);
    expect(h.dns.txtNames).toEqual([]);
  });

  test('ACM\'s certificate quota is 429 with reason certificate-quota', async () => {
    const h = rig();
    passed(h);
    h.acm.quotaReached = true;
    const res = await put(h);
    expect(res.statusCode).toBe(429);
    expect(res.body).toEqual({ message: expect.any(String), reason: 'certificate-quota' });
  });

  test('a validation record ACM has not attached yet is read again, then answered without it', async () => {
    const h = rig();
    passed(h);
    h.acm.recordDelay = 2;
    let res = await put(h);
    expect(res.body.record).toEqual(expect.objectContaining({ type: 'CNAME' }));
    expect(h.domainSleeps).toEqual([1000, 1000]);

    const late = rig();
    passed(late);
    late.acm.recordDelay = RECORD_READS;
    res = await put(late);
    expect(res.statusCode).toBe(202);
    expect(res.body).toEqual({ tenantId: TENANT, dt: DT, stage: 'certificate' });
  });

  /** The idempotency token the registrar derives for D under `dk`. */
  const idempotency = (dk: string): string => createHash('sha256').update(`${DISTRIBUTION_ID}\n${t}\n${D}\n${dk}`).digest('hex').slice(0, 32);

  test.each([
    ['FAILED', 'CAA_ERROR', /failed validation: CAA_ERROR/],
    ['VALIDATION_TIMED_OUT', undefined, /timed out/],
  ])('a request that returns a certificate %s (ACM\'s hour, the same challenge) is 422 carrying ACM\'s reason', async (status, failureReason, message) => {
    const h = rig();
    passed(h);
    h.acm.add(certificateArn(1), { domain: D, status, failureReason, tags: ownTags(t), idempotencyToken: idempotency(TOKEN_1) });
    const res = await put(h);
    expect(res.statusCode).toBe(422);
    expect(res.body.message).toMatch(message);
    expect(h.kvs.items.has(hostKey(D))).toBe(false);
  });

  test.each(['FAILED', 'VALIDATION_TIMED_OUT', 'REVOKED', 'EXPIRED'])('a certificate %s counts as absent: a new one is requested', async (status) => {
    const h = rig();
    passed(h);
    h.acm.add(certificateArn(1), { domain: D, status, tags: ownTags(t) });
    const res = await put(h);
    expect(res.statusCode).toBe(202);
    expect(res.body.stage).toBe('certificate');
    expect(acmMock.commandCalls(RequestCertificateCommand)).toHaveLength(1);
  });

  test('sub-step 6: dropped and set again over a failed certificate, the new challenge gets a new certificate', async () => {
    const h = rig();
    h.acm.add(certificateArn(1), { domain: D, status: 'FAILED', failureReason: 'OTHER', tags: ownTags(t), idempotencyToken: idempotency(TOKEN_2) });
    expect((await put(h)).body.stage).toBe('domain-challenge');
    h.dns.script([[[record(TOKEN_1)]]]);
    const res = await put(h);
    expect(res.statusCode).toBe(202);
    expect(res.body.stage).toBe('certificate');
    expect(acmMock.commandCalls(RequestCertificateCommand)[0].args[0].input.IdempotencyToken).toBe(idempotency(TOKEN_1));
    expect(h.acm.requests).toBe(1);
  });

  test('an issued certificate is used before a failed one for the same domain', async () => {
    const h = rig();
    passed(h);
    h.acm.add(certificateArn(1), { domain: D, status: 'FAILED', failureReason: 'OTHER', tags: ownTags(t) });
    issuedCertificate(h, 2);
    h.dns.script([[[record(TOKEN_1)]]]);
    expect((await put(h)).statusCode).toBe(200);
  });
});

// ===========================================================================
// Sub-step 5: issued, the re-check, the distribution tenant and host#<d>
// ===========================================================================

describe('§3.4 step 5 sub-step 5: the certificate issued', () => {
  test.each([
    ['missing', [] as never[]],
    ['mismatch', [[['tfd-verify=someone-else']]]],
    ['unresolved', ['EREFUSED']],
  ])('the record gone is 202 challenge-recheck %s; no distribution tenant, no host#; the challenge stays passed', async (challenge, txt) => {
    const h = rig();
    passed(h);
    issuedCertificate(h);
    h.dns.script(txt as never);
    const res = await put(h);
    expect(res.statusCode).toBe(202);
    expect(res.body).toEqual({ tenantId: TENANT, dt: DT, stage: 'challenge-recheck', challenge, record: { name: NAME, type: 'TXT', value: record(TOKEN_1) } });
    expect(cloudFrontMock.commandCalls(CreateDistributionTenantCommand)).toHaveLength(0);
    expect(h.kvs.items.has(hostKey(D))).toBe(false);
    expect(stored(h)).toEqual(expect.objectContaining({ d: D, dk: TOKEN_1 }));
    expect(stored(h).dx).toBeUndefined();
  });

  test('the record still there: the distribution tenant is created with the certificate and tags, host#<d> written, 200', async () => {
    const h = rig();
    passed(h);
    const arn = issuedCertificate(h);
    h.dns.script([[[record(TOKEN_1)]]]);
    const res = await put(h);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ tenantId: TENANT, dt: DT });
    expect(cloudFrontMock.commandCalls(CreateDistributionTenantCommand)[0].args[0].input).toEqual({
      DistributionId: DISTRIBUTION_ID,
      Name: distributionTenantName(DISTRIBUTION_ID, t, D),
      Domains: [{ Domain: D }],
      ConnectionGroupId: CONNECTION_GROUP_ID,
      Customizations: { Certificate: { Arn: arn } },
      Tags: {
        Items: [{ Key: TAG_TENANT_ID, Value: t }, { Key: TAG_DISTRIBUTION_ID, Value: DISTRIBUTION_ID }, { Key: TAG_COST_TENANT_ID, Value: TENANT }],
      },
      Enabled: true,
    });
    expect(h.kvs.items.get(hostKey(D))).toBe(encodeEntry(hostEntry({ t, ac: CELL_ACCOUNT })));
  });

  test('the distribution tenant\'s name is a hash within CloudFront\'s 128 characters, for the longest id and domain', () => {
    const longest = `${'a'.repeat(63)}`;
    const domain = `${'b'.repeat(51)}.example.com`;
    const name = distributionTenantName(DISTRIBUTION_ID, longest, domain);
    expect(name).toMatch(/^tfd-[0-9a-f]{32}$/);
    expect(distributionTenantName(DISTRIBUTION_ID, longest, `c${domain.slice(1)}`)).not.toBe(name);
    expect(distributionTenantName(OTHER_DISTRIBUTION_ID, longest, domain)).not.toBe(name);
  });

  test('§3.4 step 5 sub-step 5: a challenge that passed in this call is not resolved again', async () => {
    const h = rig();
    seedTenant(h, { d: D, dk: TOKEN_1, dx: NOW_S + 3600 });
    issuedCertificate(h);
    h.dns.script([[[record(TOKEN_1)]]]);
    const res = await put(h);
    expect(res.statusCode).toBe(200);
    expect(h.dns.txtNames).toEqual([NAME]);
  });

  test('a repeat once host#<d> exists looks nothing up, changes nothing and answers 200', async () => {
    const h = rig();
    passed(h);
    h.kvs.items.set(hostKey(D), encodeEntry(hostEntry({ t, ac: CELL_ACCOUNT })));
    const writes = h.kvs.writes;
    const res = await put(h);
    expect(res.statusCode).toBe(200);
    expect(acmMock.calls()).toHaveLength(0);
    expect(cloudFrontMock.calls()).toHaveLength(0);
    expect(h.dns.txtNames).toEqual([]);
    expect(h.kvs.writes).toBe(writes);
  });

  test('a distribution tenant a crashed call created is found and not created again', async () => {
    const h = rig();
    passed(h);
    const arn = issuedCertificate(h);
    h.cf.add(D, { Id: 'dt_1', DistributionId: DISTRIBUTION_ID, Tags: dtTags(t), Enabled: true, Customizations: { Certificate: { Arn: arn } } });
    h.dns.script([[[record(TOKEN_1)]]]);
    expect((await put(h)).statusCode).toBe(200);
    expect(cloudFrontMock.commandCalls(CreateDistributionTenantCommand)).toHaveLength(0);
    expect(cloudFrontMock.commandCalls(UpdateDistributionTenantCommand)).toHaveLength(0);
  });

  test('reads the found distribution tenant\'s tags with ListTagsForResource, because the lookup carries none', async () => {
    const h = rig();
    passed(h);
    const arn = issuedCertificate(h);
    h.cf.add(D, { Id: 'dt_1', DistributionId: DISTRIBUTION_ID, Tags: dtTags(t), Enabled: true, Customizations: { Certificate: { Arn: arn } } });
    h.dns.script([[[record(TOKEN_1)]]]);
    expect((await put(h)).statusCode).toBe(200);
    expect(cloudFrontMock.commandCalls(GetDistributionTenantByDomainCommand)).toHaveLength(1);
    expect(cloudFrontMock.commandCalls(ListTagsForResourceCommand).map((x) => x.args[0].input)).toEqual([{ Resource: distributionTenantArn('dt_1') }]);
  });

  test('this tenant\'s disabled distribution tenant for the domain is enabled again with the certificate', async () => {
    const h = rig();
    passed(h);
    const arn = issuedCertificate(h);
    h.cf.add(D, { Id: 'dt_1', DistributionId: DISTRIBUTION_ID, Tags: dtTags(t), Enabled: false, Customizations: { Certificate: { Arn: certificateArn(5) } } });
    h.dns.script([[[record(TOKEN_1)]]]);
    expect((await put(h)).statusCode).toBe(200);
    const update = cloudFrontMock.commandCalls(UpdateDistributionTenantCommand)[0].args[0].input;
    expect(update).toEqual(expect.objectContaining({ Id: 'dt_1', IfMatch: 'E1', Enabled: true, Customizations: { Certificate: { Arn: arn } }, Domains: [{ Domain: D }] }));
  });

  test.each([
    ['on another distribution', { DistributionId: OTHER_DISTRIBUTION_ID, Tags: dtTags(t, OTHER_DISTRIBUTION_ID) }],
    ['tagged with another tenant', { DistributionId: DISTRIBUTION_ID, Tags: dtTags(t2) }],
    ['with no tags', { DistributionId: DISTRIBUTION_ID }],
  ])('a distribution tenant for the domain %s is 409, naming no tenant; no host#', async (_why, tenant) => {
    const h = rig();
    passed(h);
    issuedCertificate(h);
    h.cf.add(D, { Id: 'dt_x', Enabled: true, ...tenant });
    h.dns.script([[[record(TOKEN_1)]]]);
    const res = await put(h);
    expect(res.statusCode).toBe(409);
    expect(JSON.stringify(res.body)).not.toContain(t2);
    expect(h.kvs.items.has(hostKey(D))).toBe(false);
    expect(cloudFrontMock.commandCalls(UpdateDistributionTenantCommand)).toHaveLength(0);
  });

  test('CNAMEAlreadyExists is 409 and the d stays pending', async () => {
    const h = rig();
    passed(h);
    issuedCertificate(h);
    h.cf.servedElsewhere = true;
    h.dns.script([[[record(TOKEN_1)]]]);
    expect((await put(h)).statusCode).toBe(409);
    expect(stored(h).d).toBe(D);
    expect(h.kvs.items.has(hostKey(D))).toBe(false);
  });

  test('§3.4 step 5: the host#<d> write is dropped when dk changed meanwhile, and the sub-steps start again', async () => {
    const h = rig();
    passed(h);
    issuedCertificate(h);
    h.dns.script([[[record(TOKEN_1)]]]);
    let raced = false;
    h.kvs.beforeUpdate = () => {
      if (raced) return false;
      raced = true;
      seedTenant(h, { d: D, dk: TOKEN_2, dx: NOW_S + 3600 });
      h.kvs.version++;
      return true;
    };
    const res = await put(h);
    expect(res.statusCode).toBe(202);
    expect(res.body).toEqual(expect.objectContaining({ stage: 'domain-challenge', challenge: 'mismatch' }));
    expect(h.kvs.items.has(hostKey(D))).toBe(false);
  });

  test('a concurrent call that routed the domain meanwhile makes this one answer 200 without a second write', async () => {
    const h = rig();
    passed(h);
    issuedCertificate(h);
    h.dns.script([[[record(TOKEN_1)]]]);
    h.kvs.beforeUpdate = () => {
      if (h.kvs.items.has(hostKey(D))) return false;
      h.kvs.set(hostKey(D), encodeEntry(hostEntry({ t, ac: CELL_ACCOUNT })));
      return true;
    };
    expect((await put(h)).statusCode).toBe(200);
  });

  test(`a tenant route that keeps changing ends in 503 after ${MAX_ROUNDS} rounds`, async () => {
    const h = rig();
    seedTenant(h, { d: D, dk: TOKEN_1, dx: NOW_S + 3600 });
    h.dns.script([[[record(TOKEN_1)]]]);
    let n = 0;
    h.kvs.beforeUpdate = () => {
      n++;
      seedTenant(h, { d: D, dk: TOKEN_1, dx: NOW_S + 3600 + n });
      h.kvs.version++;
      return true;
    };
    expect((await put(h)).statusCode).toBe(503);
  });
});

// ===========================================================================
// releaseDomain: the first phase of the two-phase removal
// ===========================================================================

describe('§3.4 step 5: releaseDomain', () => {
  test('disables this tenant\'s distribution tenant for the domain, with its ETag, keeping its domains and certificate', async () => {
    const h = rig();
    h.cf.add(D, { Id: 'dt_1', DistributionId: DISTRIBUTION_ID, Tags: dtTags(t), Enabled: true, Customizations: { Certificate: { Arn: certificateArn(1) } } });
    await h.domainsImpl.releaseDomain(t, D);
    expect(cloudFrontMock.commandCalls(UpdateDistributionTenantCommand)[0].args[0].input).toEqual(expect.objectContaining({
      Id: 'dt_1',
      DistributionId: DISTRIBUTION_ID,
      IfMatch: 'E1',
      Enabled: false,
      Domains: [{ Domain: D }],
      Customizations: { Certificate: { Arn: certificateArn(1) } },
    }));
    expect(h.cf.tenants.get(D)!.tenant.Enabled).toBe(false);
  });

  test('does nothing when no distribution tenant serves the domain, or it is already disabled', async () => {
    const h = rig();
    await h.domainsImpl.releaseDomain(t, D);
    h.cf.add(D, { Id: 'dt_1', DistributionId: DISTRIBUTION_ID, Tags: dtTags(t), Enabled: false });
    await h.domainsImpl.releaseDomain(t, D);
    expect(cloudFrontMock.commandCalls(UpdateDistributionTenantCommand)).toHaveLength(0);
  });

  test.each([
    ['another tenant', { DistributionId: DISTRIBUTION_ID, Tags: dtTags(t2) }],
    ['another distribution', { DistributionId: OTHER_DISTRIBUTION_ID, Tags: dtTags(t, OTHER_DISTRIBUTION_ID) }],
  ])('touches nothing and logs the refusal by name when the distribution tenant is %s\'s', async (_why, tenant) => {
    const h = rig();
    h.cf.add(D, { Id: 'dt_x', Enabled: true, ...tenant });
    await h.domainsImpl.releaseDomain(t, D);
    expect(cloudFrontMock.commandCalls(UpdateDistributionTenantCommand)).toHaveLength(0);
    const lines = logSpy.mock.calls.map((x) => JSON.parse(String(x[0])));
    expect(lines).toContainEqual({ level: 'WARN', message: 'distribution tenant release failed; the sweeper disables it', tenantId: t, domain: D, error: 'ConflictError' });
  });

  test('is best effort after a committed write: a CloudFront error keeps the answer', async () => {
    const h = rig();
    seedTenant(h, { d: D_OLD, dk: TOKEN_2 });
    h.kvs.items.set(hostKey(D_OLD), encodeEntry(hostEntry({ t, ac: CELL_ACCOUNT })));
    cloudFrontMock.on(GetDistributionTenantByDomainCommand).rejects(Object.assign(new Error('slow down'), { name: 'Throttling' }));
    const res = await put(h);
    expect(res.statusCode).toBe(202);
    expect(stored(h)).toEqual(expect.objectContaining({ d: D, dk: TOKEN_1 }));
    expect(h.kvs.items.has(hostKey(D_OLD))).toBe(false);
    const lines = logSpy.mock.calls.map((x) => JSON.parse(String(x[0])));
    expect(lines).toContainEqual(expect.objectContaining({ message: 'distribution tenant release failed; the sweeper disables it', error: 'Throttling' }));
  });

  test('never touches a certificate: the sweeper deletes it later', async () => {
    const h = rig();
    issuedCertificate(h);
    h.cf.add(D, { Id: 'dt_1', DistributionId: DISTRIBUTION_ID, Tags: dtTags(t), Enabled: true });
    await h.domainsImpl.releaseDomain(t, D);
    expect(acmMock.calls()).toHaveLength(0);
  });
});

// ===========================================================================
// The whole flow, one call after another
// ===========================================================================

test('§5.1: the operator\'s repeats walk the domain from challenge to routed', async () => {
  const h = rig();
  expect((await put(h)).body.stage).toBe('domain-challenge');

  h.dns.script([[[record(TOKEN_1)]]]);
  expect((await put(h)).body.stage).toBe('certificate');

  const arn = [...h.acm.certificates.keys()][0];
  h.acm.certificates.get(arn)!.status = 'ISSUED';
  h.dns.script([[[record(TOKEN_1)]]]);
  expect((await put(h)).statusCode).toBe(200);
  expect(h.cf.tenants.get(D)!.tenant.Tags).toEqual({ Items: [...dtTags(t).Items, { Key: TAG_COST_TENANT_ID, Value: TENANT }] });
  expect(h.kvs.items.has(hostKey(D))).toBe(true);
  expect(acmMock.commandCalls(RequestCertificateCommand)).toHaveLength(1);

  // The log lines name role, key and outcome, never the token.
  const logged = logSpy.mock.calls.map((x) => String(x[0])).join('');
  expect(logged).not.toContain(TOKEN_1);
});
