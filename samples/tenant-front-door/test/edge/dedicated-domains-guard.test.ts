// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { ACMClient, ListCertificatesCommand, ListTagsForCertificateCommand, ResourceNotFoundException as AcmNotFound } from '@aws-sdk/client-acm';
import { CloudFrontClient, type DistributionTenantSummary, ListDistributionTenantsCommand } from '@aws-sdk/client-cloudfront';
import { CloudFrontKeyValueStoreClient, ListKeysCommand } from '@aws-sdk/client-cloudfront-keyvaluestore';
import { mockClient } from 'aws-sdk-client-mock';
import { Deps, GuardEvent, GuardProperties, handleEvent, REGISTRAR_DRAIN_MS } from '../../src/custom-resources/dedicated-domains-guard.function';
import { TAG_READS_AT_ONCE } from '../../src/custom-resources/dedicated-resources';
import { TAG_DISTRIBUTION_ID, TAG_TENANT_ID } from '../../src/shared/contracts';
import { encodeEntry, tenantEntry } from '../../src/shared/route-table';

const KVS = 'arn:aws:cloudfront::111111111111:key-value-store/00000000-0000-0000-0000-000000000000';
const DISTRIBUTION = 'E1EXAMPLE';
const POOLED = 'dt_pooled';
const CERT = (n: number) => `arn:aws:acm:us-east-1:111111111111:certificate/${n}`;

const summaries = (...ids: string[]) => ids.map((Id) => ({ Id, DistributionId: DISTRIBUTION }) as DistributionTenantSummary);

const kvs = mockClient(CloudFrontKeyValueStoreClient);
const cloudFront = mockClient(CloudFrontClient);
const acm = mockClient(ACMClient);
const sleeps: number[] = [];
const deps: Deps = {
  kvs: new CloudFrontKeyValueStoreClient({ region: 'us-east-1' }),
  cloudFront: new CloudFrontClient({ region: 'us-east-1' }),
  acm: new ACMClient({ region: 'us-east-1' }),
  sleep: async (ms) => {
    sleeps.push(ms);
  },
};

const PROPS: GuardProperties = { DedicatedDomains: 'off', KeyValueStoreArn: KVS, DistributionId: DISTRIBUTION, PooledTenantId: POOLED };

function event(requestType: GuardEvent['RequestType'], newValue: string, oldValue?: string): GuardEvent {
  return {
    RequestType: requestType,
    PhysicalResourceId: 'dedicated-domains-guard',
    ResponseURL: 'https://cloudformation-response.example.com/x',
    StackId: 'stack',
    RequestId: 'request',
    LogicalResourceId: 'DedicatedDomainsGuard',
    ResourceProperties: { ...PROPS, DedicatedDomains: newValue },
    OldResourceProperties: oldValue === undefined ? undefined : { ...PROPS, DedicatedDomains: oldValue },
  };
}

const turnOff = () => event('Update', 'off', 'on');

const entry = (d?: string) => encodeEntry(tenantEntry({ c: 'cell-1', ac: '333333333333', dt: 1, s: 'active', n: 'Tenant', ...(d === undefined ? {} : { d, dk: 'k'.repeat(43) }) }));

function routeTable(...items: { Key: string; Value: string }[]): void {
  kvs.on(ListKeysCommand).resolves({ Items: items });
}

beforeEach(() => {
  kvs.reset();
  cloudFront.reset();
  acm.reset();
  sleeps.length = 0;
  routeTable({ Key: 'app', Value: '{}' }, { Key: 'tenant#a', Value: entry() });
  cloudFront.on(ListDistributionTenantsCommand).resolves({ DistributionTenantList: summaries(POOLED) });
  acm.on(ListCertificatesCommand).resolves({ CertificateSummaryList: [{ CertificateArn: CERT(1) }] });
  acm.on(ListTagsForCertificateCommand).resolves({ Tags: [{ Key: 'team', Value: 'other' }] });
});

describe('dedicated domains guard (spec §3.4)', () => {
  it.each([
    ['a Create', event('Create', 'on')],
    ['a Delete', event('Delete', 'on')],
    ['an off-to-on Update', event('Update', 'on', 'off')],
    ['an Update that keeps on', event('Update', 'on', 'on')],
    ['an Update that keeps off', event('Update', 'off', 'off')],
  ])('lets %s succeed at once, reading nothing', async (_name, e) => {
    routeTable({ Key: 'tenant#a', Value: entry('portal.example.org') });
    expect(await handleEvent(e, deps)).toEqual({ status: 'SUCCESS', physicalResourceId: 'dedicated-domains-guard' });
    expect(sleeps).toEqual([]);
    expect(kvs.calls()).toHaveLength(0);
    expect(cloudFront.calls()).toHaveLength(0);
    expect(acm.calls()).toHaveLength(0);
  });

  it('waits the 40 s drain, then lets the on-to-off Update succeed when nothing dedicated is left', async () => {
    expect(REGISTRAR_DRAIN_MS).toBe(40_000);
    expect(await handleEvent(turnOff(), deps)).toEqual({ status: 'SUCCESS', physicalResourceId: 'dedicated-domains-guard' });
    expect(sleeps).toEqual([40_000]);
    expect(kvs.commandCalls(ListKeysCommand)[0].args[0].input).toMatchObject({ KvsARN: KVS });
    expect(cloudFront.commandCalls(ListDistributionTenantsCommand)[0].args[0].input)
      .toMatchObject({ AssociationFilter: { DistributionId: DISTRIBUTION } });
  });

  it('refuses while a tenant entry holds a d, naming a count and no tenant', async () => {
    routeTable({ Key: 'tenant#a', Value: entry('portal.example.org') }, { Key: 'tenant#b', Value: entry() });
    const out = await handleEvent(turnOff(), deps);
    expect(out.status).toBe('FAILED');
    expect(out.reason).toMatch(/1 tenant route\(s\) hold a dedicated domain/);
    expect(out.reason).not.toMatch(/portal|tenant#a/);
  });

  it('refuses while a tenant entry cannot be decoded: it cannot show the entry holds no d', async () => {
    routeTable({ Key: 'tenant#a', Value: 'not json' });
    expect((await handleEvent(turnOff(), deps)).status).toBe('FAILED');
  });

  it('reads every ListKeys page', async () => {
    kvs.on(ListKeysCommand)
      .resolvesOnce({ Items: [{ Key: 'tenant#a', Value: entry() }], NextToken: 'n' })
      .resolvesOnce({ Items: [{ Key: 'tenant#b', Value: entry('portal.example.org') }] });
    expect((await handleEvent(turnOff(), deps)).status).toBe('FAILED');
    expect(kvs.commandCalls(ListKeysCommand)[1].args[0].input).toMatchObject({ NextToken: 'n' });
  });

  it('refuses while the distribution has a distribution tenant besides the pooled one', async () => {
    cloudFront.on(ListDistributionTenantsCommand).resolves({ DistributionTenantList: summaries(POOLED, 'dt_dedicated') });
    const out = await handleEvent(turnOff(), deps);
    expect(out).toMatchObject({ status: 'FAILED', reason: expect.stringMatching(/1 dedicated distribution tenant\(s\) remain/) });
  });

  it('refuses while a certificate is tagged with this distribution, and stops reading tags at the first', async () => {
    acm.on(ListCertificatesCommand).resolves({ CertificateSummaryList: Array.from({ length: 25 }, (_, i) => ({ CertificateArn: CERT(i) })) });
    acm.on(ListTagsForCertificateCommand, { CertificateArn: CERT(3) }).resolves({
      Tags: [{ Key: TAG_TENANT_ID, Value: 'a' }, { Key: TAG_DISTRIBUTION_ID, Value: DISTRIBUTION }],
    });
    const out = await handleEvent(turnOff(), deps);
    expect(out).toMatchObject({ status: 'FAILED', reason: expect.stringMatching(/registrar certificate remains/) });
    expect(acm.commandCalls(ListTagsForCertificateCommand)).toHaveLength(TAG_READS_AT_ONCE);
  });

  it('ignores a certificate of another distribution, and one deleted between the list and the tag read', async () => {
    acm.on(ListCertificatesCommand).resolves({ CertificateSummaryList: [{ CertificateArn: CERT(1) }, { CertificateArn: CERT(2) }] });
    acm.on(ListTagsForCertificateCommand, { CertificateArn: CERT(1) }).resolves({ Tags: [{ Key: TAG_DISTRIBUTION_ID, Value: 'E2OTHER' }] });
    acm.on(ListTagsForCertificateCommand, { CertificateArn: CERT(2) }).rejects(new AcmNotFound({ message: 'gone', $metadata: {} }));
    expect((await handleEvent(turnOff(), deps)).status).toBe('SUCCESS');
  });

  it('lists every key type, so a non-RSA certificate is not missed', async () => {
    await handleEvent(turnOff(), deps);
    expect(acm.commandCalls(ListCertificatesCommand)[0].args[0].input.Includes?.keyTypes).toContain('EC_prime256v1');
  });

  it('refuses when a read fails, naming the error and no message', async () => {
    cloudFront.on(ListDistributionTenantsCommand).rejects(Object.assign(new Error('secret detail'), { name: 'AccessDenied' }));
    expect(await handleEvent(turnOff(), deps)).toEqual({
      status: 'FAILED',
      physicalResourceId: 'dedicated-domains-guard',
      reason: 'guard read failed: AccessDenied',
    });
  });
});
