// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The key-policy builders (spec §7.2, §7.3; M-17, M-29): every statement of
 * the `vendor-key` policy by Sid, the three separate use Denies, no
 * `kms:Create*` wildcard, and the `tenant-key` template.
 *
 * Not covered here: an IAM Access Analyzer `check-no-new-access` check; it
 * calls an AWS API, which unit tests do not. These template tests and
 * integration step 5 replace it (ADR-0023).
 */

import { buildTenantKeyTemplate, buildVendorKeyPolicy, type PolicyStatement } from '../src/platform/key-policy';

const ROLES = {
  upload: 'arn:aws:iam::111122223333:role/tei/TenantUploadRole',
  process: 'arn:aws:iam::111122223333:role/tei/TenantProcessRole',
  platform: 'arn:aws:iam::111122223333:role/tei/TenantPlatformRole',
};
const CONSUMER = 'arn:aws:iam::111122223333:role/ExtractionConsumer';
const input = {
  account: '111122223333',
  region: 'eu-central-1',
  bucket: 'ingestion-bucket-example',
  tenantId: 'tenant-a',
  tenantRoleArns: [ROLES.upload, ROLES.process, ROLES.platform],
  consumerRoleArns: [CONSUMER],
  platformRoleArn: 'arn:aws:iam::111122223333:role/tei/PlatformRole',
  keyFactoryRoleArn: 'arn:aws:iam::111122223333:role/tei/KeyFactoryRole',
};
const INGEST = 'arn:aws:s3:::ingestion-bucket-example/ingest/tenant-a/*';
const DOCUMENTS = 'arn:aws:s3:::ingestion-bucket-example/documents/tenant-a/*';

function bySid(statements: PolicyStatement[], sid: string): PolicyStatement {
  const found = statements.find((s) => s.Sid === sid);
  if (found === undefined) {
    throw new Error(`no statement ${sid}`);
  }
  return found;
}

const actions = (s: PolicyStatement) => ([] as string[]).concat(s.Action);

describe('buildVendorKeyPolicy (spec §7.2)', () => {
  const policy = buildVendorKeyPolicy(input);
  const st = policy.Statement;

  it('1: administration by platformRole and keyFactoryRole, no wildcard action', () => {
    expect(actions(bySid(st, 'AdministrationPlatformRole')).sort()).toEqual(
      [
        'kms:CancelKeyDeletion',
        'kms:DeleteAlias',
        'kms:DescribeKey',
        'kms:GetKeyPolicy',
        'kms:GetKeyRotationStatus',
        'kms:ListResourceTags',
        'kms:RotateKeyOnDemand',
        'kms:ScheduleKeyDeletion',
      ].sort(),
    );
    expect(actions(bySid(st, 'AdministrationKeyFactoryRole')).sort()).toEqual(
      ['kms:CreateAlias', 'kms:DescribeKey', 'kms:EnableKeyRotation', 'kms:ScheduleKeyDeletion'].sort(),
    );
    for (const s of st.filter((x) => x.Effect === 'Allow')) {
      expect(actions(s).some((a) => a.includes('*') && a !== 'kms:*')).toBe(false);
      expect(actions(s)).not.toContain('kms:*');
    }
  });

  it('2: tenant roles use the key via S3 on the tenant prefixes only, plus DescribeKey', () => {
    const use = bySid(st, 'TenantRolesUseViaS3OnTenantPrefixes');
    expect(use.Principal).toEqual({ AWS: [ROLES.upload, ROLES.process, ROLES.platform] });
    expect(actions(use).sort()).toEqual(['kms:Decrypt', 'kms:GenerateDataKey']);
    expect(use.Condition).toEqual({
      StringEquals: { 'kms:ViaService': 's3.eu-central-1.amazonaws.com' },
      StringLike: { 'kms:EncryptionContext:aws:s3:arn': [INGEST, DOCUMENTS] },
    });
    const describe_ = bySid(st, 'TenantRolesDescribeKey');
    expect(describe_.Action).toBe('kms:DescribeKey');
    expect(describe_.Condition).toBeUndefined();
  });

  it('2b: consumer roles may only Decrypt via S3 under documents/<t>/', () => {
    const consumer = bySid(st, 'ConsumerRolesDecryptLandedDocuments');
    expect(consumer.Principal).toEqual({ AWS: [CONSUMER] });
    expect(actions(consumer)).toEqual(['kms:Decrypt']);
    expect(consumer.Condition?.StringLike).toEqual({ 'kms:EncryptionContext:aws:s3:arn': [DOCUMENTS] });
  });

  it('2b is omitted without consumer roles', () => {
    const none = buildVendorKeyPolicy({ ...input, consumerRoleArns: [] });
    expect(none.Statement.find((s) => s.Sid === 'ConsumerRolesDecryptLandedDocuments')).toBeUndefined();
    expect(bySid(none.Statement, 'DenyDecryptExceptTenantAndConsumerRoles').Condition).toEqual({
      ArnNotEquals: { 'aws:PrincipalArn': [ROLES.upload, ROLES.process, ROLES.platform] },
    });
  });

  it('3: the account principal administers, with PutKeyPolicy, and holds no use, grant or tag action', () => {
    const account = bySid(st, 'AccountAdministration');
    expect(account.Principal).toEqual({ AWS: 'arn:aws:iam::111122223333:root' });
    expect(actions(account)).toContain('kms:PutKeyPolicy');
    for (const forbidden of ['kms:Encrypt', 'kms:Decrypt', 'kms:GenerateDataKey', 'kms:ReEncrypt*', 'kms:CreateGrant', 'kms:TagResource']) {
      expect(actions(account)).not.toContain(forbidden);
    }
  });

  it('4a-i, 4a-ii, 4b and 4c are separate Deny statements to *', () => {
    const ai = bySid(st, 'DenyUseExceptTenantRoles');
    expect(ai.Effect).toBe('Deny');
    expect(ai.Principal).toBe('*');
    expect(actions(ai).sort()).toEqual(['kms:CreateGrant', 'kms:Encrypt', 'kms:GenerateDataKey*', 'kms:ReEncrypt*']);
    expect(ai.Condition).toEqual({ ArnNotEquals: { 'aws:PrincipalArn': [ROLES.upload, ROLES.process, ROLES.platform] } });

    const aii = bySid(st, 'DenyDecryptExceptTenantAndConsumerRoles');
    expect(aii.Action).toBe('kms:Decrypt');
    expect(aii.Condition).toEqual({ ArnNotEquals: { 'aws:PrincipalArn': [ROLES.upload, ROLES.process, ROLES.platform, CONSUMER] } });

    const b = bySid(st, 'DenyUseExceptViaS3');
    expect(actions(b).sort()).toEqual(['kms:CreateGrant', 'kms:Decrypt', 'kms:Encrypt', 'kms:GenerateDataKey*', 'kms:ReEncrypt*']);
    expect(b.Condition).toEqual({ StringNotEquals: { 'kms:ViaService': 's3.eu-central-1.amazonaws.com' } });

    const c = bySid(st, 'DenyUseOutsideTenantPrefixes');
    expect(c.Condition).toEqual({ StringNotLike: { 'kms:EncryptionContext:aws:s3:arn': [INGEST, DOCUMENTS] } });

    // Each Deny carries exactly one condition operator: ANDed conditions would weaken it.
    for (const s of [ai, aii, b, c]) {
      expect(Object.keys(s.Condition ?? {})).toHaveLength(1);
    }
  });

  it('5: tagging is denied to everyone', () => {
    const tag = bySid(st, 'DenyTagging');
    expect(tag.Effect).toBe('Deny');
    expect(tag.Principal).toBe('*');
    expect(actions(tag).sort()).toEqual(['kms:TagResource', 'kms:UntagResource']);
    expect(tag.Condition).toBeUndefined();
  });

  it('no statement grants kms:Create* or CreateGrant', () => {
    for (const s of st.filter((x) => x.Effect === 'Allow')) {
      expect(actions(s)).not.toContain('kms:Create*');
      expect(actions(s)).not.toContain('kms:CreateGrant');
    }
  });

  it('refuses an empty or oversized tenant role list', () => {
    expect(() => buildVendorKeyPolicy({ ...input, tenantRoleArns: [] })).toThrow(/one to three/);
    expect(() => buildVendorKeyPolicy({ ...input, tenantRoleArns: [...input.tenantRoleArns, CONSUMER] })).toThrow(/one to three/);
  });

  it('renders the bucket, tenant and Region it is given and no other', () => {
    const json = JSON.stringify(buildVendorKeyPolicy({ ...input, tenantId: 'tenant-b' }));
    expect(json).toContain('/ingest/tenant-b/*');
    expect(json).not.toContain('tenant-a');
  });
});

describe('buildTenantKeyTemplate (spec §7.3)', () => {
  const template = buildTenantKeyTemplate({
    tenantAccount: '111122223333',
    region: 'eu-central-1',
    bucket: 'ingestion-bucket-example',
    tenantId: 'tenant-a',
    tenantRoleArns: [ROLES.upload, ROLES.process, ROLES.platform],
    consumerRoleArns: [CONSUMER],
  });

  it('trusts the tenant roles via S3 on the tenant prefixes, consumers on documents only, and DescribeKey', () => {
    expect(bySid(template.Statement, 'VendorTenantRolesUseViaS3OnTenantPrefixes').Condition?.StringLike).toEqual({
      'kms:EncryptionContext:aws:s3:arn': [INGEST, DOCUMENTS],
    });
    expect(bySid(template.Statement, 'VendorConsumerRolesDecryptLandedDocuments').Condition?.StringLike).toEqual({
      'kms:EncryptionContext:aws:s3:arn': [DOCUMENTS],
    });
    expect(bySid(template.Statement, 'VendorTenantRolesDescribeKey').Action).toBe('kms:DescribeKey');
  });

  it('never grants', () => {
    const vendorStatements = template.Statement.filter((s) => s.Sid.startsWith('Vendor'));
    for (const s of vendorStatements) {
      expect(actions(s)).not.toContain('kms:CreateGrant');
    }
  });
});
