// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import {
  ACMClient,
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
    const dt: DistributionTenant = {
      Id: t.id,
      DistributionId: DISTRIBUTION_ID,
      Domains: [{ Domain: t.domain, Status: 'active' }],
      Tags: t.untagged ? undefined : { Items: tags(t.tenantTag, t.distributionTag) },
      Customizations: t.certificateArn === undefined ? undefined : { Certificate: { Arn: t.certificateArn } },
      ConnectionGroupId: 'cg-1',
      Enabled: t.enabled,
      Status: t.status,
    };
    cloudFront.on(GetDistributionTenantCommand, { Identifier: t.id }).resolves({ DistributionTenant: dt, ETag: `etag-${t.id}` });
  }
}

interface FakeCertificate {
  readonly arn: string;
  readonly domain: string;
  readonly tags: { Key: string; Value: string }[];
  readonly inUseBy?: string[];
}

function certificates(list: FakeCertificate[]): void {
  acm.on(ListCertificatesCommand).resolves({ CertificateSummaryList: list.map((c) => ({ CertificateArn: c.arn, DomainName: c.domain })) });
  for (const c of list) {
    acm.on(ListTagsForCertificateCommand, { CertificateArn: c.arn }).resolves({ Tags: c.tags });
    acm.on(DescribeCertificateCommand, { CertificateArn: c.arn }).resolves({ Certificate: { CertificateArn: c.arn, InUseBy: c.inUseBy ?? [] } });
  }
}

function deps(): RemovalDeps {
  return {
    cloudFront: new CloudFrontClient({ region: 'us-east-1' }),
    acm: new ACMClient({ region: 'us-east-1' }),
    kvs: new CloudFrontKeyValueStoreClient({ region: 'us-east-1' }),
    routeTableArn: ROUTE_TABLE_ARN,
    distributionId: DISTRIBUTION_ID,
  };
}

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
    expect(result).toEqual({ disabled: 0, deletedTenants: 1, deletedCertificates: 1, failures: 0 });
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

  it('reads each tenant entry once per run', async () => {
    certificates([
      { arn: cert(1), domain: OLD_DOMAIN, tags: tags(TENANT_A) },
      { arn: cert(2), domain: 'older-a.example.com', tags: tags(TENANT_A) },
    ]);
    await runRemoval(deps());
    expect(kvs.commandCalls(GetKeyCommand)).toHaveLength(1);
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
