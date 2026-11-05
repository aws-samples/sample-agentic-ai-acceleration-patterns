// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The test-aid stack of the integration test (spec §10, M-32, M-33).
 * Deployed before the demo stack, destroyed with it.
 *
 * - `TestProbeRole`: trusted by the runner's account for one hour. KMS use
 *   actions and `DescribeKey` on `*`, `s3:GetObject` and `s3:PutObject` on
 *   every bucket of the account; explicit Denies of `kms:PutKeyPolicy`,
 *   `CreateGrant`, `ScheduleKeyDeletion`, `TagResource`, `UntagResource`,
 *   `s3:PutBucketPolicy`, `DeleteBucketPolicy`, `PutBucketEncryption`. Any
 *   denial it meets therefore comes from a key or bucket policy.
 * - `TestConsumerRole`: the demo stack's consumer role. `s3:GetObject` on
 *   `documents/${tag}/*` of any bucket, `kms:Decrypt` via S3 on keys tagged
 *   `${tag}`. Assumed with a `TenantId` session tag, like a tenant role.
 * - A scratch bucket (§7.4 minus the principal statements) and a scratch key
 *   for tenant `tenant-a`, from the same §7.2 builder, with
 *   `TestScratchWriterRole` as its tenant role, `TestConsumerRole` as its
 *   consumer, and a MISTAKEN Allow of every use action for `TestProbeRole`,
 *   so each Deny (4a-i, 4a-ii, 4b, 4c) can be met alone (step 5).
 */

import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import type { Construct } from 'constructs';
import { createIngestionBucket } from '../../src/construct/bucket';
import { addIngestionBucketPolicy } from '../../src/construct/bucket-policy';
import { buildVendorKeyPolicy } from '../../src/construct/key-policy';
import { TENANT_ROLE_TRUST_CONDITIONS, TENANT_TAG_VARIABLE } from '../../src/construct/roles';

export const SCRATCH_TENANT = 'tenant-a';

/** The Denies that keep TestProbeRole from changing what it tests (M-33). */
export const PROBE_DENIED_ACTIONS = [
  'kms:PutKeyPolicy',
  'kms:CreateGrant',
  'kms:ScheduleKeyDeletion',
  'kms:TagResource',
  'kms:UntagResource',
  's3:PutBucketPolicy',
  's3:DeleteBucketPolicy',
  's3:PutBucketEncryption',
];

export class TestAidStack extends Stack {
  readonly probeRole: iam.Role;
  readonly consumerRole: iam.Role;
  readonly scratchWriterRole: iam.Role;

  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, props);
    const runner = new iam.AccountPrincipal(this.account);

    this.probeRole = new iam.Role(this, 'TestProbeRole', {
      assumedBy: runner,
      maxSessionDuration: Duration.hours(1),
      description: 'tenant-encrypted-ingestion integ: meets each key-policy and bucket-policy Deny alone (M-32)',
    });
    this.probeRole.addToPolicy(
      new iam.PolicyStatement({ actions: ['kms:Encrypt', 'kms:Decrypt', 'kms:GenerateDataKey*', 'kms:ReEncrypt*', 'kms:DescribeKey'], resources: ['*'] }),
    );
    this.probeRole.addToPolicy(new iam.PolicyStatement({ actions: ['s3:GetObject', 's3:PutObject'], resources: ['arn:aws:s3:::*/*'] }));
    this.probeRole.addToPolicy(new iam.PolicyStatement({ sid: 'DenyChangingWhatIsTested', effect: iam.Effect.DENY, actions: PROBE_DENIED_ACTIONS, resources: ['*'] }));

    const tagged = new iam.AccountPrincipal(this.account).withConditions(TENANT_ROLE_TRUST_CONDITIONS).withSessionTags();
    this.consumerRole = new iam.Role(this, 'TestConsumerRole', {
      assumedBy: tagged,
      maxSessionDuration: Duration.hours(1),
      description: 'tenant-encrypted-ingestion integ: a consumer role reading documents/<tenant>/ (spec §7.2 2b)',
    });
    this.consumerRole.addToPolicy(
      new iam.PolicyStatement({ actions: ['s3:GetObject'], resources: [`arn:aws:s3:::*/documents/${TENANT_TAG_VARIABLE}/*`] }),
    );
    this.consumerRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['kms:Decrypt'],
        resources: ['*'],
        conditions: { StringEquals: { 'aws:ResourceTag/TenantId': TENANT_TAG_VARIABLE, 'kms:ViaService': `s3.${this.region}.amazonaws.com` } },
      }),
    );

    // Scratch bucket and key (M-32).
    const scratch = createIngestionBucket(this, 'ScratchBucket', { dropRetentionDays: 1 });
    addIngestionBucketPolicy(scratch, { maxSignatureAgeSeconds: 900 });
    this.scratchWriterRole = new iam.Role(this, 'TestScratchWriterRole', {
      assumedBy: runner,
      maxSessionDuration: Duration.hours(1),
      description: 'tenant-encrypted-ingestion integ: the scratch key\'s tenant role',
    });
    scratch.grantReadWrite(this.scratchWriterRole);
    const policy = buildVendorKeyPolicy({
      partition: this.partition,
      account: this.account,
      region: this.region,
      bucket: scratch.bucketName,
      tenantId: SCRATCH_TENANT,
      tenantRoleArns: [this.scratchWriterRole.roleArn],
      consumerRoleArns: [this.consumerRole.roleArn],
      platformRoleArn: this.scratchWriterRole.roleArn,
      keyFactoryRoleArn: this.scratchWriterRole.roleArn,
    });
    const keyPolicy = {
      ...policy,
      Statement: [
        ...policy.Statement,
        {
          Sid: 'MistakenAllowEveryUseForTestProbeRole',
          Effect: 'Allow',
          Principal: { AWS: this.probeRole.roleArn },
          Action: ['kms:Encrypt', 'kms:Decrypt', 'kms:GenerateDataKey*', 'kms:ReEncrypt*', 'kms:DescribeKey'],
          Resource: '*',
        },
      ],
    };
    const key = new kms.CfnKey(this, 'ScratchKey', {
      description: 'tenant-encrypted-ingestion integ scratch key for tenant-a (spec §10 step 5)',
      keyPolicy,
      enableKeyRotation: true,
      pendingWindowInDays: 7,
      bypassPolicyLockoutSafetyCheck: true,
      tags: [{ key: 'TenantId', value: SCRATCH_TENANT }],
    });
    key.applyRemovalPolicy(RemovalPolicy.DESTROY);

    new CfnOutput(this, 'TestProbeRoleArn', { value: this.probeRole.roleArn });
    new CfnOutput(this, 'TestConsumerRoleArn', { value: this.consumerRole.roleArn });
    new CfnOutput(this, 'TestScratchWriterRoleArn', { value: this.scratchWriterRole.roleArn });
    new CfnOutput(this, 'ScratchBucketName', { value: scratch.bucketName });
    new CfnOutput(this, 'ScratchKeyArn', { value: key.attrArn });
  }
}
