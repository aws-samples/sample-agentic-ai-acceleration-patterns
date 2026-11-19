// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import {
  ACMClient,
  DeleteCertificateCommand,
  ListCertificatesCommand,
  ListTagsForCertificateCommand,
  ResourceInUseException,
} from '@aws-sdk/client-acm';
import {
  CloudFrontClient,
  DeleteDistributionTenantCommand,
  type DistributionTenant,
  type DistributionTenantSummary,
  GetDistributionTenantCommand,
  ListDistributionTenantsCommand,
  ListTagsForResourceCommand,
  PreconditionFailed,
  UpdateDistributionTenantCommand,
} from '@aws-sdk/client-cloudfront';
import { mockClient } from 'aws-sdk-client-mock';
import {
  checkComplete,
  Deps,
  onEvent,
  physicalResourceId,
  TeardownEvent,
} from '../../src/custom-resources/dedicated-domains-teardown.function';
import { TAG_DISTRIBUTION_ID, TAG_TENANT_ID } from '../../src/shared/contracts';

const DISTRIBUTION = 'E1EXAMPLE';
const CERT = (n: number) => `arn:aws:acm:us-east-1:111111111111:certificate/${n}`;

const cloudFront = mockClient(CloudFrontClient);
const acm = mockClient(ACMClient);
const deps: Deps = { cloudFront: new CloudFrontClient({ region: 'us-east-1' }), acm: new ACMClient({ region: 'us-east-1' }) };

function event(requestType: TeardownEvent['RequestType'], physicalId?: string): TeardownEvent {
  return { RequestType: requestType, PhysicalResourceId: physicalId, ResourceProperties: { DistributionId: DISTRIBUTION } };
}

const registrarTags = (tenant: string) => ({ Items: [{ Key: TAG_TENANT_ID, Value: tenant }, { Key: TAG_DISTRIBUTION_ID, Value: DISTRIBUTION }] });

const tenantArn = (id: string) => `arn:aws:cloudfront::111111111111:distribution-tenant/${id}`;

/**
 * Distribution tenants by id. GetDistributionTenant answers each with its
 * ETag and no tags, as CloudFront does; ListTagsForResource answers the tags.
 */
function tenants(list: (Partial<DistributionTenant> & { Id: string })[]): void {
  const summaries = list.map((t) => ({ Id: t.Id, DistributionId: DISTRIBUTION }) as DistributionTenantSummary);
  cloudFront.on(ListDistributionTenantsCommand).resolves({ DistributionTenantList: summaries });
  for (const t of list) {
    const { Tags, ...rest } = t;
    cloudFront.on(GetDistributionTenantCommand, { Identifier: t.Id }).resolves({
      DistributionTenant: { DistributionId: DISTRIBUTION, Arn: tenantArn(t.Id), Domains: [{ Domain: `${t.Id}.example.org` }], ...rest } as DistributionTenant,
      ETag: `etag-${t.Id}`,
    });
    cloudFront.on(ListTagsForResourceCommand, { Resource: tenantArn(t.Id) }).resolves({ Tags: Tags ?? { Items: [] } });
  }
}

function certificates(list: { arn: string; distribution?: string }[]): void {
  acm.on(ListCertificatesCommand).resolves({ CertificateSummaryList: list.map((c) => ({ CertificateArn: c.arn })) });
  for (const c of list) {
    acm.on(ListTagsForCertificateCommand, { CertificateArn: c.arn }).resolves({
      Tags: c.distribution === undefined ? [] : [{ Key: TAG_TENANT_ID, Value: 'a' }, { Key: TAG_DISTRIBUTION_ID, Value: c.distribution }],
    });
  }
}

beforeEach(() => {
  cloudFront.reset();
  acm.reset();
  tenants([]);
  certificates([]);
  cloudFront.on(UpdateDistributionTenantCommand).resolves({});
  cloudFront.on(DeleteDistributionTenantCommand).resolves({});
  acm.on(DeleteCertificateCommand).resolves({});
});

describe('dedicated domains teardown (spec §6.2)', () => {
  it('names one physical id per distribution, and keeps the id a Delete arrives with', async () => {
    expect(await onEvent(event('Create'))).toEqual({ PhysicalResourceId: physicalResourceId(DISTRIBUTION) });
    expect(await onEvent(event('Update', 'old'))).toEqual({ PhysicalResourceId: physicalResourceId(DISTRIBUTION) });
    expect(await onEvent(event('Delete', 'old'))).toEqual({ PhysicalResourceId: 'old' });
    await expect(onEvent({ RequestType: 'Create', ResourceProperties: { DistributionId: '' } })).rejects.toThrow(/DistributionId/);
  });

  it.each(['Create', 'Update'] as const)('completes a %s at once, touching nothing', async (type) => {
    tenants([{ Id: 'dt_a', Tags: registrarTags('a'), Enabled: true }]);
    expect(await checkComplete(event(type), deps)).toEqual({ IsComplete: true });
    expect(cloudFront.calls()).toHaveLength(0);
    expect(acm.calls()).toHaveLength(0);
  });

  it('disables an enabled dedicated distribution tenant, sending back every field under its ETag, and is not complete', async () => {
    tenants([{ Id: 'dt_a', Tags: registrarTags('a'), Enabled: true, ConnectionGroupId: 'cg', Customizations: { Certificate: { Arn: CERT(1) } } }]);
    certificates([{ arn: CERT(1), distribution: DISTRIBUTION }]);
    expect(await checkComplete(event('Delete'), deps)).toEqual({ IsComplete: false });
    expect(cloudFront.commandCalls(UpdateDistributionTenantCommand)[0].args[0].input).toEqual({
      Id: 'dt_a',
      IfMatch: 'etag-dt_a',
      DistributionId: DISTRIBUTION,
      Domains: [{ Domain: 'dt_a.example.org' }],
      Customizations: { Certificate: { Arn: CERT(1) } },
      Parameters: undefined,
      ConnectionGroupId: 'cg',
      Enabled: false,
    });
    // Certificates wait until no distribution tenant is left.
    expect(acm.calls()).toHaveLength(0);
  });

  it('waits on a disabled tenant whose disable has not deployed', async () => {
    tenants([{ Id: 'dt_a', Tags: registrarTags('a'), Enabled: false, Status: 'InProgress' }]);
    expect(await checkComplete(event('Delete'), deps)).toEqual({ IsComplete: false });
    expect(cloudFront.commandCalls(UpdateDistributionTenantCommand)).toHaveLength(0);
    expect(cloudFront.commandCalls(DeleteDistributionTenantCommand)).toHaveLength(0);
  });

  it('deletes a disabled, deployed tenant, then the registrar certificates in the same pass, pending ones included', async () => {
    tenants([{ Id: 'dt_a', Tags: registrarTags('a'), Enabled: false, Status: 'Deployed' }]);
    certificates([{ arn: CERT(1), distribution: DISTRIBUTION }, { arn: CERT(2), distribution: DISTRIBUTION }, { arn: CERT(3), distribution: 'E2OTHER' }, { arn: CERT(4) }]);
    expect(await checkComplete(event('Delete'), deps)).toEqual({ IsComplete: true });
    expect(cloudFront.commandCalls(DeleteDistributionTenantCommand)[0].args[0].input).toEqual({ Id: 'dt_a', IfMatch: 'etag-dt_a' });
    expect(acm.commandCalls(DeleteCertificateCommand).map((c) => c.args[0].input.CertificateArn)).toEqual([CERT(1), CERT(2)]);
  });

  it('leaves the pooled tenant and tenants of other distributions or without the registrar tag to CloudFormation', async () => {
    tenants([
      { Id: 'dt_pooled', Enabled: true },
      { Id: 'dt_other', Enabled: true, DistributionId: 'E2OTHER', Tags: registrarTags('a') },
      { Id: 'dt_foreign', Enabled: true, Tags: { Items: [{ Key: TAG_DISTRIBUTION_ID, Value: 'E2OTHER' }] } },
    ]);
    expect(await checkComplete(event('Delete'), deps)).toEqual({ IsComplete: true });
    expect(cloudFront.commandCalls(UpdateDistributionTenantCommand)).toHaveLength(0);
    expect(cloudFront.commandCalls(DeleteDistributionTenantCommand)).toHaveLength(0);
  });

  it('retries a race on the next poll: a tenant another writer changed, a certificate CloudFront has not released', async () => {
    tenants([{ Id: 'dt_a', Tags: registrarTags('a'), Enabled: true }]);
    cloudFront.on(UpdateDistributionTenantCommand).rejects(new PreconditionFailed({ message: 'etag', $metadata: {} }));
    expect(await checkComplete(event('Delete'), deps)).toEqual({ IsComplete: false });

    tenants([]);
    certificates([{ arn: CERT(1), distribution: DISTRIBUTION }]);
    acm.on(DeleteCertificateCommand).rejects(new ResourceInUseException({ message: 'in use', $metadata: {} }));
    expect(await checkComplete(event('Delete'), deps)).toEqual({ IsComplete: false });
  });

  it('fails on any other error, so the stack delete shows it', async () => {
    tenants([{ Id: 'dt_a', Tags: registrarTags('a'), Enabled: true }]);
    cloudFront.on(UpdateDistributionTenantCommand).rejects(Object.assign(new Error('denied'), { name: 'AccessDenied' }));
    await expect(checkComplete(event('Delete'), deps)).rejects.toThrow('denied');
  });

  it('is complete for a distribution with nothing dedicated left', async () => {
    expect(await checkComplete(event('Delete'), deps)).toEqual({ IsComplete: true });
  });
});
