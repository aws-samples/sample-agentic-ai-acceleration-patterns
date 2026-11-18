// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * `TenantUsageMetering`: the published construct (spec §6.3). This slice
 * builds the storage and the ingest pipeline (spec §3.1, §3.5, §4); the API,
 * the functions, the recounter and the sinks attach to the roles created
 * here as they are built.
 */

import { Names } from 'aws-cdk-lib';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { createPipeline, type Pipeline } from './construct/pipeline';
import { resolveProps, type ResolvedProps, type TenantUsageMeteringProps } from './construct/props';
import { createServiceRoles, type ServiceRoles, tableWriters } from './construct/roles';
import { createStorage } from './construct/storage';
import { createTable } from './construct/table';
import { emitterRolePattern } from './shared/identity';
import { acknowledgeWildcards } from './shared/nag';

export class TenantUsageMetering extends Construct {
  /** The props with every default applied. */
  public readonly config: ResolvedProps;
  public readonly table: dynamodb.TableV2;
  public readonly rawBucket: s3.Bucket;
  public readonly exportBucket: s3.Bucket;
  public readonly roles: ServiceRoles;
  public readonly pipeline: Pipeline;
  /** The ingest bus ARN; undefined with `ingestPath: DIRECT`. */
  public readonly ingestBusArn?: string;
  public readonly usageBusArn: string;
  /** The `aws:PrincipalArn` pattern of emitter roles (spec §3.2). */
  public readonly emitterRoleNamePattern: string;

  constructor(scope: Construct, id: string, props: TenantUsageMeteringProps) {
    super(scope, id);
    // Server access logs are written under a bucket policy, so the log
    // bucket keeps ACLs disabled. Set on this node (before any child exists)
    // so the construct does not depend on the consumer's cdk.json.
    this.node.setContext('@aws-cdk/aws-s3:serverAccessLogsUseBucketPolicy', true);
    this.config = resolveProps(props);

    // Physical names the trust conditions and policies need before the
    // resources exist; unique per stack and construct, within service limits.
    const unique = Names.uniqueResourceName(this, { maxLength: 40, separator: '-' }).toLowerCase();
    const names = {
      firehoseStreamName: `${unique}-raw`,
      ingestBusName: `${unique}-ingest`,
      usageBusName: `${unique}-usage`,
      ingestSubscriberName: `${unique}-ingest-to-firehose`,
    };

    this.roles = createServiceRoles(this, names);
    this.table = createTable(this, tableWriters(this.roles));
    const storage = createStorage(this, this.config, this.roles);
    this.rawBucket = storage.rawBucket;
    this.exportBucket = storage.exportBucket;
    this.pipeline = createPipeline(this, this.config, this.roles, this.rawBucket, names);
    this.ingestBusArn = this.pipeline.ingestBusArn;
    this.usageBusArn = this.pipeline.usageBusArn;
    this.emitterRoleNamePattern = emitterRolePattern(this.config.fleetName);

    acknowledgeWildcards(this, (path) => {
      if (path.includes('/FirehoseRole/')) {
        return 'Firehose writes objects under the raw/ and firehose-error/ prefixes it names at run time (hour partitions, error types); grantPut adds the multipart actions it needs (spec §3.5).';
      }
      return undefined;
    });

  }
}
