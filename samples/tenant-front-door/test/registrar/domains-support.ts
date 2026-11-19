// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Test doubles for dedicated domains: a scripted DNS lookup, and an
 * in-memory ACM and CloudFront behind `aws-sdk-client-mock`. Domains are
 * example.com names; ARNs and ids are obvious fakes.
 */

import {
  ACMClient,
  DescribeCertificateCommand,
  LimitExceededException,
  ListCertificatesCommand,
  ListTagsForCertificateCommand,
  RequestCertificateCommand,
} from '@aws-sdk/client-acm';
import {
  CloudFrontClient,
  CNAMEAlreadyExists,
  CreateDistributionTenantCommand,
  type DistributionTenant,
  EntityNotFound,
  GetDistributionTenantByDomainCommand,
  PreconditionFailed,
  UpdateDistributionTenantCommand,
} from '@aws-sdk/client-cloudfront';
import { mockClient } from 'aws-sdk-client-mock';
import { EDGE_ACCOUNT } from './support';
import { TAG_DISTRIBUTION_ID, TAG_TENANT_ID } from '../../src/shared/contracts';
import type { DnsLookup } from '../../src/shared/dns-challenge';

export const DISTRIBUTION_ID = 'E1EXAMPLE2DIST';
export const OTHER_DISTRIBUTION_ID = 'E9EXAMPLE9DIST';

/** One lookup's answer: the records, or an error code the lookup rejects with. */
export type Answer<T> = T | string;

/**
 * Each lookup takes the next scripted answer; the last one repeats. With
 * nothing scripted the name holds no record of the type (`ENODATA`).
 */
export class FakeDns implements DnsLookup {
  readonly txtAnswers: Answer<string[][]>[] = [];
  readonly cnameAnswers: Answer<string[]>[] = [];
  readonly txtNames: string[] = [];
  readonly cnameNames: string[] = [];

  async txt(name: string): Promise<string[][]> {
    const a = next(this.txtAnswers, this.txtNames.length);
    this.txtNames.push(name);
    return answer(a);
  }

  async cname(name: string): Promise<string[]> {
    const a = next(this.cnameAnswers, this.cnameNames.length);
    this.cnameNames.push(name);
    return answer(a);
  }

  /** Replaces the script and the call counts, as for a new call. */
  script(txt: Answer<string[][]>[], cname: Answer<string[]>[] = []): void {
    this.txtAnswers.splice(0, this.txtAnswers.length, ...txt);
    this.cnameAnswers.splice(0, this.cnameAnswers.length, ...cname);
    this.txtNames.length = 0;
    this.cnameNames.length = 0;
  }
}

function next<T>(answers: Answer<T>[], calls: number): Answer<T> {
  if (answers.length === 0) return 'ENODATA';
  return answers[Math.min(calls, answers.length - 1)];
}

function answer<T>(a: Answer<T>): T {
  if (typeof a === 'string') throw Object.assign(new Error(`lookup failed: ${a}`), { code: a });
  return a;
}

// ---------------------------------------------------------------------------
// In-memory ACM (us-east-1)
// ---------------------------------------------------------------------------

export interface FakeCertificate {
  domain: string;
  status: string;
  tags: { Key: string; Value: string }[];
  failureReason?: string;
  /** ACM's validation record; absent until ACM attaches it. */
  record?: { Name: string; Type: 'CNAME'; Value: string };
  idempotencyToken?: string;
}

export class FakeAcm {
  readonly certificates = new Map<string, FakeCertificate>();
  /** The next RequestCertificate fails with LimitExceededException. */
  quotaReached = false;
  /** Describe reads that still return no validation record for a new certificate. */
  recordDelay = 0;
  /** Summaries per ListCertificates page. */
  pageSize = 1000;
  requests = 0;

  add(arn: string, certificate: FakeCertificate): void {
    this.certificates.set(arn, certificate);
  }
}

export const acmMock = mockClient(ACMClient);

export function certificateArn(n: number): string {
  return `arn:aws:acm:us-east-1:${EDGE_ACCOUNT}:certificate/00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
}

export function ownTags(tenantId: string, distributionId = DISTRIBUTION_ID): { Key: string; Value: string }[] {
  return [{ Key: TAG_TENANT_ID, Value: tenantId }, { Key: TAG_DISTRIBUTION_ID, Value: distributionId }];
}

export function validationRecord(domain: string): { Name: string; Type: 'CNAME'; Value: string } {
  return { Name: `_0123456789abcdef.${domain}.`, Type: 'CNAME', Value: '_fedcba9876543210.acm-validations.aws.' };
}

export function installAcm(acm: FakeAcm): void {
  acmMock.reset();
  acmMock.on(ListCertificatesCommand).callsFake((input: { NextToken?: string }) => {
    const all = [...acm.certificates.entries()];
    const start = input.NextToken === undefined ? 0 : Number(input.NextToken);
    const page = all.slice(start, start + acm.pageSize);
    const nextToken = start + acm.pageSize < all.length ? String(start + acm.pageSize) : undefined;
    return {
      CertificateSummaryList: page.map(([arn, c]) => ({ CertificateArn: arn, DomainName: c.domain, Status: c.status })),
      NextToken: nextToken,
    };
  });
  acmMock.on(ListTagsForCertificateCommand).callsFake((input: { CertificateArn: string }) => ({
    Tags: acm.certificates.get(input.CertificateArn)?.tags ?? [],
  }));
  acmMock.on(DescribeCertificateCommand).callsFake((input: { CertificateArn: string }) => {
    const c = acm.certificates.get(input.CertificateArn)!;
    let record = c.record;
    if (acm.recordDelay > 0) {
      acm.recordDelay--;
      record = undefined;
    }
    return {
      Certificate: {
        CertificateArn: input.CertificateArn,
        DomainName: c.domain,
        Status: c.status,
        FailureReason: c.failureReason,
        DomainValidationOptions: [{ DomainName: c.domain, ValidationMethod: 'DNS', ResourceRecord: record }],
      },
    };
  });
  type Request = { DomainName: string; IdempotencyToken?: string; Tags?: { Key: string; Value: string }[] };
  acmMock.on(RequestCertificateCommand).callsFake((input: Request) => {
    if (acm.quotaReached) throw new LimitExceededException({ message: 'quota', $metadata: {} });
    for (const [arn, c] of acm.certificates) {
      if (c.idempotencyToken !== undefined && c.idempotencyToken === input.IdempotencyToken) return { CertificateArn: arn };
    }
    acm.requests++;
    const arn = certificateArn(100 + acm.requests);
    acm.add(arn, {
      domain: input.DomainName,
      status: 'PENDING_VALIDATION',
      tags: input.Tags ?? [],
      record: validationRecord(input.DomainName),
      idempotencyToken: input.IdempotencyToken,
    });
    return { CertificateArn: arn };
  });
}

// ---------------------------------------------------------------------------
// In-memory CloudFront distribution tenants
// ---------------------------------------------------------------------------

export class FakeCloudFront {
  /** By domain. */
  readonly tenants = new Map<string, { tenant: DistributionTenant; etag: string }>();
  /** CreateDistributionTenant answers CNAMEAlreadyExists, as when another account serves the domain. */
  servedElsewhere = false;
  creates = 0;
  versions = 0;

  add(domain: string, tenant: DistributionTenant): void {
    this.tenants.set(domain, { tenant: { Domains: [{ Domain: domain, Status: 'active' }], ...tenant }, etag: `E${++this.versions}` });
  }
}

export const cloudFrontMock = mockClient(CloudFrontClient);

export function dtTags(tenantId: string, distributionId = DISTRIBUTION_ID): { Items: { Key: string; Value: string }[] } {
  return { Items: ownTags(tenantId, distributionId) };
}

export function installCloudFront(cf: FakeCloudFront): void {
  cloudFrontMock.reset();
  cloudFrontMock.on(GetDistributionTenantByDomainCommand).callsFake((input: { Domain: string }) => {
    const found = cf.tenants.get(input.Domain);
    if (found === undefined) throw new EntityNotFound({ message: 'not found', $metadata: {} });
    return { DistributionTenant: found.tenant, ETag: found.etag };
  });
  cloudFrontMock.on(CreateDistributionTenantCommand).callsFake((input: DistributionTenant & { Domains: { Domain: string }[] }) => {
    const domain = input.Domains[0].Domain;
    if (cf.servedElsewhere || cf.tenants.has(domain)) throw new CNAMEAlreadyExists({ message: 'cname exists', $metadata: {} });
    cf.creates++;
    const tenant: DistributionTenant = {
      Id: `dt_${cf.creates}`,
      DistributionId: input.DistributionId,
      Name: input.Name,
      Domains: [{ Domain: domain, Status: 'inactive' }],
      Tags: input.Tags,
      Customizations: input.Customizations,
      Enabled: input.Enabled,
      Status: 'InProgress',
    };
    cf.tenants.set(domain, { tenant, etag: `E${++cf.versions}` });
    return { DistributionTenant: tenant, ETag: `E${cf.versions}` };
  });
  cloudFrontMock.on(UpdateDistributionTenantCommand).callsFake((input: DistributionTenant & { IfMatch: string }) => {
    const entry = [...cf.tenants.values()].find((x) => x.tenant.Id === input.Id);
    if (entry === undefined) throw new EntityNotFound({ message: 'not found', $metadata: {} });
    if (entry.etag !== input.IfMatch) throw new PreconditionFailed({ message: 'etag', $metadata: {} });
    entry.tenant = { ...entry.tenant, Enabled: input.Enabled, Customizations: input.Customizations };
    entry.etag = `E${++cf.versions}`;
    return { DistributionTenant: entry.tenant, ETag: entry.etag };
  });
}
