// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Template assertions for what the threat model relies on (standard §5.1):
 * roles and trust (M-12, M-13, M-14, M-22, M-23), the bucket policy and
 * settings (M-7, M-8), the access-log bucket (M-27), queues and the bus
 * (M-16), log groups (M-31), the API (M-1, M-4, M-5), the registry and its
 * watch (M-24), timing (M-11), validators (M-20), alarms (M-25), props.
 */

import { Duration } from 'aws-cdk-lib';
import { Match, type Template } from 'aws-cdk-lib/assertions';
import { asArray, flat, importedRole, logicalIdOf, statementsOf, synthConstruct, validatorFor } from './helpers';
import { PUT_KEY_POLICY_PATTERN } from '../src/construct/alarms';
import { KMS_USE_ACTIONS, TENANT_TAG_FORBIDDEN_PATTERNS } from '../src/construct/roles';
import { PROCESS_ROLE_ATTRIBUTES, PROTECTED_ATTRIBUTES, UPLOAD_ROLE_ATTRIBUTES } from '../src/shared/registry';

const { template } = synthConstruct({ consumerRoles: [] });
const throttled = synthConstruct({ tenantThrottle: { rateLimit: 10, burstLimit: 20 } }).template;

const roleId = (t: Template, name: string) => logicalIdOf(t, 'AWS::IAM::Role', `/Ingestion/${name}/Resource`);
const BASE = ['AuthoriserRole', 'ApiRole', 'ProcessorRole', 'KeyFactoryRole', 'PlatformRole', 'SweepRole', 'WatchRole'];
const TENANT = { TenantUploadRole: ['ApiRole'], TenantProcessRole: ['ProcessorRole', 'SweepRole'], TenantPlatformRole: ['PlatformRole', 'KeyFactoryRole'] };

function allows(t: Template, role: string) {
  return statementsOf(t, roleId(t, role)).filter((s) => s.Effect !== 'Deny');
}
function denies(t: Template, role: string) {
  return statementsOf(t, roleId(t, role)).filter((s) => s.Effect === 'Deny');
}
const actionsOf = (statements: Record<string, any>[]) => statements.flatMap((s) => asArray<string>(s.Action));

describe('tenant roles (M-12, M-13, M-23)', () => {
  it.each(Object.entries(TENANT))('%s is trusted by its named base roles only, with the tag guard', (tenantRole, trusted) => {
    const role = template.findResources('AWS::IAM::Role')[roleId(template, tenantRole)];
    const statements = role.Properties.AssumeRolePolicyDocument.Statement as Record<string, any>[];
    const principals = statements.flatMap((s) => asArray(s.Principal.AWS)).map((p) => flat(p));
    expect(principals.sort()).toEqual(trusted.map((b) => flat({ 'Fn::GetAtt': [roleId(template, b), 'Arn'] })).sort());
    for (const s of statements) {
      expect(asArray(s.Action).sort()).toEqual(['sts:AssumeRole', 'sts:TagSession']);
      expect(s.Condition).toEqual({
        'ForAllValues:StringEquals': { 'aws:TagKeys': ['TenantId'] },
        'Null': { 'aws:RequestTag/TenantId': 'false' },
        'StringNotLike': { 'aws:RequestTag/TenantId': TENANT_TAG_FORBIDDEN_PATTERNS },
      });
    }
  });

  it.each(Object.keys(TENANT))('every %s Allow is bound to the session tag', (tenantRole) => {
    for (const s of allows(template, tenantRole)) {
      expect(flat(s)).toContain('${aws:PrincipalTag/TenantId}');
    }
  });

  it.each(Object.keys(TENANT))('%s holds no PutItem, DeleteItem, Scan or BatchWriteItem, and the ForAnyValue Deny', (tenantRole) => {
    const actions = actionsOf(allows(template, tenantRole));
    for (const forbidden of ['dynamodb:PutItem', 'dynamodb:DeleteItem', 'dynamodb:Scan', 'dynamodb:BatchWriteItem', 'dynamodb:*']) {
      expect(actions).not.toContain(forbidden);
    }
    const protect = denies(template, tenantRole).find((s) => s.Sid === 'ProtectKeyBinding');
    expect(protect?.Condition).toEqual({ 'ForAnyValue:StringEquals': { 'dynamodb:Attributes': [...PROTECTED_ATTRIBUTES] } });
    expect(protect?.Action).toBe('dynamodb:*');
  });

  it('upload and process roles name exactly their allowlists, in their own partition', () => {
    const upload = allows(template, 'TenantUploadRole').find((s) => s.Sid === 'RegistryOwnTenantAllowlisted')!;
    expect(upload.Condition['ForAllValues:StringEquals']).toEqual({
      'dynamodb:LeadingKeys': ['TENANT#${aws:PrincipalTag/TenantId}'],
      'dynamodb:Attributes': [...UPLOAD_ROLE_ATTRIBUTES],
    });
    const processRow = allows(template, 'TenantProcessRole').find((s) => s.Sid === 'RegistryOwnTenantAllowlisted')!;
    expect(processRow.Condition['ForAllValues:StringEquals']['dynamodb:Attributes']).toEqual([...PROCESS_ROLE_ATTRIBUTES]);
    expect(processRow.Condition.StringEqualsIfExists).toEqual({ 'dynamodb:ReturnValues': ['NONE', 'UPDATED_OLD', 'UPDATED_NEW'] });
  });

  it('KMS use is conditioned on the tag and kms:ViaService = S3 in this Region', () => {
    for (const role of Object.keys(TENANT)) {
      const kms = allows(template, role).find((s) => s.Sid === 'TenantKeysViaS3')!;
      expect(kms.Condition.StringEquals).toEqual({
        'aws:ResourceTag/TenantId': '${aws:PrincipalTag/TenantId}',
        'kms:ViaService': 's3.eu-central-1.amazonaws.com',
      });
    }
  });

  it('tenantUploadRole cannot read or delete; tenantProcessRole cannot list or write outside _probe/ and documents/ (M-14)', () => {
    const upload = actionsOf(allows(template, 'TenantUploadRole'));
    expect(upload.filter((a) => a.startsWith('s3:'))).toEqual(['s3:PutObject']);
    const proc = allows(template, 'TenantProcessRole');
    expect(actionsOf(proc).filter((a) => a.startsWith('s3:List'))).toEqual([]);
    const put = proc.find((s) => s.Sid === 'WriteOwnProbesAndDocuments')!;
    expect(flat(put.Resource)).toContain('/ingest/${aws:PrincipalTag/TenantId}/_probe/*');
    expect(flat(put.Resource)).toContain('/documents/${aws:PrincipalTag/TenantId}/*');
    expect(put.Condition).toEqual({ StringEquals: { 's3:x-amz-server-side-encryption': 'aws:kms' } });
  });
});

describe('base roles (M-14, M-22)', () => {
  it.each(BASE)('%s reaches no document: no S3 action and no KMS use action in any Allow', (role) => {
    const actions = actionsOf(allows(template, role));
    expect(actions.filter((a) => a.startsWith('s3:'))).toEqual([]);
    for (const use of ['kms:Encrypt', 'kms:Decrypt', 'kms:GenerateDataKey', 'kms:ReEncrypt*', 'kms:*']) {
      expect(actions).not.toContain(use);
    }
  });

  it('each base role assumes exactly its tenant role, authoriser and watch none', () => {
    const assumed = (role: string) =>
      allows(template, role)
        .filter((s) => asArray<string>(s.Action).includes('sts:AssumeRole'))
        .flatMap((s) => asArray(s.Resource))
        .map(flat);
    const arn = (r: string) => flat({ 'Fn::GetAtt': [roleId(template, r), 'Arn'] });
    expect(assumed('ApiRole')).toEqual([arn('TenantUploadRole')]);
    expect(assumed('ProcessorRole')).toEqual([arn('TenantProcessRole')]);
    expect(assumed('SweepRole')).toEqual([arn('TenantProcessRole')]);
    expect(assumed('PlatformRole')).toEqual([arn('TenantPlatformRole')]);
    expect(assumed('KeyFactoryRole')).toEqual([arn('TenantPlatformRole')]);
    expect(assumed('AuthoriserRole')).toEqual([]);
    expect(assumed('WatchRole')).toEqual([]);
  });

  it('authoriserRole holds logs only (M-1)', () => {
    expect(actionsOf(allows(template, 'AuthoriserRole')).every((a) => a.startsWith('logs:'))).toBe(true);
  });

  it('keyFactoryRole: CreateKey with all four key conditions, tagging with the request tag, and its Denies (M-22)', () => {
    const create = allows(template, 'KeyFactoryRole').find((s) => s.Sid === 'CreateSymmetricSingleRegionKey')!;
    expect(create.Condition).toEqual({
      StringEquals: { 'kms:KeySpec': 'SYMMETRIC_DEFAULT', 'kms:KeyOrigin': 'AWS_KMS', 'kms:KeyUsage': 'ENCRYPT_DECRYPT' },
      Bool: { 'kms:MultiRegion': 'false' },
    });
    const tag = allows(template, 'KeyFactoryRole').find((s) => s.Sid === 'TagAtCreation')!;
    expect(tag.Condition).toEqual({
      'Null': { 'aws:RequestTag/TenantId': 'false' },
      'ForAllValues:StringEquals': { 'aws:TagKeys': ['TenantId', 'tei:stack'] },
    });
    const denied = actionsOf(denies(template, 'KeyFactoryRole'));
    for (const a of ['kms:PutKeyPolicy', 'kms:CreateGrant', 'kms:UntagResource', 'kms:Encrypt', 'kms:Decrypt', 'kms:GenerateDataKey*', 'kms:ReEncrypt*']) {
      expect(denied).toContain(a);
    }
  });

  it('platformRole denies CreateKey, TagResource, PutKeyPolicy, CreateGrant, use, and binding updates', () => {
    const denied = actionsOf(denies(template, 'PlatformRole'));
    for (const a of ['kms:CreateKey', 'kms:TagResource', 'kms:UntagResource', 'kms:PutKeyPolicy', 'kms:CreateGrant', 'kms:Decrypt', 'dynamodb:UpdateItem']) {
      expect(denied).toContain(a);
    }
    for (const role of ['PlatformRole', 'SweepRole']) {
      const deny = denies(template, role).find((s) => s.Sid === 'DenyBindingUpdates')!;
      expect(deny.Condition).toEqual({ 'ForAnyValue:StringEquals': { 'dynamodb:Attributes': ['keyArn', 'tier'] } });
    }
  });

  it('keyFactoryRole and platformRole deny KMS use on tenant-tagged keys only; no base role denies it unconditioned (ADR-0013)', () => {
    const tagCondition = { Null: { 'aws:ResourceTag/TenantId': 'false' } };
    for (const role of ['KeyFactoryRole', 'PlatformRole']) {
      const deny = denies(template, role).find((s) => s.Sid === 'DenyTenantKeyUse')!;
      expect(deny.Action).toEqual(KMS_USE_ACTIONS);
      expect(deny.Resource).toBe('*');
      expect(deny.Condition).toEqual(tagCondition);
    }
    for (const role of BASE) {
      for (const s of denies(template, role)) {
        const usesKms = asArray<string>(s.Action).some((a) => KMS_USE_ACTIONS.includes(a) || a === 'kms:*');
        if (usesKms) expect(s.Condition).toEqual(tagCondition);
      }
    }
  });

  it('processorRole may update only keyStatus, lastKeyCheckAt and updatedAt (plus the keys) of a row', () => {
    const revoke = allows(template, 'ProcessorRole').find((s) => s.Sid === 'RevokeKeyRow')!;
    expect(revoke.Condition['ForAllValues:StringEquals']).toEqual({ 'dynamodb:Attributes': ['PK', 'SK', 'keyStatus', 'lastKeyCheckAt', 'updatedAt'] });
  });

  it('watchRole updates only the SYSTEM partition', () => {
    const tomb = allows(template, 'WatchRole').find((s) => s.Sid === 'WriteTombstones')!;
    expect(tomb.Condition).toEqual({ 'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': ['SYSTEM'] } });
  });
});

describe('ingestion bucket (M-7, M-8, N-7)', () => {
  const bucketId = logicalIdOf(template, 'AWS::S3::Bucket', '/Ingestion/Bucket/Resource');
  const bucket = template.findResources('AWS::S3::Bucket')[bucketId];
  const policy = Object.values(template.findResources('AWS::S3::BucketPolicy')).find((p) => flat(p.Properties.Bucket).includes(bucketId))!;
  const statements = policy.Properties.PolicyDocument.Statement as Record<string, any>[];
  const sid = (s: string) => statements.find((x) => x.Sid === s)!;

  it('is versioned, owner-enforced, private, EventBridge-enabled, bucket keys off, logged', () => {
    expect(bucket.Properties.VersioningConfiguration).toEqual({ Status: 'Enabled' });
    expect(bucket.Properties.OwnershipControls).toEqual({ Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] });
    expect(bucket.Properties.PublicAccessBlockConfiguration).toEqual({
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    });
    expect(bucket.Properties.NotificationConfiguration ?? {}).toBeDefined();
    expect(flat(bucket.Properties.BucketEncryption)).toContain('"BucketKeyEnabled":false');
    expect(bucket.Properties.LoggingConfiguration).toBeDefined();
    expect(bucket.DeletionPolicy).toBe('Delete');
  });

  it('has the §3.1 lifecycle rules', () => {
    const rules = bucket.Properties.LifecycleConfiguration.Rules as Record<string, any>[];
    expect(rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          Prefix: 'ingest/',
          ExpirationInDays: 1,
          NoncurrentVersionExpiration: { NoncurrentDays: 1 },
          AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
        }),
        expect.objectContaining({ Prefix: 'ingest/', ExpiredObjectDeleteMarker: true }),
        expect.objectContaining({ Prefix: 'documents/', NoncurrentVersionExpiration: { NoncurrentDays: 7 } }),
      ]),
    );
  });

  it('denies non-TLS, non-SSE-KMS writes, drops without If-None-Match, other storage classes and redirects', () => {
    expect(statements.some((s) => s.Effect === 'Deny' && flat(s.Condition) === flat({ Bool: { 'aws:SecureTransport': 'false' } }))).toBe(true);
    expect(sid('DenyPutWithoutSseKms').Condition).toEqual({ StringNotEquals: { 's3:x-amz-server-side-encryption': 'aws:kms' } });
    expect(sid('DenyDropWithoutIfNoneMatch').Condition).toEqual({ Null: { 's3:if-none-match': 'true' } });
    expect(flat(sid('DenyDropWithoutIfNoneMatch').Resource)).toContain('/ingest/*');
    expect(flat(sid('DenyDropWithoutIfNoneMatch').Resource)).not.toContain('/documents/');
    expect(sid('DenyDropNonStandardStorageClass').Condition).toEqual({
      StringNotEquals: { 's3:x-amz-storage-class': 'STANDARD' },
      Null: { 's3:x-amz-storage-class': 'false' },
    });
    expect(sid('DenyDropWebsiteRedirect').Condition).toEqual({ Null: { 's3:x-amz-website-redirect-location': 'false' } });
  });

  it('scopes writes and deletes by role ARN, with the auto-delete provider exempt from the delete Denies', () => {
    const autoDeleteRole = flat({ 'Fn::GetAtt': ['CustomS3AutoDeleteObjectsCustomResourceProviderRole3B1BD092', 'Arn'] });
    const arn = (r: string) => flat({ 'Fn::GetAtt': [roleId(template, r), 'Arn'] });
    const exempt = (s: string) => asArray(sid(s).Condition.ArnNotEquals['aws:PrincipalArn']).map(flat).sort();
    expect(exempt('DenyDropWriteExceptTenantRoles')).toEqual([arn('TenantUploadRole'), arn('TenantProcessRole'), arn('TenantPlatformRole')].sort());
    expect(exempt('DenyDocumentWriteExceptProcessRole')).toEqual([arn('TenantProcessRole')]);
    expect(exempt('DenyDropDeleteExceptProcessPlatformAutoDelete')).toEqual([arn('TenantProcessRole'), arn('TenantPlatformRole'), autoDeleteRole].sort());
    expect(exempt('DenyDocumentDeleteExceptPlatformAutoDelete')).toEqual([arn('TenantPlatformRole'), autoDeleteRole].sort());
  });

  it('denies signatures older than max(upload TTL, validator TTL)', () => {
    expect(sid('DenyOldSignatures').Condition).toEqual({ NumericGreaterThan: { 's3:signatureAge': 900_000 } });
  });
});

describe('access-log bucket (M-27)', () => {
  function readerDeny(t: Template) {
    const id = logicalIdOf(t, 'AWS::S3::Bucket', '/Ingestion/AccessLogBucket/Resource');
    const policy = Object.values(t.findResources('AWS::S3::BucketPolicy')).find((p) => flat(p.Properties.Bucket).includes(id))!;
    return {
      bucket: t.findResources('AWS::S3::Bucket')[id],
      deny: (policy.Properties.PolicyDocument.Statement as Record<string, any>[]).find((x) => x.Sid === 'DenyReadExceptAccessLogReader')!,
    };
  }

  it('is SSE-S3, expires after dropRetentionDays + 30, and with no reader role denies reads to all', () => {
    const { bucket, deny } = readerDeny(template);
    expect(flat(bucket.Properties.BucketEncryption)).toContain('AES256');
    expect(bucket.Properties.LifecycleConfiguration.Rules[0].ExpirationInDays).toBe(31);
    expect(deny.Effect).toBe('Deny');
    expect(deny.Condition).toBeUndefined();
  });

  it('exempts exactly the reader role when one is named', () => {
    const t = synthConstruct((stack) => ({ accessLogReaderRole: importedRole(stack, 'Reader', 'log-reader') })).template;
    expect(readerDeny(t).deny.Condition).toEqual({ ArnNotEquals: { 'aws:PrincipalArn': 'arn:aws:iam::111122223333:role/log-reader' } });
  });
});

describe('queues and bus (M-16, N-7)', () => {
  it('every queue uses SSE-SQS', () => {
    for (const q of Object.values(template.findResources('AWS::SQS::Queue'))) {
      expect(q.Properties.SqsManagedSseEnabled).toBe(true);
    }
  });

  it('the queue denies senders other than the rule; the DLQ others than the queue; the bus all but the pipeline', () => {
    const policies = Object.values(template.findResources('AWS::SQS::QueuePolicy')).flatMap((p) => p.Properties.PolicyDocument.Statement as Record<string, any>[]);
    const queueDeny = policies.find((s) => s.Sid === 'DenySendExceptRuleOrRedriveOperator')!;
    expect(Object.keys(queueDeny.Condition.ArnNotEquals)).toEqual(['aws:SourceArn']);
    const dlqDeny = policies.find((s) => s.Sid === 'DenySendExceptSourceQueue')!;
    expect(Object.keys(dlqDeny.Condition.ArnNotEquals)).toEqual(['aws:SourceArn']);
    const busPolicies = Object.values(template.findResources('AWS::Events::EventBusPolicy'));
    expect(flat(busPolicies)).toContain('DenyPutEventsExceptPipeline');
  });

  it('adds the redrive operator to the queue Deny when set', () => {
    const t = synthConstruct((stack) => ({ redriveOperatorRole: importedRole(stack, 'Op', 'redrive-operator') })).template;
    const deny = Object.values(t.findResources('AWS::SQS::QueuePolicy'))
      .flatMap((p) => p.Properties.PolicyDocument.Statement as Record<string, any>[])
      .find((x) => x.Sid === 'DenySendExceptRuleOrRedriveOperator')!;
    expect(deny.Condition.ArnNotEquals['aws:PrincipalArn']).toBe('arn:aws:iam::111122223333:role/redrive-operator');
  });

  it('the Object Created rule is on the default bus, for this bucket and ingest/ only, with a target DLQ', () => {
    const rule = Object.values(template.findResources('AWS::Events::Rule')).find((r) => flat(r.Properties.EventPattern).includes('Object Created'))!;
    expect(rule.Properties.EventBusName).toBeUndefined();
    expect(rule.Properties.EventPattern.detail.object).toEqual({ key: [{ prefix: 'ingest/' }] });
    expect(rule.Properties.Targets[0].DeadLetterConfig).toBeDefined();
  });

  it('the DLQs keep messages 14 days', () => {
    const dlq = template.findResources('AWS::SQS::Queue')[logicalIdOf(template, 'AWS::SQS::Queue', '/Ingestion/DeadLetterQueue/Resource')];
    expect(dlq.Properties.MessageRetentionPeriod).toBe(14 * 24 * 3600);
  });
});

describe('functions and logs (M-31)', () => {
  it('every function has an explicit DESTROY log group with retention', () => {
    const groups = template.findResources('AWS::Logs::LogGroup');
    for (const [id, fn] of Object.entries(template.findResources('AWS::Lambda::Function'))) {
      if (id.startsWith('CustomS3AutoDelete') || id.startsWith('BucketNotificationsHandler')) {
        continue;
      }
      const ref = fn.Properties.LoggingConfig?.LogGroup?.Ref as string | undefined;
      expect(ref).toBeDefined();
      expect(groups[ref!].DeletionPolicy).toBe('Delete');
      expect(groups[ref!].Properties.RetentionInDays).toBeDefined();
    }
  });
});

describe('API (M-1, M-4, M-5)', () => {
  function methods(t: Template) {
    return Object.values(t.findResources('AWS::ApiGateway::Method')).filter((m) => m.Properties.HttpMethod !== 'OPTIONS');
  }
  const pathOf = (t: Template, m: Record<string, any>) => {
    const resources = t.findResources('AWS::ApiGateway::Resource');
    const parts: string[] = [];
    let ref = m.Properties.ResourceId.Ref as string | undefined;
    while (ref !== undefined && resources[ref] !== undefined) {
      parts.unshift(resources[ref].Properties.PathPart);
      ref = resources[ref].Properties.ParentId.Ref;
    }
    return `/${parts.join('/')}`;
  };

  it('/platform methods are AWS_IAM; /tenant methods use the token authoriser', () => {
    const all = methods(template);
    expect(all).toHaveLength(7);
    for (const m of all) {
      const path = pathOf(template, m);
      if (path.startsWith('/platform')) {
        expect(m.Properties.AuthorizationType).toBe('AWS_IAM');
        expect(m.Properties.AuthorizerId).toBeUndefined();
      } else {
        expect(path.startsWith('/tenant')).toBe(true);
        expect(m.Properties.AuthorizationType).toBe('CUSTOM');
      }
    }
  });

  it('the authoriser is TOKEN with a 300 s cache', () => {
    template.hasResourceProperties('AWS::ApiGateway::Authorizer', {
      Type: 'TOKEN',
      AuthorizerResultTtlInSeconds: 300,
      IdentitySource: 'method.request.header.Authorization',
    });
  });

  it('without tenantThrottle: no API key required, no usage plan', () => {
    for (const m of methods(template)) {
      expect(m.Properties.ApiKeyRequired ?? false).toBe(false);
    }
    expect(Object.keys(template.findResources('AWS::ApiGateway::UsagePlan'))).toHaveLength(0);
  });

  it('with tenantThrottle: apiKeyRequired on every /tenant method, AUTHORIZER key source, a throttled usage plan', () => {
    for (const m of methods(throttled)) {
      expect(m.Properties.ApiKeyRequired ?? false).toBe(pathOf(throttled, m).startsWith('/tenant'));
    }
    throttled.hasResourceProperties('AWS::ApiGateway::RestApi', { ApiKeySourceType: 'AUTHORIZER' });
    throttled.hasResourceProperties('AWS::ApiGateway::UsagePlan', { Throttle: { RateLimit: 10, BurstLimit: 20 } });
  });

  it('logs the verified tenantId in access logs and never data traces', () => {
    template.hasResourceProperties('AWS::ApiGateway::Stage', {
      AccessLogSetting: { Format: Match.stringLikeRegexp('\\$context.authorizer.tenantId') },
    });
    expect(flat(template.findResources('AWS::ApiGateway::Stage'))).not.toContain('"DataTraceEnabled":true');
  });
});

describe('registry and watch (M-24)', () => {
  it('has PITR, a NEW_AND_OLD_IMAGES stream, TTL and the two GSIs', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      StreamSpecification: { StreamViewType: 'NEW_AND_OLD_IMAGES' },
      TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({ IndexName: 'statusBucket-urlExpiresAt' }),
        Match.objectLike({ IndexName: 'keyStatus' }),
      ]),
    });
  });

  it('the watch reads the stream behind an SK = KEY filter with an on-failure SQS destination', () => {
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      FilterCriteria: { Filters: [{ Pattern: JSON.stringify({ dynamodb: { Keys: { SK: { S: ['KEY'] } } } }) }] },
      DestinationConfig: { OnFailure: { Destination: Match.anyValue() } },
      BisectBatchOnFunctionError: true,
    });
  });
});

describe('timing (M-11)', () => {
  it('T is the structural and copy budgets plus every validator timeout; visibility is factor x T', () => {
    const s = synthConstruct();
    const v = synthConstruct({ validators: [validatorFor(s.stack, 'a', 30), validatorFor(s.stack, 'b', 60)] });
    expect(v.construct.processorTimeout.toSeconds()).toBe(60 + 30 + 60 + 60);
    v.template.hasResourceProperties('AWS::SQS::Queue', { VisibilityTimeout: 6 * 210, RedrivePolicy: Match.objectLike({ maxReceiveCount: 3 }) });
    v.template.hasResourceProperties('AWS::Lambda::Function', { Timeout: 210, Description: Match.stringLikeRegexp('processor') });
  });

  it('synth fails naming the validators when T exceeds 15 minutes', () => {
    const s = synthConstruct();
    expect(() =>
      synthConstruct({ validators: [validatorFor(s.stack, 'slow-a', 600), validatorFor(s.stack, 'slow-b', 300)] }),
    ).toThrow(/slow-a, slow-b/);
  });
});

describe('validators (M-20)', () => {
  it('the processor gains invoke on the exact function ARN; the validator gains nothing', () => {
    const s = synthConstruct();
    const t = synthConstruct({ validators: [validatorFor(s.stack, 'pdf-pages')] }).template;
    const invoke = allows(t, 'ProcessorRole').filter((x) => asArray<string>(x.Action).includes('lambda:InvokeFunction'));
    expect(invoke).toHaveLength(1);
    expect(flat(invoke[0].Resource)).toBe(JSON.stringify('arn:aws:lambda:eu-central-1:111122223333:function:validator-pdf-pages'));
  });

  it('refuses a duplicate name or the reserved name structural', () => {
    const s1 = synthConstruct();
    const s2 = synthConstruct();
    expect(() => synthConstruct({ validators: [validatorFor(s1.stack, 'a'), validatorFor(s2.stack, 'a')] })).toThrow(/used twice/);
    const s = synthConstruct();
    expect(() => synthConstruct({ validators: [validatorFor(s.stack, 'structural')] })).toThrow(/structural/);
  });
});

describe('alarms (M-24, M-25)', () => {
  it('the PutKeyPolicy rule matches the CloudTrail event, and both alarms exist', () => {
    template.hasResourceProperties('AWS::Events::Rule', { EventPattern: Match.objectLike({ 'detail-type': PUT_KEY_POLICY_PATTERN.detailType }) });
    template.hasResourceProperties('AWS::CloudWatch::Alarm', { MetricName: 'TriggeredRules', Namespace: 'AWS/Events' });
    template.hasResourceProperties('AWS::CloudWatch::Alarm', { MetricName: 'KeyBindingChanged' });
  });
});

describe('props validation (spec §3.3)', () => {
  it.each([
    ['keyDeletionWindowDays', { keyDeletionWindowDays: 6 }],
    ['uploadUrlTtlSeconds', { uploadUrlTtlSeconds: 3301 }],
    ['maxInFlightPerTenant', { maxInFlightPerTenant: 0 }],
    ['dropRetentionDays', { dropRetentionDays: 8 }],
    ['validatorObjectUrlTtlSeconds', { validatorObjectUrlTtlSeconds: 59 }],
    ['maxReceiveCount', { maxReceiveCount: 11 }],
    ['visibilityTimeoutFactor', { visibilityTimeoutFactor: 1 }],
    ['abandonGraceSeconds', { abandonGraceSeconds: 59 }],
    ['allowedContentTypes', { allowedContentTypes: ['text/csv'] }],
    ['tenantThrottle', { tenantThrottle: { rateLimit: 0, burstLimit: 1 } }],
    ['allowedClientIds', { identity: { discoveryUrl: 'https://x', allowedClientIds: [] } }],
  ])('fails synth naming %s', (name, props) => {
    expect(() => synthConstruct(props as never)).toThrow(new RegExp(name));
  });

  it('accepts a validator timeout of exactly 10 minutes but no more', () => {
    const s = synthConstruct();
    expect(() => validatorFor(s.stack, 'ten', 601)).toThrow(/10 minutes/);
    void Duration;
  });
});
