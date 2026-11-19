// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import {
  ACMClient,
  type CertificateStatus,
  DeleteCertificateCommand,
  DescribeCertificateCommand,
  ListCertificatesCommand,
  ListTagsForCertificateCommand,
} from '@aws-sdk/client-acm';
import {
  CloudFrontClient,
  DeleteDistributionTenantCommand,
  type DistributionTenant,
  GetDistributionTenantCommand,
  ListDistributionTenantsCommand,
  ListTagsForResourceCommand,
  UpdateDistributionTenantCommand,
} from '@aws-sdk/client-cloudfront';
import { CloudFrontKeyValueStoreClient, GetKeyCommand } from '@aws-sdk/client-cloudfront-keyvaluestore';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DISTRIBUTION_ID,
  EDGE_ACCOUNT,
  kvs,
  logLines,
  resetAll,
  ROUTE_TABLE_ARN,
  routeTable,
  TENANT_A,
  TENANT_B,
  tenantValue,
  TOKEN_A,
} from './support';
import { TAG_DISTRIBUTION_ID, TAG_TENANT_ID } from '../../src/shared/contracts';
import { type RemovalDeps, runRemoval } from '../../src/sweeper/removal';

const cloudFront = mockClient(CloudFrontClient);
const acm = mockClient(ACMClient);

const DOMAIN_A = 'shop-a.example.com';
const OLD_DOMAIN = 'old-a.example.com';
const cert = (n: number): string => `arn:aws:acm:us-east-1:${EDGE_ACCOUNT}:certificate/00000000-0000-0000-0000-00000000000${n}`;

function tags(tenantId: string | undefined, distributionId: string = DISTRIBUTION_ID): { Key: string; Value: string }[] {
  const out = [{ Key: TAG_DISTRIBUTION_ID, Value: distributionId }];
  if (tenantId !== undefined) out.push({ Key: TAG_TENANT_ID, Value: tenantId });
  return out;
}

interface FakeTenant {
  readonly id: string;
  readonly domain: string;
  readonly enabled: boolean;
  readonly status: 'Deployed' | 'InProgress';
  readonly tenantTag?: string;
  readonly distributionTag?: string;
  readonly certificateArn?: string;
  readonly untagged?: boolean;
}

function distributionTenants(list: FakeTenant[]): void {
  cloudFront.on(ListDistributionTenantsCommand).resolves({
    DistributionTenantList: list.map((t) => ({
      Id: t.id,
      DistributionId: DISTRIBUTION_ID,
      Name: t.id,
      Arn: `arn:aws:cloudfront::${EDGE_ACCOUNT}:distribution-tenant/${t.id}`,
      Domains: [{ Domain: t.domain }],
      Customizations: t.certificateArn === undefined ? undefined : { Certificate: { Arn: t.certificateArn } },
      CreatedTime: new Date(0),
      LastModifiedTime: new Date(0),
      ETag: `list-${t.id}`,
      Enabled: t.enabled,
      Status: t.status,
    })),
  });
  for (const t of list) {
    const arn = `arn:aws:cloudfront::${EDGE_ACCOUNT}:distribution-tenant/${t.id}`;
    // CloudFront's Get carries no tags; only ListTagsForResource does.
    const dt: DistributionTenant = {
      Id: t.id,
      Arn: arn,
      DistributionId: DISTRIBUTION_ID,
      Domains: [{ Domain: t.domain, Status: 'active' }],
      Customizations: t.certificateArn === undefined ? undefined : { Certificate: { Arn: t.certificateArn } },
      ConnectionGroupId: 'cg-1',
      Enabled: t.enabled,
      Status: t.status,
    };
    cloudFront.on(GetDistributionTenantCommand, { Identifier: t.id }).resolves({ DistributionTenant: dt, ETag: `etag-${t.id}` });
    const items = t.untagged ? [] : tags(t.tenantTag, t.distributionTag);
    cloudFront.on(ListTagsForResourceCommand, { Resource: arn }).resolves({ Tags: { Items: items } });
  }
}

interface FakeCertificate {
  readonly arn: string;
  readonly domain: string;
  readonly tags: { Key: string; Value: string }[];
  readonly inUseBy?: string[];
  readonly status?: CertificateStatus;
}

function certificates(list: FakeCertificate[]): void {
  acm.on(ListCertificatesCommand).resolves({ CertificateSummaryList: list.map((c) => ({ CertificateArn: c.arn, DomainName: c.domain })) });
  for (const c of list) {
    acm.on(ListTagsForCertificateCommand, { CertificateArn: c.arn }).resolves({ Tags: c.tags });
    acm.on(DescribeCertificateCommand, { CertificateArn: c.arn }).resolves({
      Certificate: { CertificateArn: c.arn, InUseBy: c.inUseBy ?? [], Status: c.status },
    });
  }
}

function deps(): RemovalDeps {
  return {
    cloudFront: new CloudFrontClient({ region: 'us-east-1' }),
    acm: new ACMClient({ region: 'us-east-1' }),
    kvs: new CloudFrontKeyValueStoreClient({ region: 'us-east-1' }),
    routeTableArn: ROUTE_TABLE_ARN,
    distributionId: DISTRIBUTION_ID,
    pooledTenantId: POOLED,
  };
}

const POOLED = 'dt-pooled';

const deletedCertificates = (): (string | undefined)[] => acm.commandCalls(DeleteCertificateCommand).map((c) => c.args[0].input.CertificateArn);

beforeEach(() => {
  resetAll();
  cloudFront.reset();
  acm.reset();
  cloudFront.on(UpdateDistributionTenantCommand).resolves({});
  cloudFront.on(DeleteDistributionTenantCommand).resolves({});
  acm.on(DeleteCertificateCommand).resolves({});
  distributionTenants([]);
  certificates([]);
  routeTable.set(`tenant#${TENANT_A}`, tenantValue({ d: DOMAIN_A, dk: TOKEN_A }));
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('two-phase removal (spec §3.4 step 5, ADR-0018, M-25)', () => {
  it('lists only this distribution\'s tenants and every key type of certificate', async () => {
    await runRemoval(deps());
    expect(cloudFront.commandCalls(ListDistributionTenantsCommand)[0].args[0].input.AssociationFilter).toEqual({ DistributionId: DISTRIBUTION_ID });
    expect(acm.commandCalls(ListCertificatesCommand)[0].args[0].input.Includes!.keyTypes).toEqual(
      expect.arrayContaining(['RSA_2048', 'EC_prime256v1', 'EC_secp384r1']),
    );
  });

  it('disables an enabled distribution tenant whose domain is no longer its tenant\'s d, sending its fields back under the ETag', async () => {
    distributionTenants([{ id: 'dt-old', domain: OLD_DOMAIN, enabled: true, status: 'Deployed', tenantTag: TENANT_A, certificateArn: cert(1) }]);
    const result = await runRemoval(deps());
    expect(result.disabled).toBe(1);
    expect(cloudFront.commandCalls(UpdateDistributionTenantCommand)[0].args[0].input).toEqual({
      Id: 'dt-old',
      IfMatch: 'etag-dt-old',
      DistributionId: DISTRIBUTION_ID,
      Domains: [{ Domain: OLD_DOMAIN }],
      Customizations: { Certificate: { Arn: cert(1) } },
      Parameters: undefined,
      ConnectionGroupId: 'cg-1',
      Enabled: false,
    });
    expect(cloudFront.commandCalls(DeleteDistributionTenantCommand)).toHaveLength(0);
    expect(deletedCertificates()).toEqual([]);
  });

  it('skips the pooled distribution tenant before any read, even tagged with a tenant that has no d (threat model AR-33)', async () => {
    distributionTenants([{ id: POOLED, domain: OLD_DOMAIN, enabled: true, status: 'Deployed', tenantTag: TENANT_A }]);
    const result = await runRemoval(deps());
    expect(result.disabled).toBe(0);
    expect(cloudFront.commandCalls(GetDistributionTenantCommand)).toHaveLength(0);
    expect(cloudFront.commandCalls(ListTagsForResourceCommand)).toHaveLength(0);
    expect(cloudFront.commandCalls(UpdateDistributionTenantCommand)).toHaveLength(0);
    expect(cloudFront.commandCalls(DeleteDistributionTenantCommand)).toHaveLength(0);
  });

  it('waits while a disable is still deploying', async () => {
    distributionTenants([{ id: 'dt-old', domain: OLD_DOMAIN, enabled: false, status: 'InProgress', tenantTag: TENANT_A, certificateArn: cert(1) }]);
    await runRemoval(deps());
    expect(cloudFront.commandCalls(UpdateDistributionTenantCommand)).toHaveLength(0);
    expect(cloudFront.commandCalls(DeleteDistributionTenantCommand)).toHaveLength(0);
  });

  it('deletes a disabled, deployed distribution tenant and then its certificate', async () => {
    distributionTenants([{ id: 'dt-old', domain: OLD_DOMAIN, enabled: false, status: 'Deployed', tenantTag: TENANT_A, certificateArn: cert(1) }]);
    certificates([{ arn: cert(1), domain: OLD_DOMAIN, tags: tags(TENANT_A) }]);
    const result = await runRemoval(deps());
    expect(cloudFront.commandCalls(DeleteDistributionTenantCommand)[0].args[0].input).toEqual({ Id: 'dt-old', IfMatch: 'etag-dt-old' });
    expect(deletedCertificates()).toEqual([cert(1)]);
    expect(result).toEqual({ disabled: 0, deletedTenants: 1, deletedCertificates: 1, disabledRouted: 0, failures: 0 });
  });

  it('keeps a distribution tenant whose certificate CloudFront has not released yet, for a later run', async () => {
    distributionTenants([{ id: 'dt-old', domain: OLD_DOMAIN, enabled: false, status: 'Deployed', tenantTag: TENANT_A, certificateArn: cert(1) }]);
    certificates([{ arn: cert(1), domain: OLD_DOMAIN, tags: tags(TENANT_A), inUseBy: [`arn:aws:cloudfront::${EDGE_ACCOUNT}:distribution-tenant/dt-old`] }]);
    const result = await runRemoval(deps());
    expect(result.deletedTenants).toBe(1);
    expect(deletedCertificates()).toEqual([]);
    expect(result.failures).toBe(0);
  });

  it('deletes a distribution tenant of a tenant whose route is gone', async () => {
    distributionTenants([{ id: 'dt-b', domain: 'shop-b.example.com', enabled: true, status: 'Deployed', tenantTag: TENANT_B }]);
    expect((await runRemoval(deps())).disabled).toBe(1);
  });

  it('leaves the distribution tenant of a current domain alone', async () => {
    distributionTenants([{ id: 'dt-a', domain: DOMAIN_A, enabled: true, status: 'Deployed', tenantTag: TENANT_A, certificateArn: cert(1) }]);
    certificates([{ arn: cert(1), domain: DOMAIN_A, tags: tags(TENANT_A) }]);
    await runRemoval(deps());
    expect(cloudFront.commandCalls(UpdateDistributionTenantCommand)).toHaveLength(0);
    expect(acm.commandCalls(ListTagsForCertificateCommand)).toHaveLength(0);
    expect(deletedCertificates()).toEqual([]);
  });

  it('never touches the pooled distribution tenant or one tagged for another distribution', async () => {
    distributionTenants([
      { id: 'pooled', domain: 'app.example.com', enabled: true, status: 'Deployed', untagged: true },
      { id: 'foreign', domain: OLD_DOMAIN, enabled: false, status: 'Deployed', tenantTag: TENANT_A, distributionTag: 'E2OTHERDIST' },
    ]);
    await runRemoval(deps());
    expect(cloudFront.commandCalls(UpdateDistributionTenantCommand)).toHaveLength(0);
    expect(cloudFront.commandCalls(DeleteDistributionTenantCommand)).toHaveLength(0);
  });

  it('does not delete the certificate of a deleted distribution tenant when its tags name another tenant', async () => {
    distributionTenants([{ id: 'dt-old', domain: OLD_DOMAIN, enabled: false, status: 'Deployed', tenantTag: TENANT_A, certificateArn: cert(1) }]);
    certificates([{ arn: cert(1), domain: OLD_DOMAIN, tags: tags(TENANT_B) }]);
    await runRemoval(deps());
    expect(deletedCertificates()).toEqual([]);
  });

  it('deletes a pending certificate whose domain was dropped, and keeps one for the current domain', async () => {
    certificates([
      { arn: cert(1), domain: OLD_DOMAIN, tags: tags(TENANT_A) },
      { arn: cert(2), domain: DOMAIN_A, tags: tags(TENANT_A) },
    ]);
    const result = await runRemoval(deps());
    expect(deletedCertificates()).toEqual([cert(1)]);
    expect(result.deletedCertificates).toBe(1);
  });

  it('never deletes an untagged certificate, one of another distribution, or one still in use', async () => {
    certificates([
      { arn: cert(1), domain: 'app.example.com', tags: [] },
      { arn: cert(2), domain: OLD_DOMAIN, tags: tags(TENANT_A, 'E2OTHERDIST') },
      { arn: cert(3), domain: OLD_DOMAIN, tags: tags(TENANT_A), inUseBy: ['arn:aws:cloudfront::123456789012:distribution/E3'] },
    ]);
    await runRemoval(deps());
    expect(deletedCertificates()).toEqual([]);
  });

  it('skips a certificate a listed distribution tenant uses: the distribution tenant goes first', async () => {
    distributionTenants([{ id: 'dt-old', domain: OLD_DOMAIN, enabled: true, status: 'Deployed', tenantTag: TENANT_A, certificateArn: cert(1) }]);
    certificates([{ arn: cert(1), domain: OLD_DOMAIN, tags: tags(TENANT_A) }]);
    await runRemoval(deps());
    expect(deletedCertificates()).toEqual([]);
  });

  it('keeps a resource whose tenant entry cannot be read', async () => {
    routeTable.set(`tenant#${TENANT_A}`, '{"v":2}');
    certificates([{ arn: cert(1), domain: OLD_DOMAIN, tags: tags(TENANT_A) }]);
    await runRemoval(deps());
    expect(deletedCertificates()).toEqual([]);
    expect(logLines().some((l) => l.message === 'tenant entry unreadable; resource kept')).toBe(true);
  });

  it('reads the tenant entry again before each destructive call, with no run cache', async () => {
    certificates([
      { arn: cert(1), domain: OLD_DOMAIN, tags: tags(TENANT_A) },
      { arn: cert(2), domain: 'older-a.example.com', tags: tags(TENANT_A) },
    ]);
    await runRemoval(deps());
    expect(kvs.commandCalls(GetKeyCommand).map((c) => c.args[0].input.Key)).toEqual([`tenant#${TENANT_A}`, `tenant#${TENANT_A}`]);
  });

  it('keeps the certificate when the domain was set again after its distribution tenant was deleted', async () => {
    distributionTenants([{ id: 'dt-old', domain: OLD_DOMAIN, enabled: false, status: 'Deployed', tenantTag: TENANT_A, certificateArn: cert(1) }]);
    certificates([{ arn: cert(1), domain: OLD_DOMAIN, tags: tags(TENANT_A) }]);
    cloudFront.on(DeleteDistributionTenantCommand).callsFake(() => {
      routeTable.set(`tenant#${TENANT_A}`, tenantValue({ d: OLD_DOMAIN, dk: TOKEN_A, dx: 1_900_000_000 }));
      return {};
    });
    const result = await runRemoval(deps());
    expect(result.deletedTenants).toBe(1);
    expect(deletedCertificates()).toEqual([]);
  });

  it('logs a disabled distribution tenant whose domain is still routed for its tenant, and leaves it', async () => {
    routeTable.set(`host#${DOMAIN_A}`, JSON.stringify({ v: 1, t: TENANT_A, ac: '111111111111' }));
    distributionTenants([{ id: 'dt-a', domain: DOMAIN_A, enabled: false, status: 'Deployed', tenantTag: TENANT_A, certificateArn: cert(1) }]);
    const result = await runRemoval(deps());
    expect(result.disabledRouted).toBe(1);
    expect(cloudFront.commandCalls(UpdateDistributionTenantCommand)).toHaveLength(0);
    expect(cloudFront.commandCalls(DeleteDistributionTenantCommand)).toHaveLength(0);
    expect(logLines()).toContainEqual({ level: 'WARN', message: 'distribution tenant disabled on a routed domain', tenantId: TENANT_A, domain: DOMAIN_A, distributionTenantId: 'dt-a' });
  });

  it('does not log a disabled distribution tenant of a pending domain', async () => {
    distributionTenants([{ id: 'dt-a', domain: DOMAIN_A, enabled: false, status: 'Deployed', tenantTag: TENANT_A }]);
    expect((await runRemoval(deps())).disabledRouted).toBe(0);
  });

  it.each(['FAILED', 'VALIDATION_TIMED_OUT', 'REVOKED', 'EXPIRED'] as CertificateStatus[])('deletes an unused certificate %s even for the tenant\'s current d', async (status) => {
    certificates([{ arn: cert(1), domain: DOMAIN_A, tags: tags(TENANT_A), status }]);
    await runRemoval(deps());
    expect(deletedCertificates()).toEqual([cert(1)]);
  });

  it('keeps a terminal certificate that is in use, untagged or used by a listed distribution tenant', async () => {
    distributionTenants([{ id: 'dt-a', domain: DOMAIN_A, enabled: true, status: 'Deployed', tenantTag: TENANT_A, certificateArn: cert(3) }]);
    certificates([
      { arn: cert(1), domain: DOMAIN_A, tags: tags(TENANT_A), status: 'EXPIRED', inUseBy: ['arn:aws:cloudfront::123456789012:distribution-tenant/x'] },
      { arn: cert(2), domain: DOMAIN_A, tags: [], status: 'FAILED' },
      { arn: cert(3), domain: DOMAIN_A, tags: tags(TENANT_A), status: 'EXPIRED' },
    ]);
    await runRemoval(deps());
    expect(deletedCertificates()).toEqual([]);
  });

  it('defers a resource another writer changed first, without failing', async () => {
    distributionTenants([{ id: 'dt-old', domain: OLD_DOMAIN, enabled: true, status: 'Deployed', tenantTag: TENANT_A }]);
    const raced = Object.assign(new Error('etag'), { name: 'PreconditionFailed' });
    cloudFront.on(UpdateDistributionTenantCommand).rejects(raced);
    const result = await runRemoval(deps());
    expect(result.failures).toBe(0);
  });

  it('finishes the other resources and then fails when one fails', async () => {
    distributionTenants([{ id: 'dt-old', domain: OLD_DOMAIN, enabled: true, status: 'Deployed', tenantTag: TENANT_A }]);
    cloudFront.on(UpdateDistributionTenantCommand).rejects(Object.assign(new Error('denied'), { name: 'AccessDenied' }));
    certificates([{ arn: cert(1), domain: 'older-a.example.com', tags: tags(TENANT_A) }]);
    await expect(runRemoval(deps())).rejects.toThrow('removal failed for 1 resources');
    expect(deletedCertificates()).toEqual([cert(1)]);
    const failed = logLines().find((l) => l.message === 'removal failed');
    expect(failed).toEqual({ level: 'ERROR', message: 'removal failed', distributionTenantId: 'dt-old', error: 'AccessDenied' });
  });
});
